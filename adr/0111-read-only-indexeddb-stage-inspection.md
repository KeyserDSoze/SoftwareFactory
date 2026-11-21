# ADR 0111 — Read-only inspection of isolated IndexedDB AI checkpoints

Status: accepted as pre-cutover UX milestone #158 / parent #139 (22 November 2026).

## Context

After #157, the isolated CAS editor can execute actual user-consented AI requests and save outcomes in native IndexedDB. The UI did not expose those outcomes. An operator could not inspect a successful historical response, spot an interrupted `running` task or review sources without exporting JSON. Rendering untrusted AI/research text with active Markdown/HTML or URLs would introduce an avoidable scripting/navigation risk. Silent adoption of another tab's revision would also invalidate the operator's current inspection context.

## Decision

Add `inspectCasIsolatedStages(snapshot)` as an independent pure projection of the *already selected* exact CAS ID/revision/raw. Validate canonical JSON and ordered six-stage schema and fail closed on malformed layouts; no IDB, localStorage, network, provider, runner or write access. Historical output remains AI text, not independently proven test/review/approval. A `complete` state with blank output or `pending/running/failed` with contradictory output/sources is displayed as inconsistent rather than trusted completion. Never expose raw provider error strings, which may contain secrets.

Use React's default text-escaping in `<pre>` instead of HTML/Markdown insertion. Bound the viewport to 12,000 output characters and 16 sources per stage, with bounded source titles/snippets and a clear truncation notice. Do not change persisted raw JSON. Only external HTTPS URLs without credentials/control characters are actionable links; `javascript:`, `data:`, HTTP/private endpoints and malformed/credentialized URLs remain inert labels. Links use `target=_blank` and `rel=noopener noreferrer nofollow`. Sources are still unverified and operator must evaluate trust.

Show `running` as potentially interrupted, not completed. Recovery uses the existing *operator-triggered* selective reset #155 (byte-exact backup, saved-file confirmation and final destructive consent) under revision-bound CAS. Never automatically resume/abort/retry network or adopt a rival write; read the new version only on explicit reopen.

## Evidence, limitations

Vitest tests canonical/raw fail-closed, stages/false completion, security filtering, caps and zero-storage IO. Chromium two-tab integration seeds a real native CAS snapshot including HTML-looking output and unsafe sources; asserts no active DOM image/script, only safe links, read-only running recovery, pinned old version until explicit reload/reopen, legacy workspace unchanged. Marker: `FACTORY_INDEXEDDB_STAGE_INSPECTION_E2E_PASS`. Factory CI/Pages/Installer candidate all need completed/success on the same final main SHA.

This is **not** a live editor cutover, AI execution attestation, independent reviewer, cross-device CAS or cloud/GitHub synchronization. #139/#91/#92 remain open.
