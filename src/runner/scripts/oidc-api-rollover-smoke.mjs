/**
 * CI-only JWKS rollover test against the already-running real ASP.NET Core API.
 * Runs inside the isolated Docker network; never prints tokens, private keys or secrets.
 * A test-provider rollover does not prove production IdP compatibility or token revocation.
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

if (process.env.CI !== "true" || !process.env.OIDC_CI_SECRET ||
    process.env.OIDC_CI_SECRET.length < 32)
  throw Error("OIDC API rollover test is restricted to ephemeral CI");
const provider = "http://identity:8999";
const api = "http://api:8080/api/items";
const controlHeaders = { "x-ci-secret": process.env.OIDC_CI_SECRET };

async function getJson(path, headers = undefined) {
  const response = await fetch(provider + path, { headers, signal: AbortSignal.timeout(4000) });
  assert.equal(response.status, 200, "OIDC test provider response");
  return response.json();
}
async function mint(role, type = "") {
  const q = new URLSearchParams({ sub: "owner-a", role, ...(type ? { type } : {}) });
  const response = await getJson("/__ci/mint?" + q, controlHeaders);
  assert.equal(typeof response.access_token, "string");
  return response.access_token;
}
function header(token) {
  const jwt = token.split(".");
  assert.equal(jwt.length, 3);
  const decoded = JSON.parse(Buffer.from(jwt[0], "base64url").toString("utf8"));
  assert.equal(decoded.alg, "RS256");
  return decoded;
}
async function status(token, method = "GET") {
  const response = await fetch(api, {
    method, headers: { Authorization: "Bearer " + token,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify({ title: "deny post-rollover reader" }) } : {}),
    signal: AbortSignal.timeout(4000),
  });
  return response.status;
}

const oldJwks = await getJson("/jwks");
assert.equal(oldJwks.keys.length, 1);
const before = await mint("editor");
assert.equal(header(before).kid, oldJwks.keys[0].kid);
assert.equal(await status(before), 200, "API must accept original issuer signature");

const rotated = await fetch(provider + "/__ci/rotate", {
  headers: controlHeaders, method: "POST", signal: AbortSignal.timeout(4000),
});
assert.equal(rotated.status, 200, "test-only key rotation");
const newJwks = await getJson("/jwks");
assert.equal(newJwks.keys.length, 1);
assert.notEqual(newJwks.keys[0].kid, oldJwks.keys[0].kid, "issuer must publish new kid");
assert.equal(newJwks.keys[0].d, undefined, "JWKS must contain no private key");
const after = await mint("editor");
assert.equal(header(after).kid, newJwks.keys[0].kid);

let accepted = false;
let transient401 = 0;
for (let attempt = 0; attempt < 35; attempt++) {
  const actual = await status(after);
  if (actual === 200) { accepted = true; break; }
  assert.equal(actual, 401, "Unknown keys must fail closed during metadata refresh");
  transient401++;
  await sleep(600);
}
assert.ok(accepted, "Running API failed to refresh JWKS and accept new kid within 21 seconds");

// Flip a signature byte while preserving a valid three-segment JWT and its new kid.
const parts = after.split(".");
parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
assert.equal(await status(parts.join(".")), 401, "Tampered RS256 signature must remain rejected");
const reader = await mint("reader");
assert.equal(header(reader).kid, newJwks.keys[0].kid);
assert.equal(await status(reader, "POST"), 403, "New signing key must not bypass RBAC");
assert.equal(await status(reader, "GET"), 200, "One reader role must permit read");
assert.equal(await status(after, "POST"), 201, "One editor role must permit write");
// RSA-signed negative claims: an editor inside an ambiguous role list must NOT
// be enough to grant writes. The test fixture is CI-only and does not log JWTs.
for (const type of ["mixed-roles", "duplicate-roles", "unknown-role", "empty-role", "missing-role"]) {
  const bad = await mint("editor", type);
  assert.equal(await status(bad, "GET"), 403,
    "Ambiguous/unrecognized OIDC role must not grant read: " + type);
  assert.equal(await status(bad, "POST"), 403,
    "Ambiguous/unrecognized OIDC role must not grant write: " + type);
}
console.log("OIDC_API_JWKS_ROLLOVER_PASS: live ASP.NET Core accepted new kid; bad signature 401; strict unique reader/editor role with five negative variants; transient401=" + transient401);
