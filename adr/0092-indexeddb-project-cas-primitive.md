# ADR 0092 — Fondazione IndexedDB CAS per progetto: primitiva isolata e prove browser

**Data:** 2026-11-20  
**Issue:** #138, milestone #92/#91  
**Stato:** accepted per primitiva e test; **non attivata sull'editor live**.

## Contesto

`persistProjectIfUnchanged` su localStorage confronta e scrive in due operazioni distinte. Web Locks e re-read (#134/#136/#137) proteggono writer cooperativi, ma un client che ignora Web Locks può aggiornare tra compare e setItem. Un CAS richiede che `get + verifica versione + put` siano eseguiti nello stesso ambito transazionale. IndexedDB lo supporta tramite transazioni `readwrite` per singolo object store, ma è asincrono e non può sostituire silenziosamente l'attuale API sincrona senza refactor e migrazione.

## Decisione

Introduciamo `project-cas.ts` come storage engine isolato: database `softwarefactory.project.cas.v1`, object store `projects`, record `{id,revision,raw}`. `readCasProject` legge e valida, restituendo `{id,revision,raw}` oppure `null` per assenza/tombstone. `compareAndSwapCasProject(project,expected)` serializza/valida il progetto (ID, stages, config.name, updatedAt e max 1M caratteri) prima di aprire un readwrite; dentro la stessa transazione il callback del `get` confronta generazione e snapshot raw **byte-esatto** con `expected`, poi programma `put` della revisione successiva, senza `await`. Inserimento `expected=null` consentito solo su chiave logicamente assente. `deleteCasProject` richiede un token corrente e scrive una **tombstone** (raw null, revision crescente), impedendo ABA dopo ricreazione. L'esito è attestato solo da `tx.oncomplete`; errori/abort/blocked/quota o archivio corrotto generano errori generici senza contenuti raw. Nessun fallback a localStorage.

La prova end-to-end usa **due tab Chromium reali nello stesso contesto/origin**, con gara `Promise.all` fra insert/update concorrenti sulla medesima chiave. Un solo writer deve vincere, gli altri vedono conflitto; stale delete bloccato, nuova revisione dopo tombstone e read da pagina riaperta. Test browser con Docker senza rete/privilegi e log di successo esplicito. Le prove unit coprono preflight e no downgrade senza IDB.

## Limiti e prossimi passi

La primitiva **non è ancora chiamata dall'editor**, il cui `store.ts` resta localStorage. Non è dunque corretto chiamare questa milestone “CAS dei salvataggi live”: la #92 rimane aperta per un futuro cutover *esplicito* user-controlled, migrazione/backup legacy, rifattorizzazione asincrona di tutti i write/restore/pipeline/Code Agent e test browser di non-cooperazione. IndexedDB sincronizza tab nella **stessa origin/profile** e non è una transazione distribuita tra device/browser distinti o con provider cloud. Tombstone conserva solo metadata/revision ed è soggetta alle quote e alla retention del browser. Il protocollo non firma né attesta il contenuto AI, i token o il billing. Non sostituisce il test VM rootless/Tunnel né gli E2E OAuth reali.
