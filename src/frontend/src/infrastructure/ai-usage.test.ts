import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject, DEFAULT_SETTINGS } from "../domain/defaults";
import { runStage } from "../application/pipeline";
import { reviewCode } from "../application/code-agent";
import type { FeatureProposal } from "../domain/development";
import { aiComplete, formatProviderReportedUsage,
  parseProviderReportedUsage, type AiUsageObservation } from "./ai";

const profile = () => ({ ...DEFAULT_SETTINGS.profiles[0],
  id: "local-agent", model: "base-model",
  baseUrl: "https://api.openai.com/v1" });
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const answer = (usage?: unknown) => ({
  id: "id-with-possible-sensitive-provider-fields",
  model: "provider-claims-another-model",
  choices: [{ message: { content: "  Answer from a real HTTP response.  " } }],
  ...(usage === undefined ? {} : { usage }),
});
const mockResponse = (body: unknown, status = 200) =>
  vi.stubGlobal("fetch", vi.fn(async () => response(body, status)));
const usage = {
  prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
  prompt_tokens_details: { cached_tokens: 50 },
};

describe("provider-reported AI usage (not verified billing) #121", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("emits a bounded in-memory observation only after a successful completion", async () => {
    const callback = vi.fn();
    mockResponse(answer(usage));
    const text = await aiComplete(profile(), "secret-key-not-in-output",
      "private system prompt", "private user prompt", undefined,
      { model: "writer-model", onUsage: callback });
    expect(text).toBe("Answer from a real HTTP response.");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      assurance: "provider_reported_unverified",
      profileId: "local-agent", requestedModel: "writer-model",
      promptTokens: 120, completionTokens: 30, totalTokens: 150,
    });
    const captured = JSON.stringify(callback.mock.calls);
    expect(captured).not.toContain("secret-key-not-in-output");
    expect(captured).not.toContain("private system prompt");
    expect(captured).not.toContain("private user prompt");
    expect(captured).not.toContain("provider-claims-another-model");
    expect(captured).not.toContain("id-with-possible-sensitive-provider-fields");
    expect(captured).not.toContain("cached_tokens");
    expect(formatProviderReportedUsage(callback.mock.calls[0][0])).toMatch(
      /Token dichiarati dal provider \(non verificati\).*120.*30.*150.*Nessun costo monetario certificato/,
    );
    expect(formatProviderReportedUsage(callback.mock.calls[0][0], "en")).toMatch(
      /Provider-reported tokens \(unverified\).*input 120.*output 30.*total 150.*No certified monetary cost/,
    );
  });

  it("does not fabricate counts if response usage is absent", async () => {
    const callback = vi.fn();
    mockResponse(answer());
    expect(await aiComplete(profile(), "", "system", "user", undefined,
      { onUsage: callback })).toBe("Answer from a real HTTP response.");
    expect(callback).not.toHaveBeenCalled();
    expect(parseProviderReportedUsage(answer(), "p", "m")).toBeNull();
  });

  it.each([
    ["null", null],
    ["array", [1, 2]],
    ["no total", { prompt_tokens: 1, completion_tokens: 2 }],
    ["negative", { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 }],
    ["fractional", { prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3.5 }],
    ["boolean", { prompt_tokens: true, completion_tokens: 2, total_tokens: 3 }],
    ["numeric strings", { prompt_tokens: "1", completion_tokens: 2, total_tokens: 3 }],
    ["inconsistent", { prompt_tokens: 2, completion_tokens: 3, total_tokens: 6 }],
    ["overflow", { prompt_tokens: Number.MAX_SAFE_INTEGER,
      completion_tokens: 2, total_tokens: Number.MAX_SAFE_INTEGER + 2 }],
    ["over quota", { prompt_tokens: 1_000_000_001,
      completion_tokens: 0, total_tokens: 1_000_000_001 }],
    ["NaN", { prompt_tokens: NaN, completion_tokens: 2, total_tokens: NaN }],
    ["infinity", { prompt_tokens: Infinity, completion_tokens: 2, total_tokens: Infinity }],
  ])("ignores malformed usage %s while preserving valid completion", async (_label, badUsage) => {
    const callback = vi.fn();
    mockResponse(answer(badUsage));
    expect(await aiComplete(profile(), "", "system", "user", undefined,
      { onUsage: callback })).toBe("Answer from a real HTTP response.");
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps exact 0 token counts, never estimates tokens from content length", async () => {
    const callback = vi.fn();
    mockResponse(answer({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }));
    await aiComplete(profile(), "", "huge".repeat(1000), "user", undefined,
      { onUsage: callback });
    expect(callback.mock.calls[0][0]).toMatchObject({
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
    });
  });

  it("does not emit an observation on HTTP failure, empty answer or malformed JSON", async () => {
    const callback = vi.fn();
    mockResponse(answer(usage), 429);
    await expect(aiComplete(profile(), "key", "system", "user", undefined,
      { onUsage: callback })).rejects.toThrow(/HTTP 429/);
    expect(callback).not.toHaveBeenCalled();
    mockResponse({ choices: [{ message: { content: "   " } }], usage });
    await expect(aiComplete(profile(), "", "system", "user", undefined,
      { onUsage: callback })).rejects.toThrow(/vuota/);
    mockResponse({ choices: "not an array", usage });
    await expect(aiComplete(profile(), "", "system", "user", undefined,
      { onUsage: callback })).rejects.toThrow(/compatibile/);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps successful text even if the optional UI callback throws", async () => {
    mockResponse(answer(usage));
    const onUsage = vi.fn(() => { throw Error("local UI render failed"); });
    await expect(aiComplete(profile(), "", "system", "user", undefined,
      { onUsage })).resolves.toBe("Answer from a real HTTP response.");
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("never emits receipt after a cancelled signal, even if a mock transport resolves", async () => {
    mockResponse(answer(usage));
    const controller = new AbortController();
    controller.abort();
    const callback = vi.fn();
    await aiComplete(profile(), "", "system", "user", controller.signal,
      { onUsage: callback });
    expect(callback).not.toHaveBeenCalled();
  });

  it("forwards the provider observation through a real Factory pipeline task without storage", async () => {
    mockResponse(answer(usage));
    const readSecret = vi.fn(() => "");
    vi.stubGlobal("sessionStorage", { getItem: readSecret });
    const receipt = vi.fn<(observed: AiUsageObservation) => void>();
    const project = createProject();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.profiles[0].model = "pipeline-model";
    const result = await runStage(project, settings, "features", undefined,
      undefined, receipt);
    expect(result.output).toBe("Answer from a real HTTP response.");
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(receipt.mock.calls[0][0]).toMatchObject({
      assurance: "provider_reported_unverified",
      totalTokens: 150,
    });
    expect(result).toEqual({
      output: "Answer from a real HTTP response.", sources: [],
    });
    expect(JSON.stringify(project)).not.toContain("promptTokens");
    expect(JSON.stringify(settings)).not.toContain("promptTokens");
  });
});


