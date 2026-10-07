import { describe, expect, it } from 'vitest';
import { agentFrontMatter } from '../agents/config';
import { decoder } from '../git/bytes';
import { makeBlob, makeCommit, makeTree } from '../git/objects';
import { GitPushError } from '../git/remote';
import type { GitService } from '../git/service';
import {
  branchMoved,
  commitLearned,
  contentsAt,
  LESSON_TRAILER,
  lessonCommitMessage,
  redactPrivate,
} from '../learn/commit';
import {
  changeBytes,
  FRONT_MATTER_CHANGED,
  isLearnablePath,
  isText,
  validateLearned,
} from '../learn/validate';
import { gitForName } from '../lib/repos';
import { makeEnv } from './helpers/app';
import { AGENT_MD } from './helpers/reviews';
import { commitPaths } from './helpers/seed';

const MD = AGENT_MD({ body: 'Look for leaked secrets.' });
const LEARNED = AGENT_MD({
  body: 'Look for leaked secrets.\nTokens in test fixtures are fake: never flag them.',
});
const EDIT = {
  'AGENT.md': LEARNED,
  'knowledge/fixtures.md': 'Fixtures under test/ hold fake tokens.\n',
};

describe('agentFrontMatter', () => {
  it('is the block between the --- lines, exactly as written', () => {
    expect(agentFrontMatter(MD)).toBe(MD.slice(0, MD.indexOf('Look for')));
    expect(agentFrontMatter(`﻿${MD}`)).toBe(
      `﻿${MD.slice(0, MD.indexOf('Look for'))}`
    );
    expect(agentFrontMatter('# No front matter\n')).toBeNull();
  });
});

describe('validateLearned', () => {
  const base = { 'AGENT.md': MD, 'knowledge/fixtures.md': null };

  it('keeps real changes to the instructions and to knowledge/', () => {
    expect(validateLearned(base, EDIT)).toEqual({ ok: true, changes: EDIT });
  });

  it('drops files written back unchanged: nothing to commit', () => {
    expect(validateLearned(base, { 'AGENT.md': MD })).toEqual({
      ok: true,
      changes: {},
    });
  });

  it('refuses any path outside AGENT.md and knowledge/', () => {
    for (const path of [
      'README.md',
      'avatar.png',
      'knowledge',
      'knowledge/',
      'knowledge//x.md',
      'knowledge/../AGENT.md',
      'knowledge/.git/config',
      'knowledge/.GIT/x',
      'knowledge/.git./x',
      'knowledge/.git /x',
      'knowledge/git~1/x',
      'knowledge/Git~2/x',
      'knowledge/.g\u200Cit/x',
      'knowledge/notes\uFEFF.md',
      'knowledge\\..\\README.md',
      'Agent.md',
      'src/knowledge/x.md',
      '/AGENT.md',
    ]) {
      expect(isLearnablePath(path)).toBe(false);
      expect(
        validateLearned({ ...base, [path]: null }, { [path]: 'x' })
      ).toEqual({
        ok: false,
        error: `The edit changed ${path}: only AGENT.md and knowledge/ may change.`,
      });
    }
    expect(isLearnablePath('knowledge/deep/notes.md')).toBe(true);
    expect(isLearnablePath('knowledge/.github/notes.md')).toBe(true);
    expect(isLearnablePath('knowledge/git-tips.md')).toBe(true);
  });

  it('refuses deleting AGENT.md', () => {
    expect(validateLearned(base, { 'AGENT.md': null })).toEqual({
      ok: false,
      error: 'The edit deleted AGENT.md.',
    });
  });

  it('refuses a front matter change, even one that parses the same', () => {
    const renamed = LEARNED.replace('Security Agent', 'Lenient Agent');
    expect(validateLearned(base, { 'AGENT.md': renamed })).toEqual({
      ok: false,
      error: FRONT_MATTER_CHANGED,
    });
    // The same YAML, other bytes: a trailing space, and the name quoted differently.
    for (const md of [
      LEARNED.replace('engine: pass', 'engine: pass '),
      LEARNED.replace('"Security Agent"', "'Security Agent'"),
    ])
      expect(validateLearned(base, { 'AGENT.md': md })).toEqual({
        ok: false,
        error: FRONT_MATTER_CHANGED,
      });
  });

  it('refuses an AGENT.md that no longer parses', () => {
    expect(
      validateLearned(base, { 'AGENT.md': agentFrontMatter(MD)! })
    ).toEqual({
      ok: false,
      error:
        'AGENT.md no longer parses: AGENT.md has no instructions below the frontmatter.',
    });
  });

  it('refuses binary text, oversize files, and edits over 20 KB in all', () => {
    expect(validateLearned(base, { 'knowledge/a.md': 'a\0b' })).toEqual({
      ok: false,
      error: 'knowledge/a.md is not UTF-8 text.',
    });
    expect(validateLearned(base, { 'knowledge/a.md': 'a\uD800b' })).toEqual({
      ok: false,
      error: 'knowledge/a.md is not UTF-8 text.',
    });
    expect(
      validateLearned(base, { 'knowledge/a.md': 'x'.repeat(64 * 1024 + 1) })
    ).toEqual({ ok: false, error: 'knowledge/a.md is larger than 64 KB.' });
    const eleven = `${'y'.repeat(11 * 1024)}\n`;
    expect(
      validateLearned(base, {
        'knowledge/a.md': eleven,
        'knowledge/b.md': eleven,
      })
    ).toEqual({
      ok: false,
      error: 'The edit changes 22,530 bytes; at most 20 KB may change at once.',
    });
  });

  it('refuses changing or deleting an existing file that is not UTF-8 text', () => {
    const binary = { ...base, 'knowledge/logo.bin': '\0PNG' };
    for (const content of ['now text\n', null])
      expect(
        validateLearned(binary, { 'knowledge/logo.bin': content })
      ).toEqual({
        ok: false,
        error:
          'knowledge/logo.bin is not UTF-8 text; the edit may not change it.',
      });
    // Written back unchanged: dropped, not refused.
    expect(validateLearned(binary, { 'knowledge/logo.bin': '\0PNG' })).toEqual({
      ok: true,
      changes: {},
    });
  });

  it('refuses one path inside another: a file and a directory of one name', () => {
    expect(
      validateLearned(base, {
        'knowledge/x': 'flat\n',
        'knowledge/x/y.md': 'deep\n',
      })
    ).toEqual({
      ok: false,
      error:
        'The edit writes knowledge/x both as a file and as a directory (knowledge/x/y.md).',
    });
  });

  it('measures a change by the lines it adds and removes', () => {
    const long = `${'line\n'.repeat(5000)}`;
    expect(changeBytes(long, `${long}one more\n`)).toBe(9);
    expect(changeBytes(null, 'abc\n')).toBe(4);
  });
});

