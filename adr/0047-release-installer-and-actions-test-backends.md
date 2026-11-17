# ADR 0047 — Installer nelle Release e secondo test backend GitHub Actions

- Data: 17 novembre 2026
- Stato: accettato per implementazione incrementale (live PAT/Release da collaudare)
- Feature: [#90](https://github.com/KeyserDSoze/SoftwareFactory/issues/90)
- Connessa: #89 software house, #87 installer/runner, #2 runner di test

## Contesto

La SPA SoftwareFactory gira su GitHub Pages senza servizio backend centrale.
L'utente desidera scaricare l'installer del runner direttamente dall'app e
testare il codice generato tramite **runner Docker locale/remoto** o **workflow
GitHub Actions** a scelta. Sono due modelli diversi: il runner remoto riceve uno
snapshot temporaneo via API e mantiene journal/attestazioni proprie; GitHub
Actions testa soltanto il codice **già pubblicato su GitHub**.

## Decisioni

### Release come canale di distribuzione

`.github/workflows/release-installer.yml` è una Actions manuale con
`workflow_dispatch` e tag SemVer stabile. Pubblica un archivio sorgente
`softwarefactory-runner-installer.tar.gz`, il suo SHA-256, note e guide
`INSTALLER.it.md` e `INSTALLER.en.md`. Il workflow gira solo su `main`,
non sovrascrive Release precedenti; richiede autorizzazione maintainer e
permesso `contents:write` solo in quel job. **Aggiungere il workflow al
repository non pubblica automaticamente la Release.** Un operatore deve
lanciare la Action `Publish Linux runner installer`, scegliendo
`v<major>.<minor>.<patch>`; la UI segnala che l'asset non è disponibile
finché una Release valida non esiste. Il checksum rileva corruzioni ma
non sostituisce la verifica indipendente della firma del publisher.

La SPA esegue un `GET /repos/KeyserDSoze/SoftwareFactory/releases/latest`
**senza PAT**, verifica che il nome dell'asset, il tag e il dominio
`github.com` coincidano con quanto atteso, e mostra collegamenti
di download. Non avvia installazione di sistema né esegue SSH. L'utente
estrae e lancia il wizard sul proprio Linux dedicato; nessun token è
contenuto nell'archivio. La guida i18n IT/EN è nel frontend, con
documenti completi scaricabili; la migrazione i18n del resto della
SPA è incrementalmente aperta.

### GitHub Actions come secondo executor

Il generatore produce `.github/workflows/softwarefactory-tests.yml`
e `scripts/softwarefactory-tests.mjs` in ogni repository applicativa
generata. La Action `workflow_dispatch` accetta **soltanto** UUID di
correlazione e cinque scelte booleane:
`dotnet-build`, `dotnet-test`, `web-build`, `web-test`,
`playwright`. Un job su `ubuntu-latest` usa `contents:read`
e checkout con `persist-credentials:false`; esegue comandi precisi
in `spawnSync` senza shell, con timeout e output ridotto/redatto.
Test non presenti o dipendenze non installabili sono **incomplete**,
mai superati. Lo smoke Playwright di default verifica la UI con API
mock: non equivale alla verifica full-stack DB/OIDC nel runner di test.
Per integrarli realmente servono una nuova selezione e infrastruttura
isolata esplicitamente preparata.

Il processo scrive sempre `softwarefactory-results/report.json`
(schema 1, `requestId`, `repository`, `ref`, `commitSha`, `runId`,
`runAttempt`, timestamp, risultati per-step con exit code, tempo,
stato, motivo, estratto log e conteggi coerenti). Il workflow carica
l'artifact `softwarefactory-test-report` con `if:always()`. Il job
fallisce se un test fallisce o è incompleto; non si creano successi
artificiali. Le build possono eseguire package scripts del repository:
il runner è **effimero e sotto GitHub**, non il PC dell'utente.

### Collegamento PAT dalla SPA

La SPA usa il PAT di sessione configurato nelle Settings (Contents:read,
Actions:read/write) per leggere lo SHA della branch prima della dispatch
e inviare la `POST .../actions/workflows/softwarefactory-tests.yml/dispatches`.
L'API restituisce **204 senza run ID**: non si può attribuire
l'ultimo workflow al nostro task. Usiamo un UUID in `inputs.request_id`
riportato nel `run-name`, poi cerchiamo esattamente la combinazione
UUID, branch, SHA e evento workflow_dispatch. Se il branch cambia,
il client considera il risultato obsoleto.

`GET .../actions/runs/<id>/artifacts` recupera il relativo ZIP.
Il browser può non seguire il redirect a URL firmato per CORS;
la UI espone la pagina del run GitHub e l'importazione manuale dello
ZIP. Il JSON viene validato **dopo** il download e confrontato con
UUID, repo, branch, SHA, run ID, attempt, set degli step scelti,
stati/conteggi e conclusione della Action. Un JSON valido conferma
coerenza tra i dati letti e i metadati di GitHub; **non è una firma
crittografica né prova indipendente che il codice nella Action non
abbia falsificato il report**.

**Niente auto-merge, auto-push, auto-apply o invio nascosto di log a LLM.**
Per collegare i fallimenti alla riparazione AI servono una policy
di provenance, gate di review e autorizzazione esplicita. L'API runner
mantiene separato il proprio journal: non si convertono report Actions
in report Docker fittizi per superare i gate.

### Limiti e attività rimanenti

- La Release non esiste fino a un dispatch esplicito del workflow sul
  repository SoftwareFactory; il collaudo release e la firma indipendente
  dell'archivio sono aperti.
- Il workflow generato deve essere pubblicato sul **default branch**
  della repo applicativa prima di essere dispatchable.
- Non è ancora stato eseguito un vero `workflow_dispatch` tramite PAT
  dalla SPA su una repo generata privata, né verificata ogni combinazione
  di test in ambiente GitHub. Il redirect artifact e CORS dipendono dal
  browser/provider; import ZIP è la modalità di backup.
- I test senza progetto `*Tests.csproj` o `npm run test` restano
  incomplete; un setup a DB reale richiede provisioning ulteriore.
- La localizzazione IT/EN copre il nuovo wizard, download e test
  Actions; le sezioni legacy italiane devono migrare gradualmente.
- Riavvio VM, rotazione API key/tunnel token, cloud vault multi-device,
  prerequisiti installer e firma supply-chain sono ancora in #87/#89.
