# ADR 0052 — Import GitHub con ricontrollo HEAD dopo consenso umano

Data: 17 novembre 2026 · Stato: implementato, CI da verificare. Issue [#91](https://github.com/KeyserDSoze/SoftwareFactory/issues/91) e [#92](https://github.com/KeyserDSoze/SoftwareFactory/issues/92). Si affianca ad [ADR 0048](0048-github-pat-project-sync-bookwriter-parity.md), [ADR 0049](0049-local-project-exclusive-writer-web-locks.md) e [ADR 0051](0051-github-lost-ack-tree-reconciliation.md).

## Problema

Un import manuale legge da GitHub un checkpoint riferito alla HEAD corrente. Il browser lo mostra, chiede il salvataggio di un backup locale e due conferme umane. Durante i dialoghi un altro dispositivo potrebbe avanzare il branch. Senza ricontrollo, la SPA può sostituire lo stato locale e memorizzare come `lastCommit` uno SHA remoto non più corrente: il browser presenta una sincronizzazione obsoleta come riuscita.

## Decisione

- `importGithubWorkspace` continua a leggere il checkpoint con `?ref=<SHA>` (non dalla HEAD mobile). Dopo il download rilegge **la HEAD del branch** con `assertGithubImportHead`, e rifiuta uno SHA diverso prima dell'anteprima.
- In `App.importFromGithub("import")`, la destinazione GitHub viene copiata all'inizio. **Dopo il consenso e il backup** una nuova GET della HEAD verifica che corrisponda ancora allo SHA importato, prima di qualsiasi `changeProjectWithLease`.
- Prima e dopo l'ultima GET si controllano **l'identità dell'oggetto progetto corrente** e l'intera destinazione owner/repo/branch/config. Se qualcuno modifica il progetto o la destinazione durante una richiesta, l'import si annulla senza scrivere.
- Il recupero resta manuale, read-only su GitHub, senza merge/force push o nuovo consenso pubblico. Un errore blocca il nuovo checkpoint e permette all'utente di ripetere la lettura.
- I test Vitest simulano branch avanzato durante il fetch del checkpoint e durante il dialogo umano. Richiedono rifiuto fail-closed, nessuna operazione write in import, e validazione dello SHA.

## Limiti

La doppia verifica non è una transazione fra GitHub e IndexedDB/localStorage: un dispositivo remoto potrebbe avanzare la branch subito **dopo** l'ultima GET. Il prossimo push/autosync ricontrolla comunque la HEAD e fallisce se divergente. Il Web Lock locale protegge solo le schede cooperative dello stesso profilo browser. Rimangono aperti in #91/#92 i collaudi PAT/provider reali, le collisioni multi-device e il test browser completo del dialogo.
