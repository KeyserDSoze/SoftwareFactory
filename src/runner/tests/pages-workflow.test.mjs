import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

/** Regression for #101: retry failed deploy without uploading an extra artifact. */
test("GitHub Pages deploy is a separate retryable job after artifact upload", async () => {
  const yml = await readFile(new URL("../../../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(yml, /^  workflow_dispatch:/m);
  assert.match(yml, /^  build-and-upload:/m);
  assert.match(yml, /^  deploy:/m);
  const [build, deploy] = yml.split("\n  deploy:\n");
  assert.ok(build && deploy, "separate build and deploy jobs are required");
  assert.match(build, /actions\/upload-pages-artifact@v3/);
  assert.doesNotMatch(build, /actions\/deploy-pages@v4/);
  assert.match(deploy, /^    needs: build-and-upload$/m);
  assert.match(deploy, /if: needs\.build-and-upload\.outputs\.pages_enabled == 'true'/);
  assert.match(deploy, /actions\/deploy-pages@v4/);
  assert.doesNotMatch(deploy, /upload-pages-artifact|npm install|actions\/checkout/);
  assert.equal(yml.match(/uses: actions\/upload-pages-artifact@v3/g)?.length, 1);
  assert.equal(yml.match(/uses: actions\/deploy-pages@v4/g)?.length, 1);
  assert.match(yml, /^  cancel-in-progress: true$/m);
  assert.match(deploy, /name: github-pages/);
});
