import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { onRefsUpdated } from '../actions/trigger';
import {
  pullRequests,
  releasePulls,
  releases,
  workflowRuns,
  type Release,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { GitPushError, ZERO_SHA } from '../git/remote';
import { recordAudit } from './audit';
import { landTargetIs } from './land-target';
import { pullRef } from '../merge/land';
import { gitFor } from './repos';
import { chunks } from '../stack/view';
import {
  bumpVersion,
  compareVersions,
  formatVersion,
  largestBump,
  parseVersion,
  type Bump,
  type Version,
} from './semver';

// Releases: a `vX.Y.Z` tag on the default branch plus a `releases` row with its notes, cut by a person or an agent
// from the pull requests landed since the last release. "Unreleased" is D1 alone (merged into the current default
// branch, in no release_pulls row), never a walk through history. Tags are created from absent only, so an existing
// tag is never moved; releases are never deleted, so a version is never handed out twice. Hand-pushed tags are not
// releases and never count as the latest one.

export type ReleaseRow = Release;

export type UnreleasedPull = {
  number: number;
  title: string;
  author: string;
  /** Null: it asked for none, which counts as patch. */
  bump: Bump | null;
  mergedAt: number;
};

export type ReleaseView = {
  tag: string;
  title: string;
  notes: string;
  commitSha: string;
  createdAt: number;
  createdBy: string | null;
  /** The pull requests it shipped; empty for a first release, which records them without listing them. */
  pulls: { number: number; title: string; bump: Bump | null }[];
};

export type CutResult =
  | { ok: true; release: ReleaseView }
  | { ok: false; status: 400 | 403 | 409; message: string; head?: string };

export const FIRST_RELEASE_NOTES = 'First release.';

const GROUPS: { bump: Bump; heading: string }[] = [
  { bump: 'major', heading: '### Major' },
  { bump: 'minor', heading: '### Minor' },
  { bump: 'patch', heading: '### Patch' },
];

const versionOf = (r: ReleaseRow): Version => ({
  major: r.major,
  minor: r.minor,
  patch: r.patch,
});

const compareUrl = (
  origin: string,
  repoFullName: string,
  from: string,
  to: string
) => `${origin}/${repoFullName}/compare/${from}...${to}`;

/** The newest release by version, or null before the first one. */
async function latestRelease(
  db: DrizzleDB,
  repo: Repository
): Promise<ReleaseRow | null> {
  return (
    (await db
      .select()
      .from(releases)
      .where(eq(releases.repositoryId, repo.id))
      .orderBy(desc(releases.major), desc(releases.minor), desc(releases.patch))
      .limit(1)
      .get()) ?? null
  );
}

/** Merged into the current default branch and in no release, oldest landing first, with their ids. */
async function unreleasedRows(db: DrizzleDB, repo: Repository) {
  const rows = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      title: pullRequests.title,
      author: users.username,
      bump: pullRequests.versionBump,
      mergedAt: pullRequests.mergedAt,
    })
    .from(pullRequests)
    .leftJoin(releasePulls, eq(releasePulls.pullRequestId, pullRequests.id))
    .leftJoin(users, eq(users.id, pullRequests.authorId))
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        eq(pullRequests.state, 'merged'),
        landTargetIs(repo.defaultBranch),
        isNull(releasePulls.releaseId)
      )
    )
    .orderBy(asc(pullRequests.mergedAt), asc(pullRequests.number));
  return rows.map((r) => ({
    id: r.id,
    pull: {
      number: r.number,
      title: r.title,
      author: r.author ?? 'ghost',
      bump: r.bump,
      mergedAt: r.mergedAt?.getTime() ?? 0,
    } satisfies UnreleasedPull,
  }));
}

/** The version the pulls make after `latest`; null with no release yet (the first one is typed) or nothing landed. */
function nextVersion(latest: ReleaseRow | null, pulls: UnreleasedPull[]) {
  if (!latest || !pulls.length) return null;
  return formatVersion(
    bumpVersion(versionOf(latest), largestBump(pulls.map((p) => p.bump)))
  );
}

