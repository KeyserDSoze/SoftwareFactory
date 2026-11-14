import { describe, expect, it } from "vitest";
import { createProject } from "../domain/defaults";
import { commitStage, invalidateStages, promptForStage, stageReady } from "./pipeline";

describe("AI pipeline", () => {
  it("enforces stage order", () => {
    const project = createProject();
    expect(stageReady(project, "features")).toBe(true);
    expect(stageReady(project, "competitors")).toBe(false);
    const done = commitStage(project, "features", "# Features", []);
    expect(stageReady(done, "competitors")).toBe(true);
  });
  it("invalidates all downstream outputs on upstream revision", () => {
    let p = createProject();
    p = commitStage(p, "features", "first", []);
    p = commitStage(p, "competitors", "competitors", []);
    p = commitStage(p, "features", "revised", []);
    expect(p.stages.find(s => s.id === "competitors")?.status).toBe("pending");
    expect(p.stages.find(s => s.id === "competitors")?.output).toBe("");
    expect(invalidateStages(p).stages.every(s => s.status === "pending")).toBe(true);
  });
  it("includes source URLs and keeps the source distinct from facts", () => {
    const p = createProject();
    const prompt = promptForStage(p, "technical", [{ title: "Official docs", url: "https://example.org/documentation", snippet: "Claim", query: "q", fetchedAt: "2026-11-14" }]);
    expect(prompt).toContain("[S1]");
    expect(prompt).toContain("https://example.org/documentation");
    expect(prompt).toContain("fonti");
  });
});
