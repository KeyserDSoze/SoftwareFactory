# ADR 0126 — Legacy per-ID write retirement before IndexedDB handoff (#173)

Date: 23 November 2026. Status: accepted for the incremental cutover (#139), NOT a complete cutover.

## Problem

The assisted handoff (#171) inserts an IndexedDB copy but leaves the per-ID localStorage source available. A returning or concurrent cooperative legacy editor could diverge the original project from the CAS-only version. localStorage and IndexedDB cannot participate in a single atomic transaction. Legacy Web Locks only coordinate cooperating tabs; native IndexedDB CAS serializes IDB writers, not legacy ones.

## Decision

After an operator exports an exact backup and grants three consents, calculate the SHA-256 of the unchanged original JSON and synchronously write a per-ID localStorage marker with schema version 1, project ID and digest. No source content, tokens or secrets are stored in the marker. Read it back exactly BEFORE a native IndexedDB insert. Marker quota/readback errors block the insert. A failed or ambiguous native acknowledgement leaves the marker armed: no automatic retry or unlock.

Updated cooperative persistProject and persistProjectIfUnchanged paths consult this marker, with a second check before writing the authoritative project slot. Corrupt markers are fail-closed. Other project IDs remain editable. The live UI shows an IT/EN read-only warning for this ID and blocks edits, Code Agent and GitHub publication/autosync, while allowing a backup download and an explicit CAS-only route to inspect IDB. Neither a missing IDB row nor a saved marker alone proves that a transfer succeeded; the operator must reconcile backups and the CAS library.

## Limits

This is a best-effort cooperative local writer fence, NOT a transactional localStorage↔IndexedDB CAS, nor global single-writer guarantee. Old scripts, direct localStorage writes, developer tools, separate browser profiles/devices, and external GitHub/provider operations already in flight can bypass or outlive it. Never delete a source copy, remove a marker or infer remote review/test from it. Deliberately defer recovery/unlock to a separately assessed reconciliation protocol, since two storage engines cannot be checked atomically.

## Verification

Vitest: per-ID writer rejection, other IDs still writable, corrupt marker, quota/faulty adapter failure, marker already armed, native insert begins only after verified marker, uncertain native ACK forbids repeat. Chromium: actual handoff with byte-exact backup/three consents, root CAS-only, return to legacy and second tab with current legacy store API, no overwrite, IDB source unchanged. Marker FACTORY_CAS_LEGACY_RETIREMENT_E2E_PASS. Gate closure requires Factory CI, Pages and Installer candidate success for the same main SHA. Parent #139 and provider/device issues #91/#92 remain open.