/** Markdown notes: Major, Minor, Patch groups (empty ones left out), one line per pull request, then the compare link. */
export function releaseNotes(
  pulls: UnreleasedPull[],
  links: { compareUrl: string | null }
): string {
  const sections: string[] = [];
  for (const g of GROUPS) {
    const lines = pulls
      .filter((p) => (p.bump ?? 'patch') === g.bump)
      .map((p) => `- ${p.title} (#${p.number}) @${p.author}`);
    if (lines.length) sections.push([g.heading, '', ...lines].join('\n'));
  }
  if (links.compareUrl) sections.push(`Full changes: ${links.compareUrl}`);
  return sections.join('\n\n');
}

/** What landed since the last release, the version it would make, and the notes a cut would write. */
export async function unreleased(
  db: DrizzleDB,
  repo: Repository,
  origin: string,
  repoFullName: string
): Promise<{
  pulls: UnreleasedPull[];
  latest: ReleaseRow | null;
  next: string | null;
  notesPreview: string;
}> {
  const [rows, latest] = await Promise.all([
    unreleasedRows(db, repo),
    latestRelease(db, repo),
  ]);
  const pulls = rows.map((r) => r.pull);
  const next = nextVersion(latest, pulls);
  const notesPreview = !latest
    ? FIRST_RELEASE_NOTES
    : pulls.length
      ? releaseNotes(pulls, {
          compareUrl: next
            ? compareUrl(origin, repoFullName, latest.tag, next)
            : null,
        })
      : '';
  return { pulls, latest, next, notesPreview };
}

/** Ids per `IN (...)`, under D1's 100 bound parameters per statement. */
const IDS_PER_QUERY = 90;
/** `release_pulls` rows per INSERT (two parameters each). */
const PULLS_PER_INSERT = 45;

/** Runs `query` over `ids` in chunks and concatenates the results, in chunk order. */
async function inChunks<T>(
  ids: string[],
  query: (part: string[]) => Promise<T[]>
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunks(ids, IDS_PER_QUERY))
    out.push(...(await query(part)));
  return out;
}

/** Release rows as views: one query for their authors and one for their pull requests, however many there are. */
async function views(
  db: DrizzleDB,
  rows: ReleaseRow[]
): Promise<ReleaseView[]> {
  if (!rows.length) return [];
  const authorIds = [
    ...new Set(rows.map((r) => r.createdById).filter((id) => id !== null)),
  ];
  // A first release records what came before it without listing it.
  const listed = rows
    .filter((r) => r.previousReleaseId !== null)
    .map((r) => r.id);
  // D1 binds at most 100 parameters per statement: ask in chunks.
  const [authors, shipped] = await Promise.all([
    inChunks(authorIds, (part) =>
      db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, part))
    ),
    inChunks(listed, (part) =>
      db
        .select({
          releaseId: releasePulls.releaseId,
          number: pullRequests.number,
          title: pullRequests.title,
          bump: pullRequests.versionBump,
        })
        .from(releasePulls)
        .innerJoin(
          pullRequests,
          eq(pullRequests.id, releasePulls.pullRequestId)
        )
        .where(inArray(releasePulls.releaseId, part))
        .orderBy(asc(pullRequests.number))
    ),
  ]);
  const login = new Map(authors.map((a) => [a.id, a.username]));
  return rows.map((r) => ({
    tag: r.tag,
    title: r.title,
    notes: r.notes,
    commitSha: r.commitSha,
    createdAt: r.createdAt.getTime(),
    createdBy: r.createdById ? (login.get(r.createdById) ?? null) : null,
    pulls: shipped
      .filter((p) => p.releaseId === r.id)
      .map((p) => ({ number: p.number, title: p.title, bump: p.bump })),
  }));
}

/** Every release, newest version first: the changelog. */
export async function listReleases(
  db: DrizzleDB,
  repo: Repository
): Promise<ReleaseView[]> {
  const rows = await db
    .select()
    .from(releases)
    .where(eq(releases.repositoryId, repo.id))
    .orderBy(desc(releases.major), desc(releases.minor), desc(releases.patch));
  return views(db, rows);
}

