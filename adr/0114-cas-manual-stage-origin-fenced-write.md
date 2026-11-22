# ADR 0114 — Human stage checkpoint authoring with explicit local origin in isolated IndexedDB CAS

Status: accepted as pre-cutover staged writer milestone #161 / parent #139 (22 November 2026).

## Context

The legacy synchronous Factory editor can manually correct completed stage output and invalidate downstream stages. The separate IndexedDB CAS pilot, after stages #155-#160, supported AI stages, inspection, reset and JSON backup but not a human-written stage checkpoint. Directly moving just the live manual output writer would create a split-brain between localStorage and IndexedDB, so this milestone stays opt-in and isolated. Existing Stage.status=complete alone must not be represented as independently verified AI, reviewer approval, CI tests, security review or provider billing.

## Decision

Introduce optional `Stage.completionOrigin` with values `manual` and `ai`. This metadata is a local authoring-path label, **not cryptographic provenance or third-party attestation**. Old backups without it remain valid, reported as `unknown`; an origin on pending/running/failed stage or an unknown value is rejected by the strict inspector and manual preflight. The CAS AI completion path explicitly sets `ai` after its native AI execution; the human path sets `manual` after human consent. Generic stage updates and invalidations drop any old completionOrigin instead of carrying stale labels into pending states.

`buildCasIsolatedManualStage(snapshot,stageId,body)` is a pure preflight: canonical JSON and exact ID/revision, ordered six-stage structure, valid statuses and origin, nonempty text length <=60,000, no running stage, all predecessors complete with nonempty text, target pending/failed/complete. The candidate replaces the target with a new `complete/manual` checkpoint with no previous citations or error, and invalidates all following stages including output, sources, errors, timestamps and stale origin. Earlier stages are unmodified and unrelated project records remain historical; no-op re-writes are refused. This does not recreate runner or GitHub evidence.

The opt-in CAS UI provides a human text draft that is protected by its existing dirty-draft close/switch/refresh interlocks. The user must explicitly approve (1) byte-exact JSON backup download, (2) confirmation the backup was actually saved, and (3) final human replacement and downstream invalidation. Only then does the UI call the revision/raw-bound `CasSelectionController.commit(next, expected)`. Native `tx.oncomplete` is the only successful write acknowledgement. After ACK, clear the draft; on failure preserve the draft, block/reopen explicitly and never retry, rebase, call any provider, touch the live legacy editor or overwrite a rival writer.

The read-only checkpoint inspector shows human, AI and unknown authoring origins with a separate caution that no test or review has been independently verified. React escapes all stage text by default. A running stage needs operator-controlled recovery from #155 rather than human override.

## Evidence / constraints

Vitest checks preflight, tampered raw, unsafe stage ordering, no-op/blank/overlimit, immutable earlier stages, invalidation and no I/O; regression test also checks stale provenance removal in generic stage invalidation. Chromium two-tab real native IDB test checks three consents, exact raw backup, human HTML-looking text inert, manual first and later stage, correction of complete stage invalidating all successors, a noncooperating writer racing the final dialog (human draft preserved without false ACK), reload and untouched legacy localStorage. Required marker: `FACTORY_INDEXEDDB_MANUAL_STAGE_UI_E2E_PASS`. Factory CI/Pages/Installer candidate need completed/success same final main SHA before closing #161.

This does **not** change the live `App.tsx` localStorage writer, prove independent reviewer/test provenance, or deliver cross-device CAS. Parent #139 and #91/#92 remain open.