describe('lessonCommitMessage', () => {
  it('is the summary, where it was learned, and one trailer per dismissed finding', () => {
    expect(
      lessonCommitMessage({
        summary: '  Fixtures hold fake tokens.\nSaid so in the instructions.  ',
        number: 7,
        repository: 'octocat/app',
        titles: ['Token logged', 'A "quoted"\ntitle'],
        findingIds: ['f1', 'f2'],
        private: false,
      })
    ).toBe(
      `Fixtures hold fake tokens.\nSaid so in the instructions.\n\nLearned from #7 (octocat/app): dismissed "Token logged", "A "quoted" title"\n\n${LESSON_TRAILER}: f1\n${LESSON_TRAILER}: f2`
    );
  });

  it("from a private repository, redacts the repository, the pull request and the findings from the model's summary", () => {
    expect(
      lessonCommitMessage({
        summary:
          'In octocat/Secret (#7, "Rotate billing keys") the Token Logged finding was wrong; secret-sauce is unrelated.',
        number: 7,
        repository: 'octocat/secret',
        pullTitle: 'Rotate billing keys',
        titles: ['Token logged'],
        findingIds: ['f1'],
        private: true,
      })
    ).toBe(
      `In [private] (#[private], "[private]") the [private] finding was wrong; secret-sauce is unrelated.\n\n${LESSON_TRAILER}: f1`
    );
    expect(redactPrivate('#70 and #7.', [], 7)).toBe('#70 and #[private].');
  });

  it('from a private repository, is only the summary and the trailers', () => {
    expect(
      lessonCommitMessage({
        summary: 'Fixtures hold fake tokens.',
        number: 7,
        repository: 'octocat/secret',
        titles: ['Token logged'],
        findingIds: ['f1', 'f2'],
        private: true,
      })
    ).toBe(
      `Fixtures hold fake tokens.\n\n${LESSON_TRAILER}: f1\n${LESSON_TRAILER}: f2`
    );
  });
});