function releaseRow(db: DrizzleDB, repo: Repository, tag: string) {
  return db
    .select()
    .from(releases)
    .where(and(eq(releases.repositoryId, repo.id), eq(releases.tag, tag)))
    .get();
}

export async function getRelease(
  db: DrizzleDB,
  repo: Repository,
  tag: string
): Promise<ReleaseView | null> {
  const row = await releaseRow(db, repo, tag);
  return row ? (await views(db, [row]))[0] : null;
}

/** Edits a release's title or notes (nothing else ever changes). Null when there is no such release. */
export async function updateRelease(
  db: DrizzleDB,
  repo: Repository,
  tag: string,
  patch: { title?: string; notes?: string },
  actor: { id: string; via?: string | null }
): Promise<ReleaseView | null> {
  const row = await releaseRow(db, repo, tag);
  if (!row) return null;
  const set: { title?: string; notes?: string } = {};
  if (patch.title !== undefined) set.title = patch.title.trim() || row.tag;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (Object.keys(set).length) {
    await db.update(releases).set(set).where(eq(releases.id, row.id));
    await recordAudit(db, {
      repositoryId: repo.id,
      actorId: actor.id,
      via: actor.via ?? null,
      action: 'release.updated',
      target: row.tag,
      data: { fields: Object.keys(set) },
    });
  }
  return getRelease(db, repo, tag);
}

/** The tag of the release that shipped a pull request, or null. */
export async function releasedIn(
  db: DrizzleDB,
  pullRequestId: string
): Promise<string | null> {
  return (await releasedInMany(db, [pullRequestId])).get(pullRequestId) ?? null;
}

/** releasedIn for many pull requests in one query (keep it under D1's 100 bound parameters), keyed by pull request id. */
export async function releasedInMany(
  db: DrizzleDB,
  pullRequestIds: string[]
): Promise<Map<string, string>> {
  if (!pullRequestIds.length) return new Map();
  const rows = await db
    .select({ id: releasePulls.pullRequestId, tag: releases.tag })
    .from(releasePulls)
    .innerJoin(releases, eq(releases.id, releasePulls.releaseId))
    .where(inArray(releasePulls.pullRequestId, pullRequestIds));
  return new Map(rows.map((r) => [r.id, r.tag]));
}

/** Open pull requests landing on the default branch: their numbers, to find one that has pushed but is not yet merged. */
async function openPullNumbers(
  db: DrizzleDB,
  repo: Repository
): Promise<number[]> {
  const rows = await db
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        eq(pullRequests.state, 'open'),
        landTargetIs(repo.defaultBranch)
      )
    );
  return rows.map((r) => r.number);
}

/** Whether anything has queued workflow runs for `ref` in the repository (a push of it did). */
async function hasRuns(db: DrizzleDB, repo: Repository, ref: string) {
  return !!(await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(eq(workflowRuns.repositoryId, repo.id), eq(workflowRuns.ref, ref))
    )
    .limit(1)
    .get());
}

const refuse = (
  status: 400 | 409,
  message: string,
  head?: string
): CutResult => ({
  ok: false,
  status,
  message,
  ...(head ? { head } : {}),
});

/**
 * Cuts a release at `headSha`, the default branch head the caller saw: tag from absent, then the row with its
 * pull requests, then push runs for the tag, then the audit. Permission checks are the caller's (push access).
 */
