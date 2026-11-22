# ADR 0119 — Atomic config-only fork in the isolated IndexedDB pilot

Status: accepted for pre-cutover milestone #166 / parent #139 · 22 November 2026.

## Context

The isolated IndexedDB pilot can create new default projects, edit configuration, stage a pending Code Agent proposal, export JSON or scaffold ZIP and tombstone a project, but cannot branch an existing project's **configuration** without first re-entering the stack manually. A naive `readCasProject` → human consent → `compareAndSwapCasProject(newId,null)` is unsafe: a noncooperating tab can update/delete the source after the separate read, silently creating a copy of an obsolete version. A new project must also not inherit execution/reviewer attestations or GitHub publication consent.

## Decision

`application/cas-isolated-config-fork.ts` prepares a bounded, canonical ID/revision/raw ticket and strictly validates the source config schema (frontends, deployment, .NET version, DB, service bindings, name/brief/requirements and recognizable secrets), six consistent stages and JSON identity. It calls `createProject()` for a fresh UUID/timestamp, carries forward **only config**, replacing its name with bounded `(copy)`, and deliberately resets all six stages to pending with no output/origin/sources. The newly created record has no `development` object (therefore no overrides, pending proposal, review, history or runner receipt), no GitHub destination, sync/public consent or Actions receipt. This is intentionally **not** a lossless backup or a tested review.

`infrastructure/project-cas.ts::forkCasProjectConfiguration` is a new atomic primitive: one **readwrite** transaction reads the exact source row, checks its `revision` + **byte-identical** `raw`, verifies target config is identical to source except its name, scans all native rows for a target never seen (including tombstones) and the 40-active-project cap, then performs a fresh `store.add`. No asynchronous await occurs inside the transaction; only `tx.oncomplete` acknowledges the new record. Errors/quota/versionchange remain fail-closed with native CAS fault mapping. The source is never rewritten. This transaction cannot confer cross-device/cloud consistency, only same-origin IndexedDB guarantees.

The opt-in CAS panel requires a clean selected snapshot/controller, then three separate human consents: (1) download exact **pre-fork source JSON backup** to preserve recoverability, (2) acknowledge saving that file, (3) authorize the new ID and explicitly stripped state. A failed consent creates nothing; a rival tab changing the source before the tx executes aborts without target or auto-retry. After an ACK, library/readback is **observational**: a failed read cannot turn a successful insert into a false failure prompting UUID retry. The UI leaves the original source selected; working on the fork requires an explicit new selection. No legacy localStorage, cloud or GitHub writes.

## Evidence and limits

Vitest checks config-preservation and strict schema, absent provenance and source evidence, malformed/forged source, altered ticket, secret and oversized values, no external I/O, mock native consent/ACK. Chromium with two real tabs checks byte-exact backup, 3 separate consents, native copy with new ID and stage/provenance reset, rival writer winning during final dialog without creating target, explicit reopened selection, destination tombstone rejection, cap40 atomic rejection, original/legacy unchanged. Marker `FACTORY_INDEXEDDB_CONFIG_FORK_E2E_PASS`.

Close #166 only after Factory CI, Pages and Installer candidate `completed/success` for identical final `main` SHA with logged browser marker. Parent #139 remains open: this is **not** live `App.tsx` cutover or cross-device CAS, and no AI/test/reviewer attestations are proven (#91/#92/#109/#113).
