# ADR 0121 — Full stack configuration composer in the native IndexedDB workspace

Date: 22 November 2026 · Status: accepted · issue #168; parent #139.

## Context and choice

The separately rooted CAS-only workspace (`?workspace=cas`, #167) is a real non-legacy mount. Until now it could create a default project, edit brief/name/requirements, commit manual/AI stages, draft unreviewed Code Agent JSON and export a generated ZIP, but could not edit the full application stack. The main live React composer retained exclusive control over frontend kinds, deployment, .NET runtime, database and per-environment services; that prevented the CAS-only branch from producing a custom deployable scaffold without returning to a second source of truth.

Implement a native CAS-only stack composer in `CasIsolatedEditor` instead of calling `LegacyFactoryApp.editConfig`. A new pure application function `buildCasIsolatedStackConfigEdit(snapshot,config)` accepts only a strict canonical ID/revision/raw and complete, allowlisted configuration: bounded texts, unique nonempty frontend subset, deployment, supported .NET version and database, precisely five service kinds and valid dev/prod choices. Unknown keys, secret-like strings, inconsistent/running stages and noncanonical tickets fail closed. New draft state covers the whole stack; the shared dirty-draft interlock protects close, switch, refresh, fork and returning to legacy. A single save can include both brief fields and stack changes. Historical IDB fixtures lacking full config can still edit their text with the original builder but cannot guess stack defaults.

A stack change alters the generated scaffold and makes previous pipeline output invalid; it uses `invalidateStages(updateConfig(...))` to set all six stages pending, clear output/source claims and origin. **Do not silently repurpose prior code or attestations**: this stack-specific builder refuses if the project has ANY `development` object (pending/applied Code Agent or runner history), `githubDestination`, `githubSync` or `githubTestReceipt`. Users can first create a new **configuration-only fork** (#166) to make a clean, separately identified draft. This is conservative, not an automatic rebase or remote history deletion.

Saving reuses the established IDB-only form flow from #149/#152: first the exact raw JSON source backup is offered to the operator, a separate disk-save acknowledgement follows, then `CasSelectionController.commit(candidate,exactSnapshot)` performs one native IndexedDB transaction with revision/raw CAS; only committed ACK permits UI to adopt the new revision. A rival writer winning during consent blocks the stale commit without retry or silently merging drafts, and source text/select values remain on screen. No legacy localStorage, GitHub, cloud, runner or Code Agent calls are made by this builder/flow. It is **not** independent approval, CI proof or a cutover of the remaining legacy editor writers.

## Verification and limits

Vitest checks complete config changes, six-stage evidence invalidation, no-op and text-only differences, duplicate/empty frontends, invalid database/provider/deploy/.NET, excessive or secret-looking values, forged revision/raw/stage, publication/code evidence fences, and no storage/network I/O.

Real Chromium opens standalone CAS root on an origin with deliberately corrupt legacy state and GitHub autosync settings. It creates an IDB project, commits a historical stage, edits stack including frontend/cloud runtime/DB/service bindings with exact backup and two distinct consents, then verifies rev3 plus invalidated stage evidence and unchanged legacy slots. A second tab wins a race during the last confirmation; the first tab's edited controls remain visible but no stale CAS overwrite occurs. Marker `FACTORY_INDEXEDDB_FULL_STACK_EDIT_E2E_PASS`.

Close #168 only after Factory CI + Pages + Installer CI-approved candidate all `completed/success` for the **same final main SHA**, with this marker in the actual browser job logs. #139 and independent #91/#92/#109/#113 remain open: other live App/CodeAgentPanel/GitHub/cloud writers still persist through localStorage.
