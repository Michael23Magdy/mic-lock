#!/usr/bin/env node
import { run } from "../cli.js";

run().catch((err) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
