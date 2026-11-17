import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults";
import { AGENT_ROLES, EXECUTED_ROLES, resolveAgentRoute, roleFallbackStage,
  roleSystemInstruction, stageAgentRole, validateAgentRoutes } from "./agent-roles";
import { aiComplete } from "../infrastructure/ai";

const settings = () => structuredClone(DEFAULT_SETTINGS);
describe("BookWriter-style software house roles (#89)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("exposes all role responsibilities but identifies only implemented executions", () => {
    expect(AGENT_ROLES.map(r => r.id)).toContain("cloud_architect");
    expect(AGENT_ROLES.map(r => r.id)).toContain("onprem_architect");
    expect(AGENT_ROLES.map(r => r.id)).toContain("tester");
    expect(AGENT_ROLES.map(r => r.id)).toContain("project_manager");
    expect(EXECUTED_ROLES).toContain("fullstack_developer");
    expect(EXECUTED_ROLES).not.toContain("tester");
    expect(stageAgentRole("architecture")).toBe("software_architect");
    expect(roleFallbackStage("code_reviewer")).toBe("adversarial");
    expect(roleSystemInstruction("fix_developer")).toMatch(/Fix Developer/);
  });
  it("uses legacy stage assignment by default and per-role model override when configured", () => {
    const s = settings();
    s.profiles[0].model = "baseline";
    expect(resolveAgentRoute(s, "software_architect", "architecture")).toMatchObject({
      profile: { id: "default" }, model: "baseline", thinking: undefined,
    });
    s.profiles.push({ id: "specialist", label: "Local", model: "another", baseUrl: "http://localhost:1234/v1", enabled: true });
    s.agentRoutes = { software_architect: { profileId: "specialist", modelId: "architect-v2", thinking: "high" } };
    expect(resolveAgentRoute(s, "software_architect", "architecture")).toMatchObject({
      profile: { id: "specialist" }, model: "architect-v2", thinking: "high",
    });
    s.profiles[0].reasoningEffort = "medium";
    expect(resolveAgentRoute(s, "fullstack_developer", "implementation").thinking).toBe("medium");
    s.agentRoutes.fullstack_developer = { thinking: "automatic" };
    expect(resolveAgentRoute(s, "fullstack_developer", "implementation").thinking).toBe("automatic");
  });
  it("fails closed on wrong identities, disabled models and invalid thinking before any request", () => {
    const s = settings();
    s.profiles[0].model = "base";
    s.agentRoutes = { code_reviewer: { profileId: "missing" } };
    expect(() => resolveAgentRoute(s, "code_reviewer", "adversarial")).toThrow(/non disponibile/);
    s.agentRoutes = { code_reviewer: { profileId: "default", thinking: "high" } };
    s.profiles[0].enabled = false;
    expect(() => resolveAgentRoute(s, "code_reviewer", "adversarial")).toThrow(/non disponibile/);
    expect(() => validateAgentRoutes({ injected: { thinking: "high" } })).toThrow();
    expect(() => validateAgentRoutes({ code_reviewer: { thinking: "ultra" } })).toThrow();
    expect(() => validateAgentRoutes({ code_reviewer: { thinking: "high", secret: "x" } })).toThrow();
  });
  it("sends the chosen model and thinking, omitting temperature on reasoning requests", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, request: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(request.body)) as Record<string, unknown> });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "done" } }] }) };
    }));
    const p = settings().profiles[0];
    p.model = "fallback";
    expect(await aiComplete(p, "secret", "system", "user", undefined, {
      model: "architect-v2", thinking: "xhigh",
    })).toBe("done");
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].body).toMatchObject({ model: "architect-v2", reasoning_effort: "xhigh" });
    expect(calls[0].body).not.toHaveProperty("temperature");
    await aiComplete(p, "", "system", "user", undefined, { thinking: "automatic" });
    expect(calls[1].body).toMatchObject({ model: "fallback", temperature: 0.3 });
    expect(calls[1].body).not.toHaveProperty("reasoning_effort");
  });
  it("rejects a corrupted thinking value without network", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    const p = settings().profiles[0];
    p.model = "base";
    await expect(aiComplete(p, "", "system", "user", undefined,
      { thinking: "invalid" as "high" })).rejects.toThrow(/thinking/);
    expect(fn).not.toHaveBeenCalled();
  });
});
