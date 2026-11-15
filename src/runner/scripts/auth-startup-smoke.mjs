/**
 * CI-only negative startup checks for the actual compiled scaffold API.
 * No network access, secrets or tokens are printed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "src/frontend/generated-fixture");
const csproj = readFileSync(path.join(root, "src/backend/applications/Api/Api.csproj"), "utf8");
const framework = csproj.match(/<TargetFramework>net(10|11)\.0<\/TargetFramework>/)?.[1];
if (!framework) throw Error("Unsupported .NET fixture framework");
const api = path.join(root, "src/backend/applications/Api/bin/Release/net" + framework + ".0/Api.dll");
const key = randomBytes(64).toString("hex");
const baseEnvironment = {
  ...process.env,
  Auth__Mode: "legacy",
  Auth__Issuer: "factory-local",
  Auth__Audience: "factory-client",
  Auth__SigningKey: key,
  Database__ConnectionString: "Host=127.0.0.1;Database=blocked;Username=ci;Password=unused",
  ASPNETCORE_URLS: "http://127.0.0.1:0",
};
const cases = [
  ["Staging", "legacy", "", /Symmetric legacy tokens are allowed only in Development/],
  ["Production", "legacy", "", /Symmetric legacy tokens are allowed only in Development/],
  ["QA", "legacy", "", /Symmetric legacy tokens are allowed only in Development/],
  ["Staging", "oidc", "http://identity:8999", /HTTPS OIDC issuer/],
  ["Production", "oidc", "http://identity:8999", /HTTPS OIDC issuer/],
];
for (const [environment, mode, authority, expected] of cases) {
  const result = spawnSync("dotnet", [api], {
    cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 256_000,
    env: { ...baseEnvironment, ASPNETCORE_ENVIRONMENT: environment,
      Auth__Mode: mode, Auth__Authority: authority },
  });
  assert.equal(result.error, undefined, "dotnet must be runnable for " + environment);
  assert.notEqual(result.status, 0, "Unsafe auth mode must fail before startup: " + environment);
  assert.match(result.stderr + "\n" + result.stdout, expected, "Expected fail-closed rejection: " + environment);
}
console.log("AUTH_STARTUP_NEGATIVE_PASS: 5 actual .NET fail-closed startup checks");
