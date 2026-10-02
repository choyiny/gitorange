#!/usr/bin/env node
// PreToolUse (Bash): deny commands that violate project policy. OPT-IN — not wired by default.
// Config: commandRules ([{ pattern, reason }]), protectedBranches ([ "main" ]).
import { spawnSync } from "node:child_process";
import { readHookInput, loadConfig, projectDir, denyPreToolUse } from "./_lib.mjs";

const input = await readHookInput();
const command = input?.tool_input?.command;
if (typeof command !== "string" || !command.trim()) process.exit(0);

const cfg = loadConfig();

// The full command is interpolated into the deny reason below. Cap it — an agent writing a
// large file via a heredoc (`cat <<'EOF' > file.ts` with megabytes of content as the "command")
// would otherwise produce a multi-hundred-KB deny reason, which is both wasteful and (before the
// writeSync fix in _lib.mjs's denyPreToolUse) could truncate the JSON payload outright.
const MAX_ECHOED_COMMAND = 500;
const echoedCommand =
  command.length > MAX_ECHOED_COMMAND ? `${command.slice(0, MAX_ECHOED_COMMAND)}… [truncated]` : command;

const rawRules = cfg.commandRules;
const commandRules = Array.isArray(rawRules) ? rawRules : [];
for (const rule of commandRules) {
  if (typeof rule?.pattern !== "string" || !rule.pattern) continue;
  let re;
  try {
    re = new RegExp(rule.pattern);
  } catch {
    continue; // a malformed rule is skipped, never fatal
  }
  if (re.test(command)) {
    denyPreToolUse(`Blocked command: ${echoedCommand}\n\n${rule.reason ?? "This command is not allowed here."}`);
  }
}

const rawBranches = cfg.protectedBranches;
const branches = Array.isArray(rawBranches) ? rawBranches.filter((b) => typeof b === "string" && b) : [];
if (branches.length > 0 && /\bgit\s+(commit|push)\b/.test(command)) {
  // symbolic-ref (not rev-parse --abbrev-ref) also resolves on a brand-new repo with no
  // commits yet, where HEAD is an unborn branch — rev-parse would fail there.
  const res = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: projectDir(),
    encoding: "utf8",
    timeout: 10_000,
  });
  const branch = res.status === 0 ? (res.stdout ?? "").trim() : null;
  if (branch && branches.includes(branch)) {
    denyPreToolUse(
      `Blocked: you are on the protected branch \`${branch}\`.\n\n` +
        `Create a feature branch and open a pull request instead of committing or pushing here.`,
    );
  }
}

process.exit(0);
