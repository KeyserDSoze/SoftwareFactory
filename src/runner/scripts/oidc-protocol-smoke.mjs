/**
 * Real CI-only OIDC protocol smoke, executed INSIDE the private Docker network.
 * Tests PKCE S256 denial, grant redemption, RS256/JWKS, refresh rotation, logout, JWKS rollover.
 * No tokens or signing keys are printed.
 */
import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

const issuer = "http://identity:8999";
const client = "factory-web";
const audience = "factory-client";
const redirect = "http://127.0.0.1:4173/auth/callback";
const allowedReturn = "http://127.0.0.1:4173/";
const secret = process.env.OIDC_CI_SECRET;
if (process.env.CI !== "true" || !secret || secret.length < 32)
  throw Error("Only the isolated CI may run OIDC protocol checks");
const get = async path => {
  const r = await fetch(issuer + path);
  assert.equal(r.status, 200, "OIDC discovery/JWKS endpoint");
  return await r.json();
};
const discovery = await get("/.well-known/openid-configuration");
assert.equal(discovery.issuer, issuer);
assert.equal(discovery.authorization_endpoint, issuer + "/authorize");
assert.equal(discovery.token_endpoint, issuer + "/token");
assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
assert.deepEqual(discovery.id_token_signing_alg_values_supported, ["RS256"]);

const firstKeys = await get("/jwks");
assert.equal(firstKeys.keys.length, 1);
const key = firstKeys.keys[0];
assert.equal(key.alg, "RS256");
assert.equal(key.kty, "RSA");
assert.equal(key.d, undefined, "Private key must never be in the JWKS");
function checkToken(token, expectedAudience) {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  assert.equal(header.alg, "RS256");
  assert.equal(header.kid, key.kid);
  assert.equal(claims.iss, issuer);
  assert.equal(claims.aud, expectedAudience);
  assert.equal(claims.sub, "owner-a");
  assert.ok(claims.exp > Date.now() / 1000);
  assert.ok(verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]),
    createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url")));
}
async function authorize() {
  const verifier = randomBytes(36).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const q = new URLSearchParams({
    client_id: client, response_type: "code", redirect_uri: redirect,
    scope: "openid profile offline_access", state, nonce,
    code_challenge_method: "S256", code_challenge: challenge,
  });
  const response = await fetch(issuer + "/authorize?" + q, { redirect: "manual" });
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.origin + target.pathname, redirect);
  assert.equal(target.searchParams.get("state"), state);
  assert.equal(target.searchParams.get("iss"), issuer);
  assert.ok(target.searchParams.get("code"));
  return { code: target.searchParams.get("code"), verifier, nonce };
}
async function redeem(code, verifier) {
  const form = new URLSearchParams({
    client_id: client, grant_type: "authorization_code",
    code, code_verifier: verifier, redirect_uri: redirect,
  });
  return await fetch(issuer + "/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  });
}
const malicious = await authorize();
assert.equal((await redeem(malicious.code, "wrong-" + malicious.verifier)).status, 400,
  "PKCE must reject a wrong verifier");
const good = await authorize();
const response = await redeem(good.code, good.verifier);
assert.equal(response.status, 200);
const credentials = await response.json();
checkToken(credentials.access_token, audience);
checkToken(credentials.id_token, client);
assert.equal((await redeem(good.code, good.verifier)).status, 400, "Auth code must be single-use");
const profile = await fetch(issuer + "/userinfo", {
  headers: { Authorization: "Bearer " + credentials.access_token },
});
assert.equal(profile.status, 200);
assert.equal((await profile.json()).sub, "owner-a");
async function refresh(refreshToken) {
  const form = new URLSearchParams({
    client_id: client, grant_type: "refresh_token", refresh_token: refreshToken,
  });
  return await fetch(issuer + "/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  });
}
const renewedResponse = await refresh(credentials.refresh_token);
assert.equal(renewedResponse.status, 200);
const renewed = await renewedResponse.json();
assert.notEqual(renewed.refresh_token, credentials.refresh_token);
checkToken(renewed.access_token, audience);
assert.equal((await refresh(credentials.refresh_token)).status, 400, "Refresh token replay must fail");
const returnParams = new URLSearchParams({ post_logout_redirect_uri: allowedReturn, state: randomBytes(16).toString("hex") });
const logout = await fetch(issuer + "/logout?" + returnParams, { redirect: "manual" });
assert.equal(logout.status, 302);
assert.equal(new URL(logout.headers.get("location")).origin + "/", allowedReturn);
const rotated = await fetch(issuer + "/__ci/rotate", { headers: { "x-ci-secret": secret } });
assert.equal(rotated.status, 200);
const nextKeys = await get("/jwks");
assert.notEqual(nextKeys.keys[0].kid, key.kid, "Key rollover must publish a new kid");
const statsResponse = await fetch(issuer + "/__ci/stats", { headers: { "x-ci-secret": secret } });
assert.equal(statsResponse.status, 200);
const stats = await statsResponse.json();
assert.ok(stats.pkceRejected >= 1);
assert.ok(stats.redeemed >= 1);
assert.ok(stats.refreshed >= 1);
assert.ok(stats.logout >= 1);
console.log("OIDC_PROTOCOL_SMOKE_PASS: RS256 JWKS, S256 PKCE, single-use codes, rotating refresh tokens, logout, JWKS rollover");
