# ADR 0094 — Backup-gated, non-destructive legacy-to-CAS staging

Status: accepted for subtask #141 of #139, 21 November 2026.

## Decision

The active project's legacy localStorage per-ID slot is captured as the exact raw JSON string. Validate canonical JSON, project identity, shape and 1M-character maximum without normalizing stage state or checkpoints. The user first authorizes a direct download of that JSON, then separately confirms actually saving it. Only after affirmative consent may the browser attempt a never-seen insert into IndexedDB. Existing IDs, including tombstones, are collisions. Validate all existing IDB rows and the 40-live-project capacity in the SAME readwrite transaction as add; acknowledge only on transaction completion, with no automatic localStorage fallback.

Re-read the exact legacy raw both before and after the IDB transaction. If another writer changes legacy during the transaction, a copied IDB snapshot may now be stale: report that limitation, never automatically delete or overwrite either store. Keep the live localStorage editor, selected project and any PAT/session secrets untouched. The source JSON downloaded into a browser does not prove the file was saved durably on disk.

## Verification

Vitest tests malformed, missing, noncanonical, oversized and mutated legacy raw and confirmation requirements; Factory Chromium exercises the live UI download, exact JSON file bytes, two dialogs, duplicate rejection, a two-tab racing insert, stale legacy source, and tombstone. Marker FACTORY_INDEXEDDB_LEGACY_COPY_E2E_PASS.

## Deferred

No automatic migration, no switching of the active editor, no cross-store atomicity and no cloud/multi-device CAS. The future #139 milestone must migrate ALL write paths to asynchronous CAS, provide recovery/rollback UX and source-of-truth consistency. #91/#92 remain open.
