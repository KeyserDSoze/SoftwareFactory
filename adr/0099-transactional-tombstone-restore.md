# ADR 0099 — Intentional tombstone restoration with exact backup and transactional capacity

Status: accepted infrastructure milestone #146 of #139, 21 November 2026.

## Problem

CAS foundation #138 distinguishes a missing project from a deletion tombstone and preserves monotonically increasing generations. The future async editor session #143 and selection controller #144 can update/switch existing records, but deletion and human-approved restoration need stricter semantics. Restoring via a generic `compareAndSwapCasProject(project,null)` can recreate a tombstone without tying intent to the precise deletion generation, and cannot be treated as an operator-approved restore.

## Decision

`CasSelectionController.delete(expected, consent)` verifies exact id/revision/raw and positive consent, fences outstanding saves and switches, and invokes `deleteCasProject` CAS. It returns the tombstone only after the native `tx.oncomplete` of the primitive. The controller becomes blocked after confirmed deletion or ambiguous ACK/abort, because the old session token cannot be used to edit a deleted project. No retry or fallback.

`prepareCasTombstoneRestore(id, backedUpRaw)` validates canonical, byte-exact JSON of the named project and captures a matching tombstone id+revision with read-only IndexedDB. `confirmCasTombstoneRestore(ticket,true)` requires independent consent, re-reads the current tombstone and delegates to `restoreCasTombstoneProject(project,expected,exactRaw,consent)`. This primitive validates consent, ID, backup and tombstone before opening IDB. Inside ONE readwrite transaction, it reads and verifies exact tombstone generation, scans and validates all active rows and the 40-active-project capacity, then writes raw from the backup at tombstone revision +1. No await happens within the transaction; only `tx.oncomplete` may return an ACK. Stale, missing, live, corrupt, at-capacity and incompatible versions reject without overwriting.

## Multi-tab and residual limitations

Different browser tabs and noncooperating writers are serialized by the underlying IDB transaction, not by an in-memory lock. After a confirmed delete, stale writes with the old token are rejected. Two restore requests for the same tombstone and raw cannot both succeed; only one increments the revision, preventing ABA. This is still **infrastructure only**, not a React UI mode or a complete source-of-truth cutover. **Updated by ADR 0100 (#147):** generic CAS `expected=null` now rejects all existing rows including tombstones and enforces the 40-active-project limit inside the same transaction. Only explicit backup+consent restoration may revive a deleted project. Human proof that a backup was actually saved and the end-to-end UI/rollback remain outstanding under #139. No multi-device guarantee or provider attestations (#91/#92).

## Verification

Vitest mocks validate exact backup, denied consent, missing/stale tombstone, no localStorage and delete-controller fences under delayed/failed IDB ACK. Real Chromium uses two same-origin tabs with IDB CAS, checks delete from live selection, blocked stale edit, dual-tab concurrent restore (one winner), exact raw and revision progression, stale ticket rejection, a capacity-40 abort preserving tombstone and zero legacy mutation. Gate `FACTORY_INDEXEDDB_TOMBSTONE_RESTORE_E2E_PASS` on Factory CI. Require Factory CI, Pages and Installer candidate all completed/success for one main SHA before closing #146.
