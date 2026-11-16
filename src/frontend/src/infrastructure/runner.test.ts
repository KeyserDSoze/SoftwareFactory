import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { runnerEndpoint, runnerSourceFiles, submitRunnerJob, fetchRunnerJob,
  RunnerRequestError, runnerPollDecision } from "./runner";

describe("remote runner browser client", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends the supplied retry UUID as Idempotency-Key with the authenticated JSON job", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({
        id: "11111111-1111-4111-8111-111111111111", digest: "a".repeat(64), state: "queued",
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const retryKey = "22222222-2222-4222-8222-222222222222";
    await submitRunnerJob("https://runner.example.com", "x".repeat(40),
      "Frontend retry", { "src/frontend/web/src/App.tsx": "export default null;" },
      ["web-build"], undefined, retryKey);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://runner.example.com/v1/jobs");
    expect(opts.headers["Idempotency-Key"]).toBe(retryKey);
    expect(opts.headers.Authorization).toBe("Bearer " + "x".repeat(40));
    expect(JSON.parse(opts.body).steps).toEqual(["web-build"]);
  });
  it("retries only network/408/429/5xx reads with five bounded exponential delays", async () => {
    const url = "https://runner.example.com";
    const key = "x".repeat(40);
    for (const status of [408, 429, 500, 502, 503, 504]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false, status, json: async () => ({ error: "temporarily_unavailable" }),
      }));
      let error: unknown;
      try { await fetchRunnerJob(url, key, "11111111-1111-4111-8111-111111111111"); }
      catch (value) { error = value; }
      expect(error).toBeInstanceOf(RunnerRequestError);
      expect((error as RunnerRequestError).status).toBe(status);
      let decision = runnerPollDecision(error, 0);
      expect(decision).toEqual({ retry: true, attempt: 1, delayMs: 2500 });
      for (const [failures, delay] of [5000, 10000, 20000, 30000].entries()) {
        decision = runnerPollDecision(error, failures + 1);
        expect(decision).toEqual({ retry: true, attempt: failures + 2, delayMs: delay });
      }
      expect(runnerPollDecision(error, 5)).toEqual({ retry: false });
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetchRunnerJob(url, key, "11111111-1111-4111-8111-111111111111"))
      .rejects.toMatchObject({ status: null, transient: true });
  });
  it("stops on auth/integrity/missing responses, malformed JSON, and intentional abort", async () => {
    const url = "https://runner.example.com";
    const key = "x".repeat(40);
    for (const status of [400, 401, 403, 404, 409, 422]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false, status, json: async () => ({ error: "not_available" }),
      }));
      let error: unknown;
      try { await fetchRunnerJob(url, key, "11111111-1111-4111-8111-111111111111"); }
      catch (value) { error = value; }
      expect(error).toBeInstanceOf(RunnerRequestError);
      expect((error as RunnerRequestError).transient).toBe(false);
      expect(runnerPollDecision(error, 0)).toEqual({ retry: false });
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => { throw new SyntaxError("malformed report"); },
    }));
    await expect(fetchRunnerJob(url, key, "11111111-1111-4111-8111-111111111111"))
      .rejects.toThrow(/malformed report/);
    expect(runnerPollDecision(new SyntaxError("malformed report"), 0)).toEqual({ retry: false });
    const controller = new AbortController();
    controller.abort();
    const aborted = new Error("Request canceled");
    aborted.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));
    await expect(fetchRunnerJob(url, key, "11111111-1111-4111-8111-111111111111",
      controller.signal)).rejects.toBe(aborted);
    expect(runnerPollDecision(aborted, 0)).toEqual({ retry: false });
    expect(runnerPollDecision(new RunnerRequestError("offline", null, true), -1)).toEqual({ retry: false });
  });
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
