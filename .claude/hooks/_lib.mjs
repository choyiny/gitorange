// Shared helpers for .claude/hooks/* scripts.
// Dependency-free Node ESM — node: builtins only. Never throws; every failure path
// degrades to a no-op so a broken hook can never block real work.
import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Read the hook payload from stdin. Returns {} when empty, unparseable, or run from a TTY. */
export async function readHookInput() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Project root. $CLAUDE_PROJECT_DIR is set for command hooks; cwd is the fallback. */
export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** Load .claude/hooks/hooks.config.json. Returns {} when absent or invalid. */
export function loadConfig() {
  try {
    const path = join(projectDir(), ".claude", "hooks", "hooks.config.json");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const RE_META = /[.+^${}()|[\]\\]/g;

/** Convert a glob (**, *, ?) to a RegExp anchored at both ends. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // **/ also matches zero directories
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(RE_META, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

function toPosix(p) {
  return p.split("\\").join("/");
}

/** Strip the project root prefix from a posix path, if present. */
export function relativeToProject(posixPath) {
  const root = toPosix(projectDir()).replace(/\/$/, "");
  return posixPath.startsWith(`${root}/`) ? posixPath.slice(root.length + 1) : posixPath;
}

/** Match a path against a glob, trying the full path, the repo-relative path, and (for
 *  separator-free globs) the basename. A non-string (or empty) glob degrades to "no match"
 *  instead of throwing — this is the element-level guard: callers may already validate the
 *  container (e.g. `Array.isArray(cfg.testGlobs)`), but a malformed individual entry inside an
 *  otherwise-valid array (`["**\/*.test.ts", 42]`) must not crash the hook. */
export function matchesGlob(filePath, glob) {
  if (typeof glob !== "string" || !glob) return false;
  const re = globToRegExp(glob);
  const posix = toPosix(filePath);
  if (re.test(posix)) return true;
  if (re.test(relativeToProject(posix))) return true;
  return !glob.includes("/") && re.test(posix.split("/").pop());
}

/** The file a Write/Edit tool call targets, or null. */
export function targetFile(input) {
  const p = input?.tool_input?.file_path;
  return typeof p === "string" && p ? p : null;
}

/** Emit a PreToolUse deny and exit 0. Denials are stdout JSON, not exit 2.
 *  Writes synchronously: process.stdout.write() to a pipe is asynchronous, and process.exit()
 *  tears the process down without waiting for it to drain — a large payload would otherwise be
 *  silently truncated (observed at exactly the 64KB pipe buffer boundary on macOS), producing
 *  unparseable JSON and losing the denial. writeSync(1, …) blocks until the write completes. */
export function denyPreToolUse(reason) {
  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

const MAX_REPORT_LINES = 40;

/** Internal spawnSync timeout for a Stop-hook gate command, in ms. This is what actually governs
 *  how long a gate command may run — it applies regardless of the `timeout` set on the hook entry
 *  in settings.json (see hook-reference.md §1/§3). Overridable via runStopGate's `timeoutMs` for
 *  tests; the shipped hooks (typecheck.mjs, test-on-stop.mjs) always use the default. */
export const DEFAULT_STOP_GATE_TIMEOUT_MS = 300_000;

/** Run a Stop-hook gate command. Exits 2 with a stderr report on failure, 0 otherwise.
 *  Exits 0 immediately when stop_hook_active is set, so a persistently failing gate
 *  can never trap the session.
 *  A command that times out is treated as a BLOCK, not a pass: the gate could not verify the
 *  command's outcome, and silently letting an unverified command through is the wrong direction
 *  for a gate whose entire purpose is to catch problems before they ship. Only a genuinely
 *  unspawnable command (e.g. ENOENT — the binary doesn't exist) still exits 0, since that is a
 *  setup problem, not something the gate can meaningfully hold the agent responsible for. */
export function runStopGate({ input, command, label, timeoutMs = DEFAULT_STOP_GATE_TIMEOUT_MS }) {
  if (input?.stop_hook_active) process.exit(0);
  if (!command) process.exit(0);

  const [cmd, ...args] = String(command).split(/\s+/).filter(Boolean);
  if (!cmd) process.exit(0);

  const res = spawnSync(cmd, args, { cwd: projectDir(), encoding: "utf8", timeout: timeoutMs });

  if (res.error?.code === "ETIMEDOUT") {
    const seconds = Math.round((timeoutMs / 1000) * 10) / 10; // one decimal — timeoutMs may be sub-second in tests
    process.stderr.write(
      `${label}: \`${command}\` timed out after ${seconds}s (${timeoutMs}ms) and the gate could not verify it.\n\n` +
        `A timeout is treated as a failure, not a pass — the command may or may not actually be ` +
        `passing, but the gate has no way to tell. Fix the underlying slowness before finishing.\n`,
    );
    process.exit(2);
  }

  if (res.error || res.status === 0) process.exit(0); // unspawnable (e.g. ENOENT) or passing

  const lines = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split("\n");
  const shown = lines.slice(0, MAX_REPORT_LINES).join("\n");
  const elided = lines.length > MAX_REPORT_LINES ? `\n… ${lines.length - MAX_REPORT_LINES} more lines` : "";

  process.stderr.write(`${label} (\`${command}\`):\n\n${shown}${elided}\n\nFix this before finishing.\n`);
  process.exit(2);
}
