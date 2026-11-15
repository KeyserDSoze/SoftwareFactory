# Remote Test Runner — Docker + Cloudflare Tunnel (issue #2)

**Stato:** MVP sperimentale. API, worker, comandi predeterminati e UI sono implementati, ma il deployment su una VM reale, l'isolamento multi-tenant, il recupero dei container orfani e le build con dipendenze online **non sono stati ancora collaudati end-to-end**. Non esporre questo servizio su server con segreti o workload di produzione.

## Perché non nel browser

.NET WebAssembly esegue codice .NET precompilato, ma non espone nel browser l'intero SDK/compilatore/MSBuild/test runner con accesso al filesystem nativo. Playwright testa browser lanciati in un ambiente Node/OS con browser binaries, non direttamente in una pagina arbitraria. Docker Engine richiede un daemon su un host. La Factory rimane una SPA; invia snapshot a un runner separato.

## Diagramma

```text
Browser SPA (GitHub Pages) — HTTPS
     |  Consentimento invio sorgenti; API key solo sessionStorage
     v
Cloudflare Tunnel + Access (opzionale)
     |  Cloudflared egress-only (nessuna porta pubblica VM)
     v
runner-api (container node non privilegiato)
     | API key SHA-256/timingSafeEqual + CORS esplicito
     | POST /v1/jobs, GET /v1/jobs/:id
     | /data/jobs/<uuid>/input.json, report.json
     v
runner-worker (container node non privilegiato; un solo worker)
     | socket Docker ROOTLESS dedicato, non montato nell'API
     v
Docker daemon ROOTLESS su VM separata (no socket dentro i job)
     | docker run --network=none --read-only --cap-drop=ALL
     | CPU 1, RAM 1GB, pids 128, timeout 120s/step
     v
Container effimeri .NET SDK / Node / Playwright
     | workspace temporaneo, no secrets
     v
report JSON: digest, stato, exitCode, duration, stdout/stderr redatti
```

## Avvio su una VM Linux dedicata

1. Installa Docker Engine **rootless** (utente dedicato, ad esempio uid/gid 1000:1000) e Docker Compose, configura quote CPU, spazio disco e firewall. Non utilizzare un host con workload sensibili. Verifica che il socket rootless sia `/run/user/1000/docker.sock` oppure aggiorna la configurazione.
2. Prepara directory **sull'host e accessibili a uid 1000**:

```bash
sudo mkdir -p /srv/softwarefactory/{runner-data,workspaces}
sudo chown -R 1000:1000 /srv/softwarefactory
git clone https://github.com/KeyserDSoze/SoftwareFactory.git
cd SoftwareFactory
cp docker/runner/.env.example docker/runner/.env
# Genera una key random: openssl rand -hex 32
# Modifica .env con RUNNER_API_KEY, RUNNER_ALLOWED_ORIGINS, host paths e socket.
docker compose --env-file docker/runner/.env -f docker/runner/compose.yml up -d --build
```

Il file `docker/runner/.env` non va committato. **Non montare `/var/run/docker.sock` rootful**. Il socket rootless dà comunque forti poteri al worker: chi lo controlla può avviare container e modificare i volumi di quel daemon. Preferire un daemon separato su VM sacrificabile.

3. Verifica sul server: `curl http://127.0.0.1:8787/healthz` (la sola health non verifica che Docker funzioni). `GET /v1/capabilities` richiede `Authorization: Bearer <RUNNER_API_KEY>`.
4. In Cloudflare Zero Trust crea un **named Tunnel**, configura il token cloudflared nella env e una published application route `runner.tuodominio.it` → `http://runner-api:8787`. Avvia col profilo:

```bash
docker compose --env-file docker/runner/.env -f docker/runner/compose.yml --profile tunnel up -d
```

5. Proteggi il hostname con **Cloudflare Access** (controllo account/identità). Quando la Factory gira su un origin diverso (GitHub Pages), configura accuratamente redirect, CORS e i preflight OPTIONS: i service token Access non vanno distribuiti nel JavaScript o nel browser. Anche con Access l'API richiede la propria API key. Per una configurazione Access browser cross-origin più semplice è possibile pubblicare SPA e runner sotto lo stesso origin tramite un reverse proxy attendibile (ma serve un'architettura aggiuntiva).
6. Nella SPA: **Settings → Remote runner** inserisci `https://runner.tuodominio.it` e l'API key, poi **Code Agent → Test e compilazione reali**. Seleziona gli step e approva esplicitamente l'invio del codice sorgente.

## Contratto API

- `GET /healthz`: sola liveness, non autenticata.
- `GET /v1/capabilities`: lista step disponibili, protetto da Bearer.
- `POST /v1/jobs`: payload JSON `{"label":"feature","files":{"src/backend/domain/EntityId.cs":"..."},"steps":["dotnet-build"]}`. Risponde `202 {id,digest,state:"queued"}`.
- `GET /v1/jobs/{uuid}`: stato `queued | running | passed | failed | incomplete`, SHA-256 dello snapshot, step `passed/failed/skipped`, exit code e log. Se uno step manca o viene saltato, il risultato globale è **incomplete**, non **passed**.

Le operazioni sono fisse, il client non può scegliere comandi shell, immagini o argomenti. Il runner accetta solo subset C#/csproj e frontend web per test, con path allowlist, limite 160 file, totale 1.1MB e 1.5MB di payload. Ogni container ha rete **none** e risorse limitate; root filesystem è read-only (workspace temporaneo scrivibile). I report e input rimangono sulla VM: impostare retention e crittografia filesystem.

## Supporto step

