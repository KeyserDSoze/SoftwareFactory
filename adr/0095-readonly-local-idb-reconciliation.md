# ADR 0095 — Read-only reconciliation and historical recovery of IndexedDB copies

Status: accepted for incremental milestone #142 / #139 (21 November 2026).

## Problem

#141 creates a copy in IndexedDB while the active editor continues to write localStorage. A historical copy cannot be assumed to track new edits. A missing record is different from a tombstone, and a previous snapshot must not be mistaken for the active project.

## Decision

Expose readCasProjectSlot() as a readonly transaction distinguishing missing, tombstone(revision), and present(snapshot), using the original bounded row validator. Reconciliation compares exact canonical legacy JSON against IDB raw twice, rechecking the legacy source between and after IDB reads, and rejects any detected race. Errors do not fall back to localStorage. The UI provides an on-demand bilingual inspection: no automatic replacement, merge or push.

For a diverged copy, a user can explicitly authorize a JSON export from IndexedDB. Read the slot twice and match exact revision/raw to the inspected revision before initiating the download. Label the file as historical. Never mutate or delete either store. Browser download is not evidence that a file has been durably saved.

## Limits

No transaction or fencing spans both localStorage and IndexedDB, so changes after the final read remain possible. This is NOT a CAS cutover or a substitute for external backups, provider-certified identity, or multi-device sync. All live edit paths remain on localStorage until #139 completes full asynchronous persistence; #91/#92 stay open.

## Verification

Vitest covers identical/missing/tombstone/diverged status, concurrent legacy/IDB changes, corrupted legacy data, unavailable IDB and export revision guard. Chromium exercises the real SPA and IndexedDB: manual stage, further legacy edit, discrepancy, exact historical JSON download, later IDB revision change, and missing/tombstone. Marker FACTORY_INDEXEDDB_RECONCILE_E2E_PASS.
