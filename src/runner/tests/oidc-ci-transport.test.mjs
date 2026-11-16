import assert from "node:assert/strict";
import { test } from "node:test";
import { oidcCiTransport } from "../scripts/oidc-ci-transport.mjs";

const common = { CI: "true", OIDC_CI_SECRET: "x".repeat(40) };
test("CI transport permits only the two private, fixed issuer aliases and TLS paths", () => {
  assert.deepEqual(oidcCiTransport({ ...common, OIDC_ISSUER: "http://identity:8999" }),
    { secure: false, port: 8999 });
  assert.deepEqual(oidcCiTransport({ ...common, OIDC_ISSUER: "https://identity-tls:9443" }),
    { secure: true, port: 9443, cert: "/ci-tls/server.crt", key: "/ci-tls/server.key" });
});
test("CI transport refuses public, wrong-SAN and wrong-port issuer origins", () => {
  for (const issuer of ["", "https://identity:8999", "http://identity-tls:9443",
    "http://identity:9443", "https://identity-tls:8999",
    "https://evil.example:9443", "https://identity-tls:9443/path",
    "https://identity-tls:9443?secret=1", "https://identity-tls:9443#fragment",
    "https://identity-tls:9443@evil.example", "https://identity-tls:9443/"]) {
    assert.throws(() => oidcCiTransport({ ...common, OIDC_ISSUER: issuer }),
      /approved private Docker alias/);
  }
});
test("CI transport refuses calls without explicit CI and ephemeral control key", () => {
  for (const env of [
    { ...common, CI: "false", OIDC_ISSUER: "http://identity:8999" },
    { ...common, CI: "0", OIDC_ISSUER: "https://identity-tls:9443" },
    { ...common, OIDC_CI_SECRET: "short", OIDC_ISSUER: "https://identity-tls:9443" },
    { ...common, OIDC_CI_SECRET: undefined, OIDC_ISSUER: "http://identity:8999" },
  ]) assert.throws(() => oidcCiTransport(env), /CI-only OIDC transport/);
});
