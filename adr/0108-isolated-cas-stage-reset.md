# ADR 0108 — Native CAS selective stage reset in the isolated IndexedDB pilot

Status: accepted under #155 / parent #139, 21 November 2026.

## Context

The main Factory pipeline can invalidate a selected stage and dependent checkpoints; the opt-in IDB-only editor only allowed configuration edits that reset ALL stages. Before porting live pipeline writers to a single async CAS source, the pilot needs a safe native control to invalidate stage outputs without accidentally asserting AI or test success, discarding prior work or bypassing fencing.

## Decision

Add a pure `buildCasIsolatedStageReset(snapshot,stageId)` requiring a canonical ID/revision/raw snapshot and exactly six stages in the fixed `STAGES` order. Unknown IDs, malformed stage fields/layout and no-op reset are rejected without I/O. Produce a new project where stages before the selected one remain unchanged; selected and all later stages have status `pending`, empty output and sources and no error/updatedAt fields. Never change earlier checkpoints, config, project ID, createdAt, imported development or GitHub receipts; historical receipts are not transformed into current verified evidence.

In the isolated React panel, an explicit stage selector and button are disabled when the configuration draft is dirty, the CAS session is blocked or the reset would be a no-op. A consented raw byte-exact JSON download happens BEFORE write. A second acknowledgement confirms file saved and a third destructive dialog names the targeted stage, ID and revision. Only then `controller.commit(candidate,expected)` performs native IDB CAS; revision updates after `tx.oncomplete`. Race/lost ACK blocks, never auto-retries, overwrites the winner or falls back to localStorage.

## Verification and non-goals

Vitest asserts immutable prior stages, downstream clearing, bad IDs/layout and pure operation. Chromium browser runs opt-in UI with backup denial and acceptance, staged/reset no-op, dirty config guard, native rival CAS during final consent and reload; checks exact backups, no legacy changes and `FACTORY_INDEXEDDB_STAGE_RESET_E2E_PASS`. Factory CI/Pages/Installer candidate completed/success on one SHA required before closure.

Stage reset is *only* invalidation, not manual stage completion, AI execution, test or adversarial review, and not the live Factory migration. Parent #139 remains open until all live React/pipeline/Code Agent/GitHub/import/cloud writers use the same authoritative async IDB source with rollback/recovery. Cross-device #91/#92 remain open.
