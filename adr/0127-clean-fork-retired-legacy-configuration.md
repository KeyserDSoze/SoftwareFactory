# ADR 0127 — Clean configuration-only fork of a retired legacy project (#174)

Date: 23 November 2026. Status: accepted for an incremental assisted recovery, NOT full CAS cutover.

## Context

ADR 0126 introduces a cooperative, persistent per-project localStorage write retirement marker before transferring a project to an independent IndexedDB row. If native insertion is uncertain or the operator returns to legacy, the historical project remains deliberately read-only. Automatically deleting/releasing its marker or retrying insertion would create two active sources of truth across non-transactional storage engines. The user needs a safe way to continue their brief and architecture without importing historical code or unverified evidence.

## Decision

Provide a separate opt-in operation **Recover configuration only into a NEW legacy project** in the retired project's banner. Only a strict, valid marker with matching SHA-256 of the canonical, unchanged project JSON authorizes preparation. Verify the stack schema, six coherent stages and no running stage. Never assume a marker alone attests a successful IDB insertion. The source project, its retirement marker, all native CAS snapshots and old settings remain unchanged until the new local write.

Before any write, the operator must (1) authorize/download the **exact source JSON bytes** (including historical sensitive fields, for separate secure storage), (2) confirm the file was actually saved, and (3) consent to a **fresh UUID** and a configuration-only recovery with empty evidence. The ticket captures the exact source raw/digest and new UUID/serialized target. Reject tampered target tickets. Verify the source and marker after asynchronous SHA-256, before the new target lease, and again after obtaining an exclusive **ifAvailable** Web Lock on that new ID. Require the target slot to be absent with no per-ID retirement marker, both before and after lock. Use the existing checked localStorage insertion API with expected=null; do not rebase onto another writer's target or adopt a newer baseline.

Copy only validated, non-secret project `config` (name with a `(recovery)` suffix, description, requirements, complete frontend/database/deployment/service bindings). Generate all six stages afresh as `pending`, empty outputs/sources, no completion origin. Never copy `development`, Code Agent history/pending/overrides, source research, AI/review assertions, GitHub bindings/receipt, runner/test evidence or secrets. Reset the operator's GitHub destination and autosync before reloading the legacy SPA on the newly saved UUID. A successful acknowledged write may move the tab's active pointer to the new ID; this is not a migration or deletion of the protected historical ID.

In an uncertain local storage ACK (including quota/readback failure), **never automatically retry** or mark the target absent; the slot might have committed. The UI instructs manual inspection of the local project library and source backup. An observed rival target insertion cancels the fork. If source readback after commit is stale, leave the target as `created_unverified` and do not navigate. The original marker remains armed throughout.

## Limits

localStorage `getItem` + `setItem` is not a global atomic compare-and-swap against a noncooperating writer or malicious browser extension. The Web Lock only coordinates updated clients on the same origin; separate profiles/devices and old scripts can still race. The selected fork remains on legacy localStorage and is **not** a CAS-only IndexedDB project. No cloud sync, Google/OneDrive or live GitHub Actions acceptance is claimed. Future full async editor cutover remains #139; provider security #91/#92 remain separate.

## Verification

Vitest: canonical/digest marker gate, running/incoherent source, fabricated receipt/target rejection, fresh ID and complete stack copy without prior evidence, denial of consent, quota, target race before/after Web Lock, missing/corrupt marker, unknown local ACK (no repeated write). Real Chromium: exact original JSON download and three consents, an independent browser tab reserves the target during final consent and wins without overwrite, a fresh consent creates only a new config-only UUID and reloads with empty stages and GitHub settings, original marker/source and native IndexedDB row remain unchanged. Marker `FACTORY_RETIRED_LEGACY_CLEAN_FORK_E2E_PASS`. Only close #174 after Factory CI, Pages and installer candidate are completed/success on the same final main SHA; an installer workflow can report success with package/release steps skipped when an immutable tag already exists, and must never be called a new release in that case.
