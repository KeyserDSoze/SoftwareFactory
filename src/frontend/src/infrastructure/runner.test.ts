import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { fetchRunnerExecutionPlan, validateRunnerExecutionPlan, runnerEndpoint, runnerSourceFiles, submitRunnerJob, fetchRunnerJob,
  RunnerRequestError, runnerPollDecision, probeRunnerConnector, type RunnerReport } from "./runner";

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

describe("runner connector read-only onboarding probe (#87)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const url = "https://runner.example.com";
  const key = "a".repeat(40);
  const capabilities = { protocol: 1, steps: ["dotnet-build", "playwright"],
    execution: "remote-docker", networkDefault: "none" };
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const unavailable = (error: string) => ({
    ok: false, status: 503, json: async () => ({ error }),
  });
  it("checks authenticated capabilities, worker heartbeat and rootless Docker without POST or source upload", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(ok(capabilities))
      .mockResolvedValueOnce(ok({ status: "ready", worker: "responsive" }))
      .mockResolvedValueOnce(ok({ status: "ready", worker: "responsive", docker: "rootless" }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(probeRunnerConnector(url, key)).resolves.toMatchObject({
      state: "ready", steps: ["dotnet-build", "playwright"],
    });
    expect(fetchSpy.mock.calls.map(c => c[0])).toEqual([
      url + "/v1/capabilities", url + "/v1/readiness", url + "/v1/execution-readiness",
    ]);
    for (const [, config] of fetchSpy.mock.calls) {
      expect(config.method).toBeUndefined();
      expect(config.body).toBeUndefined();
      expect(config.headers.Authorization).toBe("Bearer " + key);
      expect(config.redirect).toBe("error");
      expect(config.cache).toBe("no-store");
    }
  });
  it("fails closed for an unauthenticated connector, without probing health or Docker", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: "unauthorized" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    expect((await probeRunnerConnector(url, key)).state).toBe("auth-failed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("rejects incompatible capabilities without reporting a successful connection", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ ...capabilities, networkDefault: "bridge" }));
    vi.stubGlobal("fetch", fetchSpy);
    expect((await probeRunnerConnector(url, key)).state).toBe("unsupported");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("distinguishes a missing worker heartbeat from an unready rootless daemon", async () => {
    const workerSpy = vi.fn().mockResolvedValueOnce(ok(capabilities))
      .mockResolvedValueOnce(unavailable("worker_unavailable"));
    vi.stubGlobal("fetch", workerSpy);
    expect((await probeRunnerConnector(url, key)).state).toBe("worker-offline");
    expect(workerSpy).toHaveBeenCalledTimes(2);

    const dockerSpy = vi.fn().mockResolvedValueOnce(ok(capabilities))
      .mockResolvedValueOnce(ok({ status: "ready", worker: "responsive" }))
      .mockResolvedValueOnce(unavailable("docker_unavailable"));
    vi.stubGlobal("fetch", dockerSpy);
    expect((await probeRunnerConnector(url, key)).state).toBe("docker-unavailable");
    expect(dockerSpy).toHaveBeenCalledTimes(3);
  });
  it("does not trust malformed readiness responses or extra executable steps", async () => {
    const extraStepSpy = vi.fn().mockResolvedValue(ok({
      ...capabilities, steps: ["playwright", "arbitrary-shell"],
    }));
    vi.stubGlobal("fetch", extraStepSpy);
    expect((await probeRunnerConnector(url, key)).state).toBe("unsupported");
    expect(extraStepSpy).toHaveBeenCalledTimes(1);

    const readinessSpy = vi.fn().mockResolvedValueOnce(ok(capabilities))
      .mockResolvedValueOnce(ok({ status: "ok", worker: "responsive" }));
    vi.stubGlobal("fetch", readinessSpy);
    expect((await probeRunnerConnector(url, key)).state).toBe("unsupported");
    expect(readinessSpy).toHaveBeenCalledTimes(2);
  });
  it("does not classify network errors as a ready runner", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect((await probeRunnerConnector(url, key)).state).toBe("api-unavailable");
  });
});


describe("verified runner PM job plan binding (#99)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const key = "a".repeat(40);
  const endpoint = "https://runner.example.com";
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const evidence = { version: 1, count: 3, head: "a".repeat(64) };
  const report: RunnerReport = { id, digest: "b".repeat(64), label: "test", state: "running",
    summary: "Worker started", acceptedAt: "", startedAt: "", finishedAt: null,
    steps: ["dotnet-build"], results: [], evidence };
  const payload = { version: 1, jobId: id, digest: report.digest,
    state: report.state, evidence: { count: 3, head: "a".repeat(64) },
    tasks: [{ id: "dotnet-build", owner: "Runner test worker",
      dependsOn: [], status: "waiting", exitCode: null }] };
  it("reads only GET with Bearer and binds plan to digest/evidence head", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal("fetch", spy);
    const got = await fetchRunnerExecutionPlan(endpoint, key, report);
    expect(got.tasks[0].status).toBe("waiting");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(endpoint + "/v1/jobs/" + id + "/plan");
    expect(spy.mock.calls[0][1].headers.Authorization).toBe("Bearer " + key);
    expect(spy.mock.calls[0][1].body).toBeUndefined();
  });
  it("rejects mismatched digest/head, untrusted step ids and false metadata", () => {
    for (const candidate of [
      { ...payload, digest: "0".repeat(64) },
      { ...payload, jobId: "wrong" },
      { ...payload, evidence: { count: 3, head: "c".repeat(64) } },
      { ...payload, evidence: { count: 4, head: "a".repeat(64) } },
      { ...payload, tasks: [{ ...payload.tasks[0], id: "shell" }] },
      { ...payload, tasks: [] },
    ]) expect(() => validateRunnerExecutionPlan(candidate, report)).toThrow();
  });
});
