# ADR 0105 — Requirements editor in the isolated IndexedDB CAS pilot

Status: accepted for scoped sub-issue #152 under #139, 21 November 2026. Extends ADR 0102 and 0104 without live-editor cutover.

## Problem

The operator can edit name and brief in the standalone CAS pilot, but project-level `config.requirements` remains inaccessible without writing through the unrelated legacy editor. Mixing sources of truth before coordinating all Factory writer paths is unsafe. Deleting a project with unsaved requirements would also risk discarding the operator's new draft.

## Decision

Extend the same exact-snapshot pure `buildCasIsolatedConfigEdit` operation to requirements, bounded to 12,000 characters and validated before storage. Canonical historical copies without a requirements field are read as empty for editing; unexpected non-string values fail closed. No-op detection considers all three fields. Keep config's other settings unchanged and invalidate dependent AI stage checkpoints, not silently reusing old evidence.

The React pilot tracks requirements in its isolated draft and includes them in its dirty check, create/open/switch, commit and reset lifecycle. It keeps the pre-existing **byte-exact JSON backup before the edit**, explicit file-saved confirmation, and the transaction-completed revision-bound `CasSelectionController.commit` acknowledgement. A concurrent native writer is never silently rebased or overwritten. The delete preflight must require the requirements draft to match the pinned canonical source; if dirty it is rejected without tombstoning.

## Verification and boundary

Vitest checks immutability, field bounds, no-ops, malformed historical snapshots, stage invalidation, no storage access in the pure builders and delete refusal on a requirements-only draft. Real Chromium SPA test covers an initial disabled save, changing requirements, exact downloaded backup, confirmed rev+1, noncooperating tab winning during consent, explicit reload/reopen, and legacy localStorage unchanged. The existing delete Chromium test additionally blocks deletion for unsaved requirements and preserves historical requirements in the backup. Marker `FACTORY_INDEXEDDB_REQUIREMENTS_E2E_PASS`.

Do not treat this as the coordinated #139 cutover. All live Factory writer paths, recovery/rollback and quota/versionchange UX remain outstanding. #91/#92 cover independent cross-device/provider concerns.