| Step | Comando previsto | Prerequisiti |
| --- | --- | --- |
| dotnet-build | `dotnet build src/backend/applications/Api/Api.csproj -c Release` | .NET 10/11 SDK image, progetto |
| dotnet-test | `dotnet test tests/backend/Tests.csproj -c Release` | progetto di test esplicitamente presente |
| web-build | `npm run build --prefix src/frontend/web` | dipendenze predisposte nella fase `npm-prepare` separata |
| web-test | `npm run test --prefix src/frontend/web` | script `test` configurato e fase `npm-prepare` completata |
| playwright | `./node_modules/.bin/playwright test --reporter=line` | `playwright.config.ts`, spec `e2e/*.spec.ts`, `@playwright/test` 1.64.1, immagine browser Docker 1.64.1, server localhost |

**Limiti importanti:** la preparazione npm è offline per impostazione predefinita. Senza pacchetti nella cache il risultato è `incomplete` e i test non vengono eseguiti. Il container Playwright contiene i browser, ma il pacchetto `@playwright/test` viene installato dalla fase di preparazione; versioni differenti sono rifiutate. I test E2E della baseline simulano il backend `/health` e non verificano ancora database o API reali. Le cause ambientali riconosciute non si trasformano in bug dell'app.

## Test locale del protocollo

```bash
cd src/runner
npm test
npm run check
```

Questi test verificano autenticazione, CORS, schema, hash, limitazioni, pianificazione comandi e report simulando l'esecuzione Docker. **Non provano l'isolamento reale del daemon**. La CI della Factory controlla anche il build frontend e lo scaffold .NET/React.

## Hardening obbligatorio prima di un vero prodotto

- VM dedicata e non privilegiata; rootless Docker user namespace, seccomp/AppArmor, blocco egress, mount, rate limit, quote disco, limiti di job per utente e per IP; evitare il multi-tenant in questa fase.
- Non mettere mai la Docker API sul dominio pubblico. API e worker sono separati, ma il worker ha accesso al socket rootless: in un deployment multi-tenant serve un broker con privilegi minimi e runner effimeri per utente.
- API key forte, rotazione, audit strutturato e gestione accessi per utente; la sessionStorage rimane leggibile da codice JS compromesso (XSS).
- Deduplicazione/idempotency, cancellazione job e container orfani, limiti di storage e retention, limitazione concorrente transazionale, retry espliciti, secret scanning serio e policy di build.
- Cache di dipendenze pre-warmed oppure una fase download controllata con egress esplicito/allowlist; non abilitare rete illimitata al codice AI.
- Versionare immagini Docker per digest, SBOM, SCA e vulnerability scan.
- Per garantire autenticità del risultato associare digest dello snapshot e commit GitHub verificato. Il digest del job non attesta da solo quale versione sia stata pubblicata.

## Retention e limiti di storage

Il worker elimina input e report conclusi dopo 24 ore (configurabile `RUNNER_RETENTION_HOURS`, da 1 a 168). L'API rifiuta nuovi job quando sono presenti 100 directory di job ancora memorizzate. Questo limita l'accumulo di codice sorgente in chiaro sul server; esporta i report importanti prima della scadenza, e non usare il servizio come archivio permanente. Se un worker si interrompe, al riavvio marca `running` come `failed`; l'operatore deve comunque verificare eventuali container orfani.

Il container del singolo step usa UID 0 **all'interno del daemon Docker rootless** per poter scrivere nella directory bind mount di proprietà dell'utente rootless host; `--cap-drop=ALL` e `no-new-privileges` rimangono attivi. Questo UID non è root sull'host. Non sostituire il daemon con Docker rootful: cambierebbe drasticamente il modello di sicurezza.

## Identità dello snapshot e repair supervisionato (issue #3)

La Factory invia al server un JSON canonico `{schemaVersion: 1, label, files: ordinati, steps}`. Browser e server applicano lo **stesso ordinamento bytewise dei path** e calcolano SHA-256 sul JSON UTF-8. Il browser verifica il digest ritornato in `POST /v1/jobs`, poi vincola il report al job ID, endpoint, label, digest, lista degli step, proposal ID e revisione locale.

`passed` richiede che tutti gli step siano stati realmente eseguiti nell'ordine previsto con exit code 0, senza timeout. `incomplete` non equivale a successo. Se i file cambiano o viene sostituita la proposta, l'ultimo report è mostrato come **stale** e non può essere usato per giustificare il codice attuale.

Su un fallimento riferito esattamente a una patch pendente, **Code Agent → Proponi correzione AI** invia estratti redatti e limitati degli errori al modello di implementazione. La patch riparata può sostituire soltanto i file della proposta originaria e arriva con review e test azzerati. Massimo due riparazioni per proposta; test rilanciati solo manualmente. Per applicare una patch riparata, il browser interroga nuovamente il runner e richiede build C#/React superate sullo snapshot corrente.

**Limite di fiducia:** il digest lega uno snapshot di input a un report, ma non è un'attestazione crittografica firmata dal runner né prova di isolamento sicuro. Un server compromesso può mentire sui risultati; l'installazione corretta del runner deve rimanere un requisito esplicito. La API key e la connessione TLS proteggono l'accesso alla API, non garantiscono l'integrità dell'esecuzione sottostante.

## Preparazione dipendenze separata e test Docker reale — issue #4

La versione originale usava `npm install --offline` **dentro** il container di test. Questo non era riproducibile: con cache npm vuota il build React poteva fallire prima di eseguire Vite, pur senza avere un bug nella feature. Ora il worker distingue chiaramente due momenti:

