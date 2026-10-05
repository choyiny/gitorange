import type { GitService } from '../git/service';

// Commit graphs never change, so an answer for a pair of commits holds forever (per isolate, capped).
const memo = new Map<string, boolean>();
const MAX = 2000;

/** Whether `descendant`'s history contains `ancestor`; null when git can't say (not remembered). */
export async function contains(
  git: GitService,
  ancestor: string,
  descendant: string
): Promise<boolean | null> {
  if (ancestor === descendant) return true;
  const key = `${ancestor}:${descendant}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let yes: boolean;
  try {
    yes = (await git.mergeBase(ancestor, descendant)) === ancestor;
  } catch {
    return null;
  }
  if (memo.size >= MAX) memo.delete(memo.keys().next().value!);
  memo.set(key, yes);
  return yes;
}
