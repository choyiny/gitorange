import { describe, expect, it } from 'vitest';
import { squashCredits } from '../merge/land';

const me = { name: 'Cho Yin Yong', email: 'choyiny@users.noreply.github.com' };
const claude = {
  name: 'Claude Opus 5.5 (1M context)',
  email: 'noreply@anthropic.com',
};
const account = { name: 'Cho Yin Yong', email: 'choyin@xyspace.dev' };

describe('squash credits', () => {
  it('credits the main commit author and keeps every co-author', () => {
    const credits = squashCredits(
      [
        {
          author: me,
          message:
            'One\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>',
        },
        { author: { name: 'Ada', email: 'ada@example.com' }, message: 'Two' },
        {
          author: { ...me, email: 'ChoYiny@Users.Noreply.GitHub.com' },
          message:
            'Three\n\nco-authored-by: Ada L <ADA@example.com>\nCo-authored-by: Bob <bob@example.com>',
        },
      ],
      account
    );
    expect(credits.author).toEqual(me);
    expect(credits.coAuthors).toEqual([
      claude,
      { name: 'Ada', email: 'ada@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ]);
  });

  it('falls back to the merging account when the commits are unknown', () => {
    expect(squashCredits([], account)).toEqual({
      author: account,
      coAuthors: [],
    });
  });

  it('breaks ties by the earliest commit', () => {
    const ada = { name: 'Ada', email: 'ada@example.com' };
    expect(
      squashCredits(
        [
          { author: ada, message: '' },
          { author: me, message: '' },
        ],
        account
      ).author
    ).toEqual(ada);
  });
});
