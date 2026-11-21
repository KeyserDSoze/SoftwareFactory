# ADR 0107 — Guard human drafts on isolated CAS close and blocked refresh

Status: accepted under #154 / #139, 21 November 2026.

## Context

The opt-in IndexedDB editor retains name, description and requirements in React state until the operator completes a backup and an exact-revision native CAS commit. Two existing UI commands can discard this unsaved text: closing the panel **always** reset its state without consent; after a stale write, the controller is blocked, so refresh reset the previously displayed snapshot even though its draft remained dirty. This is silent human-input loss, even if the authoritative IndexedDB row is not changed.

## Decision

Use a pure, fail-closed `hasCasIsolatedUnsavedDraft` against the selected snapshot's exact canonical raw. Missing historical optional description/requirements may represent empty strings; corrupt JSON, mismatched IDs, noncanonical serialization and invalid optional values are always dirty.

A panel close with dirty draft prompts for explicit discard; a refusal preserves all fields and the selection. Read-only refresh in a ready session never discards a draft or changes a write token. A refresh that would reset a dirty snapshot because the controller is blocked/missing prompts for a separate consent; rejecting keeps the old snapshot and text, allowing manual copying. Accepting only clears React draft/selection and refreshes IDB discovery, and still requires explicit consent for re-opening. It cannot save or merge the old text into the rival's revision. The intentionally explicit "Discard draft and selection" command retains its existing meaning. No I/O from the draft checker and no connection to live `localStorage`, cloud, GitHub or remote runner.

## Verification and limits

Vitest: all three fields, empty historical optional values, corrupt/noncanonical row rejection, no storage access. Chromium: deny close with dirty name/brief/requirements, refresh with a ready session retaining draft, real two-tab rival CAS win with blocked session, refuse and accept blocked refresh, accept dirty close without any IDB write, zero legacy changes. Marker `FACTORY_INDEXEDDB_DIRTY_DRAFT_E2E_PASS`. Require Factory CI, Pages and Installer candidate completed/success on a single main commit before closing #154.

This is a safety fix for the isolated IDB pilot, not the coordinated migration of every live writer or multi-device sync; #139/#91/#92 remain open.
