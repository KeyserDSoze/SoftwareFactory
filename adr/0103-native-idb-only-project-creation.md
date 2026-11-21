# ADR 0103 — Explicit native IndexedDB-only project creation in the isolated editor

Status: accepted scoped milestone #150 (parent #139), 21 November 2026. Extends ADR 0100 and ADR 0102.

## Problem

Although the #149 React pilot can edit transactional IndexedDB project copies, it cannot create a new project without first using the live legacy editor and staging a copy (#141). That dependency prevents a genuinely IndexedDB-native project lifecycle and tempts mixing live localStorage with CAS in one editor. The generic CAS insert became safe only after strict never-seen and capacity fix #147.

## Decision

Add `prepareCasIsolatedNewProject(name,description)` producing an immutable, serializable ticket with a fresh cryptographic UUID, default full FactoryConfig, bounded name/brief and all six pipeline stages pending/empty. The ticket is neither an import nor a copy: no inherited AI/runner evidence, GitHub binding, PAT, cloud or settings. `confirmCasIsolatedNewProject(ticket,true)` validates canonical exact JSON, identity, timestamps, default config and unmodified pending stages, and then performs exactly **one** `compareAndSwapCasProject(project,null)` call. Consent false does not touch IDB; native `expected=null` permits only a never-seen row, scans for corrupt rows and enforces cap 40 **in the same readwrite transaction** (#147). A rival writer may win or create a tombstone while the user confirms, and then insert must abort rather than overwriting or resurrecting it.

The existing opt-in `CasIsolatedEditor` gets a separate IT/EN name/brief form, explicit name/UUID confirmation, busy interlock, revision-1 commit check and exact raw readback. Successful creation refreshes the IDB list but does **not automatically open** the new project: selection remains a second explicit consent/revision check. If an IDB session is selected, creation is disabled to avoid displacing a dirty draft; the operator must discard explicitly. Rejections (missing IndexedDB, full capacity, stale UUID, quota, aborted/ambiguous ACK) are fail-closed. In particular, do not silently allocate another UUID and retry after an ambiguous ACK: the original create may already have committed, and a second insert would duplicate the project.

## Tests, boundaries and remaining work

Vitest checks canonical fresh project, stages/evidence purity, source and size bounds, forged ticket/consent denial, exact revision-1 acknowledgement and no localStorage fallback. Actual Chromium E2E uses the React fileds and dialogs to test cancelled/confirmed creation, complete new stage metadata, no implicit live selection, reopen after reload, a noncooperating tab that tombstones the same UUID before consent, 40/41 active capacity refusal, missing IndexedDB, and exact unchanged legacy slots. Required marker: `FACTORY_INDEXEDDB_NATIVE_CREATE_UI_E2E_PASS`; verify Factory CI, Pages, Installer candidate on one final main SHA.

The native-create UI and the #149 writer operate **only** within the separate IndexedDB editor. Live App.tsx remains authoritative from `localStorage`; no other writer path or multi-device synchronization is migrated. Full #139 cutover of all pipeline/Code Agent/GitHub/import/cloud/restore paths, rollback, quota/versionchange UX is still outstanding; #91/#92 remain open.
