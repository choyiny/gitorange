import { and, or, sql, type SQL } from 'drizzle-orm';
import { pullRequests } from '../db/app.schema';
import { users } from '../db/auth.schema';

// The search box of the pull request list, for the lists the page pages in SQL (closed and merged ones). The same
// words the page matches in a list it already holds: a number (`#12`, or digits that start one), or part of the
// title, the branch, the author's username or name, the app that opened it ("Claude Code") or its session label
// ("s4"). Every word has to match; "by hand" matches the pull requests no app opened.

const MAX_WORDS = 8;
const MAX_WORD = 50;

/** The words of a search, lower-cased; "by hand" is taken out and returned as its own flag. The dot in "Claude·s4" splits. */
export function searchTerms(q: string): { words: string[]; byHand: boolean } {
  const text = q.toLowerCase().replace(/·/g, ' ');
  const byHand = /\bby\s+hand\b/.test(text);
  const words = text
    .replace(/\bby\s+hand\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS)
    .map((w) => w.slice(0, MAX_WORD));
  return { words, byHand };
}

/** `text` as the inside of a LIKE pattern that matches it literally (escape character `!`). */
const literal = (text: string) => text.replace(/[!%_]/g, (c) => `!${c}`);

/** The WHERE clause of a search over `pull_requests`; undefined for a search with no words. */
export function pullSearch(q: string): SQL | undefined {
  const { words, byHand } = searchTerms(q);
  const parts: SQL[] = [];
  if (byHand) parts.push(sql`COALESCE(${pullRequests.createdVia}, '') = ''`);
  for (const w of words) {
    if (/^#\d+$/.test(w)) {
      parts.push(sql`${pullRequests.number} = ${Number(w.slice(1))}`);
      continue;
    }
    const like = `%${literal(w)}%`;
    const any: SQL[] = [
      sql`${pullRequests.title} LIKE ${like} ESCAPE '!'`,
      sql`${pullRequests.headRef} LIKE ${like} ESCAPE '!'`,
      sql`COALESCE(${pullRequests.createdVia}, '') LIKE ${like} ESCAPE '!'`,
      sql`COALESCE(${pullRequests.sessionLabel}, '') LIKE ${like} ESCAPE '!'`,
      sql`${pullRequests.authorId} IN (SELECT ${users.id} FROM ${users} WHERE ${users.username} LIKE ${like} ESCAPE '!' OR ${users.name} LIKE ${like} ESCAPE '!')`,
    ];
    if (/^\d+$/.test(w))
      any.push(sql`CAST(${pullRequests.number} AS TEXT) LIKE ${`${w}%`}`);
    parts.push(or(...any)!);
  }
  return parts.length ? and(...parts) : undefined;
}
