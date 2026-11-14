/**
 * Exercise the exported fixture as a CLI, not just a module import.
 * Only generated on the ephemeral CI host after npm run fixture.
 * Never log signing keys or signed tokens.
 */
import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";

const dir = path.resolve(process.argv[2] || "src/frontend/generated-fixture");
const filepath = path.join(dir, "tests/security/issue-tokens.mjs");
await readFile(filepath, "utf8");
const key = randomBytes(48).toString("hex");
const env = {
  ...process.env,
  CI: "true",
  Auth__Issuer: "factory-ci",
  Auth__Audience: "factory-client",
  Auth__SigningKey: key,
};
const invoke = (role, owner, customEnv=env) =>
  spawnSync(process.execPath, [filepath, role, owner], { encoding: "utf8", env: customEnv });
const result = invoke("editor", "owner-a");
assert.equal(result.status, 0, "JWT fixture CLI must sign tokens in CI");
const token = result.stdout.trim();
const [header, body, signature] = token.split(".");
assert.deepEqual(JSON.parse(Buffer.from(header,"base64url").toString("utf8")), {alg:"HS256",typ:"JWT"});
const payload = JSON.parse(Buffer.from(body,"base64url").toString("utf8"));
assert.equal(payload.sub, "owner-a");
assert.equal(payload.role, "editor");
assert.equal(payload.iss, "factory-ci");
assert.equal(payload.aud, "factory-client");
assert.ok(payload.exp - payload.iat === 600);
assert.equal(signature, createHmac("sha256",key).update(header+"."+body).digest("base64url"));
assert.notEqual(invoke("reader", "owner-a").stdout, result.stdout);
assert.notEqual(invoke("editor", "owner-b").stdout, result.stdout);
assert.notEqual(invoke("editor", "owner-a", { ...env, CI:"false" }).status, 0);
assert.notEqual(invoke("editor", "owner-a", { ...env, Auth__SigningKey:"too-short" }).status, 0);
console.log("GENERATED_JWT_FIXTURE_PASS: CLI signs short-lived per-user/role tokens with transient secrets");
