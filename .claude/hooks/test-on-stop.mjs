#!/usr/bin/env node
// Stop: block finishing while the test suite fails. Opt-in — not wired by default.
// Config: test (command line).
import { readHookInput, loadConfig, runStopGate } from "./_lib.mjs";

const input = await readHookInput();
runStopGate({ input, command: loadConfig().test, label: "Tests failed" });
