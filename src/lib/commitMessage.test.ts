import { describe, expect, it } from 'vitest';
import {
  agentIdOfEmail,
  coAuthors,
  isAgentEmail,
  parseCommitMessage,
} from './commitMessage';

describe('parseCommitMessage', () => {
  it('splits a one-line message', () => {
    expect(parseCommitMessage('Fix the thing')).toEqual({
      subject: 'Fix the thing',
      body: '',
      trailers: [],
    });
  });

  it('keeps the body and finds no trailers in ordinary prose', () => {
    const m = parseCommitMessage(
      'Add caching\n\nReads were slow.\nNow they are fast.\n'
    );
    expect(m.subject).toBe('Add caching');
    expect(m.body).toBe('Reads were slow.\nNow they are fast.');
    expect(m.trailers).toEqual([]);
  });

  it('takes the last paragraph as trailers when every line is one', () => {
    const m = parseCommitMessage(
      'Learn from #67\n\nLearned from #67 (a/b): dismissed "x"\n\nDismissed-Finding: abc123\nDismissed-Finding: def456\n'
    );
    expect(m.subject).toBe('Learn from #67');
    expect(m.body).toBe('Learned from #67 (a/b): dismissed "x"');
    expect(m.trailers).toEqual([
      { key: 'Dismissed-Finding', value: 'abc123' },
      { key: 'Dismissed-Finding', value: 'def456' },
    ]);
  });

  it('reads trailers straight after the subject', () => {
    const m = parseCommitMessage(
      'Summary\n\nDismissed-Finding: f1\nDismissed-Finding: f2'
    );
    expect(m.body).toBe('');
    expect(m.trailers.map((t) => t.value)).toEqual(['f1', 'f2']);
  });

  it('does not treat the subject or a mixed last paragraph as trailers', () => {
    expect(parseCommitMessage('Fixes: the build').trailers).toEqual([]);
    const mixed = parseCommitMessage(
      'Subject\n\nSee the docs.\nCo-Authored-By: A <a@x.y>'
    );
    expect(mixed.trailers).toEqual([]);
    expect(mixed.body).toBe('See the docs.\nCo-Authored-By: A <a@x.y>');
  });

  it('needs a space after the colon, so URLs are not trailers', () => {
    const m = parseCommitMessage('Subject\n\nhttps://example.com/x');
    expect(m.trailers).toEqual([]);
    expect(m.body).toBe('https://example.com/x');
  });

  it('joins indented continuation lines to the trailer before them', () => {
    const m = parseCommitMessage(
      'Subject\n\nBody.\n\nSigned-off-by: A <a@x.y>\nNote: one\n  two'
    );
    expect(m.trailers).toEqual([
      { key: 'Signed-off-by', value: 'A <a@x.y>' },
      { key: 'Note', value: 'one two' },
    ]);
  });

  it('handles Windows line endings and trailing blank lines', () => {
    const m = parseCommitMessage(
      'S\r\n\r\nBody\r\n\r\nCo-Authored-By: C <c@x.y>\r\n\r\n'
    );
    expect(m.subject).toBe('S');
    expect(m.body).toBe('Body');
    expect(m.trailers).toEqual([{ key: 'Co-Authored-By', value: 'C <c@x.y>' }]);
  });
});

describe('coAuthors', () => {
  it('reads Co-Authored-By trailers in any case', () => {
    expect(
      coAuthors([
        {
          key: 'Co-Authored-By',
          value: 'Claude Opus 5.5 <noreply@anthropic.com>',
        },
        { key: 'co-authored-by', value: 'Sam' },
        { key: 'Reviewed-by', value: 'Z <z@x.y>' },
      ])
    ).toEqual([
      { name: 'Claude Opus 5.5', email: 'noreply@anthropic.com' },
      { name: 'Sam', email: null },
    ]);
  });
});

describe('agent identities', () => {
  it('recognises an agent account email', () => {
    expect(isAgentEmail('u_123@agents.invalid')).toBe(true);
    expect(isAgentEmail(' U_123@Agents.Invalid ')).toBe(true);
    expect(isAgentEmail('a@example.com')).toBe(false);
    expect(isAgentEmail('a@agents.invalid.example.com')).toBe(false);
  });

  it('returns the account id inside it', () => {
    expect(agentIdOfEmail('u_123@agents.invalid')).toBe('u_123');
    expect(agentIdOfEmail('a@example.com')).toBeNull();
  });
});
