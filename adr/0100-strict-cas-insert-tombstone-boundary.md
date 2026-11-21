# ADR 0100 — Strict never-seen CAS insert and consent-bound tombstone restoration

Status: accepted for bug #147 / parent #139, 21 November 2026. Updates ADR 0099.

## Problem

The foundational CAS treated `expected=null` as a match for both a never-seen ID and an existing deletion tombstone. Any generic insert caller, including a noncooperating tab, could resurrect a deleted project without the exact backup, tombstone generation and explicit consent required by #146. Generic inserts also lacked the transactional 40-active-project capacity check already present in staging and restore.

## Decision

`compareAndSwapCasProject(project,null)` matches **only an absent slot**. Tombstones, present rows and corrupt rows fail closed, without changing revision or raw. On an absent target, the same native readwrite transaction scans and validates every row, counts all active projects and aborts if capacity is already 40, then executes the add. No await or cross-transaction capacity preflight; acknowledgment occurs only at `tx.oncomplete`. Exact-ticket updates to an existing active row do not increase capacity and remain legal at 40.

The only intentional deleted-project restore uses `prepareCasTombstoneRestore`, `confirmCasTombstoneRestore(ticket,true)` and `restoreCasTombstoneProject` (#146): canonical byte-exact external backup, consent, exact tombstone generation, transactional validation/capacity and monotonic revision. No implicit retry or localStorage fallback.

## Tests and residual constraints

Vitest validates bad backups, denied consent and unavailable IndexedDB before any legacy fallback. Real Chromium tests two-tab first insert races, stale update, tombstone strict no-revive, explicit restore at the next generation, reload, corrupt row rejecting another insertion, 40-active-project limit rejecting a 41st, and updating an existing project at capacity. Marker `FACTORY_INDEXEDDB_STRICT_INSERT_E2E_PASS` required from Factory CI. The current React editor is still synchronous localStorage; the complete cutover and all writer paths remain in #139. Neither cross-device CAS (#91/#92) nor cloud provider acceptance follows from this isolated IDB change.
