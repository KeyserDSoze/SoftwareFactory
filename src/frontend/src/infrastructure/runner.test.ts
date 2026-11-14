import { describe, expect, it } from "vitest";
import { createProject } from "../domain/defaults";
import { runnerEndpoint, runnerSourceFiles } from "./runner";

describe("remote runner browser client", () => {
  it("allows only HTTPS origins or localhost without embedded credentials", () => {
    expect(runnerEndpoint("https://runner.example.com")).toBe("https://runner.example.com");
    expect(runnerEndpoint("http://localhost:8787")).toBe("http://localhost:8787");
    for (const invalid of ["http://runner.example.com", "https://user:password@runner.example.com",
      "https://runner.example.com/admin", "https://runner.example.com/?token=secret",
      "file:///etc/passwd"]) expect(() => runnerEndpoint(invalid)).toThrow();
  });
  it("sends code files only, not docs or secrets", () => {
    const p = createProject(); p.config.name = "Runner fixture"; p.config.description = "Compile backend and frontend";
    const files = runnerSourceFiles(p, false);
    expect(files["src/backend/applications/Api/Program.cs"]).toContain("MapGet");
    expect(files["src/frontend/web/src/App.tsx"]).toContain("Runner fixture");
    expect(files["src/backend/infrastructure/Migrations/0001_create_work_items.sql"]).toContain("CREATE TABLE work_items");
    expect(files["src/backend/infrastructure/PostgresWorkItemRepository.cs"]).toContain("Npgsql");
    expect(files[".softwarefactory/manifest.json"]).toBeUndefined();
    expect(files[".github/workflows/ci.yml"]).toBeUndefined();
    expect(files["docs/research.md"]).toBeUndefined();
  });
  it("includes pending patches for testing, without mutating the project", () => {
    const p = createProject(); p.config.name = "Runner fixture"; p.config.description = "Compile";
    const source = "namespace Test; public sealed class Invoice {}";
    p.development = { revision: 0, overrides: {}, originals: {}, history: [], pending: {
      id: "proposal", request: "Implement", summary: "Invoice", createdAt: "", revision: 0,
      edits: [{ path: "src/backend/domain/Invoice.cs", content: source, reason: "domain", previous: null }],
      tests: [], assumptions: [],
    } };
    expect(runnerSourceFiles(p, true)["src/backend/domain/Invoice.cs"]).toBe(source);
    expect(runnerSourceFiles(p, false)["src/backend/domain/Invoice.cs"]).toBeUndefined();
  });
});
