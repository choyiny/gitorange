/**
 * The coding agent (or person) that opened a pull request, as the crew pages draw it: a monogram tile and a short
 * label such as "Claude·s4". Coding agents write the code and are never drawn as the reviewer robots.
 */
export type CoderKind = 'claude' | 'codex' | 'other' | 'person';

export interface Coder {
  kind: CoderKind;
  /** The letter in the tile (empty for a person, who gets an icon). */
  mono: string;
  /** "Claude", "Codex", the app's first word, or "By hand". */
  name: string;
  /** What the chip reads: "Claude·s4", "Codex", "by hand". */
  label: string;
  /** The longer wording for a tooltip: "Claude Code session s4". */
  title: string;
}

const NAME_MAX = 14;

const short = (word: string) =>
  word.length > NAME_MAX ? `${word.slice(0, NAME_MAX - 1)}…` : word;

/**
 * Who opened a pull request. `createdVia` is the app's self-reported name over MCP ("Claude Code", "Codex"); null
 * means it was opened by hand. `sessionLabel` is the label the app gave the session ("s4").
 */
export function coderOf(
  createdVia: string | null | undefined,
  sessionLabel: string | null | undefined
): Coder {
  const via = (createdVia ?? '').trim();
  if (!via)
    return {
      kind: 'person',
      mono: '',
      name: 'By hand',
      label: 'by hand',
      title: 'Opened by hand',
    };
  const session = (sessionLabel ?? '').trim();
  const first = via.split(/\s+/)[0];
  const kind: CoderKind = /^claude/i.test(first)
    ? 'claude'
    : /^codex/i.test(first)
      ? 'codex'
      : 'other';
  const name =
    kind === 'claude' ? 'Claude' : kind === 'codex' ? 'Codex' : short(first);
  const mono =
    kind === 'claude' ? 'C' : kind === 'codex' ? 'X' : first[0].toUpperCase();
  return {
    kind,
    mono,
    name,
    label: session ? `${name}·${session}` : name,
    title: session ? `${via} session ${session}` : via,
  };
}
