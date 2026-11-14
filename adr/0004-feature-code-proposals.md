# ADR 0004 — Agent di sviluppo con patch approvate (issue #1)

- **Stato:** accettato per v0.2
- **Data:** 2026-11-14
- **Issue:** https://github.com/KeyserDSoze/SoftwareFactory/issues/1

## Contesto

Lo scaffold DDD statico della v0.1 non implementava le feature. L'utente deve poter evolvere il prodotto mentre viene costruito, mantenendo le decisioni Git e la possibilità di revisionare output AI.

## Decisione

Il Code Agent è un task separato dopo il piano implementativo. Il modello autore riceve brief, requisiti e sorgenti correnti, e propone un JSON rigoroso contenente **interi file** (non comandi shell). Il parser rifiuta JSON invalido, percorsi fuori dalle cartelle codice approvate, duplicazioni, file vuoti, payload eccessivi e indicatori comuni di token/segreti. Gli output non approvati non modificano lo scaffold.

Una seconda chiamata al ruolo `adversarial` valuta le modifiche con un prompt indipendente. Una review `changes_required` blocca l'applicazione; `pass` abilita soltanto il **pulsante manuale** di approvazione, non equivale a prova di sicurezza. L'utente controlla diff testuale e motivi, applica (checkpoint locale), scarica ZIP o pubblica via GitHub. L'undo ripristina l'ultima patch applicata se i file correnti coincidono.

La configurazione può cambiare durante lo sviluppo. Per i file precedentemente modificati si confronta il contenuto della baseline originaria con la nuova baseline generata. In caso di divergenza si blocca l'esportazione o la pubblicazione finché l'utente non elimina esplicitamente **solo** gli override in conflitto. La cronologia registra `applied`, `reverted` o `superseded`.

## Limiti, minacce e alternative

- La SPA **non compila/esegue** codice prodotto dall'AI. Review statica e test suggeriti non sono test eseguiti; GitHub CI dopo il push resta il controllo determinante.
- Non esiste un runner sandbox per permettere il loop edit/build/test; vedi roadmap. Le regole allowlist non sono una sandbox contro codice malevolo.
- Il contenuto AI può contenere codice pericoloso anche senza secret regex. È obbligatoria la verifica umana prima del push.
- La concorrenza fra tab/dispositivi è ancora best-effort (localStorage), non transazionale: lavorare su un dispositivo alla volta, esportare backup.
- La dimensione patch è limitata (8 file, 32k caratteri per file, 85k totali) per mantenere revisioni ispezionabili.
- Non si modifica automaticamente CI, workflow, dipendenze e infrastruttura. Eventuali modifiche extra richiedono workflow dedicati e consenso.

## Evoluzione

Runner isolato con build, test unit/integration/E2E, controllo SHA del filesystem, lock, budget e fixer loop limitato; approvazione e pubblicazione separate (issue futura).
