# ADR 0113 — Non-destructive native IndexedDB storage-fault taxonomy and fencing

Status: accepted opt-in CAS operational resilience milestone #160 / parent #139 (22 November 2026).

## Context

The IndexedDB pilot implements native transactional CAS and a fenced editor, but native `VersionError`, `QuotaExceededError` and blocked upgrades could be reported only as generic conflicts, making safe operator recovery unclear. Some IDB object-store methods throw *synchronously*, even when scheduled inside asynchronous request callbacks; uncaught exceptions can obscure transaction abort handling. The synchronous live `App.tsx` writer cannot be partially replaced without creating incompatible sources of truth.

## Decision

Define a narrow, stable `CasStorageFault` taxonomy: `unsupported` for missing API, `upgrade` for native `VersionError`, `quota` for `QuotaExceededError`, and `blocked` for an upgrade/open blocked by another connection. Classification relies on browser-origin native **error.name**, never error.message, stack, project raw or provider exception content. Other cases retain existing generic and safe conflict handling; no arbitrary native error strings are displayed.

In `openCasDb`, reject unavailable/native unsupported errors and version mismatches without database deletion, downgrade, data migration or fallback. For readwrite CAS update/insert/delete/tombstone-restore, catch synchronous `put/add` exceptions, set the sanitized fault and abort the transaction. A request's `onerror` can report the native category but is NOT a terminal successful or failed transaction: `tx.onabort` rejects the write, while `tx.oncomplete` is the only write acknowledgement. Other fail-closed validation, tombstone fencing and capacity checks remain unchanged.

The write session and selection controller continue to become `blocked` after failed/unknown write acknowledgements, but preserve the stable typed storage code for IT/EN pilot UI. A quota abort does **not** clear a human draft, advance IDB revision, claim a saved project, retry automatically or fall back to `localStorage`. A version mismatch warns the operator to use a compatible application and preserve existing backups; it never drops or auto-recreates the existing database. Errors on read-only list/refresh are presented with the same sanitized guidance.

## Evidence and limitations

Unit tests cover code-only classification without native detail leakage, missing-IDB no-fallback, native version mismatch and propagation through session/controller while blocking. Chromium two-tab E2E seeds real native IndexedDB records; a simulated native `QuotaExceededError` is thrown at `IDBObjectStore.put` (physical disk exhaustion is **not** claimed), the real transaction aborts without revision advancement, and the draft remains. An actual upgrade to IDB schema version 2 in the *ephemeral test context only* verifies v1 readers refuse downgrade while data is preserved. Removing the IDB API tests the unsupported path; legacy `localStorage` remains untouched. Marker `FACTORY_INDEXEDDB_STORAGE_FAULT_E2E_PASS`. Require Factory CI, Pages and Installer candidate completed/success for identical final `main` SHA before closing #160.

This milestone is only the isolated CAS pilot and storage guard; it does not migrate the live synchronous App, implement full rollback/migration, establish cross-device atomicity or verify external providers. #139/#91/#92 stay open.
