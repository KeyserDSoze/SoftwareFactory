# ADR 0106 — Confirmed IndexedDB create cannot be negated by a later readback failure

Status: accepted under #153 / parent #139, 21 November 2026.

## Problem

The isolated IDB pilot creates a new project with a native never-seen CAS transaction. It then opens the just-created project and reloads the library. Both follow-up steps are read-only, but a failure or a racing writer threw into the common UI handler, which incorrectly displayed "create not confirmed" **after a successful tx.oncomplete**. The still-filled form could invite accidental creation with a different fresh UUID. Retrying cannot safely infer that the first commit was rolled back.

## Decision

Treat `confirmCasIsolatedNewProject` as the **only write boundary**. An exact CAS acknowledgment returns committed ID/revision/raw. Immediately clear the new-project form and invalidate any stale library list. A separately pure observational `verifyCasIsolatedCreatedReadback(ack,read)` checks ID+revision+raw and returns `false` for unavailable data, missing/changed row or a concurrent winner. This never triggers a second insert, automatically selects a project or propagates a post-ACK exception as if the commit failed. A subsequent library listing failure also only produces a warning.

A successful readback and library refresh show the existing normal creation notice; otherwise show a distinct IT/EN message stating the create was already confirmed and including the exact ID/revision to guide a manual refresh. Do not expose raw JSON, provider errors or credentials. A pre-ACK failure (including a rejected or indeterminate transaction) still uses the generic fail-closed path, with no retry. This is local single-origin, not cloud or multi-device CAS.

## Evidence

Vitest simulates matching vs stale/changed/missing readback and an unavailable IDB after a single confirmed insert. Real Chromium exercises a browser with an injected failure on the **second** `indexedDB.open` (first open completes the real insert, second readback fails), checks the warning, absence of a generic error, cleared form, single row in another tab and manual discovery after recovery. Legacy localStorage is untouched. Gate `FACTORY_INDEXEDDB_CREATE_POSTACK_E2E_PASS` in Factory CI, plus Pages/Installer candidate on identical main SHA required before closure. Parent #139 remains open until all live writer paths migrate with rollback/versionchange UX; #91/#92 remain open.