export async function cutRelease(opts: {
  env: CloudflareBindings;
  db: DrizzleDB;
  repo: Repository;
  repoFullName: string;
  origin: string;
  actor: { id: string; via?: string | null };
  headSha: string;
  version?: string;
  title?: string;
  notes?: string;
}): Promise<CutResult> {
  const { env, db, repo } = opts;
  // D1 before git. Landing pushes the default branch and `refs/pull/<n>/head` to the same commit in one push, then
  // marks the pull request merged. So a merged pull request read here is in the head read next (or the head moved and
  // the cut stops), and one still open here whose pull ref is that head has pushed but is not recorded yet: the cut
  // waits for it rather than ship it unlisted.
  const [rows, latest, open] = await Promise.all([
    unreleasedRows(db, repo),
    latestRelease(db, repo),
    openPullNumbers(db, repo),
  ]);
  const git = gitFor(env, repo);
  const refs = await git.refs();
  const head = refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (!head) return refuse(409, `${repo.defaultBranch} has no commits`);
  if (head !== opts.headSha)
    return refuse(
      409,
      `${repo.defaultBranch} moved to ${head}; check what it adds and cut again`,
      head
    );
  if (open.some((n) => refs.get(pullRef(n)) === head))
    return refuse(409, 'A pull request is landing; try again in a moment');

  const pulls = rows.map((r) => r.pull);
  let version: Version;
  if (opts.version !== undefined) {
    const typed = parseVersion(opts.version.trim());
    if (!typed)
      return refuse(400, 'A version looks like v1.2.3 (no pre-release suffix)');
    if (latest && compareVersions(typed, versionOf(latest)) <= 0)
      return refuse(
        400,
        `${formatVersion(typed)} is not after the latest release, ${latest.tag}`
      );
    version = typed;
  } else {
    if (!latest)
      return refuse(
        400,
        'The first release needs a version, for example v0.1.0'
      );
    version = bumpVersion(
      versionOf(latest),
      largestBump(pulls.map((p) => p.bump))
    );
  }
  if (!pulls.length) return refuse(409, 'Nothing to release');

  const tag = formatVersion(version);
  const ref = `refs/tags/${tag}`;
  // Whether this call made the tag (so it may take it back), rather than adopting one already there.
  let created = true;
  try {
    await git.createRef(ref, head);
  } catch (err) {
    if (!(err instanceof GitPushError)) throw err;
    // A cut whose tag went out but whose row and runs did not (the retry adopts its own tag). A tag pushed with git
    // queued its runs on that push, so one with runs is someone's, as is any tag elsewhere or with a release.
    const adoptable =
      (await git.refs()).get(ref) === head &&
      !(await releaseRow(db, repo, tag)) &&
      !(await hasRuns(db, repo, ref));
    if (!adoptable)
      return refuse(409, `Tag ${tag} already exists; type a version`);
    created = false;
  }

  const id = crypto.randomUUID();
  const notes =
    opts.notes ??
    (latest
      ? releaseNotes(pulls, {
          compareUrl: compareUrl(
            opts.origin,
            opts.repoFullName,
            latest.tag,
            tag
          ),
        })
      : FIRST_RELEASE_NOTES);
  try {
    await db.batch([
      db.insert(releases).values({
        id,
        repositoryId: repo.id,
        tag,
        ...version,
        commitSha: head,
        title: opts.title?.trim() || tag,
        notes,
        createdById: opts.actor.id,
        previousReleaseId: latest?.id ?? null,
        createdAt: new Date(),
      }),
      // One statement per chunk, all in the same batch, so the release and its pull requests land together.
      ...chunks(rows, PULLS_PER_INSERT).map((part) =>
        db
          .insert(releasePulls)
          .values(part.map((r) => ({ releaseId: id, pullRequestId: r.id })))
      ),
    ]);
  } catch (err) {
    if (!/UNIQUE constraint failed/.test(String(err))) throw err;
    // Another cut took the tag or these pull requests first. A tag this call made for a version no release took is
    // an orphan: take it back while it still points at the head (a tag another cut adopted has that cut's row).
    if (created && !(await releaseRow(db, repo, tag)))
      await git.deleteRef(ref, head).catch((e: unknown) => {
        if (!(e instanceof GitPushError)) throw e;
      });
    return refuse(
      409,
      'Another release was cut at the same time; reload and try again'
    );
  }

  await onRefsUpdated(
    env,
    db,
    repo,
    opts.repoFullName,
    [{ ref, old: ZERO_SHA, new: head }],
    opts.actor.id
  );
  await recordAudit(db, {
    repositoryId: repo.id,
    actorId: opts.actor.id,
    via: opts.actor.via ?? null,
    action: 'release.created',
    target: tag,
    data: { sha: head, pulls: rows.length },
  });
  const release = await getRelease(db, repo, tag);
  return { ok: true, release: release! };
}