describe("browser AI completed-envelope safety #132", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a single explicit assistant stop and legacy envelopes without metadata", async () => {
    const callback = vi.fn();
    const valid = {
      choices: [{ finish_reason: "stop", message: {
        role: "assistant", content: "  A complete answer.  ",
        refusal: null, tool_calls: null, function_call: null,
      } }],
      usage,
    };
    mockResponse(valid);
    expect(await aiComplete(profile(), "key", "system", "user", undefined,
      { onUsage: callback })).toBe("A complete answer.");
    expect(callback).toHaveBeenCalledTimes(1);
    // Compatible providers without finish_reason/role remain accepted, but
    // absence of metadata is not an execution attestation or bill.
    mockResponse(answer());
    expect(await aiComplete(profile(), "", "system", "user")).toBe(
      "Answer from a real HTTP response.");
  });

  it.each([
    ["truncated", { finish_reason: "length" }],
    ["filtered", { finish_reason: "content_filter" }],
    ["tool finish", { finish_reason: "tool_calls" }],
    ["legacy function finish", { finish_reason: "function_call" }],
    ["unknown finish", { finish_reason: "something-else" }],
    ["null finish", { finish_reason: null }],
    ["undefined-but-present finish", { finish_reason: undefined }],
    ["non assistant", { message: { role: "user" } }],
    ["system", { message: { role: "system" } }],
    ["null role", { message: { role: null } }],
    ["refusal", { message: { refusal: "I cannot help with that." } }],
    ["empty refusal", { message: { refusal: "" } }],
    ["active tool", { message: { tool_calls: [{ id: "call_1" }] } }],
    ["empty tool array", { message: { tool_calls: [] } }],
    ["function call", { message: { function_call: { name: "do_work" } } }],
  ])("rejects a %s even with nonempty text and consistent usage", async (_label, override) => {
    const onUsage = vi.fn();
    const original = { finish_reason: "stop", message: {
      role: "assistant", content: "A seemingly complete output",
    } };
    const choice = { ...original, ...override,
      message: { ...original.message, ...("message" in override ? override.message : {}) },
    };
    mockResponse({ choices: [choice], usage });
    await expect(aiComplete(profile(), "hidden-api-key",
      "hidden system message", "hidden user message", undefined,
      { onUsage })).rejects.toThrow(/risposta/);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("rejects ambiguous choices and malformed messages before emitting tokens", async () => {
    const onUsage = vi.fn();
    const valid = { finish_reason: "stop", message: {
      role: "assistant", content: "Complete" },
    };
    for (const choices of [
      [], [valid, valid], [null], [42], [valid, null],
      [{ finish_reason: "stop", message: [] }],
      [{ finish_reason: "stop", message: { role: "assistant", content: ["text"] } }],
      [{ finish_reason: "stop", message: { role: "assistant", content: "  " } }],
    ]) {
      mockResponse({ choices, usage });
      await expect(aiComplete(profile(), "", "system", "user",
        undefined, { onUsage })).rejects.toThrow(/risposta/);
    }
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("does not turn an explicitly truncated response into a pipeline checkpoint or token receipt", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    const project = createProject();
    const before = structuredClone(project);
    const onUsage = vi.fn();
    mockResponse({ choices: [{ finish_reason: "length", message: {
      role: "assistant", content: "A partial implementation plan",
    } }], usage });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.profiles[0].model = "pipeline-fixture-model";
    await expect(runStage(project, settings, "features", undefined,
      undefined, onUsage)).rejects.toThrow(/incompleta/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(onUsage).not.toHaveBeenCalled();
    expect(project).toEqual(before);
    expect(project.stages.find(s => s.id === "features")?.status).not.toBe("complete");
  });

  it("blocks a partial Code Reviewer pass before it can become a FeatureReview", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    const proposal: FeatureProposal = {
      id: "local-proposal", request: "Add validation",
      summary: "Validation proposed", revision: 0,
      createdAt: "2026-11-20T00:00:00.000Z", edits: [],
      tests: [], assumptions: [],
    };
    const before = structuredClone(proposal);
    const onUsage = vi.fn();
    mockResponse({ choices: [{ finish_reason: "content_filter", message: {
      role: "assistant", content: JSON.stringify({
        verdict: "pass", report: "Everything seems fine",
      }),
    } }], usage });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.profiles[0].model = "review-fixture-model";
    await expect(reviewCode(createProject(), settings,
      proposal, undefined, onUsage)).rejects.toThrow(/filtrata/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(onUsage).not.toHaveBeenCalled();
    expect(proposal).toEqual(before);
    expect(proposal.review).toBeUndefined();
  });
});
