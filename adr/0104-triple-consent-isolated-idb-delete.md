# ADR 0104 — Triple-consent, backup-first deletion in the isolated IndexedDB editor

Status: accepted for scoped issue #151 under parent #139, 21 November 2026. Builds on ADR 0099–0103.

## Problem

The experimental opt-in React CAS editor (#149) can update and create projects (#150), but still lacks deletion. The existing native CAS selection controller (#146) can delete a selected project transactionally using a fenced expected snapshot, and the legacy-independent JSON restore UI (#148) can later revive a tombstone on explicit consent. Without an operator-facing deletion flow these cannot be used together safely; deleting without a verified pre-delete backup risks irreversible history loss, and a stale UI could accidentally attempt to remove a concurrent writer's newer project.

## Decision

Introduce a pure `prepareCasIsolatedDelete(selected, controllerToken, draftName, draftDescription)` that fails closed unless ID, revision, raw are byte-exact and the editor draft is unchanged. The ticket contains frozen id/rev/raw/name and a deterministic JSON filename. Show a separate delete button only in the **isolated** CAS editor, disabled for dirty drafts or when there is no ready session; the live Factory's localStorage project and editor remain untouched.

Require **three independent, ordered human decisions** before one destructive operation: (1) consent to download the pre-delete **byte-exact JSON**, (2) explicit confirmation that the user actually saved the file, and (3) final destructive consent naming the project ID and exact revision. The browser download itself is not evidence that the file was saved. Denial at any gate does not touch IDB. The backup may contain historical AI checkpoints and is not a current review/test attestation.

On all three positive responses invoke exactly `CasSelectionController.delete(expected,true)`. It delegates to native `deleteCasProject` and validates ID/revision/raw in one transaction, with tombstone revision+1 acknowledged only after `tx.oncomplete`. An uncooperative writer may update or delete before final consent; that stale ticket fails closed and the controller is blocked until an explicit reopen, never automatically rebased. No retry after uncertain ACK, alternate ID, implicit resurrection or localStorage/cloud/GitHub fallback. After acknowledged delete release the selected editing token and refresh read-only IDB list; if refresh subsequently fails, it is not evidence that the delete did not commit.

## Recovery, evidence and boundaries

Restoration is an independent operation through the #148 JSON file-picker, requiring the original historical project backup and fresh tombstone + consent; generic CAS `expected=null` cannot resurrect deleted rows (#147). Vitest verifies exact backup snapshot, stale tokens, unsaved draft, corrupt JSON and no storage access before consent. Actual Chromium SPA tests refusal at each of three gates, exact raw backup with original checkpoint, successful tombstone rev2, independent consented restore rev3 and reload, racing noncooperating tab updating the snapshot during final consent, session blocked, reopen of winner and unchanged legacy pointer/slots. Marker `FACTORY_INDEXEDDB_ISOLATED_DELETE_UI_E2E_PASS`. Verify Factory CI, Pages and Installer candidate completed/success at same main SHA before closing.

**Not a live editor cutover:** all main SPA project writes remain localStorage until coordinated migration #139; #91/#92 still open, no claimed cloud/multi-device CAS.
