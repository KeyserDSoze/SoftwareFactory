/**
 * Real browser E2E on an ephemeral GitHub runner.
 * Executes the same planStep/runDockerStep path as the rootless remote worker,
 * but uses a host-owned volume and UID/GID for GitHub's CI Docker daemon.
 * Browser and local Vite webServer run inside --network none.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { planStep, runDockerStep, PLAYWRIGHT_VERSION } from "../docker.mjs";

const root = path.resolve(process.argv[2] || "src/frontend/generated-fixture");
const names = [
  "src/frontend/web/package.json",
  "src/frontend/web/playwright.config.ts",
  "src/frontend/web/e2e/smoke.spec.ts",
];
const files = Object.fromEntries(await Promise.all(names.map(async name =>
  [name, await readFile(path.join(root, name), "utf8")]
)));
const plan = planStep("playwright", files, root, {
  RUNNER_CONTAINER_UID: process.getuid() + ":" + process.getgid(),
  RUNNER_PLAYWRIGHT_IMAGE: "mcr.microsoft.com/playwright:v" + PLAYWRIGHT_VERSION + "-noble",
});
assert.ok(!plan.skip, "Playwright was skipped: " + plan.skip);
assert.ok(plan.args.includes("none"), "Browser must not access external network");
assert.ok(plan.args.includes("--read-only"));
assert.ok(plan.args.includes("--cap-drop=ALL"));
const result = await runDockerStep(plan, randomUUID(), "playwright");
if (result.state !== "passed") {
  console.error("PLAYWRIGHT_BROWSER_SMOKE_FAILED", JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /2 passed/);
  console.log("PLAYWRIGHT_BROWSER_SMOKE_PASS: " + result.stdout.split("\n").filter(line => line.includes("passed")).join(" "));
}
