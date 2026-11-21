# ADR 0097 — Revision-bound IndexedDB selection tickets and writer fencing

Status: accepted for isolated infrastructure subtask #144 of #139, 21 November 2026.

## Context and decision

An IndexedDB session from #143 can save one existing project, but a future editor also needs to list projects, prepare a target before potentially long human confirmation, and switch only if both source and destination are still the intended versions. LocalStorage remains the authoritative live editor until a coordinated cutover; this component must stay isolated.

Add openCasSelectionController(id), wrapping exactly one private CasEditorSession. Expose snapshot, readonly list, prepareSwitch, confirmSwitch and commit. The preparation reads the target via a canonicalized session and captures exact source/destination id, revision, raw plus a local generation. The target ticket is intentionally captured BEFORE confirmation. confirmSwitch enters a switching fence, reopens target from IndexedDB AFTER confirmation and requires exact revision and raw; a concurrent update, tombstone, missing slot, malformed record or unavailable DB rejects the switch and preserves the original session. Successful switch increments generation. Successful commit delegates to the #143 session whose token advances only after native IDB tx.oncomplete, then increments generation; any earlier pending ticket is invalid. No commit while switching or additional switch while saving. On an ambiguous CAS failure, block the controller for manual inspection and explicit reopen rather than automatic retry/rebase.

## Safety boundary

Controller-level fences are only within a single controller instance. A second browser tab or a noncooperating client can write directly to IndexedDB, but the transaction CAS protects actual writes. A previously selected snapshot can become stale immediately after reading; the next commit must fail atomically. A failed switch does not update/delete either store; no localStorage fallback, consent automation, import, restore or cross-device guarantee. This does not connect to the live React editor and is not an incremental cutover: all legacy writer paths still own localStorage. Parent #139 and #91/#92 remain open.

## Verification

Unit tests fake session I/O to cover preconsent ticket, changed target after consent, overlapping switch and saving, old ticket after successful commit, unavailable/missing/tombstoned target and controller blocked after CAS failure. Real Chromium runs two tabs against native IndexedDB: source A and destination B, remote modification of B during confirmation, retry only with a new exact ticket, commit fencing and stale generation, direct tombstone, a reload that reads the committed B snapshot, and zero per-project localStorage writes. Marker FACTORY_INDEXEDDB_SELECTION_E2E_PASS. Close issue only with Factory CI, Pages and Installer candidate all green on one main SHA.
