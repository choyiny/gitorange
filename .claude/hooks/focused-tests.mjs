#!/usr/bin/env node
// PostToolUse (Write|Edit): block leftover focused/skipped tests.
// Config: testGlobs ([ "**/*.test.ts", … ]).
import { readFileSync } from "node:fs";
import { readHookInput, loadConfig, matchesGlob, targetFile } from "./_lib.mjs";

const input = await readHookInput();
const file = targetFile(input);
const configuredGlobs = loadConfig().testGlobs;
const globs = Array.isArray(configuredGlobs) ? configuredGlobs : [];
if (!file || !globs.some((g) => matchesGlob(file, g))) process.exit(0);

let source;
try {
  source = readFileSync(file, "utf8");
} catch {
  process.exit(0);
}

// Detect focused/skipped tests as calls, not property reads:
//   - a test root (describe/it/test/suite/bench) followed by a chain of member
//     segments (each optionally invoked, e.g. `.each([1, 2])`) ending in `.only` or
//     `.skip` — this covers `it.only(`, `it.only.each([...])(`, `test.concurrent.only(`,
//     `describe.each([...]).only(`, and `.only`/`.skip` split across a line break
//     (matched over the whole source, not per line, so a newline inside the chain
//     doesn't hide it).
//   - the bare legacy aliases used as calls: fit(, fdescribe(, xit(, xtest(, xdescribe(
// The root anchor (describe|it|test|suite|bench, or the alias itself) is what keeps
// innocent property reads like `config.only` or `readonly.skip` from matching — neither
// string contains one of those roots at a word boundary — so we don't need to require a
// trailing `(` after `only`/`skip` to stay safe, and dropping that requirement is what
// lets `.only.each(` and `.each([...]).only(` match.
const IDENT = "[A-Za-z_$][\\w$]*";
const CALL_ARGS = "\\([^()]*\\)";
const SEG = `\\s*\\.\\s*${IDENT}\\s*(?:${CALL_ARGS})?`;
const CHAIN = `\\b(?:describe|it|test|suite|bench)\\b(?:${SEG})*\\s*\\.\\s*(?:only|skip)\\b`;
const ALIAS = `\\b(?:fit|fdescribe|xit|xtest|xdescribe)\\b\\s*\\(`;
const FOCUSED = new RegExp(`${CHAIN}|${ALIAS}`, "g");

const hits = [];
for (const m of source.matchAll(FOCUSED)) {
  const line = source.slice(0, m.index).split("\n").length;
  const snippet = m[0].replace(/\s+/g, "").replace(/\($/, "");
  hits.push(`  ${file}:${line}  ${snippet}`);
}

if (hits.length === 0) process.exit(0);

process.stderr.write(
  `Focused or skipped tests left in the file just written:\n\n${hits.join("\n")}\n\n` +
    `\`.only\` silently skips every other test in the suite, and \`.skip\` disables coverage — ` +
    `both pass CI while testing nothing. Remove them before finishing.\n`,
);
process.exit(2);
