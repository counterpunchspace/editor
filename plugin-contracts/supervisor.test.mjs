import assert from "node:assert/strict";
import { test } from "node:test";
import { supervise } from "./supervisor.mjs";

test("a slow probe is killed as a timeout", async () => {
  const result = await supervise(process.execPath, [
    "-e",
    "console.log('PROBE start slow'); setInterval(() => {}, 1000);",
  ], { probeMs: 300, totalMs: 2000, pollMs: 50 });
  assert.equal(result.outcome, "timeout");
  assert.match(result.lastProbe, /slow/);
});

test("huge stdout is oversized_output", async () => {
  const result = await supervise(process.execPath, [
    "-e",
    "console.log('x'.repeat(300000));",
  ], { probeMs: 2000, totalMs: 2000, pollMs: 50 });
  assert.equal(result.outcome, "oversized_output");
});

test("a passing report is accepted", async () => {
  const result = await supervise(process.execPath, [
    "-e",
    "console.log('PROBE start ok'); console.log('PROBE done ok'); console.log('REPORT {\"passed\":true,\"failures\":[]}');",
  ], { probeMs: 2000, totalMs: 2000, pollMs: 50 });
  assert.equal(result.outcome, "passed");
  assert.equal(result.report.passed, true);
});
