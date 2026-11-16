import assert from "node:assert/strict";
import { test } from "node:test";
import { cachedNodeDigest, ciRootfulCanaryAllowed,
  rootfulOnlySecurityOptions } from "../scripts/rootless-canary-ci-smoke.mjs";

test("CI real-Docker canary is gated to non-root GitHub Actions workers", () => {
  assert.equal(ciRootfulCanaryAllowed({ GITHUB_ACTIONS: "true", CI: "true" }, 1001), true);
  assert.equal(ciRootfulCanaryAllowed({ GITHUB_ACTIONS: "true", CI: "true" }, 0), false);
  assert.equal(ciRootfulCanaryAllowed({ GITHUB_ACTIONS: "true" }, 1001), false);
  assert.equal(ciRootfulCanaryAllowed({ GITHUB_ACTIONS: "false", CI: "true" }, 1001), false);
  assert.equal(ciRootfulCanaryAllowed({}, undefined), false);
});

test("CI canary selects exactly one cached immutable Node repository digest", () => {
  const digest = "node@sha256:" + "c".repeat(64);
  assert.equal(cachedNodeDigest(JSON.stringify([digest])), digest);
  assert.equal(cachedNodeDigest(JSON.stringify([
    "docker.io/library/" + digest, digest,
  ])), digest, "equivalent qualified and unqualified references are one digest");
  for (const raw of ["broken", "null", "{}", "[]",
    JSON.stringify(["node:22-bookworm-slim"]),
    JSON.stringify(["attacker@sha256:" + "c".repeat(64)]),
    JSON.stringify([digest, "node@sha256:" + "d".repeat(64)]),
    JSON.stringify(Array(17).fill(digest))])
    assert.throws(() => cachedNodeDigest(raw));
});

test("CI canary refuses a rootless/malformed daemon to prevent false test claims", () => {
  assert.equal(rootfulOnlySecurityOptions('["name=seccomp,profile=default"]'), true);
  for (const raw of ['["name=rootless"]',
    '["name=rootless","name=seccomp"]', "null", "{}", "invalid-json",
    '["name=seccomp",12]'])
    assert.throws(() => rootfulOnlySecurityOptions(raw));
});
