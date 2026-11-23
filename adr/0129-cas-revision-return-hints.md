# ADR 0129 — Explicit CAS-only return hint pinned to exact native revision (#176)

Date: 23 November 2026. Status: accepted for a scoped CAS-only reload/selection milestone of #139. Not the complete live editor cutover.

## Context

The standalone `?workspace=cas` root has native IndexedDB CAS selection, edits, stage pipeline and supervised local code patching. It opens nothing at startup unless the operator explicitly confirms a prior assisted handoff hint. After a normal CAS-only editing session the operator cannot deliberately bookmark the exact native version to resume later without manually searching the library. Simply persisting the last ID or automatically restoring a selected project risks opening stale or other-tab-mutated data and would inadvertently create a second writer source-of-truth.

## Decision

Add a **human-initiated, read-only** action to the isolated CAS editor to prepare a return URL for the exact currently selected CAS project. It is available only when no unsaved name/description/requirements/stack/manual-stage/Code Agent drafts exist, there is no in-flight commit or running AI stage and the active controller is `ready` and its immutable snapshot matches the React selection. The action asks for confirmation before reading native storage.

`prepareCasRevisionResumeLink` validates the ID/revision, byte-canonical JSON and six coherent non-running stage records; calls `readCasProjectSlot` to require exact same {id,revision,raw}; calculates SHA-256 over the canonical raw; rechecks the UI session gate and makes a second native readback after the awaited crypto digest. There is no automatic native/legacy write, rebase, or retry. An unavailable/blocked/tombstoned IDB row, noncanonical snapshot, concurrent update or a dirty/stale UI selection fails closed.

The URL builder strips **all inherited query parameters and fragments**, including unexpected OAuth `code`, `state` or token fields; preserves HTTP(S) origin+pathname (GitHub Pages base path); adds exactly `workspace=cas`, `casHandoff` (UUID), `casRevision` (native revision), and `casDigest` (64 lowercase hex SHA-256). No raw JSON, description, code, token, credentials, cloud references or GitHub auth values may appear. The resulting link is shown in a read-only selectable input; it is not written to localStorage, sessionStorage or clipboard automatically. The operator decides whether/where to copy/store the link.

The return side reuses the existing #171 CAS-only hint reader: merely loading the URL mounts the isolated root and displays a suggestion **without reading IDB or auto-opening a project**. Only a second explicit click and confirmation may trigger the native selection; `openCasSelectionController`, `matchesCasHandoffHint` and the existing pre/post-dialog exact snapshot comparison reject stale revisions and changed raw. A concurrent IDB writer invalidates the hint; never silently adopt its newer revision.

## Limits

This is a **same-origin browser-profile** pointer to a native revision, not a portable project backup, authentication capability, cloud sync, published GitHub URL or multi-device collaboration. The original IDB project may have been deleted or modified when the link is used. No snapshot contents are embedded in the URL, and users must use separate raw JSON backups for recovery. The legacy root still uses localStorage and live Code Agent/GitHub/cloud writers: #139 remains OPEN.

## Verification

Vitest covers canonicality, non-running stages, dirty/stale gate, native missing/tombstone, exact raw/revision including same-generation noncooperating changes, concurrent post-hash update, blocked native read, URL credential/fragment removal and Pages base path. Real Chromium covers an explicit selected CAS project from the #175 recovery flow: dirty draft disables link, declined consent creates none, affirmative consent emits only four URL keys, full reload mounts CAS-only with no active project, second human confirmation opens exact revision, a second independent tab commits a new native revision and the previously issued link is rejected without write or silent rebase. Marker `FACTORY_CAS_REVISION_RESUME_E2E_PASS`. Closing #176 requires same-SHA successful Factory CI, Pages and Installer candidate; installer packaging/publishing can be skipped if an immutable RC tag exists, which must not be misreported as a new release.
