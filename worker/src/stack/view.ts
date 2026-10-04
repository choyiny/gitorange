import { and, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prEdges,
  pullRequests,
  type PrEdge,
  type PullRequest,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import { usersById, type PublicUser } from '../lib/users';
import { parsePolicy, readPolicy } from '../review/policy';
import { buildTree, type EdgeInput, type TreeNode } from './tree';

export type StackNodeView = TreeNode & {
  title: string;
  headRef: string;
  author: PublicUser;
};
export type StackTreeView = {
  /** Stacking is on for the default branch or for a branch with open PRs. */
  stacking: boolean;
  targets: {
    branch: string;
    nodes: StackNodeView[];
    landed: { number: number; title: string }[];
  }[];
};

async function stackingOn(git: GitService, branch: string) {
  const tip = await git.resolve(branch);
  const file = tip ? await readPolicy(git, tip) : null;
  if (!file) return false;
  try {
    return parsePolicy(file.text).stacking.enabled;
  } catch {
    return false;
  }
}

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

const ghost: PublicUser = {
  id: 'ghost',
  username: 'ghost',
  name: 'Deleted user',
  image: null,
};

/**
 * The tree of every target branch with open PRs and stacking on. `defaultBranch` is checked too, so
 * `stacking` is true for a repository with stacking on and no open PR.
 */
export async function stackTreeView(
  db: DrizzleDB,
  git: GitService,
  repositoryId: string,
  opts: { branch?: string; authors?: boolean; defaultBranch?: string } = {}
): Promise<StackTreeView> {
  const open = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.state, 'open'),
        opts.branch ? eq(pullRequests.baseRef, opts.branch) : undefined
      )
    )
    .all();
  const branches = [...new Set(open.map((p) => p.baseRef))].sort();
  const on: string[] = [];
  for (const b of branches) if (await stackingOn(git, b)) on.push(b);
  if (!on.length)
    return {
      stacking:
        !opts.branch &&
        !!opts.defaultBranch &&
        !branches.includes(opts.defaultBranch) &&
        (await stackingOn(git, opts.defaultBranch)),
      targets: [],
    };
  // Only pairs with an open side on a branch with stacking on; D1 binds at most 100 parameters per statement.
  const openIds = open.filter((p) => on.includes(p.baseRef)).map((p) => p.id);
  const edges = new Map<string, PrEdge>();
  for (const ids of chunks(openIds, 45))
    for (const e of await db
      .select()
      .from(prEdges)
      .where(
        and(
          eq(prEdges.repositoryId, repositoryId),
          or(inArray(prEdges.prAId, ids), inArray(prEdges.prBId, ids))
        )
      )
      .all())
      if (on.includes(e.landTarget)) edges.set(e.id, e);
  const isOpen = new Set(openIds);
  const others = [
    ...new Set(
      [...edges.values()]
        .flatMap((e) => [e.prAId, e.prBId])
        .filter((id) => !isOpen.has(id))
    ),
  ];
  const touched = [
    ...open.map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      state: p.state,
    })),
  ];
  for (const ids of chunks(others, 90))
    touched.push(
      ...(await db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          title: pullRequests.title,
          state: pullRequests.state,
        })
        .from(pullRequests)
        .where(inArray(pullRequests.id, ids))
        .all())
    );
  const byId = new Map(touched.map((p) => [p.id, p]));
  const refs = await git.refs();
  const headOf = (p: PullRequest) => refs.get(`refs/heads/${p.headRef}`);
  const people =
    opts.authors === false
      ? new Map<string, PublicUser>()
      : await usersById(
          db,
          open.map((p) => p.authorId)
        );
  return {
    stacking: true,
    targets: on.map((branch) => {
      const prs = open
        .filter((p) => p.baseRef === branch)
        .sort((x, y) => x.number - y.number);
      const inputs: EdgeInput[] = [...edges.values()]
        .filter((e) => e.landTarget === branch)
        .flatMap((e) => {
          const a = byId.get(e.prAId);
          const b = byId.get(e.prBId);
          // Closed without merging: not a prerequisite, never "landed".
          if (!a || !b || a.state === 'closed' || b.state === 'closed')
            return [];
          return [
            {
              a: a.number,
              b: b.number,
              stage: e.stage,
              kind: e.kind,
              prerequisite: e.prerequisite,
              reason: e.reason,
              instructions: e.instructions,
              files: e.files ?? [],
            },
          ];
        });
      const tree = buildTree(
        prs.map((p) => p.number),
        inputs
      );
      const landedNumbers = new Set(
        [...tree.values()].flatMap((n) =>
          n.mustAccountFor.filter((d) => d.landed).map((d) => d.number)
        )
      );
      // Checking: no pair row involves this PR at its current head yet, though other open PRs with a
      // live branch exist. Its stack run starts once its auto-merge review ends; until then (and until it
      // claims its pairs) "independent" would be a guess.
      const live = prs.filter((p) => headOf(p));
      const checking = (p: PullRequest) => {
        const head = headOf(p);
        if (!head || live.length < 2) return false;
        return ![...edges.values()].some(
          (e) =>
            (e.prAId === p.id && e.aHead === head) ||
            (e.prBId === p.id && e.bHead === head)
        );
      };
      return {
        branch,
        nodes: prs.map((p) => ({
          ...tree.get(p.number)!,
          checking: checking(p),
          title: p.title,
          headRef: p.headRef,
          author: people.get(p.authorId) ?? ghost,
        })),
        landed: touched
          .filter((p) => landedNumbers.has(p.number))
          .map((p) => ({ number: p.number, title: p.title }))
          .sort((x, y) => x.number - y.number),
      };
    }),
  };
}

/** One open PR's place in its target's tree; null when stacking is off there. */
export async function stackViewFor(
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest
): Promise<TreeNode | null> {
  if (pr.state !== 'open') return null;
  const view = await stackTreeView(db, git, pr.repositoryId, {
    branch: pr.baseRef,
    authors: false,
  });
  const node = view.targets
    .find((t) => t.branch === pr.baseRef)
    ?.nodes.find((n) => n.number === pr.number);
  if (!node) return null;
  const { title: _t, headRef: _h, author: _a, ...rest } = node;
  return rest;
}