1. **Preparazione:** se è richiesto `web-build`, `web-test` o `playwright`, un container Node Debian esegue `npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false` sul workspace temporaneo. La preparazione resta **offline** per impostazione predefinita. Install script e `postinstall` sono disabilitati. Il runner rifiuta dipendenze `file:`, `git:`, URL, alias e workspace/override del manifest. I lockfile non sono utilizzati in questa iterazione: l'installazione con rete attiva non è ancora un build riproducibile.
2. **Build/test:** il worker riutilizza le dipendenze installate nello stesso workspace, ma avvia un **secondo container** con `--network none`. Non si installano pacchetti mentre si esegue il codice AI. Il frontend usa `node:22-bookworm-slim` per compatibilità glibc con l'immagine Playwright Ubuntu.

Se la preparazione fallisce, il report conserva un blocco `preparation` con exit code e log; gli step interessati sono `skipped` e l'esito complessivo diventa **`incomplete`**, non `failed`: un problema di setup non deve avviare una riparazione AI ingiustificata. Anche un errore del Docker daemon rende il test incompleto.

### Download npm amministrato — opt-in sperimentale

Nel file privato `docker/runner/.env` puoi impostare:

```dotenv
RUNNER_ALLOW_NET_DEPS=true
RUNNER_NPM_REGISTRY=https://registry.npmjs.org/
```

**Non abilitarlo su un server condiviso o di produzione.** Soltanto il **container di preparazione** usa la rete Docker `bridge`; per ora questo non impone alcuna allowlist d'egress. I package specifier sono limitati a nomi registry e versioni semver, e gli script lifecycle sono disabilitati, ma la supply chain npm non è fidata né immutabile. Per produzione servono download via proxy controllato, lockfile verificati, cache immutabili e pinning per digest, oltre all'isolamento per job/tenant.

Se lasci l'opzione `false` (default), una app React che richiede dipendenze non già presenti nel container o nella cache locale darà correttamente `incomplete`. Per Playwright la spec deve dipendere da `@playwright/test`/Playwright, la versione della libreria deve corrispondere ai browser preinstallati nell'immagine runner, e l'app deve avere un `webServer` configurato; tutto ciò è ancora da collaudare end-to-end.

### Prova con Docker Engine vero nella CI

`src/runner/scripts/docker-smoke.mjs` non usa mock: su un **GitHub-hosted runner effimero** crea tre job con `executeJob()` ed esegue l'immagine `node:22-bookworm-slim` tramite Docker vero. Verifica sia un build/test che passa, sia un test volutamente fallito, sia la corretta gestione di dipendenze assenti in modalità offline. Controlla inoltre exit code e cleanup dei workspace.

La CI usa eccezionalmente il socket Docker dell'host GitHub solo nel job controllato dal repository. **Questo non significa che sia appropriato montare il socket rootful nella API di SoftwareFactory o sul server di produzione**. La validazione del daemon Docker rootless con Cloudflare Tunnel su una VM dedicata rimane un'attività aperta della issue #2.

### UID container: rootless su VM e test CI

Il Docker Engine rootless avviato dall'utente dedicato mappa l'UID `0` del container verso l'UID non privilegiato dell'host; il runner conserva quindi `RUNNER_CONTAINER_UID=0:0` come valore predefinito, con tutte le capability rimosse. In GitHub Actions, dove il Docker Engine della macchina effimera **non** è rootless, lo smoke usa invece l'UID/GID di `runner` tramite un override server-side `RUNNER_CONTAINER_UID=<uid>:<gid>`. Questo permette ai container senza `CAP_DAC_OVERRIDE` di scrivere soltanto sui propri workspace `0700` (senza renderli world-writable). Tale opzione è riservata all'amministratore e non viene accettata dal payload browser. Non usare il setup rootful della CI come modello di deployment pubblico.

## Playwright E2E con browser reali — issue #5

Lo scaffold React genera `src/frontend/web/playwright.config.ts` e `src/frontend/web/e2e/smoke.spec.ts`. Il pacchetto `@playwright/test` è **pinato** alla versione `1.64.1`, la stessa dell'immagine `mcr.microsoft.com/playwright:v1.64.1-noble` selezionata dal runner. Il mismatch di versione, la mancanza della configurazione o l'assenza di spec sono `skipped` e producono esito complessivo `incomplete`, non falsi successi.

La configurazione usa `webServer` di Playwright per avviare il server Vite su `127.0.0.1:4173`. Browser, test e web server sono **dentro lo stesso container**, perciò funzionano con `--network none`: il mock della chiamata a `http://localhost:8080/health` è intercettato dal browser e non richiede contatti con Internet. Le due prove visualizzano l'app React effettiva in Chromium e verificano gli stati UI quando l'endpoint ritorna `200` oppure `503`. Sono test di presentazione e gestione errori, **non** una verifica dei servizi backend.

### Verifica con GitHub Actions

La CI di SoftwareFactory genera il progetto fixture, installa le dipendenze npm in ambiente controllato, costruisce React/.NET e invoca `src/runner/scripts/playwright-smoke.mjs`. Questo script chiama **lo stesso `planStep` e `runDockerStep`** del runner remoto: il Docker Engine avvia realmente l'immagine ufficiale Playwright e il browser Chromium. Il job usa un socket Docker dell'host **solo sulla macchina effimera GitHub**, mai nell'API pubblica o dentro il test container. Il container non ha rete, usa `--read-only`, capability azzerate e limiti CPU/memoria/processi/tempo.

Il progetto generato esporta a sua volta un workflow che installa Chromium e invoca `npm run test:e2e` come gate distinto dal build. Localmente:

```bash
cd src/frontend/web
npm install
npx playwright install chromium
npm run test:e2e
```

