# ADR 0110 — Explicit AI stage execution in the isolated IndexedDB editor

Status: accepted as opt-in milestone #157 / #139, 21 November 2026.

## Context

The #156 native CAS pipeline coordinator can begin, complete, abort and fail AI stages, but was not connected to a UI. The live React Factory still persists all active project writes synchronously to localStorage. A partial switch of live pipeline writes would create two competing authoritative stores.

## Decision

Wire `CasIsolatedEditor` (separate, opt-in only) to `openCasPipelineSession`, without changing the live App writer. Operator selects exactly one stage with valid predecessors. A pure `canBeginCasPipelineStage` preflight checks full ordered stage layout, pending/failed target and no other running stage; the actual begin repeats checks on a freshly opened IDB session and compares exact ID/revision/raw with the selection token. The component receives nonsecret settings by prop; AI secret remains session-scoped and is consumed only by the existing `runStage` implementation.

Before any new write or HTTP request: confirm exact raw JSON download, acknowledge actual file saved and separately approve sending project context/checkpoints to the configured model and optional research gateway, including possible provider charges. Only then begin persists `running` with a native transaction and returns the acknowledged ticket. The provider response is committed to complete exclusively through that ticket. AbortController stops the HTTP request; abort and failure are separately persisted as pending/failed via native CAS. Raw provider errors/secrets are not persisted.

After any acknowledged finish transaction, reopen the editor controller read-only and require exact ACK matching before adopting UI state. Post-ACK missing readback / rival mutation must never be called a failed write or retried. Conflicts or unknown ACK block the stale selection, preserve the rival winner and require explicit discovery/reopen and possibly the guarded stage reset for orphan `running` states.

## Tests and limits

Vitest tests pure preflight and existing native CAS stage ticket lifecycle. Chromium SPA test mocks the external OpenAI-compatible HTTP endpoint **only in the browser test**, while every IndexedDB write is a real same-origin browser transaction: three refusal gates, exact raw backup, success, aborted fetch and pending commit, noncooperating rival writer racing a delayed model result, reload and unchanged legacy slots. Marker `FACTORY_INDEXEDDB_AI_STAGE_UI_E2E_PASS`. Factory CI, Pages and Installer candidate must all succeed on the same final main SHA before closing #157.

AI stage output is NOT an independent test, reviewed patch, Code Reviewer approval, provider billing attestation or GitHub push. This does not migrate `App.tsx`, Code Agent, GitHub, cloud/import/restore, bootstrap or selection; #139 remains open. IDB CAS is same-origin/browser-profile only; #91/#92 remain open.
