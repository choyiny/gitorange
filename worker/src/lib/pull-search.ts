import { and, or, sql, type SQL } from 'drizzle-orm';
import { pullRequests } from '../db/app.schema';
import { users } from '../db/auth.schema';
import { contains, startsWith } from './text-match';

// The search box of the pull request list, for the lists the page pages in SQL (closed and merged ones). The same
// words the page matches in a list it already holds: a number (`#12`, or digits that start one), or part of the
// title, the branch, the author's username or name, the app that opened it ("Claude Code") or its session label
// ("s4"). Every word has to match; "by hand" matches the pull requests no app opened.

const MAX_WORDS = 8;

/** The words of a search, lower-cased; "by hand" is taken out and returned as its own flag. The dot in "Claude·s4" splits. */
export function searchTerms(q: string): { words: string[]; byHand: boolean } {
  const text = q.toLowerCase().replace(/·/g, ' ');
  const byHand = /\bby\s+hand\b/.test(text);
  const words = text
    .replace(/\bby\s+hand\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS);
  return { words, byHand };
}

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
    const any: SQL[] = [
      contains(pullRequests.title, w),
      contains(pullRequests.headRef, w),
      contains(sql`COALESCE(${pullRequests.createdVia}, '')`, w),
      contains(sql`COALESCE(${pullRequests.sessionLabel}, '')`, w),
      sql`${pullRequests.authorId} IN (SELECT ${users.id} FROM ${users} WHERE ${or(contains(users.username, w), contains(users.name, w))})`,
    ];
    if (/^\d+$/.test(w))
      any.push(startsWith(sql`CAST(${pullRequests.number} AS TEXT)`, w));
    parts.push(or(...any)!);
  }
  return parts.length ? and(...parts) : undefined;
}