Per testare API/database reali, aggiungere una seconda suite con fixture e container dei servizi, introducendo reti **private e controllate**; non disabilitare indiscriminatamente `--network none` nel runner AI. Una generazione E2E completa multi-browser e il collaudo rootless su VM Cloudflare rimangono nella issue #2.

### Limiti di sicurezza

Il pacchetto Playwright è disponibile nel workspace via fase `npm-prepare` (se la cache offline non lo contiene, occorre un proxy/cache controllato). Nel container browser non vengono esposti socket Docker, secret o rete Internet; Chromium può usare meno sandbox di processo con alcuni UID/daemon rootless. Non considerare questo un isolamento adatto a codice deliberatamente ostile e non pubblicare il runner senza hardening.

## React e API .NET reali su rete Docker privata (issue #6)

Lo scaffold genera due modalità Playwright. Per default npm run test:e2e avvia Chromium e Vite sul loopback e usa risposte simulate /health 200 e 503; il test API reale è skipped. Con E2E_MODE=integration, la UI React chiama il vero backend /health e un terzo test verifica /api/info, nome applicazione, stato e GUID di richiesta. Il caso di errore HTTP 503 resta deliberatamente simulato per verificare il percorso di errore UI.

La CI delle applicazioni generate avvia ASP.NET Core su 127.0.0.1:8080, controlla readiness, avvia Playwright in integration mode con Vite locale e termina il processo con trap. La suite predefinita con mock resta indipendente dal backend.

La CI di SoftwareFactory esegue anche src/runner/scripts/fullstack-smoke.mjs: tre container reali (API ASP.NET Core, Vite e Chromium) su una rete bridge Docker --internal generata per ciascuna esecuzione. I container si parlano con i DNS api:8080 e web:4173; non pubblicano porte host e non hanno accesso a Internet. Lo script verifica che la rete sia davvero Internal, applica limiti CPU/RAM/PIDs e no-new-privileges, ed elimina rete e container nel blocco finally. Il socket Docker è usato solo dall'orchestratore sulla macchina GitHub Actions effimera, mai dalla SPA o dai container test.

Questa verifica non utilizza PostgreSQL, SQL Server, MySQL o altri database: gli adapter di persistenza non sono ancora collegati ai repository applicativi. Prima di poter dichiarare test full-stack con persistenza bisogna implementare il database e aggiungere fixture di migrazione/rollback e isolamento per test. Il runner remoto con Cloudflare mantiene il default --network none: questa orchestrazione non gli concede comandi o reti Docker arbitrari.

## Database reale nella CI Factory — issue #7

La prova `fullstack-smoke.mjs` non usa più soltanto la API .NET: avvia anche un database PostgreSQL 17 effimero sulla rete bridge Docker `--internal`. La password viene generata casualmente all'avvio della CI e passata al container API via `Database__ConnectionString`; non viene scritta nei file o nel repository. ASP.NET Core applica le migrazioni SQL versionate, poi Vite e Chromium eseguono l'E2E `persists and deletes a work item through real PostgreSQL` (incluse modifica e verifica del nuovo valore) e controllano la persistenza sia dalla pagina sia dal client HTTP. I container e la rete vengono eliminati alla fine.

Il nuovo codice backend generato usa `Npgsql 10.0.3` e deve quindi eseguire un restore NuGet durante la fase preparatoria attendibile. Il runner remoto, che per default mantiene `--network none` e non ha una cache NuGet completa, può restituire `incomplete`; non trasformare la mancanza di package in una correzione AI del codice.

**Limite:** il CRUD è un esempio didattico con validazione minima, senza authentication/authorization, con schema migrations forward-only. La verifica green non garantisce sicurezza, backup, migrazioni rollback o scalabilità di PostgreSQL in un cluster. Il runner remoto Cloudflare non riceve ancora accesso automatico a Docker network per lanciare database: il full-stack con DB rimane esclusivamente un'attività CI su host effimero fino a isolamento più forte e approval dedicato.

## Autorizzazione delle API generate (#8)

Il runner remoto ha una sua API key, distinta dai JWT dell'app generata. Nella CI Docker della Factory, API .NET e PostgreSQL ricevono variabili di configurazione e chiave temporanea solo via environment del processo/container; mai nello snapshot sorgente o nel bundle frontend. Playwright usa tre token effimeri reader/editor per identità distinte e verifica 401, 403, owner isolation e audit transazionale Postgres. Il runner remoto non riceve la possibilità di firmare token o controllare segreti/identity provider tramite richieste browser.

Per un deploy pubblico occorrono login OIDC/JWKS, gestione segreti e rotazione chiavi, TLS, controllo XSS e test di sicurezza aggiuntivi. Il codice auth HMAC attuale serve a dimostrare enforcement di policy e proprietà, non a certificare un identity system finale.

## Verifiche OIDC su rete isolata (#9)

La CI Factory avvia oltre ad API, PostgreSQL e Chromium anche `oidc-ci-provider.mjs`, un **provider fittizio non deployabile** con discovery, JWKS e RSA 2048 effimeri. Il browser Chromium è sul loopback `127.0.0.1:4173` del proprio container per consentire Web Crypto/PKCE in un secure context, mentre i servizi di backend comunicano sulla rete Docker `--internal`. Il secondo smoke `oidc-protocol-smoke.mjs`, montato read-only nel container web solo in CI, esercita code grant S256, token refresh monouso, revoca per replay, logout e cambio delle JWK. Nessuna chiave privata raggiunge frontend/runner remoto.

Questo collaudo di protocollo non equivale ad un audit OIDC di produzione, a un provider vero o a una rotazione JWKS completa in ambiente server; i casi reali vanno validati con un IdP scelto dall'operatore e una VM dedicata.


### Acquisizione esclusiva dei job (issue #18)

