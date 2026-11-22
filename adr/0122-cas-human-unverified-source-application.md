# ADR 0122 — Human-only unverified source application from CAS pending Code Agent

Date: 22 November 2026 · Status: accepted for milestone #169 / epic #139.

## Problem

The standalone IndexedDB CAS editor (#167) can stage operator-supplied Code Agent JSON as **pending only** (#162), show an escaped source before/after diff (#164), discard it (#163) and export a ZIP (#165) that excludes pending proposals. It cannot produce custom source code without going back to the legacy localStorage-backed Code Agent. The existing `approvePending` requires a `FeatureReview.verdict=pass`, and creating or borrowing this object without independent attestation would misrepresent an approval that never happened. An operator's willingness to use source files is different from verification of code quality, successful builds/tests or independent review.

## Decision

Introduce an explicitly named **human source application** path `buildCasIsolatedHumanApplyPendingPatch` under `application`, without calling `approvePending`, AI providers, runner, GitHub or any legacy writer. Its pure preflight accepts only an exact, canonical ID/revision/raw snapshot and a single unreviewed, unrepaired pending proposal whose `revision` matches `development.revision`. Full stage inspection must not contain inconsistent/running stages. The project must not carry independent `development.history`, lastRunnerJobId/Evidence, GitHub destination/sync/test receipts; any such historical trust source blocks application rather than silently reusing it. Previous manual-only applications may exist if their metadata and scaffold baselines are coherent.

Every edited path is re-checked against `allowedCodePath`, with no duplicates, all before/after source strings **fully visible in the inert preview** (max 1,600 chars each), no recognized secret patterns, nonempty reason/content, and `edit.previous` equal to the **actual generated source + current overrides**. The `originals` ledger must agree byte-for-byte with `generateFiles` for every prior applied override; generator conflicts block application. This deliberately refuses large patches that the UI preview would otherwise truncate: seeing an excerpt is **not** consent to unseen source.

The only committed source effects are `development.overrides` and `originals`, a monotone `development.revision+1`, and removing `pending`. Store a bounded `development.humanApplications` ledger with pending ID, human-supplied summary, timestamp, paths and literal status `operator-unverified`. No `history: AppliedFeature`, `FeatureReview`, `lastRunnerEvidence`, `githubTestReceipt` or `githubSync` is created, and all six stage artifacts are unchanged. This does **not** say that source compiles or is free of malicious logic. The source ZIP includes existing manual overrides (not pending changes) and contains a neutral provenance warning that human operator-applied code is unverified. Historical feature-implementation log claiming independent review remains excluded.

The opt-in UI first offers an **exact pre-write raw JSON backup**, then requires an explicit acknowledgement that the user saved it on disk, then a third clear authorization stating no tests/reviews were run. Only `CasSelectionController.commit(candidate,expected)` may perform the single native IndexedDB compare-and-swap transaction; UI success and clearing the pending selection occur only after matching transaction ACK. A non-cooperating tab changing the snapshot during human consent wins; stale application aborts with no implicit retry, source merge, GitHub write or draft loss. This is a same-origin pilot; returning to the legacy editor does not merge source automatically.

## Verification

Vitest: pure builder for new and successive operator patches, source and original baseline consistency, exact preview and secret allowlist, malformed/tampered tickets, in-flight stage/history/runner/review/GitHub refusal, source ZIP includes only applied overrides with neutral provenance, no storage or network.

Real Chromium: `?workspace=cas` root, second native IndexedDB tab, stage human JSON, three apply consents with byte-identical backup, persisted overrides and unverified-only ledger, source ZIP includes patch and provenance but no independent review doc; reload; second proposal raced by rival writer during final dialog keeps pending and blocks stale application; legacy localStorage snapshots unchanged. Marker `FACTORY_INDEXEDDB_HUMAN_PATCH_APPLY_E2E_PASS`.

**Gate:** close #169 only when Factory CI, Pages, Installer candidate all report `completed/success` for the exact final main SHA and real browser marker exists. Parent #139 and independent verification #109/#113, GitHub/cloud #91/#92 remain **open**. Full live `App.tsx`/CodeAgentPanel async cutover is **not** implemented here.
