import { describe, expect, it } from 'vitest';
import { commitFiles } from './helpers/seed';
import { settle } from './helpers/app';
import {
  detail,
  divergedPull,
  fakeResolver,
  moved,
  NOTES,
  rows,
  runRebases,
} from './helpers/rebase';
import { events } from './helpers/stacking';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { claimResolution, MODEL_UNREACHABLE } from '../merge/commit-resolution';
import { MAX_AI_COMMITS, stopMessage } from '../merge/rebase';
import { RESOLVED_TRAILER } from '../git/rebase';
import { decoder } from '../git/bytes';

const RESOLVED = NOTES.replace('three', 'THREE (main), and a half');

/** A file at a commit of the fake repo. */
function fileAt(
  repo: Awaited<ReturnType<typeof divergedPull>>['repo'],
  commit: string,
  path: string
) {
  const tree = repo.parseTree(repo.parseCommit(commit)!.treeHash)!;
  const e = tree.find((x) => x.name === path);
  return e ? decoder.decode(repo.objects.get(e.hash)!.data) : null;
}

describe('AI resolution of a conflicting commit', () => {
  it('resolves the commit, which keeps its author and message and gets the trailer, then goes on', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const { resolver, requests } = fakeResolver(() => ({
      files: { 'notes.txt': RESOLVED },
    }));
    await runRebases(t, { resolver });
    const head = repo.refs.get('refs/heads/feature')!;
    const c = repo.parseCommit(head)!;
    expect(c.message).toBe(`Elaborate on three\n\n${RESOLVED_TRAILER}`);
    expect(c.author).toEqual({ name: 'Dev', email: 'dev@example.com' });
    expect(fileAt(repo, head, 'notes.txt')).toBe(RESOLVED);
    expect(repo.parseCommit(c.parents[0])!.message).toBe('Add b');
    // One request: the commit's conflicted file, its message and diff, the PR's title and description.
    expect(requests).toHaveLength(1);
    const { request } = requests[0];
    expect(request.labels).toEqual({ ours: 'main', theirs: f2.slice(0, 7) });
    expect(request.files['notes.txt']).toContain('<<<<<<< main');
    expect(request.theirsIntent).toContain('Pull request #1: Elaborate');
    expect(request.theirsIntent).toContain('Line three needs more detail.');
    expect(request.theirsIntent).toContain('Elaborate on three');
    expect(request.theirsIntent).toContain('+three, and a half');
    expect(request.oursIntent).toContain('Main moves');
    const [row] = await rows(t);
    expect(row).toMatchObject({ commit: f2, status: 'applied', result: head });
    expect(row.model).not.toBe('none');
    expect(JSON.parse(row.files!)).toEqual({ 'notes.txt': RESOLVED });
    expect(await events(t, 1)).toContainEqual(
      expect.objectContaining({
        kind: 'rebased',
        data: expect.objectContaining({ resolved: 1 }),
      })
    );
    expect((await detail(t, admin)).rebase!.status).toBe('up_to_date');
  });

  it('resolves several conflicting commits, one resolution each', async () => {
    const { t, repo, root } = await divergedPull();
    // Rewrite feature: two commits, each conflicting with main on its own line.
    repo.refs.set('refs/heads/feature', root);
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'notes.txt': NOTES.replace('one', 'one, first') },
      'First'
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      {
        'notes.txt': NOTES.replace('one', 'one, first').replace(
          'five',
          'five, second'
        ),
      },
      'Second'
    );
    const old = repo.refs.get('refs/heads/main')!;
    await commitFiles(
      repo,
      'main',
      {
        'notes.txt': NOTES.replace('one', 'ONE (main)').replace(
          'five',
          'FIVE (main)'
        ),
        'other.txt': 'x\n',
      },
      'Shout one and five'
    );
    const first = NOTES.replace('one', 'ONE (main), first').replace(
      'five',
      'FIVE (main)'
    );
    const second = NOTES.replace('one', 'ONE (main), first').replace(
      'five',
      'FIVE (main), second'
    );
    await moved(t, 'main', old);
    const { resolver, requests } = fakeResolver((req) => ({
      files: {
        'notes.txt': req.labels.theirs === f1.slice(0, 7) ? first : second,
      },
    }));
    await runRebases(t, { resolver });
    expect(requests.map((r) => r.request.labels.theirs)).toEqual([
      f1.slice(0, 7),
      f2.slice(0, 7),
    ]);
    const head = repo.refs.get('refs/heads/feature')!;
    expect(fileAt(repo, head, 'notes.txt')).toBe(second);
    const c = repo.parseCommit(head)!;
    expect([repo.parseCommit(c.parents[0])!.message, c.message]).toEqual([
      `First\n\n${RESOLVED_TRAILER}`,
      `Second\n\n${RESOLVED_TRAILER}`,
    ]);
    expect((await rows(t)).map((r) => [r.commit, r.status])).toEqual([
      [f1, 'applied'],
      [f2, 'applied'],
    ]);
  });

  it('shows rebase_conflict when the AI fails, and leaves the branch for the agent', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const { resolver } = fakeResolver(() => ({
      status: 'unanswered',
      reason: 'gave up',
    }));
    await runRebases(t, { resolver });
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    const [row] = await rows(t);
    expect(row).toMatchObject({
      commit: f2,
      status: 'failed',
      error: "The model didn't finish (gave up).",
    });
    const d = await detail(t, admin);
    expect(d.pullState!.reasons).toContainEqual({
      kind: 'rebase_conflict',
      commit: f2,
      files: ['notes.txt'],
      error: "The model didn't finish (gave up).",
    });
  });

  it('fails a resolution that still has conflict markers', async () => {
    const { t, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const { resolver } = fakeResolver((req) => ({
      files: { 'notes.txt': req.files['notes.txt'] },
    }));
    await runRebases(t, { resolver });
    expect((await rows(t))[0]).toMatchObject({
      status: 'failed',
      error: 'notes.txt still has conflict markers.',
    });
  });

  it('records a model that can’t be reached as a failed resolution', async () => {
    const { t, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    await runRebases(t, {
      resolver: () => ({
        resolve: async () => {
          throw new Error('AI down');
        },
      }),
    });
    expect((await rows(t))[0]).toMatchObject({
      status: 'failed',
      error: MODEL_UNREACHABLE,
    });
  });

  it('never asks the model about a binary conflict', async () => {
    const { t, repo, root } = await divergedPull();
    const old = repo.refs.get('refs/heads/main')!;
    repo.refs.set('refs/heads/feature', root);
    const f = await commitFiles(
      repo,
      'feature',
      { 'notes.txt': NOTES, 'logo.bin': 'a\u0000feature' },
      'Logo'
    );
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'other.txt': 'x\n', 'logo.bin': 'a\u0000main' },
      'Logo too'
    );
    await moved(t, 'main', old);
    const { resolver, requests } = fakeResolver();
    await runRebases(t, { resolver });
    expect(requests).toEqual([]);
    expect((await rows(t))[0]).toMatchObject({
      commit: f,
      model: 'none',
      error: `Commit ${f.slice(0, 7)} conflicts in logo.bin: binary files, or a file deleted on one side and changed on the other. Rebase locally.`,
    });
  });

  it('never asks the model about generated files', async () => {
    const { t, repo, root } = await divergedPull();
    const old = repo.refs.get('refs/heads/main')!;
    repo.refs.set('refs/heads/feature', root);
    await commitFiles(
      repo,
      'feature',
      { 'notes.txt': NOTES, 'yarn.lock': 'a 1\n' },
      'Lock'
    );
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'other.txt': 'x\n', 'yarn.lock': 'a 2\n' },
      'Lock too'
    );
    await moved(t, 'main', old);
    const { resolver, requests } = fakeResolver();
    await runRebases(t, { resolver });
    expect(requests).toEqual([]);
    expect((await rows(t))[0].error).toMatch(
      /conflicts in generated files \(yarn\.lock\)/
    );
  });

  it(`stops after ${MAX_AI_COMMITS} commits resolved by AI in one run`, async () => {
    const { t, repo, root } = await divergedPull();
    const n = MAX_AI_COMMITS + 1;
    const line = (j: number, tag: string) => `l${j}${tag}`;
    const file = (f: (j: number) => string) =>
      Array.from({ length: n }, (_, j) => f(j)).join('\n') + '\n';
    // Each feature commit changes one more line; main changed every line.
    repo.refs.set('refs/heads/main', root);
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'n.txt': file((j) => line(j, '')) },
      'Lines'
    );
    const base = repo.refs.get('refs/heads/main')!;
    repo.refs.set('refs/heads/feature', base);
    const shas: string[] = [];
    for (let i = 0; i < n; i++)
      shas.push(
        await commitFiles(
          repo,
          'feature',
          {
            'notes.txt': NOTES,
            'n.txt': file((j) => line(j, j <= i ? ' f' : '')),
          },
          `#${i}`
        )
      );
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'n.txt': file((j) => line(j, ' main')) },
      'Main lines'
    );
    await moved(t, 'main', base);
    const index = new Map(shas.map((s, i) => [s.slice(0, 7), i]));
    const { resolver, requests } = fakeResolver((req) => {
      const i = index.get(req.labels.theirs)!;
      return {
        files: { 'n.txt': file((j) => line(j, j <= i ? ' main f' : ' main')) },
      };
    });
    await runRebases(t, { resolver });
    expect(requests).toHaveLength(MAX_AI_COMMITS);
    const last = (await rows(t)).at(-1)!;
    expect(last).toMatchObject({ commit: shas[MAX_AI_COMMITS], model: 'none' });
    expect(last.error).toMatch(/AI already resolved 20 commits of this rebase/);
  });
  it('turns an AI claim left running by a dead run into the stop of a run without AI', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const pr = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 1'
    ).first<{ id: string }>())!.id;
    const tips = {
      onto: repo.refs.get('refs/heads/main')!,
      ontoBranch: 'main',
      head: f2,
    };
    await claimResolution(t.env, drizzle(t.env.DB, { schema }), pr, tips, {
      commit: f2,
      paths: ['notes.txt'],
    });
    await runRebases(t); // no resolver
    const all = await rows(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      commit: f2,
      status: 'failed',
      model: 'none',
      error: stopMessage.noAi(f2, ['notes.txt']),
    });
    expect((await detail(t, admin)).pullState!.reasons).toContainEqual(
      expect.objectContaining({ kind: 'rebase_conflict', commit: f2 })
    );
  });

  it('never asks again about a commit AI failed at these tips, and keeps that failure', async () => {
    const { t, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    await runRebases(t, {
      resolver: fakeResolver(() => ({
        status: 'unanswered',
        reason: 'gave up',
      })).resolver,
    });
    const [before] = await rows(t);
    const pr = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 1'
    ).first<{ id: string }>())!.id;
    await t.env.MERGE_RESOLUTION.create({
      id: 'rebase-again',
      params: { rebase: { pullRequestId: pr } },
    });
    const { resolver, requests } = fakeResolver();
    await runRebases(t, { resolver });
    expect(requests).toEqual([]);
    expect(await rows(t)).toEqual([before]);
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
  });

  it('reuses the applied resolution when the agent force-pushes the old head', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const { resolver, requests } = fakeResolver(() => ({
      files: { 'notes.txt': RESOLVED },
    }));
    await runRebases(t, { resolver });
    const first = repo.refs.get('refs/heads/feature')!;
    repo.refs.set('refs/heads/feature', f2); // git push --force of the old head
    expect((await detail(t, admin)).rebase!.status).toBe('behind'); // the page starts a rebase
    await runRebases(t, { resolver });
    expect(requests).toHaveLength(1);
    const again = repo.refs.get('refs/heads/feature')!;
    expect(again).not.toBe(f2);
    expect(repo.parseCommit(again)!.message).toBe(
      `Elaborate on three\n\n${RESOLVED_TRAILER}`
    );
    expect(fileAt(repo, again, 'notes.txt')).toBe(RESOLVED);
    expect(first).not.toBe(f2);
  });
  it('shows the AI failure again when the agent pushes back the head it was for, and queues no more runs', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const failing = fakeResolver(() => ({
      status: 'unanswered',
      reason: 'gave up',
    }));
    await runRebases(t, { resolver: failing.resolver }); // T1: AI fails at f2
    // The agent pushes another commit (T2): AI fails there too, a newer row.
    const h2 = await commitFiles(
      repo,
      'feature',
      {
        'notes.txt': NOTES.replace('three', 'three, and a half').replace(
          'five',
          'five!'
        ),
        'b.txt': 'b\n',
      },
      'Shout five'
    );
    await moved(t, 'feature', f2);
    await runRebases(t, { resolver: failing.resolver });
    expect((await rows(t)).map((r) => r.head)).toEqual([f2, h2]);
    // A while later (created_at has whole seconds): back to T1, git push --force of the old head.
    await t.env.DB.prepare(
      'UPDATE merge_resolutions SET created_at = created_at - 60, decided_at = decided_at - 60'
    ).run();
    repo.refs.set('refs/heads/feature', f2);
    await moved(t, 'feature', h2);
    const { resolver, requests } = fakeResolver();
    await runRebases(t, { resolver });
    expect(requests).toEqual([]);
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    const d = await detail(t, admin);
    expect(d.rebase!.status).toBe('conflict');
    expect(d.pullState!.reasons).toContainEqual({
      kind: 'rebase_conflict',
      commit: f2,
      files: ['notes.txt'],
      error: "The model didn't finish (gave up).",
    });
    // The page shows the stop: it starts no more rebases.
    const queued = () =>
      t.actions.resolutions.filter(
        (r) => (r.params as { rebase?: unknown }).rebase
      ).length;
    const before = queued();
    await detail(t, admin);
    await settle(t);
    expect(queued()).toBe(before);
    expect(await runRebases(t, { resolver })).toBe(0);
  });
});
