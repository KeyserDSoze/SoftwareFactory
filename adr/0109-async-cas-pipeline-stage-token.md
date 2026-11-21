# ADR 0109 — Async pipeline stage token protocol on native IndexedDB CAS

Status: accepted as pre-cutover API under #156 / parent #139 (21 November 2026).

## Problem

The live App.tsx pipeline currently uses synchronous localStorage changeProject() to persist stage running, completion, failure and abort cleanup. Native transactional IndexedDB CAS exists, but a long-running AI result needs a token returned **after** the running transaction commits. A stale model answer cannot be written based on the initial config or optimistic React state; a different tab might edit, delete or restore the project while awaiting the model.

## Decision

Add an isolated application-level CasPipelineSession opened only from an existing canonical IDB row. begin(stage) requires a strict six-stage layout, valid predecessors, no other running stage and a pending/failed target, then clears target and all successors, writes running using CasEditorSession.commit, and only after IDB tx.oncomplete issues an immutable, single-use ticket with ID/revision/raw. complete(ticket,output,sources), abort(ticket), fail(ticket,kind) require the *same object issued by this instance* and exact current start snapshot. No parallel duplicate, rebasing, merge or localStorage fallback; a failed/unknown native CAS blocks the underlying session and late AI output cannot overwrite a rival.

Completion requires a non-empty bounded output and bounded structured research sources with http(s) URL; failure records a bounded enum-selected generic message without raw provider secrets. Abort returns the stage to pending, invalidates the run ticket, and prevents its late completion. These transitions are **checkpoint state only**, not attestations of AI execution, independent adversarial review, passing tests, tool provenance or cloud synchronization.

## Scope and evidence

The API is deliberately NOT connected to the current App.tsx writer paths. Connecting only this pipeline path while config, Code Agent, GitHub ack, import/cloud, switch and cleanup still write legacy localStorage would create dual authoritative sources. Vitest tests strict preflight, stage progression, invalid results, abort, fail, token one-use and simulated rival. Chromium builds the API as a separate bundle and runs genuine two-tab IDB transactions: start/complete, abort+late callback, bounded fail, competitor writer during remote-model latency, read-only reopen and reload. Marker FACTORY_INDEXDB_PIPELINE_ASYNC_E2E_PASS is NOT used; the actual marker is FACTORY_INDEXEDDB_PIPELINE_ASYNC_E2E_PASS. Require Factory CI/Pages/Installer candidate completed/success same SHA before closing the issue.

A crashed run may remain running; neither an automatic reset nor a false completed status is allowed. Operator-controlled read-only assessment, exact backup and explicit recovery remain #139. GitHub/remote CAS across devices remains #91/#92.