Prima di leggere `queued`, `executeJob` crea atomicamente `/data/jobs/<uuid>/.claim` con `mkdir` **senza `recursive`**. Il solo proprietario esegue Docker, scrive i report e rimuove la claim in `finally`; un secondo worker che riceve `EEXIST` legge il report, senza eseguire step. Il polling ignora `queued` claimed per non bloccare altri job, non sovrascrive `running` claimed e non elimina directory claimed durante la retention.

**Recovery dopo crash:** una claim residua NON scade per mtime o timeout, perché non dimostra che i container siano terminati. L'operatore deve verificare che il worker sia fermo, ispezionare e fermare eventuali container orfani e **solo allora** rimuovere la directory `.claim` del job. Un report `running` senza claim diventa `failed` al polling successivo, mai `passed` e mai ri-eseguito automaticamente. I test Node simulano concorrenza e recovery, lo smoke Docker reale verifica il cleanup; mancano fencing distribuito, multi-tenant e HA, quindi la #2 resta aperta.


**Protezione dalla race di recupero:** il poller, dopo aver osservato un vecchio `running` senza lock, acquisisce a sua volta una claim atomica, rilegge il report *sotto claim* e cambia lo stato in `failed` soltanto se è tuttora `running`. Se il worker proprietario ha appena scritto `passed` prima della scansione, il suo risultato non viene sovrascritto. Il recovery non può attribuire automaticamente il lock a un processo vivo dopo un crash; l'operatore deve continuare a riconciliare gli orfani.


## Registro append-only delle evidenze del runner (#19)

Il runner genera `jobs/<uuid>/evidence.jsonl`: un registro JSONL **per job**, con `sequence`, `previousHash` SHA-256, timestamp, tipo evento e snapshot dei risultati. Gli eventi registrati sono `accepted` all'accettazione HTTP; `started`; `preparation` per npm; `step` per ogni build/test/skip; `finished` oppure `recovered`/`rejected` durante il recupero. Gli snapshot registrano digest sorgenti, step autorizzati, comando, exit code, durata e stdout/stderr **redatti**; non memorizzano il codice sorgente e non contengono API key. Il report porta `evidence: {version:1,count,head}` che identifica l'ultima entry.

Entrambi gli endpoint protetti da Bearer, `GET /v1/jobs/{uuid}` e il nuovo `GET /v1/jobs/{uuid}/evidence`, verificano sequenza, hash, contatore, head e corrispondenza fra il report corrente e l'ultimo evento. Manomissioni o assenza del journal di un job esistente restituiscono **HTTP 409 `evidence_invalid`** e non un falso `passed`. È possibile esportare l'intera catena autenticandosi allo stesso modo che per il report. I job legacy privi di journal non sono migrati automaticamente: richiedono riconciliazione, non possono essere considerati verificati.

