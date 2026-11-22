# ADR 0117 — Ispezione sorgenti pending Code Agent nel pilota IndexedDB

Data: 2026-11-22 · Stato: accepted · Issue #164 (parent #139, segue #162/#163).

## Contesto

L'editor CAS opt-in conserva la proposta Code Agent come `development.pending` e permette soltanto il suo scarto controllato. Un summary non permette di esaminare i file *full replacement* depositati. La nuova vista non deve essere presentata come review indipendente né far partire codice AI nel browser.

## Decisione

`inspectCasIsolatedPendingCodeFiles(snapshot)` è una proiezione **pura e read-only** di una revisione IndexedDB `{id,revision,raw}` canonica. L'algoritmo valida lo schema stage/snapshot, il numero massimo di otto edit, la revisione del workspace, la allowlist dei path Code Agent e l'unicità, limiti di dimensione/contenuto e pattern di credenziali. Ricalcola i file della baseline con `workspaceFiles(project)` (scaffold + overrides già approvati) e confronta **byte per byte** ogni `edit.previous` con il sorgente attuale: il precedente fornito dall'utente non è una prova. Mismatch, conflict, no-op o generator failure comportano solo `null` e warning senza dettagli sensibili: nessuna riparazione o aggiornamento automatico di raw/pending.

Ogni file viene proiettato come `path`, `reason`, `before`/ `after`, indicatori per file nuovo e troncamento; 1.600 caratteri max per lato. Il React opt-in usa `<pre>` con interpolazione testo (escaped by React), mai `dangerouslySetInnerHTML`, renderer markdown, fetch o link dal testo. La preview è memoizzata sulla snapshot selezionata, quindi una seconda scheda che scrive una revisione nuova **non** modifica silenziosamente il testo sullo schermo. Solo riapertura manuale può adottare un nuovo token. Informativa IT/EN ricorda sempre che la proposta **non è applicata/testata/approvata** e che la preview è troncata: per gli artefatti completi si deve usare un export JSON con consenso.

## Prove e limiti

Vitest: file nuovo, baseline generata, previous contraffatto, path traversal/duplicati, raw e revision non canonici, testo HTML ostile, troncamento ed assenza I/O. Factory Chromium: testo `<img onerror=...>` reso inerte, identificativo e revisione pinned, rilettura dopo reload, modifica da tab non cooperante senza auto-adopt, legacy localStorage invariato; marker `FACTORY_INDEXEDDB_CODE_DIFF_PREVIEW_E2E_PASS`. Per la chiusura verificare Factory CI, Pages e Installer candidate `completed/success` sullo **stesso SHA di main**.

**Non-obiettivi:** approvare/applicare una patch, avviare build/test/runner o Review AI, aggiornare GitHub/cloud, sostituire CodeAgentPanel live. #139/#91/#92/#109/#113 restano aperte.
