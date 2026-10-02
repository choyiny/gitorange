#!/usr/bin/env node
// Stop: block finishing while the project does not typecheck.
// Config: typecheck (command line).
import { readHookInput, loadConfig, runStopGate } from "./_lib.mjs";

const input = await readHookInput();
runStopGate({ input, command: loadConfig().typecheck, label: "Typecheck failed" });