Le scritture sono serializzate dalla claim esclusiva del worker (oppure dall'UUID nuovo creato dalla API), aggiunte in append e sincronizzate con `fsync` **prima** dell'aggiornamento atomico del report. Un crash tra questi due momenti causa una divergenza: il runner la considera un errore di integrità che richiede un operatore, non una scusa per riscrivere o tagliare automaticamente il journal. La retention del runner elimina la directory solo dopo il periodo previsto.

**Limite fondamentale:** l'hash-chain sullo **stesso disco** non è una firma indipendente, un file WORM o un'attestazione di esecuzione: un amministratore che controlla il filesystem può riscrivere tutta la storia e ricalcolare gli hash. Per veridicità contro un server compromesso servono ancora firme, ancore esterne/off-host, quote transazionali e validazione Docker rootless su VM (#2).


## Admission atomica, quota transazionale e idempotenza (#20)

`POST /v1/jobs` usa una **directory lock atomica** `/data/jobs/.admission` prima di controllare le quote e creare lo snapshot/report/journal. Anche due istanze API su un volume POSIX condiviso non superano `RUNNER_MAX_QUEUED` (default **4** job `queued/running`); esiste anche il limite di **100 directory conservate**, comprese quelle `passed/failed/incomplete`. Report mancanti o corrotti fanno fallire l'admission con HTTP **503 `admission_integrity`**, anziché liberare falsamente capacità. Una claim presente oltre l'attesa limitata produce HTTP **503 `admission_busy`** con header `Retry-After: 2`. Il lock non scade in automatico: dopo crash, verificare che nessun processo API sia attivo prima di rimuoverlo manualmente.

Il client può inviare l'header opzionale `Idempotency-Key: <UUID v4>` al POST. Il server conserva solo l'hash SHA-256 della chiave nel report iniziale e nel journal firmato *localmente* (nessun token, sorgente o UUID grezzo). Un retry con lo stesso UUID e lo stesso payload canonico (label, sorgenti e step) ritorna **202 con lo stesso job ID**, anche dopo completamento e quando la quota è piena. Stessa chiave ma digest diverso → **409 `idempotency_conflict`**; UUID non valido → **422 `invalid_idempotency_key`**. Il frontend usa un UUID per submission e lo conserva in memoria fino a risposta confermata, quindi un retry manuale dopo guasto di rete per lo stesso endpoint/digest non duplica il lavoro. Una nuova esecuzione consapevolmente avviata dopo conferma ottiene una nuova chiave.

L'idempotenza dura **finché la directory job è conservata** (retention predefinita 24 ore): la chiave vive nel report, non in una tabella separata permanente. Il worker acquisisce lo stesso lock durante la pulizia delle directory scadute, così la scansione e la cancellazione non si sovrappongono all'admission. Una richiesta HTTP interrotta dopo la registrazione del journal può lasciare un job accettato: il retry con UUID identico lo ritrova. Nel caso raro di crash *fra* creazione e persistenza finale, la directory e il lock richiedono riconciliazione, non vengono ripuliti automaticamente.

**Limiti operativi:** il filesystem deve garantire `mkdir` atomico (POSIX locale o soluzione equivalente verificata); non è un lock distribuito tra dischi separati, non offre quote per tenant/IP, e non sostituisce la VM Docker rootless dedicata. Il protocollo rimane sperimentale (#2).


## Ispezione e cleanup controllato dei container orfani (#21)

Ogni `docker run` del worker riceve il nome `sf-<UUID completo>-<step>` e label `softwarefactory.runner=job`, `softwarefactory.job-id=<UUID>`, `softwarefactory.step=<step>`. L'UUID completo evita collisioni tra job che condividono le prime otto cifre. La API pubblica **non** possiede il socket Docker né un endpoint di rimozione; lo strumento seguente va invocato esclusivamente sul worker/host rootless dedicato.

```sh
# Default: dry-run, solo report e container associati al job
node src/runner/orphans.mjs --job=<uuid-del-job>
# Solo dopo aver verificato che il worker NON sta eseguendo questo job
node src/runner/orphans.mjs --job=<uuid-del-job> --apply --confirm-job=<stesso-uuid>
```

La CLI parla soltanto con `DOCKER_HOST=unix:///run/docker.sock` oppure un socket rootless `unix:///run/user/<uid>/docker.sock`, e rifiuta il socket rootful di default. Legge e verifica `report.json` e il journal con hash-chain, controlla l'assenza di `.claim`, accetta soltanto report terminali `failed` o `incomplete` e interroga Docker per le **label esatte** dell'ID job completo. Prima di ogni `docker rm -f` reinspeziona ID completo, nome, step, label e stato/claim: un mismatch fallisce in modo conservativo. Non fa `prune`, non tocca container non etichettati o di altri job, non modifica evidenze, non ritenta codice.

**Procedura in caso di crash:** se esiste `.claim`, fermare e verificare il worker ed eventuali processi ancora vivi; non sottrarre una claim per il solo TTL. Dopo aver verificato che non esistano processi proprietari attivi, riconciliare/rimuovere manualmente la claim; il poller potrà segnare `running → failed` sotto journal verificato. Solo quando il report è terminale e la claim è assente l'operatore può rieseguire il comando di ricognizione e valutare `--apply`. In caso di journal corrotto o Docker non raggiungibile non vengono eseguite rimozioni. Non usare questo procedimento in automatico come recovery unattended.

La CI effimera verifica con Docker reale che il dry-run non elimina niente, che un container correttamente etichettato viene rimosso solo su conferma e che un container estraneo rimane disponibile. I test unitari coprono spoofing di label/nome, stati non terminali e lock; **non** certificano l'isolamento di una VM rootless distribuita.


**Verifica della modalità rootless:** il percorso Unix della socket, da solo, non dimostra che il Docker daemon sia rootless (una socket rootful potrebbe essere montata sotto `/run/docker.sock`). Prima di consultare o modificare container la CLI esegue `docker info --format '{{json .SecurityOptions}}'` e richiede esattamente `name=rootless`; in caso di risposta inattesa, daemon non rootless o accesso negato si interrompe senza fare cleanup. La CI usa deliberatamente un adapter al daemon Docker effimero del runner GitHub per testare la selezione degli oggetti, e non certifica un daemon rootless in una VM reale.


## Preflight riproducibile per VM rootless, Compose e HTTPS (#22)

La CLI `src/runner/preflight.mjs` è **soltanto in lettura** e ha tre modalità indipendenti. Nessuna modalità invia sorgenti, crea job, cancella container, modifica file di report o configura il tunnel. Gli output sono solo esiti booleani/categorie e non contengono API key, token Cloudflare, `.env`, configurazione completa Docker o contenuti HTTP.

```sh
# Repository root, prima del deployment: usa soltanto il file placeholder (CI)
node src/runner/preflight.mjs compose --env-file=docker/runner/.env.example

# Sulla VM, prima di avviare la stack: creare la .env reale mode 0600 e le
# directory dati e workspace proprie dell'utente rootless uid 1000, mode 0700.
chmod 600 docker/runner/.env
chmod 700 /srv/softwarefactory/runner-data /srv/softwarefactory/workspaces
# Invocare la verifica come utente dedicato uid 1000, non con sudo/root.
node src/runner/preflight.mjs host --env-file=docker/runner/.env
node src/runner/preflight.mjs compose --env-file=docker/runner/.env

# Solo quando hostname HTTPS, tunnel e Access sono già configurati; il token
# Bearer viene letto dal file 0600 o dalla variabile RUNNER_API_KEY, MAI da argv.
node src/runner/preflight.mjs endpoint --env-file=docker/runner/.env \\
  --url=https://runner.example.org --origin=https://factory.example.org
```

**Compose** usa `docker compose config --format json` con il file scelto, ma **non** stampa il JSON risolto: potrebbe contenere credenziali. Controlla uid non privilegiato, rootfs read-only, cap-drop, no-new-privileges, mount del socket soltanto sul worker, condivisione dei dati/workspace, nessuna rete host, porta API esclusivamente su `127.0.0.1:8787` e nessuna porta host worker/cloudflared. La CI esegue questa fase con il file `.env.example`, come controllo di configurazione **non** come prova del daemon.

**Host** richiede esecuzione come uid 1000, chiave reale non-placeholder, origin espliciti, directory `RUNNER_DATA_DIR` e `RUNNER_HOST_WORK_DIR` separate e private (proprietario 1000 e mode 0700), socket rootless `/run/user/1000/docker.sock` Unix con proprietario 1000 e senza permessi per gli altri utenti. Interroga inoltre il daemon attraverso **quel socket esplicito** e verifica `name=rootless` nelle SecurityOptions di `docker info`. Se qualunque controllo fallisce, interrompe il deployment e non prova a ripararlo autonomamente. Il controllo non certifica l'assenza di escalation nel kernel, né supporta attualmente UID diversi da 1000 (la Compose usa uid 1000 esplicito).

**Endpoint** richiede due origin HTTPS senza credenziali nella URL, disabilita i redirect, verifica `GET /healthz`, il rifiuto 401 di `GET /v1/capabilities` senza Bearer, la riuscita autenticata e `networkDefault=none`, quindi il preflight CORS `OPTIONS /v1/jobs` con Authorization e Idempotency-Key. Non invia mai POST o sorgenti. Se Cloudflare Access blocca la verifica automatica prima della API, il controllo **fallisce**; occorre verificare l'integrazione reale dell'utente/Access con la Factory, senza inserire service token nel JavaScript.

**Limiti:** l'esecuzione della CLI su una VM reale con tunnel effettivo richiede server, credenziali e hostname forniti e mantenuti dall'operatore. La CI Hosted GitHub controlla sintassi/Compose e simula in Node le condizioni pericolose, ma **non prova** rootless Docker su una VM dedicata o Cloudflare Zero Trust/Access. La issue #2 resta aperta per il collaudo operativo effettivo, evidenze off-host e hardening distribuito.


## Firma offline Ed25519 delle evidenze esportate (#23)

L'endpoint Bearer `GET /v1/jobs/{id}/evidence` ora restituisce `{version,id,count,head,report,entries}`: il report è completo e la sequenza JSONL può essere verificata **senza contattare il runner**. Un export troncato, con un solo record modificato oppure con stato/exitCode in conflitto con l'ultima entry viene rifiutato. Le entrate includono output di compilazione redatti, ma sono ancora dati potenzialmente sensibili: custodire file `evidence.json` fuori da repository pubbliche, con permessi 0600.

La firma è **volontaria, fuori dal runner e separata da Docker**. Esempio operativo su un PC di un operatore fidato (non sulla VM runner né dentro GitHub Actions):

```sh
# Una tantum su postazione di firma fidata, NON sul runner
umask 077
openssl genpkey -algorithm Ed25519 -out attestor-private.pem
openssl pkey -in attestor-private.pem -pubout -out attestor-public.pem
chmod 600 attestor-private.pem
# Custodire la pubblica verificata in un canale separato e affidabile

# Esporta l'endpoint HTTPS autorizzato: il token arriva solo da una variabile
# di sessione NON stampata e non inclusa nella URL. Usare un client sicuro
# che salvi la risposta HTTP Bearer sul PC come evidence.json (mode 0600).
# Non includere bearer/token nel terminal history, nel command line o nei log.

node src/runner/attest.mjs sign \\
  --evidence=evidence.json --private-key=attestor-private.pem --out=receipt.json
# Su postazione di verifica differente, con chiave pubblica già pinned
node src/runner/attest.mjs verify \\
  --evidence=evidence.json --receipt=receipt.json --public-key=attestor-public.pem
```

Il comando `sign` rilegge e verifica localmente ogni entry SHA-256, stato e digest, rifiuta bundle `queued/running` (nessuna esecuzione conclusa) e firma un documento contenente `jobId`, `inputDigest`, `state`, `count`, `head` e `bundleSha256`; aggiunge il fingerprint SHA-256 della chiave Ed25519 pubblica e una signature Base64url. Il file ricevuta viene creato con `mode 0600` e non sovrascrive file esistenti. Il comando `verify` ricalcola ogni valore dall'export, confronta il fingerprint della chiave **pinned esplicitamente** e verifica la firma; non esegue richieste di rete né legge credenziali runner. Le chiavi private sono accettate soltanto da file regolari non symlink con permessi 0600. Il codice usa solo `node:crypto`, nessun pacchetto esterno.

**Modello di fiducia:** un host runner compromesso può ricalcolare l'intera hash-chain e generare un bundle locale convincente, ma non può modificare un export *già firmato da un operatore esterno* senza invalidarne la firma. La firma attesta soltanto la scelta del firmatario di sottoscrivere i byte/log, **non** l'effettiva esecuzione di build/test, l'autenticità della data, l'identità della VM o l'assenza di alterazioni precedenti alla firma. Occorrono custodia off-host della chiave, distribuzione fidata della pubblica, conservazione della ricevuta fuori dal server, e in futuro ancoraggio automatico, firma da infrastruttura indipendente e collaudo della VM rootless (issue #2). Non mettere la private key nel `.env` del runner, nei container o nella repository.


## Re-test obbligatorio e supervisionato dopo AI repair (#24)

Il Code Agent ora collega i fallimenti reali ai successivi re-test senza far partire un worker AI autonomo. Con una proposta **pendente**, il pulsante `Proponi correzione AI` appare soltanto per un report corrente con uno step realmente fallito: il client chiede il consenso a inviare i log all'AI e **ricarica** il report dall'API Bearer, che deve aver verificato l'evidenza JSONL. Se il report è `queued/running/incomplete/stale` o se il workspace è cambiato, la correzione viene rifiutata. La proposta AI può toccare soltanto i path originali, fino a **2** tentativi, e il progetto conserva per ogni tentativo `repairTrail` (ID/digest/step del job fallito, mai stdout, chiavi o token).

Una patch riparata non viene applicata. Il Code Agent esegue una **nuova review indipendente** e, solo quando passa, il pannello runner mostra `Conferma e riesegui test repair`. Il piano contiene l'intero set degli step del job fallito più le build pertinenti ai file riparati (`dotnet-build`, `web-build`, `playwright`) e gli eventuali step aggiuntivi selezionati; togliere il segno dalle checkbox **non** rimuove i controlli obbligatori. Ogni nuova trasmissione richiede un consenso esplicito con elenco degli step. La submission è idempotente per stessa origin/digest; la receipt deve essere `queued`, UUID v4 e avere esattamente il digest inviato. Un cambio di progetto durante il POST rifiuta il binding. Il polling continua a leggere la API: nessun test viene marcato `passed` per sola review o accettazione del job.

Dopo una riuscita autentica, l'utente controlla ancora i diff e conferma manualmente `Approva e applica`: l'azione ricarica il report e verifica lo snapshot attuale **e** tutti gli step richiesti. Se il secondo repair fallisce ancora, la stessa proposta non può essere riparata una terza volta: occorre scartarla o avviare una nuova feature consapevolmente. Non c'è auto-push, auto-deploy, esecuzione AI nel browser o ripristino automatico dei crash. Non descrivere il flusso come un agente che opera 24/7 né come prova della VM rootless reale. Rimangono aperti in #2 worker orchestrator autonomo, multi-host fencing e deployment reale.


## Registro persistente per repair supervisionati (#25)

L'API offre un **coordinatore di checkpoint**, separato dal worker Docker e dal Code Agent AI. È utile a conservare il percorso di un tentativo fra riavvii del browser e fra istanze API, con politica di transizione e verifiche reali sui job. **Non genera patch, non fa polling o invii automatici, non invoca un provider AI, non concede permessi su GitHub e non applica codice.** Lo stato `recorded_approval` registra soltanto la dichiarazione dell'operatore: non rappresenta un'approvazione autonoma nella SPA.

Tutte le richieste richiedono la consueta API key Bearer e Origin esplicitamente consentito. Il corpo è JSON al massimo **4096 byte**; ogni scrittura necessita di `consent: true`. Esempi di payload (non inserire la chiave nell'URL, nei log o nel codice generato):

```http
POST /v1/repair-sessions
Content-Type: application/json
Authorization: Bearer <session-api-key>

{"failedJobId":"<job-uuid>","proposalId":"<proposal-uuid>","paths":["src/backend/domain/Invoice.cs"],"consent":true}
```

Restituisce 201 e un `id` di sessione persistente, `state: "awaiting_patch"`, `requiredSteps`, `attempts`, `checkpointHead`. Richieste duplicate con stessi job/proposta/path ritrovano lo stesso ID, anche dopo riavvio. Si parte solo da un job `failed` con journal valido e uno step effettivamente fallito, **non** da setup `incomplete` né da job `queued/running/passed`. I path devono essere ordinati lessicograficamente, unici (1–8) e ammessi per il Code Agent, non package, script di deployment o segreti.

Il client propone `POST /v1/repair-sessions/{id}/checkpoints` con uno di questi corpi, **solo dopo** l'azione umana o del modello già eseguita sotto il suo controllo:

```json
{"action":"patch","consent":true,"digest":"<nuovo-sha256-canonico-64hex>","paths":["src/backend/domain/Invoice.cs"]}
{"action":"review","consent":true,"verdict":"pass"}
{"action":"retest","consent":true,"jobId":"<nuovo-job-uuid>"}
{"action":"record_approval","consent":true,"confirmSessionId":"<id-sessione>"}
```

Gli stati persistiti sono `awaiting_patch → awaiting_review → awaiting_retest → awaiting_approval → recorded_approval`. Una review con `changes_required` passa a `review_blocked`; un re-test realmente `failed` passa a `retest_failed`, consentendo un altro digest, **fino a 2**. Il re-test è registrabile soltanto con un *altro* job eseguito dal runner, report + journal verificato, `digest` uguale a quello della patch e **tutti gli step falliti del primo job più le build obbligatorie dei path**; `passed` significa ogni comando effettivamente riuscito (`exitCode=0`, `timedOut=false`, duration valida). Incompleti, setup falliti o report falsi rifiutati. Prima dell'ultima registrazione l'API verifica di nuovo le evidenze del re-test.

`GET /v1/repair-sessions/{id}` restituisce il solo snapshot di checkpoint: UUID, digest, stati, step e hash dell'ultimo evento; **mai file di codice, prompt AI, output/log, token o secret**. Ogni evento ha contatore, prevHash e SHA-256, il file viene aggiornato atomicamente sotto `/data/repair-sessions` con lo stesso lock `/data/jobs/.admission` usato dalla coda. Le due istanze API sullo stesso filesystem vedono un unico storico. **Maks 100** sessioni conservate, max 12 eventi per sessione, senza garbage collection automatica: la saturazione restituisce 429, corruzione/lock causa 409/503 *fail-closed* e richiede revisione operatore. I checkpoint non aggiungono credenziali né capacità di esecuzione al processo API.

**Confini di fiducia:** la review registrata è una dichiarazione del client e non una prova indipendente; chi conosce la API key può effettuare le stesse transizioni. L'hash locale rileva modifiche non coerenti ma non un amministratore che riscrive tutta la storia, per cui restano necessarie firme esterne e conservazione off-host (#23). Il coordinatore **non è ancora chiamato automaticamente dalla UI** (le API sono disponibili per futuri client/integrazioni amministrative). Non è un'automazione 24/7, un'applicazione della patch o un controller multi-tenant. La #2 resta aperta per provisioning reale, RBAC/quote per tenant, rate limit, attestazione/approvazione indipendenti e coordinamento automatico.
