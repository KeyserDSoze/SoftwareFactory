# ADR 0102 — First isolated IndexedDB editing surface, never a partial live-editor cutover

Status: accepted for scoped milestone #149 of parent #139, 21 November 2026.

## Problem

CAS foundation (#138), async session (#143) and revision-fenced selection (#144) guarantee transactional writes, but no operator-facing React editor has ever committed through their path. The main SPA remains synchronous localStorage, including pipeline/Code Agent/GitHub/import/restore; replacing only a few writers there would create two authorities for a single in-memory project, risking lost updates and false persisted acknowledgements.

## Decision

Offer a strictly opt-in and **separate** React `CasIsolatedEditor` panel in the local-project section, not as the main workspace source. Nothing is read or written in IDB until the user opens the panel and chooses a source. Discovery uses IDB-only validated choices. Initial open reads a canonical exact CAS token, requires consent, reads again and rejects changed ID/revision/raw; switching uses #144 `prepareSwitch` and `confirmSwitch` with preconsent and postconsent checks. A dirty draft cannot silently switch. The component has its own state and `CasSelectionController` ref and never calls live `setProject`, `changeProject`, `persistProjectIfUnchanged`, GitHub, cloud or runner.

Only name/description can be edited initially, bounded to 120/8000 characters. Pure `buildCasIsolatedConfigEdit` validates the exact canonical snapshot and uses domain `updateConfig` and `invalidateStages` to reset stale pipeline output/sources when the configuration changes. No changes are silently rebased or combined with a newer snapshot. Existing other fields and historical GitHub evidence are preserved as *historical only* and do not certify the new source.

Before committing, two human steps are required: approve download of the **byte-exact pre-edit project raw** (`id/revision` in filename) and independently confirm that the file was actually saved. Only then call `CasSelectionController.commit(candidate, expected)` and update React state after its `tx.oncomplete`. A concurrent writer may win, so the transaction must fail, lock the session and require a fresh manual read; no automatic retry, fallback to localStorage, or optimistic UI ACK. List refresh does not automatically advance the pinned edit token; a failed session must reopen via explicit selection.

## Evidence and remaining work

Vitest proves pure editing/invalidated stage evidence and no storage interaction. Real Chromium in two tabs tests explicit open, backup cancel and second-consent decline, raw byte-for-byte download, successful CAS revision and stage invalidation, controlled destination switch, a noncooperating rival writer during confirmation, failed stale commit without overwrite, explicit re-open and reload; it asserts no writes to the live legacy project. Gate `FACTORY_INDEXEDDB_ISOLATED_EDITOR_E2E_PASS`, plus Factory CI/Pages/Installer on the same main SHA.

This is a **separate pilot** and does not make IDB authoritative for the main SPA. Full atomic cutover of all live write paths, bootstrap, projects selection, import/cloud, GitHub publication ack, Code Agent, pipeline and end-user rollback/diagnostics is still #139. Cross-device provider consistency #91/#92 remains unproven.
