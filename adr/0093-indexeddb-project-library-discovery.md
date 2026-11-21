# ADR 0093 — IndexedDB project-library discovery before editor cutover

Status: accepted for infrastructure-only milestone #140 (21 November 2026). Parent #139, follows #138 / ADR 0092.

## Context

The Factory editor still saves to localStorage. The separate IndexedDB compare-and-swap primitive can atomically write one project's version, but a future migration requires a trustworthy way to discover IndexedDB projects without a global localStorage index that can lose writes across tabs.

## Decision

Export listCasProjects() from project-cas.ts. Read the CAS database in one readonly transaction with a cursor. Validate every key, record and JSON project identity/schema/1M-char bound through existing readRow. Return only id, name, updatedAt, repository and revision. Omit tombstones without deleting them. Sort updatedAt descending, ID ascending. An invalid row or more than 40 live rows must abort the list rather than silently omit data. Error messages must not leak raw JSON. No storage writes or localStorage fallback.

A future milestone must decide atomic admission for a maximum 40-project IDB library; this read-only method only detects overfull stores, not prevents their creation by CAS clients.

## Verification

The Factory CI browser harness checks real IndexedDB on two Chromium pages, tab reopen, tombstones, second project, a deliberately corrupt row, then 41 active rows. Existing preflight Vitest also rejects unavailable IndexedDB without localStorage fallback. Marker FACTORY_INDEXEDDB_LIBRARY_E2E_PASS.

## Deferred

The method is not linked to SPA project selection. No automatic migration, backup, async editor cutover, cloud CAS, cross-device identity or silent cleanup is claimed. The migration design, operator consent/backup, conflict recovery and full async write-loop belong to #139; #91/#92 remain open.
