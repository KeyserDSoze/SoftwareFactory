# ADR 0112 — Revision-pinned full JSON export for isolated IndexedDB editor

Status: accepted pre-cutover read-only recovery milestone #159 / #139 (22 November 2026).

## Context

The opt-in IndexedDB CAS pilot supports user-consented AI stage execution (#157) and read-only checkpoint inspection (#158), but its selected editor did not expose a direct *full JSON backup* unless the operator initiated a config edit/reset/delete. A backup is especially useful with interrupted or historical AI stages, and must not mutate a draft or assume that another tab has not advanced the CAS record. Prior #145 recovery library and #142 reconciliation already provide safe read-only primitives; reuse them rather than introducing a new storage source.

## Decision

Add a pure `prepareCasIsolatedExport(selectedSnapshot)` which verifies canonical ID/revision/raw and returns a frozen ticket with a filename derived **only** from canonical project ID and revision. No IDB/localStorage/network/secret reads occur at preparation. From the isolated editor only, permit an operator to request an export of a `ready` selected controller, including when configuration fields contain an unsaved draft. The backup exports the **persisted revision** rather than claiming to save the draft. Do not call `accept()`, update React's selected revision, or persist any data.

After the first explicit download consent, `confirmCasIsolatedExport` uses `prepareCasRecoveryTicket` then `confirmCasRecoveryTicket` to perform three native IDB read-only checks of ID/revision/raw. Tombstone, stale IDB revision/raw, unavailable storage or a rival writer prevents the file handoff. No merge, auto-retry or legacy fallback. Only after successful verification hand the exact raw JSON to the browser download API, then ask for an *independent operator acknowledgment* that the file was actually saved. Browser download initiation is **not** filesystem evidence. A separate message distinguishes user-confirmed saved status from unknown file retention. The historical export is not a multi-device source of truth and may become stale immediately after confirmation.

## Evidence and limits

Vitest proves immutable pure preflight, malformed tickets, denied consent with no native reads, stale raw/revision rejection, and propagation of readback conflicts. Chromium tests with two tabs and genuine IndexedDB CAS transactions export exact source bytes from an AI checkpoint, preserve a dirty config draft, refuse download before consent, reject a rival modification while a confirmation dialog is open, and preserve legacy localStorage through reload. Marker `FACTORY_INDEXEDDB_SELECTED_EXPORT_E2E_PASS`. Factory CI, GitHub Pages and Installer candidate must each be completed/success for the identical final main SHA.

No automatic cloud backup, provider credential export, runner-test proof, independent AI/reviewer attestation, CAS cutover of the active App writer or cross-device synchronization is created. #139, #91 and #92 remain open.
