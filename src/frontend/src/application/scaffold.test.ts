import { describe, expect, it } from "vitest";
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
