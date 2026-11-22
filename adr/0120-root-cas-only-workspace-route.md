# ADR 0120 — Root CAS-only workspace boundary (pilot cutover step)

Date: 2026-11-22 · Status: accepted for issue #167 (parent #139).

## Problem

The Factory SPA `App.tsx` mounts the legacy project's synchronous `loadProject`, per-ID localStorage writer lease, GitHub autosync/outbox, OAuth/runner polling and `CodeAgentPanel` whenever the default route is shown, including while the operator uses an embedded IndexedDB CAS pilot panel. The CAS panel's own transactions are real, but they do not fence the concurrently mounted legacy effects. Simply setting a React state flag *inside* the Legacy component would leave legacy async effects mounted for at least part of the transition and allow misleading claims of single-store operation.

## Decision

A new **explicit root route** `?workspace=cas` (preserving the GitHub Pages base path) selects a **different React subtree before** any LegacyFactoryApp state/effects initialize. `App` is a minimal router; `LegacyFactoryApp` preserves the existing editor/default route, while `CasRootWorkspace` mounts only a static mode disclaimer and `CasIsolatedEditor`. CAS root reads **settings only** via `loadSettings` (AI profile routing is unchanged), but does **not** call `loadProject`, request a legacy writer Web Lock, mount CodeAgentPanel/BackgroundTaskToast, start GitHub autosync, resolve OAuth login or perform cloud restore. The native CAS editor retains explicit read/list/selection/create/edit/stage/pending/JSON/ZIP/fork/delete contracts and never writes legacy project slots.

Entering this mode from the legacy editor is a **full document navigation**, not a same-page state toggle. The entry gate requires ready writer lease for the selected legacy ID, no in-flight task, conflict, editor draft, project switch or enabled GitHub autosync. It checks `JSON.stringify(projectRef.current)` equals the **actual** per-ID localStorage slot before consent and again **after** all consents: (1) download a complete legacy recovery JSON, (2) confirm the human really saved the file, (3) confirm replacement of the live UI with CAS-only root. An interrupted/declined/stale gate performs no navigation or import. Browser handoff is not proof of saved disk bytes. A direct `?workspace=cas` URL also starts no legacy effects, without requiring any project read (and mounts no selected IDB project until the operator opens the CAS panel).

The CAS workspace's explicit return button checks in-flight operations and unsaved CAS drafts and requires confirmation, then navigates to the regular legacy URL with a **full reload**; this does not copy/merge IndexedDB state into legacy. Languages IT/EN disclose the boundary and limits. The existing embedded pilot is left in place for backward compatibility with previous tests/workflows; the standalone mode is the first root isolation path, **not** a fully coordinated live editor migration.

## Security boundary and non-goals

A URL flag is **not** a data migration or global lock: other tabs (and legacy browsers) may still change localStorage; same-origin IndexedDB is not a cross-device CAS. Neither existing `changeProject` write paths nor legacy pipeline/Code Agent/GitHub ACK/import/cloud restore have been converted to IndexedDB. CAS mode intentionally omits live GitHub/cloud controls rather than silently reusing localStorage. No runner/test/review attestations, GitHub push or cloud sync are fabricated. The rest of epic #139 and #91/#92/#109/#113 remain open.

## Verification

Vitest pure mode parsing, Pages base URL preservation, strict preflight guard for stale/dirty/busy/lease/autosync. Chromium **real built SPA**:
- Open `?workspace=cas` directly with corrupt legacy pointer + stale legacy slot + GitHub autosync enabled in settings. Verify no legacy DOM/lease, no automatic IndexedDB open, native IDB create only after explicit action, no legacy or settings writes and no unintended legacy bootstrap across reload.
- Open normal legacy tab with confirmed per-ID writer. Decline first consent (no switch), then three consents, inspect exact legacy recovery JSON, navigate CAS-only via full reload with original legacy raw unchanged. Explicitly return with consent and check recovered unchanged legacy workspace.
- Marker: `FACTORY_INDEXEDDB_STANDALONE_ROOT_E2E_PASS`.

Close #167 only on verified same final SHA `main` with Factory CI, Pages and Installer candidate all `completed/success` and the real Chromium marker in CI logs. Do not close #139.
