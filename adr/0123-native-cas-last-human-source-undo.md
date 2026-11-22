# ADR 0123 — Revision-fenced undo of the latest human-applied CAS source change

Date: 22 November 2026 · Status: accepted for issue #170; parent #139.

## Context

Issue #169 enabled an explicit **unreviewed human** path from pending Code Agent JSON into native IndexedDB `development.overrides/originals`. It never creates independent Code Review, runner or CI evidence. Its original bounded `humanApplications` ledger stored IDs, paths, timestamp and `operator-unverified` but not the previous source text. That made it unsafe to reconstruct a replaced file during undo, especially if another manual application had subsequently overwritten the same source path.

## Decision

For **new** human applications record alongside the existing ledger, for each applied file, a bounded `files: [{path,before,after}]` list. `before` is the actual effective, source-checked `FeatureEdit.previous`, `after` the operator-approved full replacement. Both fit the already enforced 1600-character, nontruncated, inert preview contract (#164/#169), and the record's `status` remains `operator-unverified`. No new `FeatureReview`, `AppliedFeature`, runner receipt, GitHub receipt or claim that code was tested is created.

Implement a pure **latest-application only** undo builder `prepareCasIsolatedHumanUndo` / `buildCasIsolatedHumanUndo`. Strict preflight checks canonical selected ID/revision/raw and six coherent stages not running; no pending, independent Code Agent history, runner job/evidence or GitHub binding/receipt; trusted generator baseline with every current `overrides/originals` pair matching generated files; last human application is `operator-unverified` and its development revision equals the actual workspace revision; unique allowlisted paths and complete ≤1600-character current/restore texts without obvious embedded secrets. For new records, `files[*].after` must byte-match the **current effective source**; `before` must byte-match either the generated scaffold baseline or the latest earlier **active** human-applied source's recorded `after`. Refuse mismatched revisions, forged previous text and missing/partial history rather than rebasing.

**Historical #169 records without `files`** are supported only if they added source paths **not present in the original generated scaffold and never mentioned by any earlier operator application**. Only then can the current override safely be removed without inventing a prior source. Any legacy overwrite with unknown before-image remains explicitly blocked: the operator must use the downloaded raw JSON backup and an appropriate explicit recovery path.

The candidate increments `development.revision`, removes the selected override and `originals` pair if the restored version equals the generated baseline, or restores an earlier *verified-by-ledger* operator override otherwise. Keep the immutable application record but mark it `status:reverted` with `revertedAt`; this records a local human undo **not** an independent review or test. All six stage checkpoints are invalidated because their relation to current source may have changed. The current implementation only undoes the **most recent application**; it does not promise a general arbitrary-step history rewind. New applications may follow a reverted record.

The UI renders full current and restored source in escaped `<pre>` blocks, with explicit delete notice for newly added files; a disabled action explains unsupported history. The operator must (1) agree to download the exact pre-change JSON, (2) confirm they saved it on disk, (3) authorize the single undo/analysis invalidation. `CasSelectionController.commit(candidate, expected)` is the ONLY writer; the native IDB revision+raw CAS commit ACK controls success. A second tab updating source during consent causes a blocked session: no retry, silent merge, localStorage fallback, GitHub/cloud upload or false approval. Source ZIP after undo includes only the remaining persisted overrides and keeps its neutral unverified provenance note.

## Verification

Vitest: newly-added file removed, metadata before/after bound to exact source, previous operator override restored, subsequent apply after a reverted record, original stage invalidation and historical additive-only support; reject forged before/after, truncated/secret source, runner/review/GitHub history, invalid stage, pending proposal, obsolete ID/revision/raw; no I/O or credentials.

Actual Chromium two-tab isolated CAS root: stage operator JSON → apply with three consents → verify full audit → undo with 3 separate consents and exact pre-undo raw JSON backup → verify deleted source and all pipeline stages pending → source ZIP omits removed file and independent-review history → reload/explicit reopen; apply another operator patch and let a rival native writer win at third undo consent → no overwrite; historical #169 additive ledger safely undoable; legacy localStorage untouched. Marker `FACTORY_INDEXEDDB_HUMAN_PATCH_UNDO_E2E_PASS`.

Close #170 only when Factory CI + GitHub Pages + Installer candidate are all `completed/success` on the exact final SHA of `main` and the real Chromium marker is present in CI logs.

## Explicit limits

No review attestation, real build/test, runner dispatch, GitHub publishing, multi-device synchronization or full legacy editor migration is introduced. The live `LegacyFactoryApp`/CodeAgentPanel still uses localStorage. Parent #139 and #91/#92/#109/#113 remain open.
