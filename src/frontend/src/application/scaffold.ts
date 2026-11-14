import type { FactoryProject, FrontendKind, ProjectConfig } from "../domain/types";

const PLAYWRIGHT_VERSION = "1.64.1"; // Keep in sync with the runner browser image.
function lines(...parts: string[]): string { return parts.join("\n") + "\n"; }
function slugify(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "factory-app";
}
function dockerCompose(c: ProjectConfig): string {
  const deps = c.database !== "sqlite" ? ["db"] : [];
  const services = [
    "services:",
    "  api:",
    "    build:",
    "      context: ..",
    "      dockerfile: docker/Api.Dockerfile",
    "    ports:",
    '      - "127.0.0.1:8080:8080"',
    "    environment:",
    "      ASPNETCORE_ENVIRONMENT: Development",
    "      Database__Provider: " + c.database,
    c.database === "postgresql" ? '      Database__ConnectionString: "Host=db;Port=5432;Database=app;Username=app;Password=${DB_PASSWORD:?Set DB_PASSWORD in .env}"' : '      Database__ConnectionString: "${DATABASE_URL:-}"',
  ];
  if (c.database === "postgresql") {
    services.push(
      '      Auth__Mode: "${AUTH_MODE:-oidc}"',
      '      Auth__Authority: "${AUTH_AUTHORITY:-}"',
      '      Auth__Issuer: "${AUTH_ISSUER:-}"',
      '      Auth__Audience: "${AUTH_AUDIENCE:?Set AUTH_AUDIENCE in docker/.env}"',
      '      Auth__SigningKey: "${AUTH_SIGNING_KEY:-}"',
    );
  }
  if (deps.length) services.push("    depends_on:", "      db:", "        condition: " + (c.database === "postgresql" ? "service_healthy" : "service_started"));
  services.push(
    "  web:", "    build:", "      context: ..", "      dockerfile: docker/Web.Dockerfile",
    "      args:", "        VITE_API_URL: http://localhost:8080",
    c.database === "postgresql" ? '        VITE_OIDC_AUTHORITY: "${OIDC_PUBLIC_AUTHORITY:-}"' : "",
    c.database === "postgresql" ? '        VITE_OIDC_CLIENT_ID: "${OIDC_PUBLIC_CLIENT_ID:-}"' : "",
    c.database === "postgresql" ? '        VITE_OIDC_AUDIENCE: "${AUTH_AUDIENCE:-}"' : "",
    "    ports:", '      - "3000:80"',
  );
  if (c.database === "postgresql") {
    services.push("  db:", "    image: postgres:17-alpine", "    environment:",
      "      POSTGRES_DB: app", "      POSTGRES_USER: app", '      POSTGRES_PASSWORD: "${DB_PASSWORD:?Set DB_PASSWORD in .env}"',
      "    ports:", '      - "127.0.0.1:5432:5432"', "    healthcheck:", '      test: ["CMD-SHELL", "pg_isready -U app -d app"]', "      interval: 2s", "      timeout: 2s", "      retries: 20", "    volumes:", "      - pgdata:/var/lib/postgresql/data", "volumes:", "  pgdata:");
  } else if (c.database === "mysql") {
    services.push("  db:", "    image: mysql:8.4", "    environment:", "      MYSQL_DATABASE: app", "      MYSQL_USER: app",
      '      MYSQL_PASSWORD: "${DB_PASSWORD:?Set DB_PASSWORD in .env}"',
      '      MYSQL_ROOT_PASSWORD: "${DB_ROOT_PASSWORD:?Set DB_ROOT_PASSWORD in .env}"',
      "    volumes:", "      - mysqldata:/var/lib/mysql", "volumes:", "  mysqldata:");
  } else if (c.database === "sqlserver") {
    services.push("  db:", "    image: mcr.microsoft.com/mssql/server:2022-latest",
      "    environment:", '      ACCEPT_EULA: "Y"', '      MSSQL_SA_PASSWORD: "${DB_PASSWORD:?Set DB_PASSWORD in .env}"',
      "    volumes:", "      - sqlserverdata:/var/opt/mssql", "volumes:", "  sqlserverdata:");
  }
  if (Object.values(c.services.cache).includes("redis")) services.push(
    "  redis:", "    image: redis:7.4-alpine", "    command: [redis-server, --appendonly, 'yes']");
  if (Object.values(c.services.queue).includes("rabbitmq")) services.push(
    "  rabbitmq:", "    image: rabbitmq:4-management", "    ports:", '      - "15672:15672"');
  if (Object.values(c.services.telemetry).includes("opentelemetry-jaeger")) services.push(
    "  jaeger:", "    image: jaegertracing/all-in-one:1.65.0", "    ports:",
    '      - "16686:16686"', '      - "4317:4317"');
  if (Object.values(c.services.storage).includes("minio")) services.push(
    "  minio:", "    image: minio/minio:RELEASE.2025-02-07T23-21-09Z", "    command: server /data",
    "    environment:", '      MINIO_ROOT_USER: "${MINIO_USER:?Set MINIO_USER}"', '      MINIO_ROOT_PASSWORD: "${MINIO_PASSWORD:?Set MINIO_PASSWORD}"');
  return lines(...services);
}
function terraform(c: ProjectConfig, slug: string): string {
  const head = ['terraform {', '  required_version = ">= 1.7.0"'];
  if (c.deployment === "azure") {
    return lines(...head, '  required_providers { azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" } }', "}",
      'variable "subscription_id" { type = string }', 'variable "location" {\n  type = string\n  default = "westeurope"\n}',
      'provider "azurerm" {', '  features {}', '  subscription_id = var.subscription_id', '}',
      'resource "azurerm_resource_group" "app" {', '  name = "' + slug + '-rg"', '  location = var.location', '}');
  }
  if (c.deployment === "aws") {
    return lines(...head, '  required_providers { aws = { source = "hashicorp/aws", version = "~> 6.0" } }', "}",
      'variable "region" {\n  type = string\n  default = "eu-west-1"\n}',
      'provider "aws" { region = var.region }', "# Add a private network, compute, storage and database with reviewed IAM policies.");
  }
  if (c.deployment === "gcp") {
    return lines(...head, '  required_providers { google = { source = "hashicorp/google", version = "~> 7.0" } }', "}",
      'variable "project_id" { type = string }', 'variable "region" {\n  type = string\n  default = "europe-west1"\n}',
      'provider "google" {', '  project = var.project_id', '  region = var.region', '}',
      "# Add reviewed Cloud Run/GKE, network, Cloud SQL and IAM resources.");
  }
  return lines(...head, "}", '# Local/on-prem deployment: Docker Compose or Kubernetes manifests are under docker/ and infra/kubernetes/.');
}
function frontendFiles(name: string): Record<string, string> {
  return {
    "src/frontend/web/package.json": JSON.stringify({
      name: slugify(name) + "-web", private: true, version: "0.1.0", type: "module",
      scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview", "test:e2e": "playwright test" },
      dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
      devDependencies: { "@types/react": "^19.2.0", "@types/react-dom": "^19.2.0", typescript: "^5.9.0", vite: "^7.1.0", "@vitejs/plugin-react": "^4.7.0", "@playwright/test": PLAYWRIGHT_VERSION },
    }, null, 2) + "\n",
    "src/frontend/web/playwright.config.ts": lines(
      'import { defineConfig, devices } from "@playwright/test";',
      'const integration = process.env.E2E_MODE === "integration";',
      "export default defineConfig({",
      '  testDir: "./e2e",',
      "  fullyParallel: false,",
      "  forbidOnly: !!process.env.CI,",
      "  retries: 0,",
      "  workers: 1,",
      "  timeout: 20_000,",
      '  reporter: [["list"]],',
      '  use: {',
      '    baseURL: integration ? (process.env.E2E_WEB_ORIGIN || "http://web:4173") : "http://127.0.0.1:4173",',
      '    trace: "retain-on-failure",',
      '    screenshot: "only-on-failure",',
      '  },',
      '  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: {',
      '    args: process.env.E2E_INSECURE_OIDC_HTTP === "true"',
      '      ? ["--unsafely-treat-insecure-origin-as-secure=http://web:4173"] : [],',
      '  } } }],',
      '  webServer: process.env.E2E_WEB_SERVER_EXTERNAL === "true" ? undefined : {',
      '    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",',
      '    url: "http://127.0.0.1:4173",',
      "    reuseExistingServer: false,",
      "    timeout: 30_000,",
      "  },",
      '  outputDir: "./test-results",',
      "});",
    ),
    "src/frontend/web/e2e/smoke.spec.ts": lines(
      'import { test, expect } from "@playwright/test";',
      'const integration = process.env.E2E_MODE === "integration";',
      'const api = process.env.E2E_API_ORIGIN || (integration ? "http://api:8080" : "http://localhost:8080");',
      "",
      'test("loads the generated UI with a healthy API", async ({ page }) => {',
      '  if (!integration) await page.route(api + "/health", route => route.fulfill({',
      '    status: 200, contentType: "application/json",',
      '    headers: { "access-control-allow-origin": "*" },',
      '    body: JSON.stringify({ status: "ok" }),',
      '  }));',
      '  const liveHealth = integration ? page.waitForResponse(response => response.url() === api + "/health") : undefined;',
      '  await page.goto("/");',
      '  if (liveHealth) expect((await liveHealth).ok()).toBeTruthy();',
      '  await expect(page.getByRole("heading", { level: 1 })).toHaveText(' + JSON.stringify(name) + ');',
      '  await expect(page.getByText("API raggiungibile")).toBeVisible();',
      "});",
      "",
      'test("shows an error when the API is unavailable", async ({ page }) => {',
      '  await page.route(api + "/health", route => route.fulfill({',
      '    status: 503, contentType: "application/json",',
      '    headers: { "access-control-allow-origin": "*" },',
      '    body: JSON.stringify({ status: "unavailable" }),',
      "  }));",
      '  await page.goto("/");',
      '  await expect(page.getByText("API non raggiungibile")).toBeVisible();',
      "});",
      "",
      'test("real ASP.NET Core API returns an application identity", async ({ request }) => {',
      '  test.skip(!integration, "Requires a running real ASP.NET Core backend");',
      '  const health = await request.get(api + "/health");',
      '  expect(health.ok()).toBeTruthy();',
      '  expect((await health.json()).status).toBe("ok");',
      '  const response = await request.get(api + "/api/info");',
      '  expect(response.ok()).toBeTruthy();',
      '  const info = await response.json();',
      '  expect(info).toMatchObject({ name: ' + JSON.stringify(name) + ', status: "scaffold" });',
      '  expect(info.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);',
      "});",
    ),
    "src/frontend/web/tsconfig.json": JSON.stringify({ compilerOptions: {
      target: "ES2022", lib: ["ES2022", "DOM"], module: "ESNext", moduleResolution: "Bundler",
      jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true, types: ["vite/client"],
    }, include: ["src"] }, null, 2) + "\n",
    "src/frontend/web/vite.config.ts": lines('import { defineConfig } from "vite";', 'import react from "@vitejs/plugin-react";', "export default defineConfig({ plugins: [react()], server: { allowedHosts: [\"web\"] } });"),
    "src/frontend/web/index.html": lines('<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + escapeHtml(name) + '</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'),
    "src/frontend/web/src/main.tsx": lines('import React from "react";', 'import { createRoot } from "react-dom/client";', 'import App from "./App";', 'createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);'),
    "src/frontend/web/src/App.tsx": lines('import { useEffect, useState } from "react";',
      'const API = import.meta.env.VITE_API_URL || "http://localhost:8080";',
      'export default function App() {',
      '  const [status, setStatus] = useState("verifica in corso");',
      '  useEffect(() => { fetch(API + "/health").then(r => { if (!r.ok) throw Error(); return r.json(); }).then(() => setStatus("API raggiungibile")).catch(() => setStatus("API non raggiungibile")); }, []);',
      '  return <main style={{ fontFamily: "system-ui", maxWidth: 720, margin: "3rem auto", padding: 24 }}>',
      '    <h1>' + escapeJsx(name) + '</h1><p>Progetto generato con SoftwareFactory.</p><p>Stato: {status}</p>',
      '    <p>Questo è uno scheletro: implementare le feature approvate prima del rilascio.</p></main>;',
      '}'),
  };
}
function escapeHtml(v: string): string { return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function escapeJsx(v: string): string { return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/{/g, "&#123;").replace(/}/g, "&#125;"); }
function otherFrontend(kind: FrontendKind): Record<string, string> {
  const folder = kind === "react-native" ? "mobile-react-native" : kind;
  const human = kind === "unity" ? "Unity" : kind === "ios" ? "iOS Swift" : kind === "android" ? "Android Kotlin" : "React Native TypeScript";
  return { ["src/frontend/" + folder + "/README.md"]: lines("# " + human,
    "", "Target selezionato (placeholder). Il generatore MVP non crea ancora un progetto " + human + " compilabile.",
    "Inizializzare toolchain/SDK nativi, CI dedicata, navigation e integration tests prima di considerarlo supportato.") };
}

function postgresqlFiles(c: ProjectConfig): Record<string, string> {
  const sources: Record<string, string> = {
  "src/backend/domain/WorkItem.cs": "namespace FactoryApp.Domain;\npublic sealed record WorkItem(Guid Id, string Title, DateTimeOffset CreatedAt);\npublic interface IWorkItemRepository {\n    Task<IReadOnlyList<WorkItem>> ListAsync(string owner, CancellationToken ct);\n    Task<WorkItem> AddAsync(string owner, string title, CancellationToken ct);\n    Task<WorkItem?> UpdateAsync(string owner, Guid id, string title, CancellationToken ct);\n    Task<bool> DeleteAsync(string owner, Guid id, CancellationToken ct);\n}\n",
  "src/backend/business/WorkItemService.cs": "using FactoryApp.Domain;\nnamespace FactoryApp.Business;\npublic sealed class WorkItemService(IWorkItemRepository repository) {\n    public Task<IReadOnlyList<WorkItem>> ListAsync(string owner, CancellationToken ct)\n        => repository.ListAsync(owner, ct);\n    public Task<WorkItem> AddAsync(string owner, string title, CancellationToken ct) {\n        Validate(title);\n        return repository.AddAsync(owner, title.Trim(), ct);\n    }\n    public Task<WorkItem?> UpdateAsync(string owner, Guid id, string title, CancellationToken ct) {\n        Validate(title);\n        return repository.UpdateAsync(owner, id, title.Trim(), ct);\n    }\n    public Task<bool> DeleteAsync(string owner, Guid id, CancellationToken ct)\n        => repository.DeleteAsync(owner, id, ct);\n    private static void Validate(string title) {\n        if (string.IsNullOrWhiteSpace(title) || title.Trim().Length > 120)\n            throw new ArgumentException(\"Title must contain 1 to 120 characters.\", nameof(title));\n    }\n}\n",
  "src/backend/infrastructure/Infrastructure.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup><TargetFramework>net__FRAMEWORK__</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>\n  <ItemGroup>\n    <ProjectReference Include=\"../domain/Domain.csproj\" />\n    <PackageReference Include=\"Npgsql\" Version=\"10.0.3\" />\n    <EmbeddedResource Include=\"Migrations/*.sql\" />\n  </ItemGroup>\n</Project>\n",
  "src/backend/infrastructure/PostgresWorkItemRepository.cs": "using FactoryApp.Domain;\nusing Npgsql;\nusing NpgsqlTypes;\nnamespace FactoryApp.Infrastructure;\npublic sealed class PostgresWorkItemRepository(NpgsqlDataSource db) : IWorkItemRepository {\n    public async Task<IReadOnlyList<WorkItem>> ListAsync(string owner, CancellationToken ct) {\n        var result = new List<WorkItem>();\n        await using var connection = await db.OpenConnectionAsync(ct);\n        await using var command = new NpgsqlCommand(\n            \"SELECT id, title, created_at FROM work_items WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100\",\n            connection);\n        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = owner, NpgsqlDbType = NpgsqlDbType.Text });\n        await using var reader = await command.ExecuteReaderAsync(ct);\n        while (await reader.ReadAsync(ct))\n            result.Add(new WorkItem(reader.GetGuid(0), reader.GetString(1), reader.GetFieldValue<DateTimeOffset>(2)));\n        return result;\n    }\n    public async Task<WorkItem> AddAsync(string owner, string title, CancellationToken ct) {\n        var entry = new WorkItem(Guid.NewGuid(), title, DateTimeOffset.UtcNow);\n        await using var connection = await db.OpenConnectionAsync(ct);\n        await using var transaction = await connection.BeginTransactionAsync(ct);\n        await using (var command = new NpgsqlCommand(\n            \"INSERT INTO work_items (id, title, created_at, owner_id) VALUES ($1, $2, $3, $4)\", connection, transaction)) {\n            command.Parameters.Add(new NpgsqlParameter<Guid> { TypedValue = entry.Id, NpgsqlDbType = NpgsqlDbType.Uuid });\n            command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = entry.Title, NpgsqlDbType = NpgsqlDbType.Text });\n            command.Parameters.Add(new NpgsqlParameter<DateTimeOffset> { TypedValue = entry.CreatedAt, NpgsqlDbType = NpgsqlDbType.TimestampTz });\n            command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = owner, NpgsqlDbType = NpgsqlDbType.Text });\n            await command.ExecuteNonQueryAsync(ct);\n        }\n        await AuditAsync(connection, transaction, owner, entry.Id, \"create\", ct);\n        await transaction.CommitAsync(ct);\n        return entry;\n    }\n    public async Task<WorkItem?> UpdateAsync(string owner, Guid id, string title, CancellationToken ct) {\n        await using var connection = await db.OpenConnectionAsync(ct);\n        await using var transaction = await connection.BeginTransactionAsync(ct);\n        WorkItem? entry = null;\n        await using (var command = new NpgsqlCommand(\n            \"UPDATE work_items SET title = $3 WHERE id = $1 AND owner_id = $2 RETURNING id, title, created_at\",\n            connection, transaction)) {\n            command.Parameters.Add(new NpgsqlParameter<Guid> { TypedValue = id, NpgsqlDbType = NpgsqlDbType.Uuid });\n            command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = owner, NpgsqlDbType = NpgsqlDbType.Text });\n            command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = title, NpgsqlDbType = NpgsqlDbType.Text });\n            await using var reader = await command.ExecuteReaderAsync(ct);\n            if (await reader.ReadAsync(ct))\n                entry = new WorkItem(reader.GetGuid(0), reader.GetString(1), reader.GetFieldValue<DateTimeOffset>(2));\n        }\n        if (entry is not null) await AuditAsync(connection, transaction, owner, id, \"update\", ct);\n        await transaction.CommitAsync(ct);\n        return entry;\n    }\n    public async Task<bool> DeleteAsync(string owner, Guid id, CancellationToken ct) {\n        await using var connection = await db.OpenConnectionAsync(ct);\n        await using var transaction = await connection.BeginTransactionAsync(ct);\n        await using var command = new NpgsqlCommand(\n            \"DELETE FROM work_items WHERE id = $1 AND owner_id = $2 RETURNING id\", connection, transaction);\n        command.Parameters.Add(new NpgsqlParameter<Guid> { TypedValue = id, NpgsqlDbType = NpgsqlDbType.Uuid });\n        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = owner, NpgsqlDbType = NpgsqlDbType.Text });\n        var removed = await command.ExecuteScalarAsync(ct) is not null;\n        if (removed) await AuditAsync(connection, transaction, owner, id, \"delete\", ct);\n        await transaction.CommitAsync(ct);\n        return removed;\n    }\n    private static async Task AuditAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,\n        string owner, Guid id, string action, CancellationToken ct) {\n        await using var cmd = new NpgsqlCommand(\n            \"INSERT INTO work_item_audit(owner_id, work_item_id, action) VALUES ($1, $2, $3)\",\n            connection, transaction);\n        cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = owner, NpgsqlDbType = NpgsqlDbType.Text });\n        cmd.Parameters.Add(new NpgsqlParameter<Guid> { TypedValue = id, NpgsqlDbType = NpgsqlDbType.Uuid });\n        cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = action, NpgsqlDbType = NpgsqlDbType.Text });\n        await cmd.ExecuteNonQueryAsync(ct);\n    }\n}\n",
  "src/backend/infrastructure/PostgresSchemaMigrator.cs": "using Npgsql;\nusing System.Reflection;\nnamespace FactoryApp.Infrastructure;\npublic sealed class PostgresSchemaMigrator(NpgsqlDataSource db) {\n    public async Task ApplyAsync(CancellationToken ct = default) {\n        await using var connection = await db.OpenConnectionAsync(ct);\n        await using var transaction = await connection.BeginTransactionAsync(ct);\n        await using (var advisory = new NpgsqlCommand(\"SELECT pg_advisory_xact_lock(20261114)\", connection, transaction))\n            await advisory.ExecuteNonQueryAsync(ct);\n        await using (var schema = new NpgsqlCommand(\n            \"CREATE TABLE IF NOT EXISTS factory_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())\",\n            connection, transaction))\n            await schema.ExecuteNonQueryAsync(ct);\n        var assembly = typeof(PostgresSchemaMigrator).Assembly;\n        var migrations = assembly.GetManifestResourceNames()\n            .Where(name => name.Contains(\".Migrations.\") && name.EndsWith(\".sql\", StringComparison.Ordinal))\n            .OrderBy(name => name, StringComparer.Ordinal)\n            .ToArray();\n        if (migrations.Length == 0) throw new InvalidOperationException(\"No SQL migration embedded.\");\n        foreach (var name in migrations) {\n            var version = name.Split(\".Migrations.\", 2)[1];\n            await using (var check = new NpgsqlCommand(\n                \"SELECT EXISTS(SELECT 1 FROM factory_schema_migrations WHERE version = $1)\",\n                connection, transaction)) {\n                check.Parameters.AddWithValue(version);\n                if ((bool)(await check.ExecuteScalarAsync(ct) ?? false)) continue;\n            }\n            using var stream = assembly.GetManifestResourceStream(name)\n                ?? throw new InvalidOperationException(\"Migration resource missing.\");\n            using var reader = new StreamReader(stream);\n            var sql = await reader.ReadToEndAsync(ct);\n            await using (var migration = new NpgsqlCommand(sql, connection, transaction))\n                await migration.ExecuteNonQueryAsync(ct);\n            await using (var mark = new NpgsqlCommand(\n                \"INSERT INTO factory_schema_migrations(version) VALUES ($1)\",\n                connection, transaction)) {\n                mark.Parameters.AddWithValue(version);\n                await mark.ExecuteNonQueryAsync(ct);\n            }\n        }\n        await transaction.CommitAsync(ct);\n    }\n}\n",
  "src/backend/infrastructure/Migrations/0001_create_work_items.sql": "CREATE TABLE work_items (\n    id uuid PRIMARY KEY,\n    title varchar(120) NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),\n    created_at timestamptz NOT NULL\n);\nCREATE INDEX idx_work_items_created ON work_items (created_at DESC, id DESC);\n",
  "src/frontend/web/src/WorkItems.tsx": "import { useEffect, useState } from \"react\";\nimport type { FormEvent } from \"react\";\nimport { oidcEnabled, oidcManager, finishOidcLogin, finishOidcLogout } from \"./oidc\";\ntype WorkItem = { id: string; title: string; createdAt: string };\nexport default function WorkItems({ api }: { api: string }) {\n  const [items, setItems] = useState<WorkItem[]>([]);\n  const [token, setToken] = useState(() => oidcEnabled ? \"\" : sessionStorage.getItem(\"sf_api_access_token\") || \"\");\n  const [loginBusy, setLoginBusy] = useState(false);\n  const [enteredToken, setEnteredToken] = useState(\"\");\n  const auth = { Authorization: \"Bearer \" + token };\n  useEffect(() => {\n    if (!oidcEnabled) return;\n    let active = true;\n    const manager = oidcManager();\n    const sync = async () => {\n      try {\n        if (window.location.pathname === \"/\" && new URLSearchParams(window.location.search).has(\"state\")) {\n          await finishOidcLogout();\n          window.history.replaceState({}, \"\", \"/\");\n          await manager.removeUser();\n          if (active) setToken(\"\");\n        } else if (window.location.pathname === \"/auth/callback\") {\n          const signedIn = await finishOidcLogin();\n          window.history.replaceState({}, \"\", \"/\");\n          if (active) setToken(signedIn.access_token);\n        } else {\n          const user = await manager.getUser();\n          if (active) setToken(user && !user.expired ? user.access_token : \"\");\n        }\n      } catch {\n        if (active) { setToken(\"\"); setError(\"Accesso OpenID Connect non riuscito.\"); }\n      }\n    };\n    void sync();\n    const onLoaded = (user: { access_token: string }) => { if (active) setToken(user.access_token); };\n    const onExpired = () => { if (active) { setToken(\"\"); setItems([]); } };\n    manager.events.addUserLoaded(onLoaded);\n    manager.events.addAccessTokenExpired(onExpired);\n    return () => { active = false; manager.events.removeUserLoaded(onLoaded);\n      manager.events.removeAccessTokenExpired(onExpired); };\n  }, []);\n  const [title, setTitle] = useState(\"\");\n  const [error, setError] = useState(\"\");\n  const [busy, setBusy] = useState(false);\n  const [editing, setEditing] = useState<string | null>(null);\n  const [draft, setDraft] = useState(\"\");\n  useEffect(() => {\n    if (!token) { setItems([]); return; }\n    const controller = new AbortController();\n    void fetch(api + \"/api/items\", { signal: controller.signal, headers: { Authorization: \"Bearer \" + token } })\n      .then(response => { if (!response.ok) throw Error(\"HTTP \" + response.status); return response.json() as Promise<WorkItem[]>; })\n      .then(setItems)\n      .catch(err => { if (!controller.signal.aborted) setError(\"Archivio non disponibile: \" + String(err)); });\n    return () => controller.abort();\n  }, [api, token]);\n  const add = async (event: FormEvent<HTMLFormElement>) => {\n    event.preventDefault();\n    const next = title.trim();\n    if (!next || next.length > 120 || busy) return;\n    setBusy(true); setError(\"\");\n    try {\n      const response = await fetch(api + \"/api/items\", {\n        method: \"POST\", headers: { ...auth, \"Content-Type\": \"application/json\" }, body: JSON.stringify({ title: next }),\n      });\n      if (!response.ok) throw Error(\"HTTP \" + response.status);\n      const created = await response.json() as WorkItem;\n      setItems(old => [created, ...old]); setTitle(\"\");\n    } catch (err) { setError(\"Salvataggio non riuscito: \" + String(err)); }\n    finally { setBusy(false); }\n  };\n  const update = async (event: FormEvent<HTMLFormElement>, item: WorkItem) => {\n    event.preventDefault();\n    if (!draft.trim() || draft.trim().length > 120 || busy) return;\n    setBusy(true); setError(\"\");\n    try {\n      const response = await fetch(api + \"/api/items/\" + encodeURIComponent(item.id), {\n        method: \"PUT\", headers: { ...auth, \"Content-Type\": \"application/json\" },\n        body: JSON.stringify({ title: draft.trim() }),\n      });\n      if (!response.ok) throw Error(\"HTTP \" + response.status);\n      const updated = await response.json() as WorkItem;\n      setItems(old => old.map(x => x.id === item.id ? updated : x));\n      setEditing(null); setDraft(\"\");\n    } catch (err) { setError(\"Modifica non riuscita: \" + String(err)); }\n    finally { setBusy(false); }\n  };\n  const remove = async (item: WorkItem) => {\n    if (busy) return;\n    setBusy(true); setError(\"\");\n    try {\n      const response = await fetch(api + \"/api/items/\" + encodeURIComponent(item.id), { method: \"DELETE\", headers: auth });\n      if (!response.ok) throw Error(\"HTTP \" + response.status);\n      setItems(old => old.filter(x => x.id !== item.id));\n    } catch (err) { setError(\"Eliminazione non riuscita: \" + String(err)); }\n    finally { setBusy(false); }\n  };\n  return <section aria-label=\"Archivio PostgreSQL\" style={{ marginTop: 32 }}>\n    <h2>Elementi salvati</h2>\n    {oidcEnabled ? <div>\n      {!token ? <button type=\"button\" disabled={loginBusy} onClick={() => {\n        setLoginBusy(true); void oidcManager().signinRedirect().catch(() => {\n          setError(\"Accesso OpenID Connect non disponibile.\"); setLoginBusy(false);\n        });\n      }}>Accedi con OpenID Connect</button> : <button type=\"button\" onClick={() => {\n        setToken(\"\"); setItems([]);\n        void oidcManager().signoutRedirect().catch(() => oidcManager().removeUser());\n      }}>Esci</button>}\n    </div> : <form onSubmit={event => { event.preventDefault();\n      const value = enteredToken.trim(); if (!value) return;\n      sessionStorage.setItem(\"sf_api_access_token\", value); setToken(value); setEnteredToken(\"\");\n    }}>\n      <label htmlFor=\"access-token\">Token di accesso (sessione demo)</label>\n      <input id=\"access-token\" type=\"password\" autoComplete=\"off\" value={enteredToken}\n        onChange={event => setEnteredToken(event.target.value)} />\n      <button type=\"submit\">Usa token</button>\n      <button type=\"button\" onClick={() => { sessionStorage.removeItem(\"sf_api_access_token\"); setToken(\"\"); setItems([]); }}>Disconnetti</button>\n    </form>}\n    {!token && <p>Accesso necessario per visualizzare e modificare i propri elementi.</p>}\n    {error && <p role=\"alert\">{error}</p>}\n    {token && <>\n    <form onSubmit={event => void add(event)}>\n      <label htmlFor=\"work-item-title\">Titolo elemento</label>\n      <input id=\"work-item-title\" value={title} maxLength={120}\n        onChange={event => setTitle(event.target.value)} placeholder=\"Nuovo elemento\" />\n      <button type=\"submit\" disabled={busy || !title.trim()}>Aggiungi</button>\n    </form>\n    <ul>{items.map(item => <li key={item.id}>\n      {editing === item.id ? <form onSubmit={event => void update(event, item)}>\n        <label htmlFor=\"work-item-edit\">Modifica titolo</label>\n        <input id=\"work-item-edit\" value={draft} maxLength={120}\n          onChange={event => setDraft(event.target.value)} />\n        <button type=\"submit\" disabled={busy || !draft.trim()}>Salva</button>\n        <button type=\"button\" onClick={() => setEditing(null)}>Annulla</button>\n      </form> : <>\n        <span>{item.title}</span>{\" \"}\n        <button type=\"button\" disabled={busy} aria-label={\"Modifica \" + item.title}\n          onClick={() => { setEditing(item.id); setDraft(item.title); }}>Modifica</button>\n      </>}\n      <button type=\"button\" disabled={busy} aria-label={\"Elimina \" + item.title}\n        onClick={() => void remove(item)}>Elimina</button>\n    </li>)}</ul></>}\n  </section>;\n}\n",
  "src/backend/infrastructure/Migrations/0002_owner_and_audit.sql": "-- Existing pre-auth records are deliberately quarantined (no signed user owns them).\nALTER TABLE work_items ADD COLUMN owner_id text NOT NULL DEFAULT 'legacy-unassigned';\nALTER TABLE work_items ALTER COLUMN owner_id DROP DEFAULT;\nCREATE INDEX idx_work_items_owner_created ON work_items(owner_id, created_at DESC, id DESC);\nCREATE TABLE work_item_audit (\n    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n    owner_id text NOT NULL,\n    work_item_id uuid NOT NULL,\n    action varchar(12) NOT NULL CHECK (action IN ('create','update','delete')),\n    occurred_at timestamptz NOT NULL DEFAULT now()\n);\nCREATE INDEX idx_work_item_audit_owner ON work_item_audit(owner_id, occurred_at DESC);\n",
  "src/backend/applications/Api/AuthStartup.cs": "using System.Text;\nusing Microsoft.AspNetCore.Authentication.JwtBearer;\nusing Microsoft.AspNetCore.RateLimiting;\nusing Microsoft.IdentityModel.Tokens;\nusing System.Threading.RateLimiting;\nnamespace FactoryApp.Api;\npublic static class AuthStartup {\n    public static void AddWorkItemSecurity(this WebApplicationBuilder builder) {\n        var mode = builder.Configuration[\"Auth:Mode\"] ?? \"oidc\";\n        var audience = builder.Configuration[\"Auth:Audience\"];\n        if (string.IsNullOrWhiteSpace(audience))\n            throw new InvalidOperationException(\"Auth:Audience is required.\");\n        if (mode != \"oidc\" && mode != \"legacy\")\n            throw new InvalidOperationException(\"Unsupported Auth:Mode.\");\n        if (mode == \"legacy\" && builder.Environment.IsProduction())\n            throw new InvalidOperationException(\"Symmetric legacy tokens are forbidden in Production.\");\n        string issuer;\n        if (mode == \"oidc\") {\n            var authority = builder.Configuration[\"Auth:Authority\"]?.TrimEnd('/');\n            if (!Uri.TryCreate(authority, UriKind.Absolute, out var uri)\n                || (uri.Scheme != Uri.UriSchemeHttps\n                    && !(builder.Environment.IsDevelopment() && uri.Scheme == Uri.UriSchemeHttp))\n                || !string.IsNullOrWhiteSpace(uri.UserInfo)\n                || !string.IsNullOrWhiteSpace(uri.Query)\n                || !string.IsNullOrWhiteSpace(uri.Fragment))\n                throw new InvalidOperationException(\"Auth:Authority must be an HTTPS OIDC issuer (HTTP only in Development).\");\n            issuer = authority!;\n        } else {\n            issuer = builder.Configuration[\"Auth:Issuer\"] ?? \"\";\n            var key = builder.Configuration[\"Auth:SigningKey\"];\n            if (string.IsNullOrWhiteSpace(issuer) || string.IsNullOrWhiteSpace(key)\n                || Encoding.UTF8.GetByteCount(key) < 48)\n                throw new InvalidOperationException(\"Legacy auth requires issuer and a random signing key of at least 48 bytes.\");\n        }\n        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)\n            .AddJwtBearer(options => {\n                options.MapInboundClaims = false;\n                if (mode == \"oidc\") {\n                    options.Authority = issuer;\n                    options.Audience = audience;\n                    options.RequireHttpsMetadata = !builder.Environment.IsDevelopment();\n                    options.RefreshOnIssuerKeyNotFound = true;\n                }\n                options.TokenValidationParameters = new TokenValidationParameters {\n                    ValidateIssuer = true, ValidIssuer = issuer,\n                    ValidateAudience = true, ValidAudience = audience,\n                    ValidateIssuerSigningKey = true,\n                    IssuerSigningKey = mode == \"legacy\"\n                        ? new SymmetricSecurityKey(Encoding.UTF8.GetBytes(builder.Configuration[\"Auth:SigningKey\"]!))\n                        : null,\n                    ValidAlgorithms = mode == \"oidc\"\n                        ? new[] { SecurityAlgorithms.RsaSha256 }\n                        : new[] { SecurityAlgorithms.HmacSha256 },\n                    RequireSignedTokens = true, RequireExpirationTime = true,\n                    ValidateLifetime = true, ClockSkew = TimeSpan.FromSeconds(20),\n                    NameClaimType = \"sub\", RoleClaimType = \"role\",\n                };\n            });\n        builder.Services.AddAuthorization(options => {\n            options.AddPolicy(\"items.read\", policy => policy.RequireAuthenticatedUser()\n                .RequireClaim(\"sub\").RequireRole(\"reader\", \"editor\"));\n            options.AddPolicy(\"items.write\", policy => policy.RequireAuthenticatedUser()\n                .RequireClaim(\"sub\").RequireRole(\"editor\"));\n        });\n        builder.Services.AddRateLimiter(options => {\n            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;\n            options.AddPolicy(\"items\", ctx => RateLimitPartition.GetFixedWindowLimiter(\n                ctx.User.FindFirst(\"sub\")?.Value ?? ctx.Connection.RemoteIpAddress?.ToString() ?? \"anon\",\n                _ => new FixedWindowRateLimiterOptions {\n                    PermitLimit = 50, Window = TimeSpan.FromMinutes(1),\n                    QueueLimit = 0, AutoReplenishment = true,\n                }));\n        });\n        builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 8 * 1024);\n    }\n}\n",
  "src/frontend/web/src/oidc.ts": "import { UserManager, WebStorageStateStore } from \"oidc-client-ts\";\nconst authority = import.meta.env.VITE_OIDC_AUTHORITY as string | undefined;\nconst clientId = import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined;\nconst audience = import.meta.env.VITE_OIDC_AUDIENCE as string | undefined;\nexport const oidcEnabled = Boolean(authority && clientId && audience);\nlet instance: UserManager | undefined;\nlet pendingSignIn: ReturnType<UserManager[\"signinRedirectCallback\"]> | undefined;\nlet pendingSignOut: ReturnType<UserManager[\"signoutRedirectCallback\"]> | undefined;\nexport function finishOidcLogin() {\n  return pendingSignIn ??= oidcManager().signinRedirectCallback();\n}\nexport function finishOidcLogout() {\n  return pendingSignOut ??= oidcManager().signoutRedirectCallback();\n}\nexport function oidcManager(): UserManager {\n  if (!oidcEnabled) throw Error(\"OIDC is not configured for this application.\");\n  return instance ??= new UserManager({\n    authority: authority!, client_id: clientId!,\n    redirect_uri: window.location.origin + \"/auth/callback\",\n    post_logout_redirect_uri: window.location.origin + \"/\",\n    response_type: \"code\", scope: \"openid profile offline_access\",\n    automaticSilentRenew: true,\n    monitorSession: false,\n    userStore: new WebStorageStateStore({ store: window.sessionStorage }),\n    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),\n    extraQueryParams: { audience: audience! },\n  });\n}\n"
};
  return Object.fromEntries(Object.entries(sources).map(([path, content]) => [path, content.replaceAll("__FRAMEWORK__", c.dotnetVersion)]));
}

export function generateFiles(project: FactoryProject): Record<string, string> {
  const c = project.config;
  if (!c.name.trim() || !c.description.trim()) throw new Error("Servono nome e descrizione dell'applicazione.");
  if (!c.frontends.length) throw new Error("Seleziona almeno un frontend.");
  const slug = slugify(c.name);
  const done = (id: string) => project.stages.find(s => s.id === id)?.output || "Non ancora generato: richiede una fase AI.";
  const research = project.stages.flatMap(s => s.sources);
  const evidence = [...new Map(research.filter(s => s.title !== "Ricerca non disponibile").map(s => [s.url, s])).values()];
  const files: Record<string, string> = {
    "README.md": lines("# " + c.name, "", c.description, "",
      "## Stato", "", "**Scaffold tecnico, non prodotto finito.** Le feature elencate sono piani, non funzionalità implementate.",
      "", "## Prerequisiti", "", "- .NET SDK " + c.dotnetVersion,
      "- Node.js 22 e npm", "- Docker Compose (opzionale)", "",
      "## Avvio locale", "", "1. Imposta `DB_PASSWORD` in un file `docker/.env` locale (non committare segreti).",
      "2. Per PostgreSQL configura anche AUTH_ISSUER e AUTH_AUDIENCE, poi genera AUTH_SIGNING_KEY con openssl rand -hex 48.",
      "2. `docker compose --env-file docker/.env -f docker/compose.yml up --build`",
      "3. Web: http://localhost:3000 — API: http://localhost:8080/health", "",
      "## Test browser (smoke con API simulata)", "",
      "1. `cd src/frontend/web && npm install`",
      "2. `npx playwright install chromium`",
      "3. `npm run test:e2e`",
      "Questo smoke usa mock di `/health`: verifica la UI React in un browser vero, non il backend reale.", "",
      "## Documentazione", "", "- `docs/features.md`: backlog e criteria", "- `docs/research.md`: fonti da verificare",
      "- `docs/architecture.md`: design e vincoli", "- `adr/`: scelte", "- `infra/`: Terraform/on-prem",
      "- `.softwarefactory/manifest.json`: configurazione esportabile senza credenziali", ""),
    ".gitignore": lines("**/node_modules/", "**/bin/", "**/obj/", "**/dist/", "**/playwright-report/", "**/test-results/", ".env", "**/.env", "!**/.env.example", ".terraform/", "*.tfstate", "*.tfstate.*", "*.tfvars", ".DS_Store"),
    ".softwarefactory/manifest.json": JSON.stringify({ schemaVersion: 1, generator: "SoftwareFactory", createdAt: project.createdAt,
      config: c, stages: project.stages.map(s => ({ id: s.id, status: s.status })) }, null, 2) + "\n",
    "docs/features.md": lines("# Piano feature", "", done("features"), "", "## Piano implementativo", "", done("implementation")),
    "docs/research.md": lines("# Ricerca competitor, tecnica e normativa", "",
      "> Le fonti sono spunti di ricerca, non certificazione di fatti o consulenza legale. Verificare fonti primarie e date.",
      "", "## Competitor", "", done("competitors"), "", "## Documentazione, standard e norme", "", done("technical"),
      "", "## Fonti recuperate", "", ...(evidence.length ? evidence.map(s => "- [" + s.title.replace(/[\[\]]/g, "") + "](" + s.url + ") — " + s.snippet.replace(/\s+/g, " ").slice(0, 220)) : ["Nessuna fonte esterna verificata."])),
    "docs/architecture.md": lines("# Architettura", "", "## Configurazione scelta", "",
      "```json", JSON.stringify({ deployment: c.deployment, dotnetVersion: c.dotnetVersion, frontends: c.frontends, database: c.database, services: c.services }, null, 2), "```",
      "", "## Proposta", "", done("architecture"), "", "## Red team / adversarial", "", done("adversarial")),
    "adr/0001-modular-ddd.md": lines("# ADR 0001 — DDD a moduli con stack componibile", "",
      "- Stato: proposta — da approvare prima del rilascio", "- Data: " + new Date().toISOString().slice(0, 10), "",
      "## Contesto", "", c.description, "", "## Decisione proposta", "",
      "- .NET " + c.dotnetVersion + " con applications → business → domain e adapter infrastructure.",
      "- Frontend: " + c.frontends.join(", "), "- Database: " + c.database,
      "- Deploy target: " + c.deployment, "", "## Rischi e alternative", "", done("adversarial")),
    "docker/compose.yml": dockerCompose(c),
    "docker/.env.example": lines("# Copiare in docker/.env; NON committare il file reale", "DB_PASSWORD=replace-with-a-strong-password", "DB_ROOT_PASSWORD=replace-with-a-strong-password", "AUTH_MODE=oidc", "AUTH_AUTHORITY=", "OIDC_PUBLIC_AUTHORITY=", "OIDC_PUBLIC_CLIENT_ID=", "AUTH_ISSUER=factory-local", "AUTH_AUDIENCE=factory-web", "AUTH_SIGNING_KEY=", "DATABASE_URL=", "MINIO_USER=localadmin", "MINIO_PASSWORD=replace-with-a-strong-password"),
    "docker/Api.Dockerfile": lines("FROM mcr.microsoft.com/dotnet/sdk:" + c.dotnetVersion + " AS build",
      "WORKDIR /app", "COPY src/backend/ ./src/backend/", "RUN dotnet publish src/backend/applications/Api/Api.csproj -c Release -o /out",
      "FROM mcr.microsoft.com/dotnet/aspnet:" + c.dotnetVersion, "WORKDIR /app", "COPY --from=build /out ./",
      "EXPOSE 8080", "ENV ASPNETCORE_URLS=http://+:8080", "ENTRYPOINT [\"dotnet\", \"Api.dll\"]"),
    "docker/Web.Dockerfile": lines("FROM node:22-alpine AS build", "WORKDIR /app",
      "COPY src/frontend/web/package.json ./", "RUN npm install --no-audit --no-fund",
      "COPY src/frontend/web/ ./", "ARG VITE_API_URL=http://localhost:8080", "ENV VITE_API_URL=$VITE_API_URL", "ARG VITE_OIDC_AUTHORITY=", "ARG VITE_OIDC_CLIENT_ID=", "ARG VITE_OIDC_AUDIENCE=", "ENV VITE_OIDC_AUTHORITY=$VITE_OIDC_AUTHORITY", "ENV VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID", "ENV VITE_OIDC_AUDIENCE=$VITE_OIDC_AUDIENCE", "RUN npm run build",
      "FROM nginx:1.27-alpine", "COPY --from=build /app/dist /usr/share/nginx/html", "EXPOSE 80"),
    "infra/README.md": lines("# Infrastructure as Code", "", "Target iniziale: **" + c.deployment + "**.",
      "", "Il file `main.tf` è un punto di partenza, NON un deploy completo o hardenizzato.",
      "Completare reti private, segreti, IAM least-privilege, cifratura, backup, observability, ambienti e cost management.",
      "Non usare `terraform apply` in produzione senza review e plan. Per locale: `docker/compose.yml`."),
    "infra/main.tf": terraform(c, slug),
    "tests/README.md": lines("# Test strategy", "", "Smoke browser: `src/frontend/web/e2e/smoke.spec.ts` (Chromium reale, endpoint `/health` mockato).",
      "La CI generata esegue anche Playwright contro l\u0027API ASP.NET Core reale (health/info); il database resta da integrare.", "", "Gate richiesti prima della produzione:",
      "- Unit test domain/business, integration test API con database reale",
      "- Contract testing tra frontend e API",
      "- Security checks, SAST/dependency scans, accessibilità ed E2E",
      "- Smoke test containerizzati e ripristino backup",
      "", "La CI compila .NET e React ed esegue lo smoke browser in Chromium con `/health` simulato."),
    "src/backend/domain/Domain.csproj": lines('<Project Sdk="Microsoft.NET.Sdk">', "  <PropertyGroup><TargetFramework>net" + c.dotnetVersion + "</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>", "</Project>"),
    "src/backend/domain/EntityId.cs": lines("namespace FactoryApp.Domain;", "public readonly record struct EntityId(Guid Value) { public static EntityId New() => new(Guid.NewGuid()); }"),
    "src/backend/business/Business.csproj": lines('<Project Sdk="Microsoft.NET.Sdk">', "  <PropertyGroup><TargetFramework>net" + c.dotnetVersion + "</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>",
      '  <ItemGroup><ProjectReference Include="../domain/Domain.csproj" /></ItemGroup>', "</Project>"),
    "src/backend/business/ApplicationService.cs": lines("using FactoryApp.Domain;", "namespace FactoryApp.Business;",
      "public sealed class ApplicationService { public EntityId NewId() => EntityId.New(); }"),
    "src/backend/infrastructure/Infrastructure.csproj": lines('<Project Sdk="Microsoft.NET.Sdk">', "  <PropertyGroup><TargetFramework>net" + c.dotnetVersion + "</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>", "</Project>"),
    "src/backend/infrastructure/PersistenceOptions.cs": lines("namespace FactoryApp.Infrastructure;",
      "public sealed class PersistenceOptions { public string Provider { get; set; } = \"postgresql\"; public string? ConnectionString { get; set; } }",
      "// Adapter reale da implementare (EF Core/Npgsql, migrazioni, transaction boundary)."),
    "src/backend/applications/Api/Api.csproj": lines('<Project Sdk="Microsoft.NET.Sdk.Web">',
      "  <PropertyGroup><TargetFramework>net" + c.dotnetVersion + "</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>",
      '  <ItemGroup><ProjectReference Include="../../domain/Domain.csproj" /><ProjectReference Include="../../business/Business.csproj" /><ProjectReference Include="../../infrastructure/Infrastructure.csproj" /></ItemGroup>', "</Project>"),
    "src/backend/applications/Api/Program.cs": lines("using FactoryApp.Business;", "using FactoryApp.Infrastructure;", "",
      "var builder = WebApplication.CreateBuilder(args);", "builder.Services.AddCors(options => options.AddPolicy(\"web\", policy => policy.WithOrigins(\"http://localhost:3000\", \"http://localhost:5173\", \"http://127.0.0.1:4173\", \"http://web:4173\").AllowAnyHeader().AllowAnyMethod()));",
      "builder.Services.Configure<PersistenceOptions>(builder.Configuration.GetSection(\"Database\"));",
      "builder.Services.AddScoped<ApplicationService>();",
      "var app = builder.Build();", "app.UseCors(\"web\");",
      'app.MapGet("/health", () => Results.Ok(new { status = "ok" }));',
      'app.MapGet("/api/info", (ApplicationService service) => Results.Ok(new { name = ' + JSON.stringify(c.name) + ', requestId = service.NewId().Value, status = "scaffold" }));',
      "app.Run();"),
    ".github/workflows/ci.yml": lines("name: Build and smoke-test scaffold", "on:", "  push:", "    branches: [main]", "  pull_request:", "jobs:",
      "  build:", "    runs-on: ubuntu-latest", "    permissions:", "      contents: read", "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-dotnet@v4", "        with:", "          dotnet-version: '" + c.dotnetVersion + ".x'",
      "      - run: dotnet build src/backend/applications/Api/Api.csproj -c Release",
      "      - uses: actions/setup-node@v4", "        with:", "          node-version: '22'",
      "      - run: npm install --no-audit --no-fund && npm run build", "        working-directory: src/frontend/web",
      "      - run: npx playwright install --with-deps chromium", "        working-directory: src/frontend/web",
      "      - run: npm run test:e2e", "        working-directory: src/frontend/web",
      "      - name: Verify browser and real ASP.NET Core API",
      "        run: |",
      "          ASPNETCORE_URLS=http://127.0.0.1:8080 dotnet src/backend/applications/Api/bin/Release/net" + c.dotnetVersion + "/Api.dll &",
      "          API_PID=$!",
      "          trap 'kill $API_PID 2>/dev/null || true' EXIT",
      "          for i in $(seq 1 45); do",
      "            if curl -fsS http://127.0.0.1:8080/health >/dev/null; then break; fi",
      "            if ! kill -0 $API_PID 2>/dev/null; then exit 1; fi",
      "            sleep 1",
      "          done",
      "          curl -fsS http://127.0.0.1:8080/health >/dev/null",
      "          E2E_MODE=integration E2E_WEB_ORIGIN=http://127.0.0.1:4173 E2E_API_ORIGIN=http://127.0.0.1:8080 VITE_API_URL=http://127.0.0.1:8080 npm run test:e2e --prefix src/frontend/web"),
  };
  if (c.frontends.includes("react")) Object.assign(files, frontendFiles(c.name));
  else {
    // Web is included as a minimal operational dashboard even for native-only products.
    Object.assign(files, frontendFiles(c.name));
    files["src/frontend/web/README.md"] = "Dashboard operativa React. Frontend target primario: " + c.frontends.join(", ") + ".\n";
  }
  for (const kind of c.frontends.filter(k => k !== "react")) Object.assign(files, otherFrontend(kind));

  if (c.database === "postgresql") {
    Object.assign(files, postgresqlFiles(c));
    const apiPath = "src/backend/applications/Api/Program.cs";
    files["src/backend/applications/Api/Api.csproj"] = files["src/backend/applications/Api/Api.csproj"]
      .replace("</ItemGroup>", '<PackageReference Include="Microsoft.AspNetCore.Authentication.JwtBearer" Version="' +
        (c.dotnetVersion === "11.0" ? "11.0.0" : "10.0.15") + '" /></ItemGroup>');
    files[apiPath] = files[apiPath]
      .replace('app.UseCors("web");', "")
      .replace("using FactoryApp.Business;", "using FactoryApp.Business;\nusing FactoryApp.Domain;\nusing FactoryApp.Api;\nusing Microsoft.AspNetCore.RateLimiting;\nusing Npgsql;")
      .replace("var app = builder.Build();", [
        'var connectionString = builder.Configuration["Database:ConnectionString"];',
        'if (string.IsNullOrWhiteSpace(connectionString)) throw new InvalidOperationException("Database:ConnectionString is required for PostgreSQL.");',
        'builder.Services.AddSingleton(new NpgsqlDataSourceBuilder(connectionString).Build());',
        'builder.Services.AddScoped<IWorkItemRepository, PostgresWorkItemRepository>();',
        'builder.Services.AddScoped<WorkItemService>();',
        'builder.Services.AddSingleton<PostgresSchemaMigrator>();',
        'builder.AddWorkItemSecurity();',
        'var app = builder.Build();',
        'app.UseExceptionHandler(errors => errors.Run(async context => {',
        '  context.Response.StatusCode = 500;',
        '  await context.Response.WriteAsJsonAsync(new { error = "server_error" });',
        '}));',
        'app.UseRouting();',
        'app.UseCors("web");',
        'app.UseAuthentication();',
        'app.UseAuthorization();',
        'app.UseRateLimiter();',
        'await app.Services.GetRequiredService<PostgresSchemaMigrator>().ApplyAsync();',
      ].join("\n"))
      .replace("app.Run();", [
        'app.MapGet("/ready", async (NpgsqlDataSource db, CancellationToken ct) => {',
        '  try { await using var connection = await db.OpenConnectionAsync(ct); return Results.Ok(new { ready = true }); }',
        '  catch { return Results.StatusCode(503); }',
        '}).RequireAuthorization("items.read");',
        'app.MapGet("/api/items", (HttpContext context, WorkItemService service, CancellationToken ct) =>',
        '  service.ListAsync(context.User.FindFirst("sub")!.Value, ct))',
        '  .RequireAuthorization("items.read").RequireRateLimiting("items");',
        'app.MapPost("/api/items", async (HttpContext context, CreateWorkItemRequest request, WorkItemService service, CancellationToken ct) => {',
        '  if (string.IsNullOrWhiteSpace(request.Title) || request.Title.Trim().Length > 120)',
        '    return Results.BadRequest(new { error = "invalid_title" });',
        '  var created = await service.AddAsync(context.User.FindFirst("sub")!.Value, request.Title, ct);',
        '  return Results.Created("/api/items/" + created.Id, created);',
        '}).RequireAuthorization("items.write").RequireRateLimiting("items");',
        'app.MapPut("/api/items/{id:guid}", async (HttpContext context, Guid id, UpdateWorkItemRequest request, WorkItemService service, CancellationToken ct) => {',
        '  if (string.IsNullOrWhiteSpace(request.Title) || request.Title.Trim().Length > 120)',
        '    return Results.BadRequest(new { error = "invalid_title" });',
        '  var updated = await service.UpdateAsync(context.User.FindFirst("sub")!.Value, id, request.Title, ct);',
        '  return updated is null ? Results.NotFound() : Results.Ok(updated);',
        '}).RequireAuthorization("items.write").RequireRateLimiting("items");',
        'app.MapDelete("/api/items/{id:guid}", async (HttpContext context, Guid id, WorkItemService service, CancellationToken ct) =>',
        '  await service.DeleteAsync(context.User.FindFirst("sub")!.Value, id, ct) ? Results.NoContent() : Results.NotFound())',
        '  .RequireAuthorization("items.write").RequireRateLimiting("items");',
        'app.Run();',
        'record CreateWorkItemRequest(string? Title);',
        'record UpdateWorkItemRequest(string? Title);',
      ].join("\n"));
    const webManifestPath = "src/frontend/web/package.json";
    const webManifest = JSON.parse(files[webManifestPath]);
    webManifest.dependencies["oidc-client-ts"] = "3.5.0";
    files[webManifestPath] = JSON.stringify(webManifest, null, 2) + "\n";
    files["src/frontend/web/src/App.tsx"] = files["src/frontend/web/src/App.tsx"]
      .replace('import { useEffect, useState } from "react";', 'import { useEffect, useState } from "react";\nimport WorkItems from "./WorkItems";')
      .replace('</main>;', '<WorkItems api={API}/></main>;');
    files["src/frontend/web/e2e/smoke.spec.ts"] += [
      '',
      'test("persists and deletes a work item through real PostgreSQL", async ({ page, request }) => {',
      '  test.skip(!integration || process.env.E2E_DATABASE !== "postgresql", "Requires PostgreSQL integration environment");',
      '  const token = process.env.E2E_AUTH_TOKEN;',
      '  if (!token) throw Error("Missing signed CI editor token");',
      '  const headers = { Authorization: "Bearer " + token };',
      '  if (process.env.E2E_AUTH_MODE !== "oidc")',
      '  await page.addInitScript(value => sessionStorage.setItem("sf_api_access_token", value), token);',
      '  if (process.env.E2E_AUTH_MODE === "oidc") {',
      '    await page.goto("/");',
      '    await page.getByRole("button", { name: "Accedi con OpenID Connect" }).click();',
      '    { const current = new URL(page.url());',
      '      console.log("OIDC_BROWSER_STAGE", JSON.stringify({ host: current.host, path: current.pathname,',
      '        text: (await page.locator("body").innerText().catch(() => "")).slice(0, 260) })); }',
      '    await expect(page.getByLabel("Titolo elemento")).toBeVisible();',
      '  }',
      '  const unique = "Elemento " + Date.now() + "-" + Math.floor(Math.random() * 100000);',
      '  if (process.env.E2E_AUTH_MODE !== "oidc") await page.goto("/");',
      '  await page.getByLabel("Titolo elemento").fill(unique);',
      '  await page.getByRole("button", { name: "Aggiungi" }).click();',
      '  await expect(page.getByText(unique)).toBeVisible();',
      '  const renamed = unique + " aggiornato";',
      '  await page.getByRole("button", { name: "Modifica " + unique }).click();',
      '  await page.getByLabel("Modifica titolo").fill(renamed);',
      '  await page.getByRole("button", { name: "Salva" }).click();',
      '  await expect(page.getByText(renamed)).toBeVisible();',
      '  const stored = await request.get(api + "/api/items", { headers });',
      '  expect(stored.ok()).toBeTruthy();',
      '  expect((await stored.json()).some((row: { title: string }) => row.title === renamed)).toBeTruthy();',
      '  await page.getByRole("button", { name: "Elimina " + renamed }).click();',
      '  await expect(page.getByText(renamed)).toHaveCount(0);',
      '  const removed = await request.get(api + "/api/items", { headers });',
      '  expect((await removed.json()).some((row: { title: string }) => row.title === renamed)).toBeFalsy();',
      '});',
      '',
      'test("enforces JWT role policy and owner isolation on real PostgreSQL", async ({ request }) => {',
      '  test.skip(!integration || process.env.E2E_DATABASE !== "postgresql", "Requires PostgreSQL integration environment");',
      '  const editor = process.env.E2E_AUTH_TOKEN;',
      '  const reader = process.env.E2E_READER_TOKEN;',
      '  const other = process.env.E2E_OTHER_TOKEN;',
      '  if (!editor || !reader || !other) throw Error("Missing isolated CI tokens");',
      '  const asEditor = { Authorization: "Bearer " + editor };',
      '  const asReader = { Authorization: "Bearer " + reader };',
      '  const asOther = { Authorization: "Bearer " + other };',
      '  expect((await request.get(api + "/api/items")).status()).toBe(401);',
      '  expect((await request.get(api + "/ready")).status()).toBe(401);',
      '  if (process.env.E2E_AUTH_MODE === "oidc") {',
      '    for (const key of ["E2E_BAD_AUD_TOKEN", "E2E_EXPIRED_TOKEN"]) {',
      '      const bad = process.env[key]; if (!bad) throw Error("Missing invalid JWT fixture");',
      '      expect((await request.get(api + "/api/items", { headers: { Authorization: "Bearer " + bad } })).status()).toBe(401);',
      '    }',
      '    const badRole = process.env.E2E_MISSING_ROLE_TOKEN;',
      '    if (!badRole) throw Error("Missing roleless JWT fixture");',
      '    expect((await request.get(api + "/api/items", { headers: { Authorization: "Bearer " + badRole } })).status()).toBe(403);',
      '  }',
      '  expect((await request.get(api + "/api/items", { headers: asReader })).status()).toBe(200);',
      '  expect((await request.post(api + "/api/items", { headers: asReader, data: { title: "denied" } })).status()).toBe(403);',
      '  expect((await request.get(api + "/ready", { headers: asEditor })).status()).toBe(200);',
      '  expect((await request.post(api + "/api/items", { headers: asEditor, data: { title: " " } })).status()).toBe(400);',
      '  const created = await request.post(api + "/api/items", { headers: asEditor, data: { title: "private" } });',
      '  expect(created.status()).toBe(201);',
      '  const id = (await created.json()).id;',
      '  try {',
      '    const others = await request.get(api + "/api/items", { headers: asOther });',
      '    expect(others.status()).toBe(200);',
      '    expect((await others.json()).some((row: { id: string }) => row.id === id)).toBeFalsy();',
      '    expect((await request.put(api + "/api/items/" + id, { headers: asOther, data: { title: "stolen" } })).status()).toBe(404);',
      '    expect((await request.delete(api + "/api/items/" + id, { headers: asOther })).status()).toBe(404);',
      '    const mine = await request.get(api + "/api/items", { headers: asEditor });',
      '    expect((await mine.json()).some((row: { id: string }) => row.id === id)).toBeTruthy();',
      '  } finally {',
      '    expect((await request.delete(api + "/api/items/" + id, { headers: asEditor })).status()).toBe(204);',
      '  }',
      '});',
      '',
      'test("signs in and out using browser OIDC redirect + PKCE", async ({ page }) => {',
      '  test.skip(process.env.E2E_AUTH_MODE !== "oidc", "Requires CI OpenID provider");',
      '  await page.goto("/");',
      '  await page.getByRole("button", { name: "Accedi con OpenID Connect" }).click();',
      '  { const current = new URL(page.url());',
      '    console.log("OIDC_BROWSER_STAGE", JSON.stringify({ host: current.host, path: current.pathname,',
      '      text: (await page.locator("body").innerText().catch(() => "")).slice(0, 260) })); }',
      '  await expect(page.getByLabel("Titolo elemento")).toBeVisible();',
      '  await expect(page.getByRole("button", { name: "Esci" })).toBeVisible();',
      '  await page.getByRole("button", { name: "Esci" }).click();',
      '  await expect(page.getByRole("button", { name: "Accedi con OpenID Connect" })).toBeVisible();',
      '});',
      '',
    ].join("\n");

    files["tests/security/issue-tokens.mjs"] = "import { createHmac } from \"node:crypto\";\nimport { pathToFileURL } from \"node:url\";\nexport function signCiToken(key, issuer, audience, subject, role) {\n  if (Buffer.byteLength(key, \"utf8\") < 48 || !issuer || !audience ||\n      !/^[a-zA-Z0-9_-]{1,80}$/.test(subject) || ![\"reader\", \"editor\"].includes(role))\n    throw Error(\"Invalid ephemeral test auth configuration\");\n  const enc = obj => Buffer.from(JSON.stringify(obj)).toString(\"base64url\");\n  const now = Math.floor(Date.now() / 1000);\n  const signingInput = enc({ alg: \"HS256\", typ: \"JWT\" }) + \".\" +\n    enc({ iss: issuer, aud: audience, sub: subject, role, iat: now, exp: now + 600 });\n  return signingInput + \".\" + createHmac(\"sha256\", key).update(signingInput).digest(\"base64url\");\n}\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {\n  if (process.env.CI !== \"true\") throw Error(\"Token fixture is restricted to isolated CI\");\n  process.stdout.write(signCiToken(\n    process.env.Auth__SigningKey || \"\", process.env.Auth__Issuer || \"\",\n    process.env.Auth__Audience || \"\", process.argv[3] || \"\", process.argv[2] || \"\"));\n}\n";
    const workflowPath = ".github/workflows/ci.yml";
    const workflow = files[workflowPath];
    const marker = "      - name: Verify browser and real ASP.NET Core API";
    const start = workflow.indexOf(marker);
    if (start < 0) throw new Error("Generated workflow integration step missing");
    files[workflowPath] = workflow.slice(0, start) + [
      "      - name: Verify browser, real ASP.NET Core API and PostgreSQL",
      "        run: |",
      "          DB_NAME=sf-ci-db-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT",
      "          DB_PASSWORD=$(openssl rand -hex 24)",
      "          export Auth__Mode=legacy",
      "          export Auth__Issuer=factory-ci",
      "          export Auth__Audience=factory-client",
      "          export Auth__SigningKey=$(openssl rand -hex 48)",
      "          export E2E_AUTH_TOKEN=$(node tests/security/issue-tokens.mjs editor owner-a)",
      "          export E2E_READER_TOKEN=$(node tests/security/issue-tokens.mjs reader owner-a)",
      "          export E2E_OTHER_TOKEN=$(node tests/security/issue-tokens.mjs editor owner-b)",
      '          trap \'kill $API_PID 2>/dev/null || true; docker rm -f "$DB_NAME" >/dev/null 2>&1 || true\' EXIT',
      '          docker run -d --name "$DB_NAME" -p 127.0.0.1:54329:5432 -e POSTGRES_USER=app -e POSTGRES_DB=app -e POSTGRES_PASSWORD="$DB_PASSWORD" postgres:17-alpine',
      "          for i in $(seq 1 45); do",
      '            if docker exec "$DB_NAME" pg_isready -U app -d app >/dev/null 2>&1; then break; fi',
      "            sleep 1",
      "          done",
      '          docker exec "$DB_NAME" pg_isready -U app -d app',
      '          ASPNETCORE_ENVIRONMENT=Development Database__Provider=postgresql Database__ConnectionString="Host=127.0.0.1;Port=54329;Database=app;Username=app;Password=$DB_PASSWORD" ASPNETCORE_URLS=http://127.0.0.1:8080 dotnet src/backend/applications/Api/bin/Release/net' + c.dotnetVersion + '/Api.dll &',
      "          API_PID=$!",
      "          for i in $(seq 1 45); do",
      "            if curl -fsS http://127.0.0.1:8080/health >/dev/null; then break; fi",
      "            if ! kill -0 $API_PID 2>/dev/null; then exit 1; fi",
      "            sleep 1",
      "          done",
      "          curl -fsS http://127.0.0.1:8080/health >/dev/null",
      "          E2E_MODE=integration E2E_DATABASE=postgresql E2E_WEB_ORIGIN=http://127.0.0.1:4173 E2E_API_ORIGIN=http://127.0.0.1:8080 VITE_API_URL=http://127.0.0.1:8080 npm run test:e2e --prefix src/frontend/web",
    ].join("\n") + "\n";
  }
  if (c.deployment === "kubernetes") {
    files["infra/kubernetes/api.yaml"] = lines("apiVersion: apps/v1", "kind: Deployment",
      "metadata:", "  name: " + slug + "-api", "spec:", "  replicas: 1", "  selector:",
      "    matchLabels:", "      app: " + slug + "-api", "  template:", "    metadata:",
      "      labels:", "        app: " + slug + "-api", "    spec:", "      containers:",
      "        - name: api", "          image: REPLACE_WITH_YOUR_IMAGE:TAG", "          ports:",
      "            - containerPort: 8080", "---", "apiVersion: v1", "kind: Service",
      "metadata:", "  name: " + slug + "-api", "spec:", "  selector:",
      "    app: " + slug + "-api", "  ports:", "    - port: 80", "      targetPort: 8080");
  }
  return files;
}
