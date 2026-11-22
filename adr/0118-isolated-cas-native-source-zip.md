# ADR 0118 — Source-only ZIP from the pinned IndexedDB CAS project

Status: accepted · 22 November 2026 · issue #165 / parent #139.

## Problem

The legacy live Factory can export a generated scaffold ZIP via `App.tsx` but persists its workspace via synchronous localStorage. The isolated native IndexedDB editor has genuine CAS writes, direct project creation and a complete raw JSON backup, yet has no way to export generated sources independently. Reading the same project's legacy slot to produce a ZIP would create a misleading second source of truth.

## Decision

Add `prepareCasIsolatedSourceZip(snapshot)` as a **pure** builder on canonical ID/revision/raw and valid six-stage layout. It derives sources from `workspaceFiles(project)` — deterministic scaffold plus **already applied** overrides — and checks the development workspace shape, applied override path allowlist, contents and originals, generator conflicts, limited entry size/count and obvious token/private-key patterns. A failure means **no ZIP and no fallback**; scanning for recognizable secrets is *not* a guarantee that other secrets are absent.

`development.pending` is deliberately **never** merged into the ZIP, even if a user has staged human JSON. Historical `docs/feature-implementation.md` is removed from this particular archive: it includes a statement implying independent review based only on a possibly restored/imported project history, which cannot be attested by a read-only export. A neutral `docs/cas-idb-export-provenance.md` explains unverified provenance, absence of build/test/Code Reviewer/runner attestations, pending exclusion and operator review before publishing. App legacy ZIP and its source of truth are **not** changed by this milestone.

In the **isolated** React panel, the operator sees IT/EN warning about project data, missing unsaved drafts and unverified status. Only after explicit download consent does the app call `confirmCasIsolatedExport(prepareCasIsolatedExport(expected),true)`: the established native IndexedDB historical readback checks id/revision/raw, without merge/rebase or retry. If the selected revision changed, **no ZIP download**. On a positive readback, `fflate.zipSync` creates the archive entirely in memory and browser download is offered; a separate confirmation distinguishes operator-reported disk save from an unverified browser handoff. A dirty React draft remains untouched. No project/legacy/cloud/GitHub writes, no Code Agent apply, no runner, no AI and no built-in ZIP execution.

## Verification and boundaries

Vitest: scaffold entries/provenance, pending source exclusion, applied override inclusion with exclusion of unverified history claims, forged/invalid raw, stage corruption, path traversal, baseline conflict, oversized or secret-looking source, and no I/O. Real Chromium: create IDB pending patch, download ZIP and unzip to assert **pending excluded** and provenance present; second tab wins during download consent and IDB readback blocks ZIP, preserving both IDB and live localStorage. Marker `FACTORY_INDEXEDDB_SOURCE_ZIP_E2E_PASS`.

Close #165 only after Factory CI, Pages and Installer candidate are `completed/success` at the exact same final `main` SHA and the Chromium marker appears in CI job logs.

This is an **opt-in isolated pre-cutover writer/view**. It does not change `App.tsx` bootstrap, switch, CodeAgentPanel, pipeline writer, cloud restore, import, GitHub sync or rollback. Parent #139 and sync/security #91/#92 and independent agent/reviewer #109/#113 remain open.
