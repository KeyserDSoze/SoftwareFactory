# ADR 0115 — Code Agent pending-only patch staging in isolated IndexedDB CAS

Status: accepted as isolated pre-cutover writer milestone #162 / parent #139 (22 November 2026).

## Context

The live CodeAgentPanel uses the synchronous Factory project writer. The IndexedDB CAS pilot covers manual and AI stages, project config, export/recovery and concurrent tab fencing, but does not yet write `development.pending`. Moving just Code Agent live would create a split-brain; meanwhile a pending patch must not be presented as compiled, reviewed, independently approved, applied, runner-passed or published.

## Decision

Add `application/cas-isolated-code-patch.ts` for a human-pasted JSON patch proposal bound to a canonical, pinned IndexedDB snapshot. It reuses `validateProposal(raw,project,request)` and `setPending(project,proposal)`: enforce request <=2k, JSON <=145k, full-file replacements for 1–8 allowlisted source files, path uniqueness, file size/total limits, absent pending patch, generated baseline workspace conflict checks and valid development revision. Reject recognizable PAT/secret/key patterns **across all operator content** (summary, reason, tests, assumptions, request and file content). Reject malformed stage layout/completionOrigin. The builder does not access storage or network; the candidate changes only `development.pending`, preserves historical context and never invents new code review, runner evidence or GitHub receipt. `canStageCasIsolatedCodePatch` only checks readiness, not full validation on every render, and the write action always repeats the full guard. Inspection of pending is bounded/inert and reports review status conservatively.

The opt-in CAS panel adds explicit human feature and JSON textarea drafts, covered by the dirty-draft interlock used for other CAS edits. Before a single `CasSelectionController.commit(candidate,expected)` IndexedDB transaction, the operator must consent to (1) exact pre-edit raw JSON backup download; (2) affirm the backup was saved on disk; (3) accept an unreviewed/unapproved **pending-only** update. Native `tx.oncomplete` alone is successful commit. A noncooperating writer changing ID/revision/raw during the third dialog blocks the session; the human request and JSON draft remain visible and no retry, rebase or legacy fallback occurs.

The opt-in refresh reads the native library **before** clearing the selected controller or draft, even if the operator agreed to discard, so an IDB outage cannot erase uncommitted code text. Explicit selection discard also checks dirty state. No external provider, runner, independent reviewer, patch apply, GitHub sync or cloud calls are made.

## Evidence and boundaries

Vitest covers canonical ID/revision/raw, disallowed paths, duplicate pending, secrets in JSON metadata, size bounds, no I/O and absence of false evidence. Real two-tab Chromium E2E tests the approved pending-only write, exact pre-edit backup, three consents, React escaping of untrusted summary, reload, rival winning during final consent, human draft preserved after conflict and failed IDB refresh, and unchanged live legacy localStorage; marker `FACTORY_INDEXEDDB_CODE_PROPOSAL_UI_E2E_PASS`. Require Factory CI, Pages and Installer candidate `completed/success` on the same final main SHA to close #162.

This does NOT cut over active CodeAgentPanel or the other synchronous live project writers. It offers no independent Code Reviewer approval, test execution, repair budget attestation, cloud security, or multi-device CAS. Parent #139 and #91/#92/#113/#109 remain open.
