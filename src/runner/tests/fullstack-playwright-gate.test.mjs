import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyFullstackPlaywrightOutcome as gate } from "../scripts/fullstack-playwright-gate.mjs";

const spec = n => Array.from({ length: n },
  (_, i) => 'test("scenario ' + i + '", async ({ page }) => {});').join("\n") + "\n";
const outcome = (stdout, extras = {}) => ({
  state: "passed", exitCode: 0, timedOut: false, stdout, ...extras,
});

test("accepts exactly the number of executed test declarations, independently of 17/18 constants", () => {
  for (const n of [1, 17, 18, 19, 42, 80])
    assert.equal(gate(spec(n), outcome("\n  " + n + " passed (17.8s)\n")), n);
});
test("rejects skipped, failed, flaky or interrupted tests even when count summary is forged", () => {
  const source = spec(18);
  for (const status of ["1 failed", "1 skipped", "1 flaky", "1 interrupted"]) {
    assert.throws(() => gate(source, outcome("\n  18 passed (12s)\n  " + status + "\n")),
      /did not pass every declared test/);
  }
  for (const misleading of [
    "17 passed (12s)", "118 passed (12s)", "18 passed", "18 passed but not really",
    "  18 passed (12s) 19 skipped", "18 passed (12s) but then an error",
    "0 passed (12s)", "18 passed (12s)\n  1 skipped\n",
  ])
    assert.throws(() => gate(source, outcome(misleading)),
      /did not pass every declared test/, misleading);
});
test("rejects failed, incomplete, wrong-exit and timeout execution despite convincing summary", () => {
  for (const patch of [{ state: "failed" }, { state: "incomplete" },
    { exitCode: 1 }, { exitCode: null }, { timedOut: true },
    { timedOut: undefined }, { stdout: null }]) {
    assert.throws(() => gate(spec(18), outcome("\n  18 passed (1s)\n", patch)),
      /not a verified pass/);
  }
  assert.throws(() => gate(spec(18), undefined), /not a verified pass/);
});
test("rejects empty, truncated, untrusted or non-declared suites without claiming coverage", () => {
  for (const bad of ["", "test.skip(\"not executed\", () => {});\n",
    "  test(\"indented\", () => {});\n", "x".repeat(1_000_001)]) {
    assert.throws(() => gate(bad, outcome("\n  1 passed (1s)\n")),
      /Invalid/);
  }
  assert.throws(() => gate(null, outcome("\n  1 passed (1s)\n")), /Invalid/);
  assert.throws(() => gate(spec(81), outcome("\n  81 passed (1s)\n")), /Invalid/);
  assert.throws(() => gate(spec(2), outcome("\n  1 passed (1s)\n")),
    /did not pass every declared test/);
});