/** A bare Artifacts repository with an agent's main: AGENT.md and knowledge/README.md. */
async function agentRepository() {
  const t = makeEnv();
  await t.fake.binding.create('r_learn');
  const repo = t.fake.repos.get('r_learn')!;
  const base = await commitPaths(
    repo,
    'main',
    { 'AGENT.md': MD, 'knowledge/README.md': 'Notes.\n' },
    'Create agent'
  );
  return { repo, base, git: () => gitForName(t.env, 'r_learn') };
}

const AUTHOR = {
  name: 'Security Agent',
  email: 'a1@agents.invalid',
  timestamp: 1_700_000_000,
};

async function read(git: GitService, sha: string, path: string) {
  const entry = await git.entryAt(sha, path);
  if (entry?.type !== 'blob') return null;
  return decoder.decode((await git.blob(entry.entry.hash))!);
}

/** A git whose pushes always lose the compare-and-swap. */
function racing(git: GitService) {
  git.client.push = async () => {
    throw new GitPushError('ng refs/heads/main stale info');
  };
  return git;
}

describe('commitLearned', () => {
  it('commits the edit on main with compare-and-swap, as the given author, keeping every other file', async () => {
    const { repo, base, git } = await agentRepository();
    const out = await commitLearned({
      git: git(),
      fresh: git,
      branch: 'main',
      baseSha: base,
      files: EDIT,
      author: AUTHOR,
      message: 'Learned.',
    });
    if (out.status !== 'committed') throw new Error(JSON.stringify(out));
    expect(repo.refs.get('refs/heads/main')).toBe(out.sha);
    const commit = repo.parseCommit(out.sha)!;
    expect(commit.parents).toEqual([base]);
    expect(commit.author).toEqual({ name: AUTHOR.name, email: AUTHOR.email });
    expect(commit.committer).toEqual(commit.author);
    expect(commit.message).toBe('Learned.');
    expect(await read(git(), out.sha, 'AGENT.md')).toBe(LEARNED);
    expect(await read(git(), out.sha, 'knowledge/fixtures.md')).toBe(
      EDIT['knowledge/fixtures.md']
    );
    expect(await read(git(), out.sha, 'knowledge/README.md')).toBe('Notes.\n');
  });

  it('commits nothing for an edit written back unchanged, or one validation refuses', async () => {
    const { repo, base, git } = await agentRepository();
    const opts = {
      git: git(),
      fresh: git,
      branch: 'main',
      baseSha: base,
      author: AUTHOR,
      message: 'x',
    };
    expect(await commitLearned({ ...opts, files: { 'AGENT.md': MD } })).toEqual(
      {
        status: 'nothing',
      }
    );
    expect(
      await commitLearned({ ...opts, files: { 'README.md': 'Hi\n' } })
    ).toEqual({
      status: 'failed',
      error:
        'The edit changed README.md: only AGENT.md and knowledge/ may change.',
    });
    expect(repo.refs.get('refs/heads/main')).toBe(base);
  });

  it('refuses to change a binary file in the repository (no NUL, just not UTF-8)', async () => {
    const { repo, base, git } = await agentRepository();
    const parent = repo.parseCommit(base)!;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    const blob = await makeBlob(bytes);
    const knowledge = (await git().entryAt(base, 'knowledge'))!;
    if (knowledge.type !== 'tree') throw new Error('no knowledge/');
    const sub = await makeTree([
      ...knowledge.entries.map((e) => ({ ...e })),
      { name: 'logo.bin', mode: '100644', hash: blob.sha },
    ]);
    const root = await makeTree([
      ...repo
        .parseTree(parent.treeHash)!
        .filter((e) => e.name !== 'knowledge')
        .map((e) => ({ name: e.name, mode: e.mode, hash: e.hash })),
      { name: 'knowledge', mode: '40000', hash: sub.sha },
    ]);
    const commit = await makeCommit({
      tree: root.sha,
      parents: [base],
      author: AUTHOR,
      message: 'Add a logo',
    });
    for (const o of [blob, sub, root, commit]) repo.add(o);
    repo.refs.set('refs/heads/main', commit.sha);
    const content = (
      await contentsAt(git(), commit.sha, ['knowledge/logo.bin'])
    )['knowledge/logo.bin']!;
    expect(isText(content)).toBe(false);
    expect(
      await commitLearned({
        git: git(),
        fresh: git,
        branch: 'main',
        baseSha: commit.sha,
        files: { 'knowledge/logo.bin': 'A logo.\n' },
        author: AUTHOR,
        message: 'Learned.',
      })
    ).toEqual({
      status: 'failed',
      error:
        'knowledge/logo.bin is not UTF-8 text; the edit may not change it.',
    });
    expect(repo.refs.get('refs/heads/main')).toBe(commit.sha);
  });

  it('keeps a byte-order mark: AGENT.md reads back byte for byte', async () => {
    const { repo, git } = await agentRepository();
    const sha = await commitPaths(
      repo,
      'main',
      { 'AGENT.md': `﻿${MD}` },
      'BOM'
    );
    expect(await contentsAt(git(), sha, ['AGENT.md', 'nope.md'])).toEqual({
      'AGENT.md': `﻿${MD}`,
      'nope.md': null,
    });
  });

  it('retries once from the new tip when main moved without touching the edited files', async () => {
    const { repo, base, git } = await agentRepository();
    const moved = await commitPaths(
      repo,
      'main',
      {
        'AGENT.md': MD,
        'knowledge/README.md': 'Notes.\n',
        'README.md': 'Hi\n',
      },
      'Add a README'
    );
    const out = await commitLearned({
      git: git(),
      fresh: git,
      branch: 'main',
      baseSha: base,
      files: EDIT,
      author: AUTHOR,
      message: 'Learned.',
    });
    if (out.status !== 'committed') throw new Error(JSON.stringify(out));
    expect(repo.parseCommit(out.sha)!.parents).toEqual([moved]);
    expect(await read(git(), out.sha, 'README.md')).toBe('Hi\n');
    expect(await read(git(), out.sha, 'AGENT.md')).toBe(LEARNED);
  });

  it('fails, committing nothing, when main changed an edited file meanwhile', async () => {
    const { repo, base, git } = await agentRepository();
    const theirs = AGENT_MD({ body: 'Look for leaked secrets and keys.' });
    const moved = await commitPaths(
      repo,
      'main',
      { 'AGENT.md': theirs, 'knowledge/README.md': 'Notes.\n' },
      'A person edits the agent'
    );
    expect(
      await commitLearned({
        git: git(),
        fresh: git,
        branch: 'main',
        baseSha: base,
        files: EDIT,
        author: AUTHOR,
        message: 'Learned.',
      })
    ).toEqual({
      status: 'failed',
      error:
        'AGENT.md changed on main while the agent was learning; nothing was committed.',
    });
    expect(repo.refs.get('refs/heads/main')).toBe(moved);
  });

  it('refuses a file over a directory: the subtree is never dropped unchecked', async () => {
    const { repo, git } = await agentRepository();
    const base = await commitPaths(
      repo,
      'main',
      {
        'AGENT.md': MD,
        'knowledge/README.md': 'Notes.\n',
        'knowledge/x/notes.md': 'Kept.\n',
      },
      'Notes in a directory'
    );
    expect(
      await commitLearned({
        git: git(),
        fresh: git,
        branch: 'main',
        baseSha: base,
        files: { 'knowledge/x': 'flat\n' },
        author: AUTHOR,
        message: 'Learned.',
      })
    ).toEqual({
      status: 'failed',
      error:
        "knowledge/x is a directory, so the edit can't write it as a file; nothing was committed.",
    });
    expect(repo.refs.get('refs/heads/main')).toBe(base);
  });

  it('refuses a directory over a file', async () => {
    const { repo, base, git } = await agentRepository();
    expect(
      await commitLearned({
        git: git(),
        fresh: git,
        branch: 'main',
        baseSha: base,
        files: { 'knowledge/README.md/y.md': 'deep\n' },
        author: AUTHOR,
        message: 'Learned.',
      })
    ).toEqual({
      status: 'failed',
      error:
        "knowledge/README.md is a file, so the edit can't write knowledge/README.md/y.md; nothing was committed.",
    });
    expect(repo.refs.get('refs/heads/main')).toBe(base);
  });

  it('refuses an edit writing one path as both a file and a directory', async () => {
    const { repo, base, git } = await agentRepository();
    expect(
      await commitLearned({
        git: git(),
        fresh: git,
        branch: 'main',
        baseSha: base,
        files: { 'knowledge/x': 'flat\n', 'knowledge/x/y.md': 'deep\n' },
        author: AUTHOR,
        message: 'Learned.',
      })
    ).toEqual({
      status: 'failed',
      error:
        'The edit writes knowledge/x both as a file and as a directory (knowledge/x/y.md).',
    });
    expect(repo.refs.get('refs/heads/main')).toBe(base);
  });

  it("fails, keeping the person's notes, when main made the written path a directory meanwhile", async () => {
    const { repo, base, git } = await agentRepository();
    const moved = await commitPaths(
      repo,
      'main',
      {
        'AGENT.md': MD,
        'knowledge/README.md': 'Notes.\n',
        'knowledge/x/notes.md': 'A person wrote this.\n',
      },
      'A person adds notes'
    );
    expect(
      await commitLearned({
        git: git(),
        fresh: git,
        branch: 'main',
        baseSha: base,
        files: { 'knowledge/x': 'flat\n' },
        author: AUTHOR,
        message: 'Learned.',
      })
    ).toEqual({
      status: 'failed',
      error:
        "knowledge/x is a directory, so the edit can't write it as a file; nothing was committed.",
    });
    expect(repo.refs.get('refs/heads/main')).toBe(moved);
    expect(await read(git(), moved, 'knowledge/x/notes.md')).toBe(
      'A person wrote this.\n'
    );
  });

  it('fails when main keeps moving: the compare-and-swap lost twice', async () => {
    const { repo, base, git } = await agentRepository();
    expect(
      await commitLearned({
        git: racing(git()),
        fresh: () => racing(git()),
        branch: 'main',
        baseSha: base,
        files: EDIT,
        author: AUTHOR,
        message: 'Learned.',
      })
    ).toEqual({ status: 'failed', error: branchMoved('main') });
    expect(repo.refs.get('refs/heads/main')).toBe(base);
  });
});

