/** A commit message split the way a person reads it: the subject, the prose, and the trailers at the end. */
export interface Trailer {
  key: string;
  value: string;
}

export interface ParsedMessage {
  subject: string;
  /** The prose between the subject and the trailers (trimmed; empty when there is none). */
  body: string;
  trailers: Trailer[];
}

// `Key: value`, as git writes them. The space after the colon keeps a pasted URL from reading as one.
const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):[ \t]+(\S.*)$/;

/** Reads a block of lines as trailers (continuation lines start with a space), or null if any line is not one. */
function readTrailers(lines: string[]): Trailer[] | null {
  const out: Trailer[] = [];
  for (const line of lines) {
    const m = TRAILER.exec(line);
    if (m) out.push({ key: m[1], value: m[2].trim() });
    else if (/^[ \t]+\S/.test(line) && out.length)
      out[out.length - 1].value += ` ${line.trim()}`;
    else return null;
  }
  return out.length ? out : null;
}

/**
 * Splits a commit message into subject, body and trailers. Trailers are git's: the last paragraph, when it is not
 * the subject's own and every line in it is `Key: value`. Reviewer agents write `Dismissed-Finding: <id>` this way,
 * and coding agents add `Co-Authored-By:`. Anything else stays in the body.
 */
export function parseCommitMessage(message: string): ParsedMessage {
  const text = message.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const lines = text.split('\n');
  let lastBlank = lines.length - 1;
  while (lastBlank >= 0 && lines[lastBlank].trim() !== '') lastBlank--;
  // lastBlank < 1: no paragraph after the subject's own, so nothing can be a trailer block.
  const trailers =
    lastBlank >= 1 ? readTrailers(lines.slice(lastBlank + 1)) : null;
  const bodyEnd = trailers ? lastBlank : lines.length;
  return {
    subject: lines[0] ?? '',
    body: lines.slice(1, bodyEnd).join('\n').trim(),
    trailers: trailers ?? [],
  };
}

export interface CoAuthor {
  name: string;
  email: string | null;
}

/** The people named in `Co-Authored-By` trailers. */
export function coAuthors(trailers: Trailer[]): CoAuthor[] {
  return trailers
    .filter((t) => t.key.toLowerCase() === 'co-authored-by')
    .map((t) => {
      const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(t.value);
      return m
        ? { name: m[1] || m[2], email: m[2] || null }
        : { name: t.value, email: null };
    });
}

const AGENT_EMAIL = /^([^@\s]+)@agents\.invalid$/i;

/**
 * Whether a commit identity is a reviewer agent's. Every agent account's email is `<account id>@agents.invalid`
 * (worker/src/agents/identity.ts), and the server never matches that address to a member.
 */
export const isAgentEmail = (email: string) => AGENT_EMAIL.test(email.trim());

/** The agent account id inside an agent email, or null for any other address. */
export const agentIdOfEmail = (email: string) =>
  AGENT_EMAIL.exec(email.trim())?.[1] ?? null;
