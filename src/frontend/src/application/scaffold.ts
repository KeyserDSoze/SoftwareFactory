import type { FactoryProject, FrontendKind, ProjectConfig } from "../domain/types";

const PLAYWRIGHT_VERSION = "1.64.1"; // Keep in sync with the runner browser image.\nfunction lines(...parts: string[]): string { return parts.join("\n") + "\n"; }
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
    '      - "8080:8080"',
    "    environment:",
    "      ASPNETCORE_ENVIRONMENT: Development",
    "      Database__Provider: " + c.database,
    '      Database__ConnectionString: "${DATABASE_URL:-}"',
  ];
  if (deps.length) services.push("    depends_on:", "      db:", "        condition: service_started");
  services.push(
    "  web:", "    build:", "      context: ..", "      dockerfile: docker/Web.Dockerfile",
    "      args:", "        VITE_API_URL: http://localhost:8080",
    "    ports:", '      - "3000:80"',
  );
  if (c.database === "postgresql") {
    services.push("  db:", "    image: postgres:17-alpine", "    environment:",
      "      POSTGRES_DB: app", "      POSTGRES_USER: app", '      POSTGRES_PASSWORD: "${DB_PASSWORD:?Set DB_PASSWORD in .env}"',
      "    ports:", '      - "5432:5432"', "    volumes:", "      - pgdata:/var/lib/postgresql/data", "volumes:", "  pgdata:");
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
      "export default defineConfig({",
      '  testDir: "./e2e",',
      "  fullyParallel: false,",
      "  forbidOnly: !!process.env.CI,",
      "  retries: 0,",
      "  workers: 1,",
      "  timeout: 20_000,",
      '  reporter: [["list"]],',
      '  use: {',
      '    baseURL: "http://127.0.0.1:4173",',
      '    trace: "retain-on-failure",',
      '    screenshot: "only-on-failure",',
      '  },',
      '  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],',
      "  webServer: {",
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
      "",
      'test("loads the generated UI with a healthy API", async ({ page }) => {',
      '  await page.route("http://localhost:8080/health", route => route.fulfill({',
      '    status: 200, contentType: "application/json",',
      '    headers: { "access-control-allow-origin": "*" },',
      '    body: JSON.stringify({ status: "ok" }),',
      '  }));',
      '  await page.goto("/");',
      '  await expect(page.getByRole("heading", { level: 1 })).toHaveText(' + JSON.stringify(name) + ');',
      '  await expect(page.getByText("API raggiungibile")).toBeVisible();',
      "});",
      "",
      'test("shows an error when the API is unavailable", async ({ page }) => {',
      '  await page.route("http://localhost:8080/health", route => route.fulfill({',
      '    status: 503, contentType: "application/json",',
      '    headers: { "access-control-allow-origin": "*" },',
      '    body: JSON.stringify({ status: "unavailable" }),',
      "  }));",
      '  await page.goto("/");',
      '  await expect(page.getByText("API non raggiungibile")).toBeVisible();',
      "});",
    ),
    "src/frontend/web/tsconfig.json": JSON.stringify({ compilerOptions: {
      target: "ES2022", lib: ["ES2022", "DOM"], module: "ESNext", moduleResolution: "Bundler",
      jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true, types: ["vite/client"],
    }, include: ["src"] }, null, 2) + "\n",
    "src/frontend/web/vite.config.ts": lines('import { defineConfig } from "vite";', 'import react from "@vitejs/plugin-react";', "export default defineConfig({ plugins: [react()] });"),
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
      "2. `docker compose --env-file docker/.env -f docker/compose.yml up --build`",
      "3. Web: http://localhost:3000 — API: http://localhost:8080/health", "",\n      "## Test browser (smoke con API simulata)", "",\n      "1. `cd src/frontend/web && npm install`",\n      "2. `npx playwright install chromium`",\n      "3. `npm run test:e2e`",\n      "Questo smoke usa mock di `/health`: verifica la UI React in un browser vero, non il backend reale.", "",
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
    "docker/.env.example": lines("# Copiare in docker/.env; NON committare il file reale", "DB_PASSWORD=replace-with-a-strong-password", "DB_ROOT_PASSWORD=replace-with-a-strong-password", "DATABASE_URL=", "MINIO_USER=localadmin", "MINIO_PASSWORD=replace-with-a-strong-password"),
    "docker/Api.Dockerfile": lines("FROM mcr.microsoft.com/dotnet/sdk:" + c.dotnetVersion + " AS build",
      "WORKDIR /app", "COPY src/backend/ ./src/backend/", "RUN dotnet publish src/backend/applications/Api/Api.csproj -c Release -o /out",
      "FROM mcr.microsoft.com/dotnet/aspnet:" + c.dotnetVersion, "WORKDIR /app", "COPY --from=build /out ./",
      "EXPOSE 8080", "ENV ASPNETCORE_URLS=http://+:8080", "ENTRYPOINT [\"dotnet\", \"Api.dll\"]"),
    "docker/Web.Dockerfile": lines("FROM node:22-alpine AS build", "WORKDIR /app",
      "COPY src/frontend/web/package.json ./", "RUN npm install --no-audit --no-fund",
      "COPY src/frontend/web/ ./", "ARG VITE_API_URL=http://localhost:8080", "ENV VITE_API_URL=$VITE_API_URL", "RUN npm run build",
      "FROM nginx:1.27-alpine", "COPY --from=build /app/dist /usr/share/nginx/html", "EXPOSE 80"),
    "infra/README.md": lines("# Infrastructure as Code", "", "Target iniziale: **" + c.deployment + "**.",
      "", "Il file `main.tf` è un punto di partenza, NON un deploy completo o hardenizzato.",
      "Completare reti private, segreti, IAM least-privilege, cifratura, backup, observability, ambienti e cost management.",
      "Non usare `terraform apply` in produzione senza review e plan. Per locale: `docker/compose.yml`."),
    "infra/main.tf": terraform(c, slug),
    "tests/README.md": lines("# Test strategy", "", "Smoke browser: `src/frontend/web/e2e/smoke.spec.ts` (Chromium reale, endpoint `/health` mockato).",\n      "Non sostituisce E2E integrati con API e database reali.", "", "Gate richiesti prima della produzione:",
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
      "var builder = WebApplication.CreateBuilder(args);", "builder.Services.AddCors(options => options.AddPolicy(\"web\", policy => policy.WithOrigins(\"http://localhost:3000\", \"http://localhost:5173\").AllowAnyHeader().AllowAnyMethod()));",
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
      "      - run: npm run test:e2e", "        working-directory: src/frontend/web"),
  };
  if (c.frontends.includes("react")) Object.assign(files, frontendFiles(c.name));
  else {
    // Web is included as a minimal operational dashboard even for native-only products.
    Object.assign(files, frontendFiles(c.name));
    files["src/frontend/web/README.md"] = "Dashboard operativa React. Frontend target primario: " + c.frontends.join(", ") + ".\n";
  }
  for (const kind of c.frontends.filter(k => k !== "react")) Object.assign(files, otherFrontend(kind));
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
