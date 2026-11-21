# ADR 0096 — Explicit fail-closed async IndexedDB editor session

Status: accepted as a non-UI foundation for #143 / parent #139, 21 November 2026.

## Context

The localStorage live editor uses synchronous changeProject/persistProjectIfUnchanged. Isolated IndexedDB transactions from #138, user-confirmed staging from #141 and readonly reconciliation from #142 do NOT make the existing editor crash-safe, conflict-safe under uncooperative writers or cross-device aware. Replacing only one writer with async persistence would create two competing sources of truth.

## Decision

Add explicit `openCasEditorSession(id)` that reads a present IndexedDB row and validates canonical JSON, project identity and size, returning a session handle; missing/tombstone/corrupt/unavailable IDB fails without implicit project creation. Never read or write localStorage in this module. The handle exposes a defensive snapshot of its current `id + revision + raw` ticket and a state: ready, saving or blocked.

`commit(next, expectedSnapshot)` requires a strict match to the current token, refuses concurrent in-flight operations, validates the candidate before starting the transaction, and passes its token to `compareAndSwapCasProject`. **Only a resolved transaction acknowledgement (`tx.oncomplete` in the CAS primitive)** can advance the token to the returned revision and raw; the new token must match the exact serialized project and expected increment. A conflict, quota/IDB failure, aborted or inconsistent confirmation blocks the session for inspection/reopen. There is no automatic retry, merge, last-write-wins, optimistic acknowledgement, localStorage fallback, rebase, tombstone revival or cross-store transaction.

## Verification

Vitest fakes IDB CAS to make delayed acknowledgements and abort paths observable and proves token unchanged while saving, same-session concurrent submit refusal, stale token rejection, final confirmation fencing and explicit reopened state. Real Chromium builds and runs the actual bundled TypeScript against native IndexedDB in two tabs: simultaneous writers, one loser blocked, a noncooperating direct CAS writer superseding a live session, failed stale commit, explicit browser reload to the newer revision, double click while saving, tombstone refusal and no legacy project localStorage writes. Gate `FACTORY_INDEXEDDB_ASYNC_EDITOR_E2E_PASS`. Factory CI/Pages/Installer evidence required for sub-issue closure.

## Deferred / no false claims

This is a **library only**. The live Studio editor and all its writers still use localStorage: partial cutover must not ship. #139 remains open until all write paths and project selection/reload are converted together, with user-approved backup and recovery. IndexedDB is same origin/profile, not GitHub/cloud or multi-device CAS. #91/#92 remain open pending provider and security acceptance.
