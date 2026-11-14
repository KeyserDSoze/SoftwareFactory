import { describe, expect, it } from "vitest";
import { createProject } from "./defaults";
import type { FactoryProject } from "./types";
import {
  allowedCodePath, approvePending, developmentOf, dropConflictingChanges, rejectPending,
  saveReview, setPending, undoLatest, validateProposal, workspaceConflicts, workspaceFiles,
} from "./development";
import { lineDiff } from "../application/code-diff";
import { parseReview } from "../application/code-agent";

const featureRequest = "Add domain validation and a safe data endpoint";
const review = { verdict: "pass" as const, report: "No blocking issues found in static review; builds not run.", completedAt: "2026-11-14" };
function project(): FactoryProject {
  const p = createProject();
  p.config.name = "Invoice Studio";
  p.config.description = "Track invoices and create searchable records.";
  return p;
}
function raw(path = "src/backend/domain/Invoice.cs", content = "namespace InvoiceStudio.Domain; public sealed record Invoice(Guid Id);"): string {
  return JSON.stringify({ summary: "New invoice domain type", files: [{ path, content, reason: "Represent invoices" }],
    tests: ["Build .NET application"], assumptions: ["No invoice persistence yet"] });
}
function staged() {
  const p = project(), patch = validateProposal(raw(), p, featureRequest);
  return setPending(p, patch);
}
describe("safe feature development", () => {
  it("restricts file ownership and prevents traversal, hidden files and pipeline edits", () => {
    for (const path of ["src/backend/domain/Invoice.cs", "src/backend/applications/Api/Program.cs",
      "src/frontend/web/src/components/Invoices.tsx", "src/frontend/web/src/theme.css"]) {
      expect(allowedCodePath(path)).toBe(true);
    }
    for (const path of ["../.github/workflows/ci.yml", "/etc/passwd", "src/backend/domain/../../.env",
      "src/frontend/web/package.json", ".github/workflows/ci.yml", "src/backend/domain/A.csproj",
      "src/frontend/web/src/../.env", "src/backend/domain//A.cs", "src/frontend/web/src/.hidden.ts",
      "src\\backend\\domain\\Secret.cs"]) expect(allowedCodePath(path)).toBe(false);
  });
  it("parses a proposed edit but does not alter the export before explicit acceptance", () => {
    const p = project(), original = workspaceFiles(p);
    const pending = staged();
    expect(developmentOf(pending).pending?.edits).toHaveLength(1);
    expect(workspaceFiles(pending)).toEqual(original);
    expect(() => approvePending(pending)).toThrow(/review avversaria/i);
    expect(rejectPending(pending).development?.pending).toBeUndefined();
  });
  it("applies independently reviewed edits, tracks ledger, then restores previous files", () => {
    const p = staged();
    const pendingId = p.development!.pending!.id;
    const reviewed = saveReview(p, pendingId, review);
    const approved = approvePending(reviewed);
    const path = "src/backend/domain/Invoice.cs";
    expect(workspaceFiles(approved)[path]).toContain("Invoice(Guid Id)");
    expect(workspaceFiles(approved)["docs/feature-implementation.md"]).toContain("New invoice domain type");
    expect(developmentOf(approved).history[0].status).toBe("applied");
    const reverted = undoLatest(approved);
    expect(workspaceFiles(reverted)[path]).toBeUndefined();
    expect(developmentOf(reverted).history[0].status).toBe("reverted");
    expect(() => undoLatest(reverted)).toThrow();
  });
  it("rejects stale approvals and prevents conflicting auto-rebase after config changes", () => {
    const p = project(), path = "src/backend/applications/Api/Program.cs";
    const oldContent = workspaceFiles(p)[path];
    const draft = setPending(p, validateProposal(raw(path, oldContent + "\n// Invoice endpoint\n"), p, featureRequest));
    draft.config.name = "Renamed Studio";
    const reviewed = saveReview(draft, draft.development!.pending!.id, review);
    expect(workspaceConflicts(reviewed)).toEqual([]);
    expect(approvePending(reviewed)).toThrow(); // baseline changed; old Program.cs no longer matches
  });
  it("detects and resolves a changed baseline without dropping unrelated generated files", () => {
    const p = project(), path = "src/backend/applications/Api/Program.cs";
    const proposed = validateProposal(raw(path, workspaceFiles(p)[path] + "\n// An extra endpoint"), p, featureRequest);
    const accepted = approvePending(saveReview(setPending(p, proposed), proposed.id, review));
    const revised = { ...accepted, config: { ...accepted.config, name: "Renamed Studio" } };
    expect(workspaceConflicts(revised)).toContain(path);
    expect(() => workspaceFiles(revised)).toThrow(/Config changed/i);
    const recovered = dropConflictingChanges(revised);
    expect(workspaceConflicts(recovered)).toEqual([]);
    expect(workspaceFiles(recovered)[path]).toContain("Renamed Studio");
    expect(developmentOf(recovered).history[0].status).toBe("superseded");
  });
  it("rejects invalid JSON, duplicates, disallowed files, no-op edits and secrets", () => {
    const p = project();
    expect(() => validateProposal("explanation", p, featureRequest)).toThrow(/JSON/);
    expect(() => validateProposal(raw("../secrets.txt"), p, featureRequest)).toThrow(/Path/);
    expect(() => validateProposal(raw("src/frontend/web/package.json"), p, featureRequest)).toThrow(/Path/);
    const same = workspaceFiles(p)["src/backend/domain/EntityId.cs"];
    expect(() => validateProposal(raw("src/backend/domain/EntityId.cs", same), p, featureRequest)).toThrow(/Nessuna differenza/);
    const duplicate = JSON.stringify({ summary: "dup", files: [
      { path: "src/backend/domain/Invoice.cs", content: "a", reason: "new" },
      { path: "src/backend/domain/Invoice.cs", content: "b", reason: "new" },
    ] });
    expect(() => validateProposal(duplicate, p, featureRequest)).toThrow(/duplicato/);
    expect(() => validateProposal(raw("src/backend/domain/Token.cs",
      "const token = 'github_pat_abcdefghijklmnopqrstuvwxyz123456789';"), p, featureRequest)).toThrow(/credenziale/);
  });
  it("fails closed for adverse reviews and supports bounded diff", () => {
    const p = staged();
    const adverse = saveReview(p, p.development!.pending!.id, { verdict: "changes_required", report: "Missing validation", completedAt: "2026-11-14" });
    expect(() => approvePending(adverse)).toThrow();
    expect(parseReview('{"verdict":"pass","report":"Looks sound (not executed)"}').verdict).toBe("pass");
    expect(() => parseReview('{"verdict":"pass"}')).toThrow();
    const diff = lineDiff("a\nb\nc", "a\nnew\nc");
    expect(diff.some(x => x.kind === "added" && x.text === "new")).toBe(true);
    expect(diff.some(x => x.kind === "removed" && x.text === "b")).toBe(true);
  });
  it("does not churn scaffold timestamp between calls", () => {
    const p = project();
    expect(workspaceFiles(p)[".softwarefactory/manifest.json"]).toBe(workspaceFiles(p)[".softwarefactory/manifest.json"]);
  });
});
