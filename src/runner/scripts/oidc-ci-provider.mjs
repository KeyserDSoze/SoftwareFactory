/**
 * CI-only disposable OpenID Provider implementing RS256/JWKS and code+S256 PKCE.
 * NOT a production identity provider. Only bind on an internal per-job Docker network.
 */
import http from "node:http";
import { generateKeyPairSync, randomBytes, createHash, sign, verify, timingSafeEqual } from "node:crypto";

if (process.env.CI !== "true" || !process.env.OIDC_CI_SECRET || process.env.OIDC_CI_SECRET.length < 32)
  throw Error("CI-only OIDC provider requires a unique ephemeral control secret");
const issuer = process.env.OIDC_ISSUER;
const clientId = process.env.OIDC_CLIENT_ID;
const audience = process.env.OIDC_AUDIENCE;
const redirectUri = process.env.OIDC_REDIRECT_URI;
const allowedOrigin = process.env.OIDC_ALLOWED_ORIGIN;
if (!issuer || !clientId || !audience || !redirectUri || !allowedOrigin)
  throw Error("Missing OIDC CI configuration");
const controlSecret = Buffer.from(process.env.OIDC_CI_SECRET);
const codes = new Map();
const refreshTokens = new Map();
const stats = { redeemed: 0, refreshed: 0, logout: 0, pkceRejected: 0 };
let keys;
function rotateKeys() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keys = { ...pair, kid: randomBytes(8).toString("hex") };
}
rotateKeys();
const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
function jwt(claims) {
  const raw = enc({ alg: "RS256", kid: keys.kid, typ: "JWT" }) + "." + enc(claims);
  return raw + "." + sign("RSA-SHA256", Buffer.from(raw), keys.privateKey).toString("base64url");
}
function accessToken(subject, role, extra = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return jwt({ iss: issuer, aud: audience, sub: subject, role, iat, exp: iat + 600, jti: randomBytes(10).toString("hex"), ...extra });
}
function matchesSecret(req) {
  const candidate = Buffer.from(String(req.headers["x-ci-secret"] || ""));
  return candidate.length === controlSecret.length && timingSafeEqual(candidate, controlSecret);
}
function cors(res, req) {
  if (req.headers.origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
}
function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function fail(res, status, error) { json(res, status, { error }); }
function issuePair(subject, role, nonce, authTime = Math.floor(Date.now() / 1000)) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const access = accessToken(subject, role);
  const identity = jwt({ iss: issuer, aud: clientId, sub: subject, iat: issuedAt,
    exp: issuedAt + 600, auth_time: authTime, ...(nonce ? { nonce } : {}), role });
  const refresh = randomBytes(32).toString("base64url");
  refreshTokens.set(refresh, { subject, role, nonce, authTime, expires: Date.now() + 600_000 });
  return { access_token: access, id_token: identity, token_type: "Bearer", expires_in: 600,
    refresh_token: refresh, scope: "openid profile offline_access" };
}
function authorize(res, url) {
  const q = url.searchParams;
  const challenge = q.get("code_challenge") || "";
  const state = q.get("state") || "";
  const nonce = q.get("nonce") || "";
  const valid = q.get("response_type") === "code" && q.get("client_id") === clientId
    && q.get("redirect_uri") === redirectUri && q.get("code_challenge_method") === "S256"
    && /^[A-Za-z0-9_-]{43,128}$/.test(challenge) && state.length > 16 && (!nonce || nonce.length > 16)
    && (q.get("scope") || "").split(" ").includes("openid");
  if (!valid) {
    console.log("OIDC_AUTHORIZE_REJECT", JSON.stringify({
      responseType: q.get("response_type"),
      clientMatch: q.get("client_id") === clientId,
      redirectMatch: q.get("redirect_uri") === redirectUri,
      method: q.get("code_challenge_method"),
      challengeLength: challenge.length,
      stateLength: state.length,
      nonceLength: nonce.length,
      openidScope: (q.get("scope") || "").split(" ").includes("openid")
    }));
    return fail(res, 400, "invalid_request");
  }
  const code = randomBytes(32).toString("base64url");
  codes.set(code, { challenge, state, nonce, expires: Date.now() + 60_000, used: false });
  const to = new URL(redirectUri);
  to.searchParams.set("code", code);
  to.searchParams.set("state", state);
  to.searchParams.set("iss", issuer);
  res.writeHead(302, { Location: to.toString(), "Cache-Control": "no-store" });
  res.end();
}
async function token(req, res) {
  let body = "";
  for await (const part of req) {
    body += part;
    if (body.length > 8192) return fail(res, 413, "invalid_request");
  }
  const q = new URLSearchParams(body);
  if (q.get("client_id") !== clientId) return fail(res, 400, "invalid_client");
  if (q.get("grant_type") === "authorization_code") {
    const code = q.get("code") || "";
    const entry = codes.get(code);
    codes.delete(code);
    const verifier = q.get("code_verifier") || "";
    const computed = createHash("sha256").update(verifier).digest("base64url");
    if (!entry || entry.used || entry.expires < Date.now() || q.get("redirect_uri") !== redirectUri
      || verifier.length < 43 || computed !== entry.challenge) {
      stats.pkceRejected++;
      return fail(res, 400, "invalid_grant");
    }
    stats.redeemed++;
    return json(res, 200, issuePair("owner-a", "editor", entry.nonce));
  }
  if (q.get("grant_type") === "refresh_token") {
    const refresh = q.get("refresh_token") || "";
    const entry = refreshTokens.get(refresh);
    refreshTokens.delete(refresh);
    if (!entry || entry.expires < Date.now()) return fail(res, 400, "invalid_grant");
    stats.refreshed++;
    return json(res, 200, issuePair(entry.subject, entry.role, entry.nonce, entry.authTime));
  }
  return fail(res, 400, "unsupported_grant_type");
}
function readJwt(bearer) {
  const parts = String(bearer || "").replace(/^Bearer /, "").split(".");
  if (parts.length !== 3) return null;
  try {
    if (!verify("RSA-SHA256", Buffer.from(parts[0]+"."+parts[1]),
        keys.publicKey, Buffer.from(parts[2], "base64url"))) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (claims.iss !== issuer || claims.exp < Date.now()/1000) return null;
    return claims;
  } catch { return null; }
}
const server = http.createServer(async (req, res) => {
  cors(res, req);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url || "/", issuer);
  if (url.pathname === "/.well-known/openid-configuration") return json(res, 200, {
    issuer, authorization_endpoint: issuer + "/authorize",
    token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks",
    userinfo_endpoint: issuer + "/userinfo", end_session_endpoint: issuer + "/logout",
    response_types_supported: ["code"], response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "profile", "offline_access"],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "role"],
  });
  if (url.pathname === "/jwks") return json(res, 200, { keys: [{
    ...keys.publicKey.export({ format: "jwk" }), kid: keys.kid, alg: "RS256", use: "sig"
  }] });
  if (url.pathname === "/authorize" && req.method === "GET") return authorize(res, url);
  if (url.pathname === "/token" && req.method === "POST") return token(req, res);
  if (url.pathname === "/userinfo") {
    const claims = readJwt(req.headers.authorization);
    return claims ? json(res, 200, { sub: claims.sub, role: claims.role }) : fail(res, 401, "invalid_token");
  }
  if (url.pathname === "/logout") {
    const to = url.searchParams.get("post_logout_redirect_uri");
    if (to !== allowedOrigin + "/") return fail(res, 400, "invalid_redirect_uri");
    stats.logout++;
    const redirect = new URL(to);
    if (url.searchParams.has("state")) redirect.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" });
    return res.end();
  }
  if (url.pathname.startsWith("/__ci/")) {
    if (!matchesSecret(req)) return fail(res, 404, "not_found");
    if (url.pathname === "/__ci/stats") return json(res, 200, stats);
    if (url.pathname === "/__ci/rotate") {
      rotateKeys(); return json(res, 200, { rotated: true });
    }
    if (url.pathname === "/__ci/mint") {
      const subject = url.searchParams.get("sub") || "";
      const role = url.searchParams.get("role") || "";
      const type = url.searchParams.get("type") || "";
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(subject) || !["reader","editor","none"].includes(role)
        || !["", "wrong-audience", "expired", "empty-sub", "missing-sub"].includes(type))
        return fail(res, 400, "invalid_user");
      const extra = type === "wrong-audience" ? { aud: "not-the-api" } :
        type === "expired" ? { exp: Math.floor(Date.now()/1000)-120 } :
        type === "empty-sub" ? { sub: "" } :
        type === "missing-sub" ? { sub: undefined } : {};
      return json(res, 200, { access_token: accessToken(subject, role, extra) });
    }
  }
  return fail(res, 404, "not_found");
});
server.listen(8999, "0.0.0.0", () => process.stdout.write("OIDC_CI_PROVIDER_READY\n"));
