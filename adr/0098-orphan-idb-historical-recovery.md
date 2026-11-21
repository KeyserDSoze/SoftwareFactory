# ADR 0098 — Read-only recovery library independent from the legacy project

Status: accepted for scoped recovery subtask #145 of #139, 21 November 2026.

## Problem

Legacy-to-IDB staging (#141) can leave a valuable exact JSON snapshot even after an accidental localStorage deletion or corruption. The current read-only comparison (#142) requires prepareLegacyCasCopy(), making it unusable precisely when a legacy project is missing or malformed. A UI that treats IDB copies as current also risks accidentally restoring historical runner/AI evidence or overwriting a live editor.

## Decision

Expose listCasRecoveryCopies(), prepareCasRecoveryTicket(id,listedRevision) and confirmCasRecoveryTicket(ticket,explicitConsent). Use the native IDB library reader (#140) with fail-closed validation, max 40 active projects and tombstone exclusion. The preparation reads a present IDB slot without touching localStorage, verifies canonical JSON, and captures **exact** ID, revision and raw before user confirmation. Post-consent, perform **two** independent IDB read-only transactions; reject if either source differs in revision or raw. The raw comparison detects even same-revision modification by a malicious/noncooperating writer. Return original JSON bytes for an explicit browser download; no changes to IDB, legacy, the active project, GitHub or secrets.

## Guarantees and limits

Reads are not an atomic cross-store transaction, nor do they fence writes *after* the final read. An unexpected database error or changed row fails closed; avoid treating a tombstone as a missing or recoverable record. A completed browser download attempt does not prove the user saved the file. The historical JSON may contain proprietary briefs and AI checkpoints; it must not be published or imported automatically. This is **not** a live-editor cutover, remote sync, migration or rollback. The SPA continues to use localStorage until the complete async transition in #139. #91/#92 remain open.

## Verification

Vitest mocks reject missing/corrupt legacy dependencies, invalid/missing/tombstone IDB rows, malformed JSON, absent consent, same-revision raw tampering and stale revisions. Real Chromium exercises the app's new IT/EN recovery UI after creating an IDB-only project and another with a corrupted localStorage slot, accepts a single explicit JSON export dialog (declined consent is covered by Vitest), checks downloaded byte-exact raw, ensures no legacy rewrite, tests stale library revision, forces a second tab to mutate raw at the same revision during confirmation, and verifies tombstone exclusion. Marker FACTORY_INDEXEDDB_ORPHAN_RECOVERY_E2E_PASS. Close only after Factory CI/Pages/Installer success at one main SHA.
