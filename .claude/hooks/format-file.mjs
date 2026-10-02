#!/usr/bin/env node
// PostToolUse (Write|Edit): format the touched file in place.
// Config: format (command line; file path appended as the last arg), formatExtensions ([".ts", …]).
// Fire-and-forget: always exits 0. A formatter problem must never block a write.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { readHookInput, loadConfig, projectDir, targetFile } from "./_lib.mjs";

const input = await readHookInput();
const file = targetFile(input);
const cfg = loadConfig();

const rawExtensions = cfg.formatExtensions;
const extensions = (Array.isArray(rawExtensions) ? rawExtensions : []).map((ext) => String(ext).toLowerCase());
if (file && cfg.format && existsSync(file) && extensions.includes(extname(file).toLowerCase())) {
  const [cmd, ...args] = String(cfg.format).split(/\s+/).filter(Boolean);
  if (cmd) {
    spawnSync(cmd, [...args, file], {
      cwd: projectDir(),
      stdio: "ignore",
      timeout: 30_000,
    });
  }
}

process.exit(0);
