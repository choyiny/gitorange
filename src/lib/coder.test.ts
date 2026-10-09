import { describe, expect, it } from 'vitest';
import { coderOf } from './coder';

describe('coderOf', () => {
  it('names a Claude Code session by its short name and label', () => {
    expect(coderOf('Claude Code', 's4')).toEqual({
      kind: 'claude',
      mono: 'C',
      name: 'Claude',
      label: 'Claude·s4',
      title: 'Claude Code session s4',
    });
  });

  it('gives Codex its own monogram', () => {
    expect(coderOf('Codex', 's5')).toMatchObject({
      kind: 'codex',
      mono: 'X',
      name: 'Codex',
      label: 'Codex·s5',
    });
  });

  it('matches the app name without caring about case or what follows', () => {
    expect(coderOf('claude desktop', 's1').kind).toBe('claude');
    expect(coderOf('CODEX CLI', null).kind).toBe('codex');
  });

  it('keeps another app by its first word with its initial', () => {
    expect(coderOf('Cursor Agent', 's9')).toMatchObject({
      kind: 'other',
      mono: 'C',
      name: 'Cursor',
      label: 'Cursor·s9',
      title: 'Cursor Agent session s9',
    });
  });

  it('shows the app alone when it reported no session label', () => {
    expect(coderOf('Claude Code', null)).toMatchObject({
      label: 'Claude',
      title: 'Claude Code',
    });
    expect(coderOf('Claude Code', '   ').label).toBe('Claude');
  });

  it('treats no app as a pull request opened by hand', () => {
    expect(coderOf(null, null)).toEqual({
      kind: 'person',
      mono: '',
      name: 'By hand',
      label: 'by hand',
      title: 'Opened by hand',
    });
    expect(coderOf('', 's4').kind).toBe('person');
    expect(coderOf(undefined, undefined).kind).toBe('person');
  });

  it('shortens a very long app name', () => {
    const c = coderOf('A'.repeat(40) + ' Agent', 's1');
    expect(c.name.length).toBeLessThanOrEqual(14);
    expect(c.name.endsWith('…')).toBe(true);
  });
});
