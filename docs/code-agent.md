# Code Agent — prima iterazione

## Come usare

1. Compila il brief e completa l'intera AI Factory, compreso il piano implementativo.
2. Configura un modello compatibile `/chat/completions` per `implementation` e un modello/ruolo `adversarial`. Meglio profili indipendenti.
3. Apri **Code Agent**, descrivi una feature piccola e premi **Genera patch e review**.
4. L'autore AI propone da 1 a 8 file (interi contenuti). La patch passa prima i controlli di struttura e path, poi la review avversaria.
5. Controlla per ogni file differenze, versione prima e dopo, assunzioni e test da eseguire.
6. Solo una review con verdict `pass` abilita **Approva e applica**, che modifica il workspace locale. Una review negativa blocca la patch: scartala e prova una nuova richiesta.
7. In **Architecture** puoi vedere tutti i file aggiornati, esportare lo ZIP o, in **Settings → GitHub**, pubblicare manualmente dopo aver controllato la repository.

## Workspace e conflitti

- Proposte non approvate restano nel progetto locale, ma **non** nei file esportati o nel commit GitHub.
- Le modifiche approvate sono override in `development.overrides`. Le versioni baseline e la cronologia rimangono localmente, nel backup cloud e nel workspace.
- **Annulla ultima feature** torna alla versione precedente solo se l'ultima patch è ancora applicata senza modifiche intervenute.
- Se modifichi stack, servizi o brief, le analisi AI vengono invalidate. Le patch rimangono memorizzate; dove la baseline è cambiata, l'export si blocca. In Code Agent scegli se scartare gli override in conflitto.
- `docs/feature-implementation.md` viene aggiunto alla proiezione di export e tiene traccia solo delle patch approvate e ancora attive.

## Sicurezza e verifica

- Si possono modificare file C# sotto `src/backend/{applications/Api,business,domain,infrastructure}` e TS/TSX/CSS sotto `src/frontend/web/src`. Non si accettano nuovi workflow, `.env`, private key, pacchetti o configurazioni Terraform.
- Il modello non esegue comandi shell, né installa librerie nel browser. Alcuni payload con credenziali sono bloccati con euristiche; non è una garanzia contro ogni segreto.
- La review avversaria è basata su un LLM, non su compilazione: l'utente deve verificare codice, test, dipendenze e security.
- In caso di push su GitHub, la CI automatica dello scaffold prova a compilare backend e frontend. Per i progetti generati che aggiungono nuovi file test, configurare esplicitamente test runner prima di dichiarare qualità production.
- Token e PAT rimangono in sessionStorage. Il backup cloud può contenere codice e dettagli applicativi; non caricare informazioni riservate su servizi non autorizzati.

## Limiti

L'elaborazione si interrompe quando il browser viene chiuso o sospeso; eventuale risposta incompleta viene scartata. Non c'è ancora coding agent iterativo con sandbox e autoriparazione; questa è una milestone di sviluppo supervisionato.

## Repair assistito dai risultati dei test (issue #3)

Il runner remoto calcola un digest SHA-256 di `schemaVersion`, `label`, lista ordinata dei sorgenti C#/React e lista degli step richiesti. Il browser calcola lo stesso digest prima dell'invio e rifiuta le receipt incoerenti. Il report è classificato `passed` **solo** se tutti gli step richiesti sono presenti nell'ordine corretto, hanno exit code zero, risultano eseguiti e il codice corrente ha ancora lo stesso digest, proposal ID e revisione. Un report precedente viene marcato **stale** e non può sbloccare il repair.

Dopo un esito `failed` verificabile su una patch ancora pendente, il pulsante **Proponi correzione AI** invia al modello autore estratti limitati e non attendibili degli errori. Il modello può sostituire solo gli stessi file della proposta originale; sono vietati path aggiunti o eliminati, modifiche a dipendenze e workflow, e patch identiche. Si possono tentare al massimo **due riparazioni** per feature. La nuova patch riceve un ID diverso, perde review ed evidenza dei test precedenti, richiede **adversarial review** nuova e una nuova esecuzione del runner.

Il pulsante **Approva e applica** per patch riparate controlla nuovamente il report in tempo reale e ricalcola il digest. Devono risultare `passed` almeno `dotnet-build` per modifiche C# e/o `web-build` per modifiche React. In mancanza del runner o se i sorgenti cambiano, l'approvazione è bloccata. L'utente conferma comunque manualmente; ZIP e GitHub non sono mai aggiornati da soli.

Un problema infrastrutturale senza un vero test fallito (es. worker interrompe il job) viene mostrato come incomplete, non sblocca il repair. Una mancata installazione npm dovuta a cache offline potrebbe comunque produrre un exit code fallito: prima di chiedere una correzione al codice controlla che il setup del runner sia corretto.

**Non è un ciclo 24/7**: l'AI repair gira solo con la scheda attiva, e non ripete i test senza il consenso dell'utente. Digest e report legano i dati ma non rendono affidabile un runner remoto compromesso.

## Scrittura di test browser da parte del Code Agent (issue #5)

Il Code Agent può generare o aggiornare anche test `src/frontend/web/e2e/*.spec.ts` (comprese sottocartelle con path sicuri), oltre ai sorgenti React/C#. I test Playwright si validano come file di codice: proposta JSON, diff, review avversaria e approvazione manuale; restano esclusi workflow, package.json e `playwright.config.ts` per ridurre lo scope di modifica dell'AI. Se una patch riparata modifica uno spec E2E, il gate di approvazione richiede un nuovo esito positivo `playwright` sullo snapshot aggiornato.
