import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProject } from "../domain/defaults";
import { generateFiles } from "./scaffold";

describe("application scaffold", () => {
  function example() {
    const p = createProject();
    p.config.name = "Legge & Codice";
    p.config.description = "Ricerca giuridica e comparazione documenti.";
    return p;
  }
  it("creates a compile-oriented .NET + React DDD scaffold", () => {
    const files = generateFiles(example());
    expect(files["src/backend/applications/Api/Program.cs"]).toContain('app.MapGet("/health"');
    expect(files["src/backend/domain/Domain.csproj"]).toContain("net11.0");
    expect(files["src/backend/business/Business.csproj"]).toContain("ProjectReference");
    expect(files["src/frontend/web/src/App.tsx"]).toContain("Legge");
    expect(files["docker/compose.yml"]).toContain("postgres:17-alpine");
    expect(files[".github/workflows/ci.yml"]).toContain("dotnet-version: '11.0.x'");
    expect(files["docs/features.md"]).toContain("# Piano feature");
    expect(files["adr/0001-modular-ddd.md"]).toContain("DDD");
    expect(files["infra/main.tf"]).toContain("terraform");
  });
  it("ships an opt-in GitHub Actions test workflow and a fail-closed JSON reporter", () => {
    const files = generateFiles(example());
    const workflow = files[".github/workflows/softwarefactory-tests.yml"];
    const script = files["scripts/softwarefactory-tests.mjs"];
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("run-name: 'SoftwareFactory tests ${{ inputs.request_id }}'");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("permissions:\n  contents: read");
    for (const input of ["dotnet_build", "dotnet_test", "web_build", "web_test", "playwright"])
      expect(workflow).toContain("      " + input + ":");
    expect(workflow).toContain("Upload JSON report even if tests fail");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("retention-days: 14");
    expect(workflow).not.toContain("contents: write");
    expect(script).not.toContain("shell: true");
    expect(script).toContain('state: "incomplete"');
    expect(script).toContain("softwarefactory-results");
    expect(script).toContain("checkout_sha_mismatch");
    const dir = mkdtempSync(path.join(tmpdir(), "sf-actions-"));
    try {
      const target = path.join(dir, "scripts", "softwarefactory-tests.mjs");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, script);
      const processResult = spawnSync(process.execPath, [target], { cwd: dir,
        encoding: "utf8", timeout: 5000,
        env: { ...process.env, SF_REQUEST_ID: "123e4567-e89b-42d3-a456-426614174000",
          GITHUB_SHA: "a".repeat(40), GITHUB_REF_NAME: "main",
          GITHUB_REPOSITORY: "octocat/app", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1",
          SF_DOTNET_BUILD: "false", SF_DOTNET_TEST: "false", SF_WEB_BUILD: "false",
          SF_WEB_TEST: "false", SF_PLAYWRIGHT: "false" } });
      expect(processResult.status).toBe(1);
      const generated = JSON.parse(readFileSync(path.join(dir, "softwarefactory-results", "report.json"), "utf8"));
      expect(generated.schemaVersion).toBe(1);
      expect(generated.state).toBe("incomplete");
      expect(generated.summary.passed).toBe(0);
      expect(generated.commitSha).toBe("a".repeat(40));
      expect(JSON.stringify(generated)).not.toContain("github_pat_");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("supports branch-independent multiple frontend target placeholders", () => {
    const p = example();
    p.config.frontends = ["react", "react-native", "ios", "unity"];
    const files = generateFiles(p);
    expect(files["src/frontend/mobile-react-native/README.md"]).toContain("placeholder");
    expect(files["src/frontend/ios/README.md"]).toContain("placeholder");
    expect(files["src/frontend/unity/README.md"]).toContain("placeholder");
  });
  it("changes templates on .NET and provider selection", () => {
    const p = example(); p.config.dotnetVersion = "10.0"; p.config.deployment = "azure";
    const files = generateFiles(p);
    expect(files["docker/Api.Dockerfile"]).toContain("sdk:10.0");
    expect(files["infra/main.tf"]).toContain("azurerm_resource_group");
    expect(files["src/backend/domain/Domain.csproj"]).toContain("net10.0");
  });
  it("rejects missing brief and does not include secrets", () => {
    const p = example(); p.config.description = "";
    expect(() => generateFiles(p)).toThrow();
    p.config.description = "A platform";
    const files = generateFiles(p);
    expect(JSON.stringify(files)).not.toContain("github_pat_");
    expect(JSON.parse(files[".softwarefactory/manifest.json"]).config.database).toBe("postgresql");
  });
  it("emits a pinned Chromium Playwright suite and CI browser gate", () => {
    const files = generateFiles(example());
    const packageJson = JSON.parse(files["src/frontend/web/package.json"]);
    expect(packageJson.devDependencies["@playwright/test"]).toBe("1.64.1");
    expect(packageJson.scripts["test:e2e"]).toBe("playwright test");
    expect(files["src/frontend/web/playwright.config.ts"]).toContain("127.0.0.1:4173");
    expect(files["src/frontend/web/playwright.config.ts"]).toContain("chromium");
    expect(files["src/frontend/web/e2e/smoke.spec.ts"]).toContain("API raggiungibile");
    expect(files["src/frontend/web/e2e/smoke.spec.ts"]).toContain("API non raggiungibile");
    expect(files["src/frontend/web/e2e/smoke.spec.ts"]).toContain('toHaveText("Legge & Codice")');
    expect(files[".github/workflows/ci.yml"]).toContain("npx playwright install --with-deps chromium");
    expect(files[".github/workflows/ci.yml"]).toContain("npm run test:e2e");
    expect(files[".gitignore"]).toContain("test-results/");
  });
  it("generates separate mocked and live API browser integration modes", () => {
    const files = generateFiles(example());
    const config = files["src/frontend/web/playwright.config.ts"];
    const smoke = files["src/frontend/web/e2e/smoke.spec.ts"];
    const backend = files["src/backend/applications/Api/Program.cs"];
    const workflow = files[".github/workflows/ci.yml"];
    expect(config).toContain('process.env.E2E_MODE === "integration"');
    expect(config).toContain("E2E_WEB_ORIGIN");
    expect(files["src/frontend/web/vite.config.ts"]).toContain('allowedHosts: ["web"]');
    expect(config).toContain("E2E_WEB_SERVER_EXTERNAL");
    expect(smoke).toContain("const integration =");
    expect(smoke).toContain('if (!integration) await page.route(api + "/health"');
    expect(smoke).toContain('page.waitForResponse(response => response.url() === api + "/health")');
    expect(smoke).toContain('request.get(api + "/api/info")');
    expect(smoke).toContain('test.skip(!integration');
    expect(smoke).toContain('status: "scaffold"');
    const browserCors = files["src/backend/applications/Api/BrowserCorsStartup.cs"];
    expect(backend).toContain("builder.AddBrowserCors();");
    expect(browserCors).toContain('"http://web:4173"');
    expect(browserCors).toContain('"http://127.0.0.1:4173"');
    expect(workflow).toContain("Verify browser, real ASP.NET Core API and PostgreSQL");
    expect(workflow).toContain("E2E_DATABASE=postgresql");
    expect(workflow).toContain("docker exec");
    expect(workflow).toContain("openssl rand -hex 24");
    expect(workflow).toContain("E2E_MODE=integration");
    expect(workflow).toContain("E2E_API_ORIGIN=http://127.0.0.1:8080");
    expect(workflow).toContain("curl -fsS http://127.0.0.1:8080/health");
  });
  it("keeps cross-tab OIDC logout terminal against delayed refresh and stale boot sync", () => {
    const generated = generateFiles(example());
    const component = generated["src/frontend/web/src/WorkItems.tsx"];
    const browser = generated["src/frontend/web/e2e/smoke.spec.ts"];
    expect(component).toContain("const logoutFence = useRef(false)");
    expect(component).toContain("if (active && !logoutFence.current)");
    expect(component).toContain("if (logoutFence.current)");
    expect(component).toContain("logoutFence.current = true;");
    expect(component).toContain("void manager.removeUser().catch(() => {})");
    expect(component).toContain('setItems([]); setEditing(null); setTitle(""); setDraft("");');
    expect(browser).toContain("late OIDC silent refresh cannot resurrect a cross-tab logged-out session");
    expect(browser).toContain('const response = await route.fetch()');
    expect(browser).toContain('await releaseGate');
    expect(browser).toContain("Object.keys(sessionStorage)");
  });
  it("does not invalidate an in-flight save for duplicate OIDC userLoaded callbacks", () => {
    const files = generateFiles(example());
    const ui = files["src/frontend/web/src/WorkItems.tsx"];
    const e2e = files["src/frontend/web/e2e/smoke.spec.ts"];
    expect(ui).toContain('if (nextToken && activeToken.current === nextToken && !logoutFence.current) return;');
    expect(ui).toContain('sessionEpoch.current++;');
    expect(e2e).toContain('const createResponsePromise = page.waitForResponse');
    expect(e2e).toContain('response.request().method() === "POST"');
    expect(e2e).toContain('expect(createResponse.ok(), "Real API create returned HTTP " + createResponse.status())');
    expect(e2e).toContain('test("duplicate OIDC userLoaded notifications cannot discard a real PostgreSQL POST"');
    expect(e2e).toContain('const response = await route.fetch();');
    expect(e2e).toContain('await manager.events.load(user, true);');
    expect(e2e).toContain('await expect(page.getByLabel("Titolo elemento")).toHaveValue(unique);');
    expect(e2e).toContain('await route.fulfill({ response });');
    expect(e2e).toContain('await expect(page.getByText(unique, { exact: true })).toBeVisible();');
    // A negative API outcome is a test failure, never a silently green run.
    expect(e2e).not.toContain('continueOnError: true');
  });
  it("fences every generated PostgreSQL mutation and 401 to the active OIDC session", () => {
    const files = generateFiles(example());
    const component = files["src/frontend/web/src/WorkItems.tsx"];
    const browser = files["src/frontend/web/e2e/smoke.spec.ts"];
    expect(component).toContain("const sessionEpoch = useRef(0)");
    expect(component).toContain("sessionEpoch.current++");
    expect(component).toContain("sessionEpoch.current === expectedEpoch");
    expect(component).toContain("clearUnauthorizedSession(token, expectedEpoch)");
    expect(component.match(/const mutationIsCurrent = \(\) => sessionMatches\(token, expectedEpoch\)/g)).toHaveLength(3);
    expect(component.match(/if \(!mutationIsCurrent\(\)\) return;/g)).toHaveLength(6);
    expect(component.match(/if \(mutationIsCurrent\(\)\) setBusy\(false\)/g)).toHaveLength(3);
    expect(component.match(/if \(mutationIsCurrent\(\)\) setError\(/g)).toHaveLength(3);
    expect(browser).toContain("late OIDC POST response after cross-tab logout cannot restore private items");
    expect(browser).toContain("const response = await route.fetch()");
    expect(browser).toContain("await releaseGate");
  });
  it("generates real PostgreSQL repository, migrations and a browser CRUD journey", () => {
    const files = generateFiles(example());
    const infrastructure = files["src/backend/infrastructure/Infrastructure.csproj"];
    const migrate = files["src/backend/infrastructure/PostgresSchemaMigrator.cs"];
    const repository = files["src/backend/infrastructure/PostgresWorkItemRepository.cs"];
    const program = files["src/backend/applications/Api/Program.cs"];
    expect(infrastructure).toContain('PackageReference Include="Npgsql" Version="10.0.3"');
    expect(infrastructure).toContain('<TargetFramework>net11.0</TargetFramework>');
    expect(infrastructure).toContain('EmbeddedResource Include="Migrations/*.sql"');
    expect(migrate).toContain("factory_schema_migrations");
    expect(migrate).toContain("pg_advisory_xact_lock");
    expect(files["src/backend/infrastructure/Migrations/0001_create_work_items.sql"]).toContain("CREATE TABLE work_items");
    expect(repository).toContain("NpgsqlParameter<Guid>");
    expect(repository).toContain("WHERE id = $1");
    expect(repository).toContain("UPDATE work_items SET title = $3 WHERE id = $1 AND owner_id = $2");
    expect(repository).toContain("work_item_audit");
    expect(files["src/backend/infrastructure/Migrations/0002_owner_and_audit.sql"]).toContain("owner_id text NOT NULL");
    expect(files["src/backend/business/WorkItemService.cs"]).toContain("UpdateAsync");
    expect(files["src/backend/domain/WorkItem.cs"]).toContain("UpdateAsync");
    expect(program).toContain('app.MapPost("/api/items"');
    expect(program).toContain('app.MapDelete("/api/items/{id:guid}"');
    expect(program).toContain('app.MapPut("/api/items/{id:guid}"');
    expect(program).toContain("ApplyAsync()");
    expect(program).toContain('RequireAuthorization("items.write")');
    expect(program).toContain('RequireAuthorization("items.read")');
    expect(program).toContain('UseAuthentication()');
    expect(program).toContain('UseRateLimiter()');
    expect(files["src/backend/applications/Api/AuthStartup.cs"]).toContain("JwtBearerDefaults.AuthenticationScheme");
    expect(files["src/backend/applications/Api/AuthStartup.cs"]).toContain("ValidateIssuer = true");
    expect(files["src/backend/applications/Api/AuthStartup.cs"]).toContain("RequireExpirationTime = true");
    expect(files["src/backend/applications/Api/AuthStartup.cs"]).toContain('RequireRole("editor")');
    expect(files["src/backend/applications/Api/Api.csproj"]).toContain("Microsoft.AspNetCore.Authentication.JwtBearer");
    expect(files["tests/security/issue-tokens.mjs"]).toContain('process.env.CI !== "true"');
    expect(files[".github/workflows/ci.yml"]).toContain("Auth__SigningKey=$(openssl rand -hex 48)");
    expect(files[".github/workflows/ci.yml"]).toContain("E2E_OTHER_TOKEN");

    expect(files["src/frontend/web/src/WorkItems.tsx"]).toContain('aria-label="Archivio PostgreSQL"');
    expect(files["src/frontend/web/src/WorkItems.tsx"]).toContain('method: "PUT"');
    expect(files["src/frontend/web/e2e/smoke.spec.ts"]).toContain('getByLabel("Modifica titolo")');
    expect(files["src/frontend/web/src/App.tsx"]).toContain("<WorkItems api={API}/>");
    expect(files["src/frontend/web/e2e/smoke.spec.ts"]).toContain("persists and deletes a work item through real PostgreSQL");
    expect(files["docker/compose.yml"]).toContain("service_healthy");
    expect(files["docker/compose.yml"]).toContain('127.0.0.1:5432:5432');
    expect(files["docker/compose.yml"]).toContain('127.0.0.1:8080:8080');
    expect(files["docker/compose.yml"]).toContain("Auth__SigningKey");
    expect(files["docker/.env.example"]).toContain("AUTH_SIGNING_KEY=");
    expect(files["docker/.env.example"]).not.toContain("AUTH_SIGNING_KEY=abcdef");
    expect(files["docker/compose.yml"]).toContain('Password=${DB_PASSWORD:?Set DB_PASSWORD in .env}');
  });
  it("does not claim PostgreSQL persistence for other database selections", () => {
    for (const database of ["mysql", "sqlserver", "sqlite"] as const) {
      const p = example(); p.config.database = database;
      const files = generateFiles(p);
      expect(files["src/backend/infrastructure/PostgresWorkItemRepository.cs"]).toBeUndefined();
      expect(files["src/frontend/web/src/WorkItems.tsx"]).toBeUndefined();
      expect(files["src/frontend/web/e2e/smoke.spec.ts"]).not.toContain("persists and deletes a work item");
      expect(files[".github/workflows/ci.yml"]).not.toContain("E2E_DATABASE=postgresql");
    }
  });
  it("rejects ambiguous signed OIDC role claims in the generated .NET policy and real-CI fixture", () => {
    const files = generateFiles(example());
    const auth = files["src/backend/applications/Api/AuthStartup.cs"];
    expect(auth).toContain("private static bool HasValidRole");
    expect(auth.match(/HasValidSubject\(context.User\) && HasValidRole\(context.User\)/g)).toHaveLength(2);
    expect(auth).toContain('var roles = user.FindAll("role").ToArray()');
    expect(auth).toContain('roles.Length == 1');
    expect(auth).toContain('roles[0].Value == "reader" || roles[0].Value == "editor"');
    expect(auth).toContain('RequireRole("reader", "editor")');
    expect(auth).toContain('RequireRole("editor")');
  });
  it("emits real OIDC code+PKCE UI and production-only JWKS verifier with explicit legacy-dev mode", () => {
    const files = generateFiles(example());
    const auth = files["src/backend/applications/Api/AuthStartup.cs"];
    const oidc = files["src/frontend/web/src/oidc.ts"];
    const ui = files["src/frontend/web/src/WorkItems.tsx"];
    expect(auth).toContain('Auth:Mode"] ?? "oidc"');
    expect(auth).toContain('mode == "legacy" && !builder.Environment.IsDevelopment()');
    expect(auth).toContain("private static bool HasValidSubject");
    expect(auth).toContain("subjects.Length == 1");
    expect(auth).toContain("!string.IsNullOrWhiteSpace(subjects[0].Value)");
    expect(auth).toContain("subjects[0].Value.Length <= 255");
    expect(auth).toContain("RequireAssertion(context => HasValidSubject(context.User) && HasValidRole(context.User))");
    expect(auth).toContain("options.Authority = issuer");
    expect(auth).toContain("options.RefreshOnIssuerKeyNotFound = true");
    expect(auth).toContain("SecurityAlgorithms.RsaSha256");
    expect(auth).toContain("RequireHttpsMetadata = !builder.Environment.IsDevelopment()");
    expect(oidc).toContain("UserManager");
    expect(oidc).toContain("isTerminalOidcRenewError");
    expect(oidc).toContain("error instanceof ErrorResponse");
    expect(oidc).toContain("renewOidcSession");
    expect(oidc).toContain("subscribeOidcLogout");
    expect(oidc).toContain("broadcastOidcLogout");
    expect(oidc).toContain('oidcLogoutChannel()?.postMessage("logout")');
    expect(oidc).toContain('let logoutChannel: BroadcastChannel | undefined;');
    expect(oidc).toContain("if (!logoutChannel) logoutChannel = new BroadcastChannel(logoutChannelName)");
    expect(oidc).toContain("logoutSubscribers++");
    expect(oidc).toContain("logoutSubscribers--");
    expect(oidc).toContain('if (event.data === "logout") handler()');
    expect(oidc).toContain('channel.removeEventListener("message", onMessage)');
    expect(oidc).toContain("channel.close()");
    expect(oidc).not.toContain("localStorage");
    expect(ui).toContain("stopCrossTabLogout()");
    expect(ui).toContain("Sessione chiusa da un'altra scheda.");
    expect(ui).toContain("broadcastOidcLogout()");
    const multiTabE2e = files["src/frontend/web/e2e/smoke.spec.ts"];
    expect(multiTabE2e).toContain("manual OIDC logout clears another authenticated browser tab");
    expect(multiTabE2e).toContain("real API 401 in one OIDC browser tab invalidates another tab");
    expect(multiTabE2e).toContain("page.context().newPage()");
    expect(multiTabE2e).toContain("authorization: \"Bearer invalid.jwt.token\"");
    expect(multiTabE2e).toContain("other.reload()");

    expect(oidc).toContain("current?.refresh_token === before.refresh_token");
    expect(ui).toContain("addSilentRenewError");
    expect(ui).toContain("addUserUnloaded");
    expect(ui).toContain("removeSilentRenewError");
    const renewE2e = files["src/frontend/web/e2e/smoke.spec.ts"];
    expect(renewE2e).toContain("revoked OIDC refresh token clears session after real invalid_grant");
    expect(renewE2e).toContain("transient refresh network failure retains a valid OIDC session");
    expect(renewE2e).toContain('route.abort("failed")');
    expect(oidc).toContain('response_type: "code"');
    expect(oidc).toContain("WebStorageStateStore");
    expect(oidc).toContain("extraQueryParams");
    expect(files["src/frontend/web/e2e/smoke.spec.ts"]).toContain("E2E_EMPTY_SUB_TOKEN");
    expect(files["src/frontend/web/e2e/smoke.spec.ts"]).toContain("E2E_MISSING_SUB_TOKEN");
    expect(ui).toContain("signinRedirect()");
    const browserE2e = files["src/frontend/web/e2e/smoke.spec.ts"];
    expect(browserE2e).toContain("renews OIDC session with rotated refresh token and real API access");
    expect(browserE2e).toContain("manager.signinSilent()");
    expect(browserE2e).toContain("refreshRotated");
    expect(browserE2e).toContain("replayDenied: replay.status === 400");
    expect(browserE2e).toContain("apiAuthorized: result.status === 200");
    expect(browserE2e).toContain("const providerLogout = page.waitForResponse");
    expect(browserE2e).toContain('key.startsWith("oidc.user:")');
    expect(ui).toContain("clearUnauthorizedSession");
    expect(ui).toContain("oidcManager().removeUser()");
    expect(ui).toContain('sessionStorage.removeItem("sf_api_access_token")');
    expect(ui).toContain("sessionMatches(usedToken, expectedEpoch)");
    expect((ui.match(/response.status === 401/g) || []).length).toBe(4);
    expect(ui).toContain("Sessione scaduta o non più valida. Accedi nuovamente.");
    const e2e = files["src/frontend/web/e2e/smoke.spec.ts"];
    expect(e2e).toContain("clears a stored browser session when the real API returns 401 on list");
    expect(e2e).toContain("clears the identity after a real API 401 on create");
    expect(e2e).toContain("preserves the session for a real API 403 role denial");
    expect(e2e).toContain('route.continue({ headers:');
    expect(oidc).toContain("signinRedirectCallback()");
    expect(oidc).toContain("signoutRedirectCallback()");
    expect(ui).toContain("signoutRedirect()");
    expect(ui).toContain("Accesso OpenID Connect");
    expect(JSON.parse(files["src/frontend/web/package.json"]).dependencies["oidc-client-ts"]).toBe("3.5.0");
    expect(files["docker/compose.yml"]).toContain("AUTH_MODE:-oidc");
    expect(files["docker/compose.yml"]).toContain("Auth__Authority");
    expect(files["docker/compose.yml"]).toContain("OIDC_PUBLIC_CLIENT_ID");
    expect(files["docker/Web.Dockerfile"]).toContain("nginx.conf");
    expect(files["docker/Web.Dockerfile"]).toContain("default.conf" + String.fromCharCode(10) + "EXPOSE 80");
    expect(files["src/frontend/web/nginx.conf"]).toContain("try_files $uri $uri/ /index.html");
    expect(files["README.md"]).toContain("Auth__Mode=oidc");
    expect(files["src/frontend/web/nginx.conf"]).toContain("X-Content-Type-Options");
    const nginx = files["src/frontend/web/nginx.conf"];
    const cspBuilder = files["src/frontend/web/scripts/build-nginx.mjs"];
    expect(nginx).toContain("Content-Security-Policy");
    expect(nginx).toContain("script-src 'self'");
    expect(nginx).toContain("frame-ancestors 'none'");
    expect(nginx).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(cspBuilder).toContain("VITE_OIDC_AUTHORITY");
    expect(cspBuilder).toContain("VITE_API_URL");
    expect(cspBuilder).toContain("SF_CSP_INTERNAL_TEST");
    expect(cspBuilder).toContain("writeFileSync");
    expect(files["docker/Web.Dockerfile"]).toContain("RUN node scripts/build-nginx.mjs");
    expect(files["docker/Web.Dockerfile"]).toContain("COPY --from=build /app/nginx.conf");
    const browserCsp = files["src/frontend/web/e2e/smoke.spec.ts"];
    expect(browserCsp).toContain("enforces Nginx CSP in Chromium");
    expect(browserCsp).toContain("E2E_CSP_ORIGIN");
    expect(browserCsp).toContain("__sfCspInjected");

    expect(files["docker/compose.yml"]).toContain("AUTH_SIGNING_KEY:-");
    expect(files["docker/compose.yml"]).toContain("AUTH_AUDIENCE:?");
    expect(files[".github/workflows/ci.yml"]).toContain("Auth__Mode=legacy");
    expect(oidc).not.toContain("Auth__SigningKey");
    expect(ui).not.toContain("VITE_OIDC_CLIENT_SECRET");
  });
  it("generates no-store OIDC callback with inherited CSP and rejects incomplete origins", () => {
    const files = generateFiles(example());
    const stock = files["src/frontend/web/nginx.conf"];
    const builder = files["src/frontend/web/scripts/build-nginx.mjs"];
    expect(stock).toContain('add_header Cache-Control "no-store" always;');
    expect(stock).toContain("add_header Content-Security-Policy");
    expect(stock).toContain("location / { try_files $uri $uri/ /index.html; }");
    expect(stock).not.toContain("location = /auth/callback");
    expect(builder).toContain("configuredOidc !== 0 && configuredOidc !== 3");
    expect(files["src/frontend/web/e2e/smoke.spec.ts"])
      .toContain('expect(callback.headers()["cache-control"]).toContain("no-store")');

    // Execute the generated build script in an isolated local directory:
    // this tests the resulting real nginx.conf, not just a string template.
    const directory = mkdtempSync(path.join(tmpdir(), "sf-oidc-csp-"));
    const scripts = path.join(directory, "scripts");
    mkdirSync(scripts);
    const scriptPath = path.join(scripts, "build-nginx.mjs");
    const outputPath = path.join(directory, "nginx.conf");
    writeFileSync(scriptPath, builder, { mode: 0o600 });
    const run = (vars: Record<string, string>) => {
      rmSync(outputPath, { force: true });
      return spawnSync(process.execPath, [scriptPath], {
        encoding: "utf8", timeout: 6000, maxBuffer: 65536,
        env: { PATH: process.env.PATH || "/usr/bin:/bin",
          HOME: process.env.HOME || "/tmp", ...vars },
      });
    };
    try {
      const local = run({});
      expect(local.status).toBe(0);
      expect(local.stdout).toContain("CSP_NGINX_BUILD_PASS");
      const localNginx = readFileSync(outputPath, "utf8");
      expect(localNginx).toContain('add_header Cache-Control "no-store" always;');
      expect(localNginx).toContain("add_header Content-Security-Policy");
      expect(localNginx).toContain("connect-src 'self' http://localhost:8080");
      expect(localNginx).not.toMatch(/script-src[^;]*unsafe-eval/);

      const production = run({
        VITE_API_URL: "https://api.example.test",
        VITE_OIDC_AUTHORITY: "https://login.example.test",
        VITE_OIDC_CLIENT_ID: "public-browser",
        VITE_OIDC_AUDIENCE: "https://api.example.test",
      });
      expect(production.status).toBe(0);
      const nginx = readFileSync(outputPath, "utf8");
      expect(nginx).toContain("connect-src 'self' https://api.example.test https://login.example.test");
      expect(nginx).toContain("frame-src https://login.example.test");
      expect(nginx).toContain("form-action 'self' https://login.example.test");
      expect(nginx).toContain('add_header Cache-Control "no-store" always;');
      expect(nginx).not.toContain("http://localhost:8080");

      const config = {
        VITE_OIDC_AUTHORITY: "https://login.example.test",
        VITE_OIDC_CLIENT_ID: "public-browser",
        VITE_OIDC_AUDIENCE: "https://api.example.test",
      };
      for (const missing of Object.keys(config)) {
        const vars: Record<string, string> = { ...config };
        delete vars[missing];
        const failed = run(vars);
        expect(failed.status).not.toBe(0);
        expect(failed.stderr).toContain("OIDC public configuration is incomplete");
        expect(() => readFileSync(outputPath, "utf8")).toThrow();
      }
      for (const key of Object.keys(config)) {
        const failed = run({ [key]: config[key as keyof typeof config] });
        expect(failed.status).not.toBe(0);
        expect(failed.stderr).toContain("OIDC public configuration is incomplete");
      }
      const whitespace = run({ ...config, VITE_OIDC_CLIENT_ID: "   " });
      expect(whitespace.status).not.toBe(0);
      expect(whitespace.stderr).toContain("OIDC public configuration is incomplete");
      for (const invalid of [
        "http://idp.example.test",
        "https://idp.example.test/\r\nInjected:yes",
        "https://login.example.test/?query=bad",
      ]) {
        const rejected = run({ ...config, VITE_OIDC_AUTHORITY: invalid });
        expect(rejected.status).not.toBe(0);
        expect(() => readFileSync(outputPath, "utf8")).toThrow();
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("renders dev and HTTPS OIDC production Compose with safe browser origins", () => {
    const files = generateFiles(example());
    const compose = files["docker/compose.yml"];
    const envExample = files["docker/.env.example"];
    const readme = files["README.md"];
    expect(compose).toContain('      ASPNETCORE_ENVIRONMENT: "${APP_ENVIRONMENT:-Development}"');
    expect(compose).toContain('        VITE_API_URL: "${PUBLIC_API_URL:-http://localhost:8080}"');
    expect(compose).toContain('        VITE_OIDC_AUDIENCE: "${OIDC_PUBLIC_AUDIENCE:-}"');
    expect(compose).not.toContain('        VITE_OIDC_AUDIENCE: "${AUTH_AUDIENCE:-}"');
    expect(compose).toContain('      - "127.0.0.1:3000:80"');
    expect(compose).not.toContain('      - "3000:80"');
    expect(compose).toContain('      - "127.0.0.1:8080:8080"');
    expect(envExample).toContain("APP_ENVIRONMENT=Development");
    expect(envExample).toContain("PUBLIC_API_URL=http://localhost:8080");
    expect(envExample).toContain("OIDC_PUBLIC_AUDIENCE=");
    expect(readme).toContain("APP_ENVIRONMENT=Production");
    expect(readme).toContain("PUBLIC_API_URL=https://api.example");
    expect(readme).toContain("OIDC_PUBLIC_AUDIENCE");

    // Render the actual generated Compose with the Docker CLI where installed.
    // Do not contact Docker daemon or run any service; local frontend-only
    // developers without Docker can still run the pure template assertions.
    const processEnv = { PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: process.env.HOME || "/tmp" };
    const available = spawnSync("docker", ["compose", "version"], {
      encoding: "utf8", timeout: 6000, maxBuffer: 65536, env: processEnv,
    });
    if (available.error &&
        (available.error as NodeJS.ErrnoException).code === "ENOENT") {
      if (process.env.CI === "true") throw Error("Docker Compose required by CI");
      return;
    }
    expect(available.status, available.stderr).toBe(0);
    const directory = mkdtempSync(path.join(tmpdir(), "sf-composed-oidc-"));
    const dockerDir = path.join(directory, "docker");
    mkdirSync(dockerDir);
    const composeFile = path.join(dockerDir, "compose.yml");
    const envFile = path.join(dockerDir, ".env");
    writeFileSync(composeFile, compose, { mode: 0o600 });
    const render = (envLines: string[]) => {
      writeFileSync(envFile, envLines.join("\n") + "\n", { mode: 0o600 });
      const output = spawnSync("docker", [
        "compose", "-f", composeFile, "--env-file", envFile,
        "config", "--format", "json",
      ], { encoding: "utf8", timeout: 12000,
        maxBuffer: 1_000_000, env: processEnv });
      expect(output.status, output.stderr).toBe(0);
      return JSON.parse(output.stdout) as {
        services: {
          api: { environment: Record<string, string>;
            ports: Array<{ host_ip: string; published: string }> };
          web: { build: { args: Record<string, string> };
            ports: Array<{ host_ip: string; published: string }> };
        };
      };
    };
    try {
      const local = render([
        "DB_PASSWORD=ci-local-only-placeholder",
        "AUTH_MODE=legacy", "AUTH_AUDIENCE=factory-web",
        "AUTH_SIGNING_KEY=ci-local-only-placeholder-key-xxxxxxxxxxxxxxxxxxxxxxxx",
      ]);
      expect(local.services.api.environment.ASPNETCORE_ENVIRONMENT).toBe("Development");
      expect(local.services.web.build.args.VITE_API_URL).toBe("http://localhost:8080");
      expect(local.services.web.build.args.VITE_OIDC_AUTHORITY).toBe("");
      expect(local.services.web.build.args.VITE_OIDC_CLIENT_ID).toBe("");
      expect(local.services.web.build.args.VITE_OIDC_AUDIENCE).toBe("");
      expect(local.services.web.ports[0].host_ip).toBe("127.0.0.1");
      expect(String(local.services.web.ports[0].published)).toBe("3000");
      expect(local.services.api.ports[0].host_ip).toBe("127.0.0.1");

      const production = render([
        "DB_PASSWORD=ci-production-only-placeholder",
        "APP_ENVIRONMENT=Production",
        "PUBLIC_API_URL=https://api.example.test",
        "AUTH_MODE=oidc",
        "AUTH_AUDIENCE=resource-app",
        "AUTH_AUTHORITY=https://login.example.test",
        "OIDC_PUBLIC_AUTHORITY=https://login.example.test",
        "OIDC_PUBLIC_CLIENT_ID=public-browser",
        "OIDC_PUBLIC_AUDIENCE=resource-app",
      ]);
      expect(production.services.api.environment.ASPNETCORE_ENVIRONMENT).toBe("Production");
      expect(production.services.api.environment.Auth__Mode).toBe("oidc");
      expect(production.services.api.environment.Auth__Authority)
        .toBe("https://login.example.test");
      expect(production.services.web.build.args.VITE_API_URL).toBe("https://api.example.test");
      expect(production.services.web.build.args.VITE_OIDC_AUTHORITY)
        .toBe("https://login.example.test");
      expect(production.services.web.build.args.VITE_OIDC_CLIENT_ID).toBe("public-browser");
      expect(production.services.web.build.args.VITE_OIDC_AUDIENCE).toBe("resource-app");
      expect(production.services.web.ports[0].host_ip).toBe("127.0.0.1");
      expect(String(production.services.web.ports[0].published)).toBe("3000");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30000); // Docker Compose CLI can be slow under parallel CI workloads.
  it("renders optional services before top-level volumes across all database variants", () => {
    const processEnv = { PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: process.env.HOME || "/tmp" };
    const available = spawnSync("docker", ["compose", "version"], {
      encoding: "utf8", timeout: 6000, maxBuffer: 65536, env: processEnv,
    });
    const hasCompose = available.status === 0;
    if (!hasCompose && process.env.CI === "true")
      throw Error("Docker Compose is mandatory for the CI schema check");
    const directory = mkdtempSync(path.join(tmpdir(), "sf-compose-services-"));
    const dockerDir = path.join(directory, "docker");
    mkdirSync(dockerDir);
    const composeFile = path.join(dockerDir, "compose.yml");
    const envFile = path.join(dockerDir, ".env");
    writeFileSync(envFile, [
      "DB_PASSWORD=ci-only-fake-db-password",
      "DB_ROOT_PASSWORD=ci-only-fake-root-password",
      "AUTH_AUDIENCE=factory-web",
      "AUTH_MODE=legacy",
      "MINIO_USER=ci-only-minio",
      "MINIO_PASSWORD=ci-only-fake-minio-password",
    ].join("\n") + "\n", { mode: 0o600 });
    try {
      for (const database of ["postgresql", "mysql", "sqlserver", "sqlite"] as const) {
        const project = example();
        project.config.database = database;
        project.config.services.cache.development = "redis";
        project.config.services.queue.development = "rabbitmq";
        project.config.services.telemetry.development = "opentelemetry-jaeger";
        project.config.services.storage.development = "minio";
        const files = generateFiles(project);
        const compose = files["docker/compose.yml"];
        const volumeName = database === "postgresql" ? "pgdata" :
          database === "mysql" ? "mysqldata" :
          database === "sqlserver" ? "sqlserverdata" : null;
        expect(compose).toContain("  jaeger:");
        expect(compose).toContain("  rabbitmq:");
        expect(compose).toContain("  redis:");
        expect(compose).toContain("  minio:");
        expect(compose).toContain('      - "127.0.0.1:15672:15672"');
        expect(compose).toContain('      - "127.0.0.1:16686:16686"');
        expect(compose).toContain('      - "127.0.0.1:4317:4317"');
        if (volumeName) {
          const marker = "\nvolumes:\n";
          expect(compose).toContain(marker);
          expect(compose.indexOf("  minio:")).toBeLessThan(compose.indexOf(marker));
          expect(compose).toContain(marker + "  " + volumeName + ":\n");
        } else {
          expect(compose).not.toContain("\nvolumes:\n");
        }
        if (!hasCompose) continue;
        writeFileSync(composeFile, compose, { mode: 0o600 });
        const out = spawnSync("docker", [
          "compose", "-f", composeFile, "--env-file", envFile,
          "config", "--format", "json",
        ], { encoding: "utf8", timeout: 12000,
          maxBuffer: 1_000_000, env: processEnv });
        expect(out.status, database + ": " + out.stderr).toBe(0);
        const rendered = JSON.parse(out.stdout) as {
          services: Record<string, {
            ports?: Array<{ host_ip: string; published: string }>;
          }>;
          volumes?: Record<string, unknown>;
        };
        for (const service of ["api", "web", "redis", "rabbitmq", "jaeger", "minio"])
          expect(rendered.services[service], service + " missing for " + database).toBeDefined();
        if (volumeName) expect(rendered.volumes?.[volumeName]).toBeDefined();
        else expect(rendered.volumes || {}).toEqual({});
        for (const exposed of ["web", "rabbitmq", "jaeger"]) {
          expect(rendered.services[exposed].ports?.length).toBeGreaterThan(0);
          for (const port of rendered.services[exposed].ports || [])
            expect(port.host_ip, exposed + " not loopback").toBe("127.0.0.1");
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("generates strict production OIDC CORS allowlist without wildcard or credentials", () => {
    const files = generateFiles(example());
    const program = files["src/backend/applications/Api/Program.cs"];
    const cors = files["src/backend/applications/Api/BrowserCorsStartup.cs"];
    const compose = files["docker/compose.yml"];
    expect(cors).toContain('builder.Configuration["Web:AllowedOrigins"]');
    expect(cors).toContain('!builder.Environment.IsDevelopment()');
    expect(cors).toContain("configured.Split(',', StringSplitOptions.None)");
    expect(cors).toContain("origins.Length > 8");
    expect(cors).toContain("origins.Distinct(StringComparer.Ordinal)");
    expect(cors).toContain("origin.Contains('*')");
    expect(cors).toContain("uri.UserInfo.Length != 0");
    expect(cors).toContain("uri.Query.Length != 0");
    expect(cors).toContain("uri.Fragment.Length != 0");
    expect(cors).toContain('uri.AbsolutePath != "/"');
    expect(cors).toContain("uri.GetLeftPart(UriPartial.Authority)");
    expect(cors).toContain("Uri.UriSchemeHttps");
    expect(cors).toContain("uri.IsLoopback");
    expect(cors).toContain('uri.Host == "web"');
    expect(cors).toContain("policy.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod()");
    expect(cors).not.toContain("AllowAnyOrigin");
    expect(cors).not.toContain("AllowCredentials");
    expect(program).toContain("builder.AddBrowserCors();");
    expect(program).toContain('app.UseCors("web");');
    expect(program).not.toContain('policy.WithOrigins("http://localhost:3000"');
    expect(compose).toContain('Web__AllowedOrigins: "${WEB_ALLOWED_ORIGINS:-}"');
    expect(files["docker/.env.example"]).toContain("WEB_ALLOWED_ORIGINS=");
    expect(files["README.md"]).toContain("WEB_ALLOWED_ORIGINS=https://app.example");
    const e2e = files["src/frontend/web/e2e/smoke.spec.ts"];
    expect(e2e).toContain("API CORS preflight allows only configured browser origins");
    expect(e2e).toContain('"Access-Control-Request-Method": "POST"');
    expect(e2e).toContain('response.headers()["access-control-allow-origin"]');
    expect(e2e).toContain("https://attacker.example");

    const other = example();
    other.config.database = "mysql";
    const noOidc = generateFiles(other);
    expect(noOidc["src/backend/applications/Api/BrowserCorsStartup.cs"]).toBeUndefined();
    expect(noOidc["docker/compose.yml"]).not.toContain("Web__AllowedOrigins");
  });
  it("can target Kubernetes and optional services", () => {
    const p = example(); p.config.deployment = "kubernetes";
    p.config.services.queue.development = "rabbitmq";
    p.config.services.cache.development = "redis";
    const files = generateFiles(p);
    expect(files["infra/kubernetes/api.yaml"]).toContain("Deployment");
    expect(files["docker/compose.yml"]).toContain("rabbitmq");
    expect(files["docker/compose.yml"]).toContain("redis");
  });
});
