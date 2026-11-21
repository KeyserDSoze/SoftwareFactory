# ADR 0101 — Explicit JSON-file tombstone restore UI isolated from the live editor

Status: accepted for scoped #148 of parent #139, 21 November 2026. Builds on ADR 0098, 0099 and 0100.

## Problem

The indexedDB tombstone restore primitive (#146) and strict no-implicit-revive generic CAS (#147) guarantee revision-bound storage mutations, but there is no operator-accessible path in the SPA to select a previously saved backup and intentionally restore a deleted IDB project. Automatic migration would be unsafe because live React writers remain synchronous localStorage and two stores cannot share one transaction.

## Decision

Add a dedicated JSON file picker in the local-project recovery panel, with Italian and English disclosure, strict byte-size preflight (1.5 MB), no file retention or upload, and controlled parsing to canonical project JSON. Accept raw saved project JSON from the legacy/IDB export and the existing v1 `softwarefactory-local-recovery` file envelope from the SPA. For an envelope, only the **project payload** is serialized into IDB; the backup wrapper and timestamp are not project data. Invalid format, unsupported version, malformed/oversized project, non-tombstoned ID or unavailable IDB reject with no write. The file picker resets after each selection so a declined consent can be retried intentionally.

Prepare an immutable current tombstone ticket through `prepareCasTombstoneRestore(id,raw)` **before** user consent; display the project name (bounded length), exact ID and tombstone generation in `window.confirm`, and explicitly warn that checkpoint evidence may be historical. On a positive answer, call `confirmCasTombstoneRestore(ticket,true)`; the second tombstone read and the same-transaction CAS revision/capacity check of `restoreCasTombstoneProject` apply. An absent, already-restored or concurrently updated tombstone fails closed. No silent rebase, retry or localStorage restore.

## Separation of authority and limitations

The new UI writes **only** IndexedDB, invalidates the read-only recovery list, and never selects/open/writes a project in the live legacy editor. It does not invoke GitHub, cloud, runner or secret storage, nor assert current CI/review for the historical AI evidence inside the file. A successful IDB restore is not a two-store rollback and is not a proof that the file is authentic. Backup confidentiality and provenance remain the operator's responsibility. Live editor migration with all writer paths and coherent rollback remains #139; multi-device/cloud #91/#92 stay open.

## Verification

Vitest validates raw JSON, v1 envelope, formatting normalization, invalid schema/identity, oversized text and no storage interaction. Chromium real SPA uses `setInputFiles` in an isolated origin profile, tests malformed/never-seen input, explicit cancellation, a confirmed JSON restore and duplicate refusal, v1 envelope restore, and a competing second tab that restores the same tombstone while confirmation is open. Assert historic IDB raw/revision and that every legacy slot/active-project pointer is unchanged. Marker `FACTORY_INDEXEDDB_UI_TOMBSTONE_RESTORE_E2E_PASS`. Close only after Factory CI, Pages and Installer candidate are completed/success on the exact same main SHA.