describe('GitService.commitFiles', () => {
  it('writes nested paths, keeps siblings, deletes with null, and drops emptied directories', async () => {
    const { repo, base, git } = await agentRepository();
    const sha = await git().commitFiles({
      branch: 'main',
      parent: base,
      files: {
        'knowledge/README.md': null,
        'knowledge/a/b/c.md': 'deep\n',
        'AGENT.md': LEARNED,
      },
      author: AUTHOR,
      message: 'Edit',
    });
    expect(repo.refs.get('refs/heads/main')).toBe(sha);
    expect(await read(git(), sha, 'knowledge/README.md')).toBeNull();
    expect(await read(git(), sha, 'knowledge/a/b/c.md')).toBe('deep\n');
    const gone = await git().commitFiles({
      branch: 'main',
      parent: sha,
      files: { 'knowledge/a/b/c.md': null },
      author: AUTHOR,
      message: 'Empty',
    });
    expect(await git().entryAt(gone, 'knowledge')).toBeNull();
    await expect(
      git().commitFiles({
        branch: 'main',
        parent: base,
        files: { 'AGENT.md': MD },
        author: AUTHOR,
        message: 'Stale',
      })
    ).rejects.toBeInstanceOf(GitPushError);
  });

  it('never swaps a directory for a file or back', async () => {
    const { base, git } = await agentRepository();
    const cases: Record<string, string | null>[] = [
      { knowledge: 'flat\n' },
      { knowledge: null },
      { 'AGENT.md/x': 'deep\n' },
      { 'knowledge/a': 'flat\n', 'knowledge/a/b': 'deep\n' },
      { 'knowledge/a/b': 'deep\n', 'knowledge/a': 'flat\n' },
    ];
    for (const files of cases)
      await expect(
        git().commitFiles({
          branch: 'main',
          parent: base,
          files,
          author: AUTHOR,
          message: 'Bad',
        })
      ).rejects.toThrow(/is a (file|directory)|both as a file and a directory/);
  });
});
