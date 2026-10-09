import { describe, expect, it } from 'vitest';
import {
  RECENT_MAX,
  addRecent,
  parseRecent,
  readRecent,
  recentKey,
  removeRecent,
  writeRecent,
  type RecentRepo,
} from './recentRepos';

const repo = (fullName: string, agent?: RecentRepo['agent']): RecentRepo =>
  agent ? { fullName, agent } : { fullName };

/** A Storage stand-in: the tests run in workerd, which has no localStorage. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

const throwing = {
  getItem(): string | null {
    throw new Error('SecurityError: storage is blocked');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

describe('addRecent', () => {
  it('puts the latest visit first', () => {
    const list = addRecent(addRecent([], repo('a/one')), repo('a/two'));
    expect(list.map((r) => r.fullName)).toEqual(['a/two', 'a/one']);
  });

  it('dedupes: a revisit moves the repository to the front and keeps one entry', () => {
    let list: RecentRepo[] = [];
    for (const name of ['a/one', 'a/two', 'a/three', 'A/One'])
      list = addRecent(list, repo(name));
    expect(list.map((r) => r.fullName)).toEqual(['A/One', 'a/three', 'a/two']);
  });

  it('takes the newer details on a revisit (an agent repository learned later)', () => {
    const list = addRecent(
      [repo('dataagent/dataagent')],
      repo('dataagent/dataagent', { handle: 'dataagent', color: '#199e70' })
    );
    expect(list).toEqual([
      {
        fullName: 'dataagent/dataagent',
        agent: { handle: 'dataagent', color: '#199e70' },
      },
    ]);
  });

  it(`keeps at most ${RECENT_MAX}, dropping the oldest`, () => {
    let list: RecentRepo[] = [];
    for (let i = 1; i <= 7; i++) list = addRecent(list, repo(`o/r${i}`));
    expect(RECENT_MAX).toBe(5);
    expect(list.map((r) => r.fullName)).toEqual([
      'o/r7',
      'o/r6',
      'o/r5',
      'o/r4',
      'o/r3',
    ]);
  });

  it('never changes the list it was given', () => {
    const before = [repo('a/one')];
    addRecent(before, repo('a/two'));
    expect(before).toEqual([repo('a/one')]);
  });
});

describe('removeRecent', () => {
  it('forgets a repository (deleted or renamed), whatever its case', () => {
    expect(
      removeRecent([repo('a/one'), repo('a/two')], 'A/ONE').map(
        (r) => r.fullName
      )
    ).toEqual(['a/two']);
  });
});

describe('parseRecent', () => {
  it('reads back what was written', () => {
    const list = [
      repo('choyiny/gitorange'),
      repo('dataagent/dataagent', { handle: 'dataagent', color: null }),
    ];
    expect(parseRecent(JSON.stringify(list))).toEqual(list);
  });

  it('survives bad JSON and anything that is not a list', () => {
    for (const raw of [null, '', '{', 'null', '42', '"a/b"', '{"a":1}'])
      expect(parseRecent(raw)).toEqual([]);
  });

  it('skips malformed entries and keeps the good ones', () => {
    const raw = JSON.stringify([
      1,
      null,
      { fullName: 3 },
      { fullName: 'no-slash' },
      { fullName: 'too/many/parts' },
      { fullName: 'a/ok', agent: 'nope' },
      { fullName: 'b/ok', agent: { handle: 'b', color: 7 } },
    ]);
    expect(parseRecent(raw)).toEqual([
      { fullName: 'a/ok' },
      { fullName: 'b/ok', agent: { handle: 'b', color: null } },
    ]);
  });

  it(`dedupes and caps at ${RECENT_MAX} even when storage holds more`, () => {
    const names = ['a/1', 'a/2', 'A/1', 'a/3', 'a/4', 'a/5', 'a/6', 'a/7'];
    expect(
      parseRecent(JSON.stringify(names.map((n) => repo(n)))).map(
        (r) => r.fullName
      )
    ).toEqual(['a/1', 'a/2', 'a/3', 'a/4', 'a/5']);
  });
});

describe('storage', () => {
  it('keeps one list per person', () => {
    expect(recentKey('u1')).not.toBe(recentKey('u2'));
    expect(recentKey('u1').startsWith('go-')).toBe(true);
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    writeRecent(storage, 'k', [repo('a/one')]);
    expect(readRecent(storage, 'k')).toEqual([repo('a/one')]);
  });

  it('reads an empty list when storage is missing, blocked or holds junk', () => {
    expect(readRecent(null, 'k')).toEqual([]);
    expect(readRecent(throwing, 'k')).toEqual([]);
    expect(readRecent(memoryStorage({ k: '[{' }), 'k')).toEqual([]);
  });

  it('never throws when writing fails', () => {
    expect(() => writeRecent(throwing, 'k', [repo('a/one')])).not.toThrow();
    expect(() => writeRecent(null, 'k', [repo('a/one')])).not.toThrow();
  });
});
