# ADR 0116 — Scarto Code Agent pending solo nel pilota IndexedDB

Data: 2026-11-22. Stato: accepted. Issue #163, parent #139.

## Decisione

La #162 permette di preparare nel pannello CAS separato una proposta umana non revisionata. Il nuovo builder puro `buildCasIsolatedDiscardPendingCodePatch` accetta solo snapshot canonici `id/revision/raw` e pending **non revisionati e non riparati**, usando il dominio `rejectPending`. Non altera stage, history, overrides, originali o ricevute runner/GitHub storiche. Una proposta con review/repair richiede un lifecycle diverso.

Un controller `ready` con bozza config/stage/Code Agent pulita è prerequisito. L'operatore approva (1) download backup JSON **raw esatto** della revisione, (2) dichiarazione esplicita che il file è stato realmente salvato, (3) conferma distruttiva con ID/rev. Il download non garantisce persistenza del file. L'unica scrittura usa `CasSelectionController.commit(next,expected)`: confronto ID/revision/raw nella stessa transazione IndexedDB, ACK solo su `tx.oncomplete`. Un writer concorrente, quota/upgrade o ACK incerto blocca, senza retry, rebase o fallback localStorage.

Non è review, approvazione, esecuzione codice, AI, test, pubblicazione, cloud sync né cutover live. #139/#91/#92/#109/#113 rimangono aperte.

## Prove

Vitest: stato immutato tranne pending, guard per raw/token non canonico, review/repair e nessun I/O. Factory Chromium reale: backup byte-esatto, consensi negati/accettati, commit/reload, nuova proposta, writer rivale durante conferma finale e isolamento legacy. Marker `FACTORY_INDEXEDDB_CODE_DISCARD_UI_E2E_PASS`. Verificare Factory CI/Pages/Installer candidato sullo stesso SHA prima della chiusura.
