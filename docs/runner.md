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
- `POST /v1/jobs`: payload JSON `{"label":"feature","files":{"src/backend/domain/EntityId.cs":"..."},"steps":["dotnet-build"]}`. Una prima accettazione risponde `202 {id,digest,state:"queued"}`; un retry idempotente risponde `202` con lo stesso ID e lo **stato verificato corrente** (`queued/running/passed/failed/incomplete`), non un falso `queued`.
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

Una patch riparata non viene applicata. Il Code Agent esegue una **nuova review indipendente** e, solo quando passa, il pannello runner mostra `Conferma e riesegui test repair`. Il piano contiene l'intero set degli step del job fallito più le build pertinenti ai file riparati (`dotnet-build`, `web-build`, `playwright`) e gli eventuali step aggiuntivi selezionati; togliere il segno dalle checkbox **non** rimuove i controlli obbligatori. Ogni nuova trasmissione richiede un consenso esplicito con elenco degli step. La submission è idempotente per stessa origin/digest; la receipt deve contenere uno stato noto (anche terminale per retry), UUID v4 e avere esattamente il digest inviato. Il campo `state` non prova il superamento degli step: servono sempre nuovo GET e report verificato. Un cambio di progetto durante il POST rifiuta il binding. Il polling continua a leggere la API: nessun test viene marcato `passed` per sola review o accettazione del job.

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


## Sincronizzazione automatica della SPA con il coordinatore di checkpoint (#26)

Il contratto server-side della #25 è ora integrato nel percorso supervisionato della SPA. La prima volta che l'utente conferma la condivisione di un fallimento reale con il Code Agent, la UI ricarica il report firmato *localmente* dal journal e crea/riprende una sessione `POST /v1/repair-sessions`; per la sessione salvata nel progetto conserva **solo** `id,rootJobId,rootProposalId,endpoint`. Non persiste token o API key, che restano in sessionStorage. Se il server non è raggiungibile il repair si interrompe; la sessione remota eventualmente creata resta riutilizzabile allo stesso job/proposta/path.

Dopo la nuova patch AI e review indipendente positiva, **non parte alcun test automaticamente**: al click `Conferma e riesegui test repair` l'utente approva un nuovo invio. La SPA prepara il digest SHA-256 esatto di label+sorgenti+step, poi consulta lo stato remoto; se necessario registra `patch` e `review=pass` sul ledger, riutilizzando questi checkpoint se la risposta precedente non era arrivata. Ogni tentativo usa gli step richiesti dalla #24 e **almeno** gli step `requiredSteps` calcolati dal server #25. Un cambiamento della selezione che alteri il digest dopo la registrazione del checkpoint blocca l'invio anziché creare un altro tentativo ambiguo. Solo dopo il checkpoint `awaiting_retest` la SPA invia il job alla API Docker con Idempotency-Key. Il risultato è associato a proposal/revisione/digest, mai a un log non verificato.

Il polling riconosce `passed` o `failed` solo dopo validazione del report corrente e sincronizza il checkpoint `retest` con il relativo job ID. Su fallimento della rete, il pulsante di retry del repair o il click di approvazione rilegge il checkpoint e lo recupera senza duplicarlo; il server verifica il journal, il digest e le build obbligatorie. Prima dell'approvazione locale la SPA chiede la normale conferma umana, controlla che il codice sia effettivamente applicabile, rivalida il report `passed`, registra esplicitamente `record_approval` e applica soltanto se **progetto e sessione sono rimasti coerenti**. Errori nei checkpoint bloccano l'approvazione; l'API **non modifica codice Git** e la SPA non invia push senza ulteriore consenso.

**Modello di fiducia e migrazione:** il registro conserva decisioni *dichiarate* tramite una API key globale, non firme di identità individuali. Un client con la API key può registrare verdict `pass`; i report Docker sono comunque ricontrollati dal server. Le patch riparate prima della #26 e prive di `repairSession` non possono più superare il nuovo gate senza reimpostare il workflow. Lo stato originale del Code Agent resta local-first, la nuova sessione è persistente sul runner; non c'è un servizio 24/7. Il normale funzionamento con VM rootless e Cloudflare Tunnel reali non è ancora stato collaudato; vedere #2.


## Credenziali di ruolo per il coordinatore repair (#27)

**Separazione delle credenziali:** `RUNNER_API_KEY` consente submission/report dei job Docker e capabilities, ma **non** può più leggere o aggiornare `/v1/repair-sessions*`. Per il ledger, l'amministratore configura fuori dal repository la variabile privata `RUNNER_REPAIR_OPERATORS_JSON` come array JSON di operatori (da 1 a 12): ognuno ha `id` (slug lowercase univoco), `key` (32–256 caratteri stampabili, univoca, differente da `RUNNER_API_KEY`) e `roles` (uno o più fra `propose`, `review`, `approve`). Il parser rifiuta duplicati, secret deboli, ruoli extra e campi non riconosciuti; la configurazione non viene mai stampata. Per creare chiavi diverse utilizzare `openssl rand -hex 32` in un terminale amministrativo fidato, **non** nel repository. Esempio illustrativo con segnaposti, da copiare **solo** in `docker/runner/.env` mode 0600 e mai in Git:

```dotenv
RUNNER_REPAIR_OPERATORS_JSON=[{"id":"editor","key":"<unique-propose-secret-64-hex>","roles":["propose"]},{"id":"reviewer","key":"<unique-reviewer-secret-64-hex>","roles":["propose","review"]},{"id":"approver","key":"<unique-approver-secret-64-hex>","roles":["approve"]}]
```

Lo scope `propose` permette `POST /v1/repair-sessions` e i checkpoint `patch/retest`; `review` permette `review`; `approve` permette `record_approval`; qualunque operatore registrato può fare GET. Le route respingono Bearer globali e credenziali sconosciute con 401, scope inadatti con 403, assenza di registro con **503 repair_auth_unconfigured**. L'API normale di esecuzione funziona anche senza registro. Il confronto usa SHA-256 + `timingSafeEqual`; l'identità conservata nel ledger è soltanto `actorId`, legato agli hash di ogni nuovo evento. Voci create prima della #27 non hanno un autore identificabile: sono esplicitamente legacy/unattributed in GET, non vengono riscritte. Un amministratore con controllo del filesystem può comunque ricostruire la chain; la firma esterna (#23) rimane indipendente.

Nella Factory SPA, configurare in **Settings → Runner Docker remoto** la **Runner API key** per i job e la distinta **Operatore repair** per i checkpoint. Ogni fase richiede una chiave con lo scope e l'ID appropriati: `propose` per patch e retest, poi **altro ID** `review` per la review, poi ritorno al proponente per il re-test e infine **terzo ID** `approve` per la dichiarazione finale. La UI non salva questi token in localStorage/ZIP/Git. Il server non può garantire che i tre ID appartengano a tre esseri umani: il possesso di tre token diversi non è un login personale o una firma. Nessun auto-apply/push; OIDC/RBAC, policy multifattore e VM rootless/Tunnel rimangono in #2.


## Robustezza della ricognizione del ledger in concorrenza (#28)

La creazione di sessioni idempotenti avviene sotto lock condiviso con la coda. La scansione verifica **tutti** i record già presenti, anche quando trova subito un job corrispondente: non permette a un file corrotto in un'altra sessione di essere mascherato da un retry valido. Nel caso circoscritto di una voce transitoria non interpretabile durante la scrittura di snapshot atomici, ripete la scansione **al massimo tre volte** con breve pausa e solo dopo che tutti i file risultano validi restituisce la sessione. Se una voce persiste o risulta corrotta, risponde `409 repair_integrity` e richiede indagine dell'operatore; non elimina o modifica alcuna prova. Il lock può anche rispondere `503 admission_busy` con `Retry-After: 2`: in tal caso il client può riprovare l'idempotent start dopo una pausa. Nessun retry automatico di una approvazione è autorizzato a bypassare la verifica del risultato Docker.


## Policy di separazione degli operatori di repair (#29)

Dopo i ruoli di chiave introdotti dalla #27, il server applica anche **vincoli fra gli ID attribuiti agli eventi della stessa sessione**, riprodotti nella verifica del journal: `started` identifica il proponente; soltanto **lo stesso ID** può registrare `patch`, `retest_passed` e `retest_failed` anche al secondo tentativo; ogni `review` è dichiarata da un **altro ID**; `record_approval` richiede un **terzo** ID diverso sia dal proponente sia dall'ultimo reviewer. Il controllo non si basa sul contenuto della richiesta o su claims del browser, ma sull'operatore che ha autenticato il Bearer. Un token con tutti gli scope può comunque registrare **soltanto** una delle tre posizioni incompatibili all'interno della sessione. `409 repair_actor_conflict` segnala una mutazione vietata; nessun checkpoint viene scritto. Le vecchie sessioni (prima della #27) senza actor nel primo evento rimangono verificabili in GET come `unattributed`, ma **qualsiasi mutazione** produce `409 repair_legacy_readonly`: non si può fingere una retroattiva review indipendente. Per ripartire serve un nuovo job fallito e una nuova proposta con consenso.

**Sequenza supervisionata nella SPA:** (1) il proponente configura in Settings la sua credenziale `propose` e approva la condivisione dei log AI (apre la sessione); (2) dopo la nuova review locale positiva, preme `Conferma e riesegui test repair`: il primo click registra **soltanto** `patch` (digest di payload, nessun invio di sorgenti); (3) il revisore usa la sua credenziale `review`, vede il diff e al secondo click registra **soltanto** la dichiarazione `review pass`; (4) si torna alla credenziale **del proponente** e un terzo click autorizza **l'invio reale** del nuovo job, con tutti gli step obbligatori e Idempotency-Key; (5) al completamento, il proponente sincronizza il re-test effettivamente verificato; (6) l'approvatore terzo usa la sua credenziale `approve` per richiedere la registrazione finale e solo dopo l'applicazione locale (nessun push automatico). L'operatore può tornare su Settings senza perdere il binding di sessione; se una risposta HTTP scompare il prossimo click usa GET per riconciliare la fase. Un errore di scope/attore blocca il flusso. Se il re-test passato non è stato ancora sincronizzato, la UI consente di riprovare la sola sincronizzazione con la chiave del proponente.

**Limite di identità:** non è una dimostrazione di tre *persone*, soltanto tre **ID di token diversi**. L'amministratore può gestire più credenziali e il runner oggi non verifica presenza umana, firma per-azione, login OIDC, MFA o back-channel logout. Gli hash possono essere riscritti dall'admin del filesystem: servono gestione identità, controllo indipendente e firme remote per affermazioni forti. I registri della #25 non diventano production-ready; #2 rimane aperta.


## Correzione timestamp iniziale e falso repair_integrity (#30)

La verifica del registro impone da sempre `createdAt === events[0].at` per l'evento `started`. Prima della #30, l'avvio chiamava `new Date().toISOString()` una volta per il record e una seconda volta per l'evento. Se l'esecuzione passava il confine di un millisecondo, un record valido poteva generare `409 repair_integrity` subito dopo la creazione, senza alcun file corrotto. Il coordinatore acquisisce ora **una sola volta** il timestamp iniziale e lo usa identico nell'evento con hash. È un bug distinto dalla scansione e dai retry bounded della #28; non si aumentano attese o si ignorano errori permanenti. La regression simula un clock che salterebbe da `00:00:00.999Z` a `00:00:01.000Z`, verifica una sola lettura, verifica il file su disco e il GET dall'altra API.


## Registro privato a file: revoca e rotazione degli operatori senza restart (#31)

La modalità `RUNNER_REPAIR_OPERATORS_JSON` della #27 rimane utilizzabile per test e installazioni legacy, ma è **immutabile per la durata del processo**: per revocare una chiave bisogna sostituire la variabile e riavviare **tutte** le repliche. Per la revoca dalla richiesta successiva, usare **esclusivamente** la modalità `RUNNER_REPAIR_OPERATORS_FILE` con un unico file JSON privato condiviso da tutte le API. Le due fonti configurate contemporaneamente sono rifiutate all'avvio. Il file è un array di 1–12 oggetti con `id`, `key` (univoca, 32–256 caratteri stampabili, diversa dalla chiave dei job) e `roles` (`propose`, `review`, `approve`), come descritto nella #27. Il formato e la separazione per ID della #29 non cambiano.

**Montaggio Docker (directory, non file):** sull'host dedicato, predisporre una directory privata, per esempio `/srv/softwarefactory/repair-operators` (proprietario uid 1000, permessi **0700**), contenente `operators.json` (uid 1000, **0600**). Indicare `RUNNER_REPAIR_OPERATORS_DIR=/srv/softwarefactory/repair-operators` nel file host privato `docker/runner/.env`. Avviare l'override opzionale insieme al Compose ordinario:

```sh
docker compose --env-file docker/runner/.env \
  -f docker/runner/compose.yml \
  -f docker/runner/compose.repair-operators.yml up -d
node src/runner/preflight.mjs compose \
  --env-file=docker/runner/.env --operator-registry
```

L'override imposta `RUNNER_REPAIR_OPERATORS_FILE=/run/secrets/runner-operators/operators.json` solo nel container API e monta la **directory** dell'host come `/run/secrets/runner-operators:ro`. Non montare un singolo file tramite bind mount: Docker può mantenere il vecchio inode dopo `rename` e non vedere la rotazione. Il runner-worker con socket Docker rootless e i container test **non** ricevono il segreto, e non va collocato nella directory `RUNNER_DATA_DIR` già condivisa con il worker. Il preflight valida anche questo override e fallisce se il file è configurato senza il mount read-only dedicato o se il worker riceve la directory. Il file e la directory devono essere leggibili da uid 1000 nel container API, non da altri utenti. **Il file deve inoltre risultare di proprietà dell'EUID effettivo del processo API** (`fstat.uid === process.geteuid()`), altrimenti ogni richiesta repair fallisce con `503 repair_auth_unavailable`, mentre i job normali restano disponibili (#32). In Docker rootless/user namespace, l'UID visto *dentro* il container può essere diverso dall'UID numerico dell'host: verificare ownership e accesso nel container API prima di abilitare il servizio; non allargare i permessi o passare il processo a root per aggirare il controllo.

**Rotazione / revoca amministrativa:** creare nello stesso direttorio un nuovo `operators.json.new` con lo stesso schema, file privato **0600** e proprietario uid 1000. Per ruotare una chiave mantenere l'ID del relativo operatore e sostituire solo `key`. Per revocare un operatore togliere **l'intera voce**; per rimuovere uno scope modificarne `roles`. Convalidare schema e unicità off-host, poi, con permessi di amministratore, sostituire atomicamente il file: `mv -f operators.json.new operators.json` **nello stesso filesystem**. Non scrivere in-place, non usare `cat`/echo con credenziali in cron o log, non usare chiavi condivise; custodire le vecchie chiavi in un vault aziendale per revoca auditabile ma **non** lasciarle nel JSON attivo. Entrambe le istanze API vedono la nuova versione alla **prossima richiesta** (senza cache). La SPA deve inserire esplicitamente la nuova chiave in Settings: nessuna rotazione in sessionStorage automatica. Il ledger conserva gli `actorId` già firmati localmente nella hash-chain; i checkpoint non vengono riscritti quando una chiave cambia.

**Comportamento fail-closed:** il server apre il file ad ogni richiesta repair con `O_NOFOLLOW`, controlla il descrittore con `fstat` (file regolare, `nlink=1`, nessuna autorizzazione group/other, size <=10 KB) e rifiuta credenziali duplicate, ruoli non ammessi, malformazioni e chiavi uguali alla `RUNNER_API_KEY`. File assente, world-readable o JSON non valido: `503 {"error":"repair_auth_unavailable"}`, senza stampare il file o i token. Un Bearer rimosso risponde `401 unauthorized`; un token ancora valido ma privo dello scope richiesto risponde 403. Le API dei job restano utilizzabili con `RUNNER_API_KEY`. **Limiti:** rotazione efficace per richieste nuove; una richiesta già autenticata e in corso può terminare. La lettura condivisa richiede filesystem locale/POSIX e sostituzioni atomiche, non è un sistema distribuito di consenso né un servizio di key management certificato. Non revoca JWT, login OIDC, cookie, token dei modelli o altre API. Identità personale e MFA/off-host restano nella #2.

**Importante — confine del Docker socket:** l'override non monta la directory del registry nel worker, ma un worker compromesso che controlla il socket del Docker daemon rootless potrebbe chiedere al daemon di montare altre directory host leggibili dall'UID del daemon. Con entrambi i servizi sullo stesso host/UID, `read_only: true` e la sola separazione dei mount non sono una garanzia di segretezza rispetto alla compromissione del worker. Per ottenere un confine forte servono identità host indipendenti, segreti off-host o un identity provider con policy separate e prove reali su daemon rootless; questa evoluzione resta in #2. Verificare anche la mappatura UID/GID nei bind mount rootless reali prima del deploy, perché il test CI usa Docker effimero e non prova il mapping del server.


## Recheck delle credenziali prima del commit del repair (#33)

Nella modalità file `RUNNER_REPAIR_OPERATORS_FILE`, ogni POST `/v1/repair-sessions` e `/v1/repair-sessions/{id}/checkpoints` esegue due controlli separati: autenticazione iniziale per leggere il body e **nuovo caricamento del file dopo l'acquisizione esclusiva del lock** `/data/jobs/.admission`, prima di qualsiasi lettura/scrittura del ledger. Se un POST aspettava il lock quando è stato effettuato un `rename` atomico di `operators.json`, il controllo nel lock non accetta più il token vecchio (401), un ID/scope cambiato (403) o un registry non valido/illeggibile (503). Queste richieste non aggiungono eventi o snapshot; la lettura GET del checkpoint e la normale API di esecuzione job restano indipendenti. In modalità JSON inline il registry non può cambiare senza restart, quindi il recheck è necessario solo in modalità file.

**Confine temporale:** il controllo è eseguito prima della mutazione ma il file di segreti e il ledger non sono nello **stesso dominio transazionale**. Se l'operatore è revocato *dopo* questo nuovo controllo e il processo ha già iniziato la mutazione, questa può ancora concludersi. La misura chiude la finestra di attesa del lock, **non** annulla retroattivamente richieste già autorizzate né fornisce revoca lineare/atomica, IAM tenant, firme di approvazione o identità MFA. Per quella garanzia servono un sistema di autorizzazione/commit transazionale e collaudo distribuito, ancora nella #2.


## Admission con verifica completa delle evidenze (#34)

La quota del POST `/v1/jobs` ora è calcolata **solo da report validati tramite hash-chain JSONL**. Durante la scansione sotto `/data/jobs/.admission`, la API verifica l'input del report rispetto all'ultimo evento per **ogni** UUID conservato: non basta trovare un retry valido; una voce diversa, terminale o non pertinente con journal troncato o stato modificato rende il volume incoerente. Restituisce `503 {"error":"admission_integrity"}` e non accetta nuovi job né invia ricevute idempotenti. Un report `queued` manomesso in `passed` non libera la quota. Il worker può aggiornare in breve sequenza journal fsync e report rename senza usare il lock di admission: il controllo riprova due volte con breve pausa *solo* su errore di evidenza, per evitare false interruzioni di lettura; se persiste è fail-closed e richiede controllo dell'operatore. La scansione è bounded dal massimo di 100 job conservati, ma aumenta il costo di ogni POST con il numero e dimensione dei journal: monitorare latenza e `admission_busy` sulla VM.

Un retry con Idempotency-Key dello stesso job, digest immutato e evidenze integre ritorna l'ID originale e lo **stato effettivo** corrente, inclusi `passed/failed/incomplete` se il worker ha terminato. HTTP 202 indica che la richiesta di submission/replay è stata trattata, non un esito di test positivo. Il client può usare lo stato come informazione, ma deve sempre interrogare `GET /v1/jobs/{id}` e controllare digest, step, exit code e `timedOut` prima di mostrare build/test superati o applicare una correzione. Una riscrittura coerente dell'intera hash-chain da parte di un amministratore del server non viene scoperta da questa sola verifica: servono ricevute firmate esternamente (#23) o ancoraggio off-host futuro (#2).


## Rate limit globale sull'ammissione dei job (#35)

Imposta nella env del runner `RUNNER_MAX_ACCEPTED_PER_MINUTE=5` e riavvia **tutte** le istanze API per limitare a 5 nuove accettazioni in una finestra **scorrevole** di 60 secondi. Valori ammessi: intero 0–100, 0 (default) disabilita la nuova policy; valori fuori range o non numerici impediscono il bootstrap. L'override è passato a `runner-api` tramite Compose, non al worker. Il contatore deriva dagli `acceptedAt` ISO dei job ancora conservati: non servono nuove credenziali, indici o database, e le due API che condividono `/data/jobs` usano lo stesso contatore sotto il lock `/data/jobs/.admission`. Contano anche i job già `passed/failed/incomplete` accettati nell'ultimo minuto. Sono necessari il journal SHA-256 integro e il report per **ogni** job (regole #34); con rate attivo un timestamp corrotto fallisce chiuso con 503. Timestamp nel futuro vengono contati conservativamente (possibili clock-skew).

Quando la soglia è piena, un nuovo POST `/v1/jobs` risponde **429 `{"error":"rate_limited"}`** e `Retry-After: N` in secondi, bounded tra 1 e 60; non crea directory o journal. Un retry con la **stessa** `Idempotency-Key` e digest, già verificati sul filesystem, restituisce 202 e il medesimo job con stato corrente *anche sotto rate limit*. Se la chiave è riutilizzata per un altro payload, rimane 409. La quota `RUNNER_MAX_QUEUED` e il limite delle 100 directory rimangono indipendenti; quando sono pieni il risultato è `429 queue_full`, non `rate_limited`.

**Ambito di sicurezza:** controllo locale su un **unico volume POSIX condiviso**; non è un limitatore per tenant, API key diverse, IP o utente, non è persistente oltre la retention/rimozione manuale dei job e non garantisce un limite cross-host con dischi distinti. I `Retry-After` sono indicativi, non una prenotazione di capacità; gli script client devono usare backoff e, per retry della stessa submission, conservare UUID e digest. Per rate per tenant, audit centralizzato e fencing distribuito si deve ancora completare la #2.


## Lettura bounded durante la transizione journal/report (#36)

Durante un job reale, `recordJobEvidence` appende e sincronizza una nuova entry in `evidence.jsonl` **prima** di sostituire `report.json` via `rename`. Un GET senza lock può osservare il journal aggiornato e il report precedente e scambiarli per una manomissione. Entrambi gli endpoint di lettura autenticati, `GET /v1/jobs/{uuid}` e `GET /v1/jobs/{uuid}/evidence`, ora usano **al massimo tre verifiche integrali**, con pause da 25ms soltanto quando l'errore è `EVIDENCE_INVALID`. Viene restituito 200 **solo** se l'intera catena e il report sono coerenti nello stesso tentativo; nessun tentativo riscrive, tronca o ricostruisce file. Se tutte le letture rilevano inconsistenza, resta **409 `evidence_invalid`**. Un job inesistente continua a dare 404 senza ritardi artificiali. La scansione admission conserva il proprio retry e il lock della #34.

Questa tolleranza limita i falsi errori durante il polling SPA ma non copre una scrittura su filesystem distribuiti con semantiche differenti né garantisce il completamento entro 50ms se il worker o lo storage sono bloccati. Nessun job deve essere dichiarato passato senza report + steps completi; attestation off-host e fencing restano parte della #2.


## Polling browser e ripristino di una lettura interrotta (#37)

Il client `RunnerPanel` interroga `GET /v1/jobs/{uuid}` ogni 2,5 secondi finché lo stato resta `queued` o `running`. Un problema di rete, Cloudflare Tunnel momentaneamente irraggiungibile o HTTP `408`, `429` o `5xx` non è un fallimento del test: il client riprova fino a cinque volte consecutive, con backoff 2,5 / 5 / 10 / 20 / 30 secondi. Una lettura riuscita resetta l'intero budget; un report terminale valido arresta normalmente il polling. Anche durante l'attesa non viene generata alcuna nuova submission, patch o approvazione automatica.

HTTP `401/403` (autenticazione/autorizzazione), `404` (job inesistente), `409` (evidenza corrotta) e risposte JSON non parseabili **non vengono ritentati automaticamente**: il client mostra che non ci sono prove verificate e sospende il polling, senza mantenere un precedente esito come credibile. Dopo l'esaurimento dei retry compare `Riprova lettura`, che azzera il budget ed esegue **solo un GET del job già noto**, mai un POST. Il cleanup di `AbortController` e timer protegge da risposte obsolete dopo cambio job/endpoint/secret o unmount. Il browser non può distinguere un errore CORS da altri errori di rete: in quei casi si ferma comunque dopo cinque retry e mostra il controllo manuale, senza bypass di sicurezza. L'approvazione repair resta vincolata a report, digest e step realmente verificati (#2).


## Readiness autenticata e heartbeat del worker (#38)

La vecchia `GET /healthz` è volutamente **solo liveness API**, senza autenticazione: risponde anche quando il worker è offline. Per verificare il collegamento tra i due container sullo stesso volume, eseguire:

```bash
curl -fsS -H "Authorization: Bearer $RUNNER_API_KEY" \
  http://127.0.0.1:8787/v1/readiness
```

Il worker salva ogni 5 secondi `/data/worker-heartbeat.json` con un `instanceId` casuale e due timestamp ISO; il file è creato via rename atomico con permessi 0600, senza PID, secret, identificativi Docker, sorgenti o dettagli dei job. Un timer indipendente dal poller lo aggiorna anche durante un test Docker atteso. L'API apre il file con `O_NOFOLLOW`, controlla `fstat` sulla FD (file regolare, singolo inode, owner UID efficace, mode privato e dimensione limitata), valida JSON/version/UUID e timestamp. Se tutto è coerente e `updatedAt` è negli ultimi 30s (default), restituisce HTTP 200 `{"status":"ready","worker":"responsive"}`. Se il file manca, è corrotto, non appartiene all'UID dell'API, è stale o nel futuro, risponde HTTP 503 `{"error":"worker_unavailable"}` e `Retry-After: 5`; un Bearer invalido produce 401. La healthz non cambia e gli endpoint job/repair non vengono automaticamente chiusi dal solo heartbeat.

La soglia si configura con `RUNNER_WORKER_HEARTBEAT_MAX_AGE_SECONDS=30` nella `.env` Compose; valore ammesso intero 10–300, errato => avvio API rifiutato. Entrambi i container devono vedere lo stesso volume e l'UID mapping deve permettere la lettura owner-only. Un crash può lasciare un falso 200 fino alla scadenza; un heartbeat valido prova soltanto **worker Node recentemente responsivo e accessibilità del file**, non accesso effettivo al daemon Docker, rootless mode, correttezza CLI, SDK .NET/Playwright, sicurezza dei container, attestazione off-host o reachability pubblica di Cloudflare Access. Il collaudo in VM dedicata e un vero test Docker sono ancora richiesti in #2. Gli endpoint readiness protetti non vanno usati come prova per approvare un patch.


## Readiness del daemon Docker rootless (senza dare il socket all'API) (#39)

Il solo heartbeat del worker della #38 può risultare fresco anche con Docker spento. Il worker esegue in background ogni 10s il comando fissato `docker info --format '{{json .SecurityOptions}}'`, con timeout 5s e 4096 byte massimi, attraverso il socket UNIX locale configurato per la sua esecuzione. Il comando non usa una shell e passa soltanto un ambiente minimo Docker (`PATH`, `HOME=/tmp`, `DOCKER_CONFIG=/tmp`, `DOCKER_HOST`). Sono rifiutati host `tcp://`, `ssh://` e percorsi socket non consentiti; `name=rootless` deve emergere **dal daemon**, non essere inferito dal solo socket path. Errori, timeout, output non valido o daemon rootful marcano il probe come negativo, senza riversare dettagli privati nel heartbeat o nei log.

Il heartbeat passa alla versione 2 con il solo sotto-oggetto `docker: {rootless, checkedAt}`. Le API verificano il file privato come prima. Il GET aggiuntivo `/v1/execution-readiness` richiede Bearer dei job e risponde 200 con `{"status":"ready","worker":"responsive","docker":"rootless"}` **solo** se il segnale Node e l'ultimo probe positivo sono entrambi recenti entro `RUNNER_WORKER_HEARTBEAT_MAX_AGE_SECONDS` (default 30s), non futuri o malformati. Altrimenti: **503 `{"error":"docker_unavailable"}`** con `Retry-After: 5`. Il vecchio heartbeat v1 resta leggibile dalla `/v1/readiness`, ma non può mai dichiarare execution-readiness. Nessuna modifica a healthz, CORS, job, repair, o autorizzazioni precedenti. Esempio sulla VM, passando la chiave soltanto all'endpoint:

```bash
curl -fsS -H "Authorization: Bearer $RUNNER_API_KEY" \
  http://127.0.0.1:8787/v1/execution-readiness
```

Il worker non esegue container di prova durante il probe. `docker info` su socket rootless è un indicatore di **disponibilità e modalità daemon al momento del controllo**, non una verifica di user namespace o dei bind mount, della disponibilità immagini/SDK/.NET/Playwright, né del corretto funzionamento del tunnel e degli utenti Cloudflare Access. Hosted CI usa Docker rootful per lo smoke e non può essere spacciata come collaudo del daemon rootless su VM. Prima di affidare job reali serve eseguire un campione job in una VM isolata con Docker rootless, con verifiche indipendenti dei namespace e della rete (#2).


## Canary rootless: avvio di container verificabile su VM (solo operatore, #40)

La readiness della #39 verifica `docker info`, non un vero container. Per verificare anche **`docker create → inspect → start → inspect → cleanup`** usa il comando operatore nella VM dedicata. Questa funzione non è esposta alle API, non viene lanciata automaticamente dai job, non usa credenziali cloud o token e non modifica le issue GitHub.

1. Sul daemon **rootless** dedicato, pre-carica l'immagine Node ufficiale `node:22-bookworm-slim` e ottieni il suo riferimento *immutabile* `node@sha256:<digest>`. Controlla la provenienza del digest/immagine secondo le policy dell'organizzazione. Non utilizzare un tag mutabile come input al canary.
2. Sull'host con il progetto, esegui nel container `runner-worker` come UID non privilegiato (il socket Docker è montato **solo** nel worker). Per il valore `DIGEST` usare i 64 caratteri hex effettivi del digest del repository immagine già presente sul daemon rootless. Non copiare esempi o placeholder come valori reali:

```bash
# Come utente del daemon rootless, prima dello smoke:
docker --host unix:///run/user/1000/docker.sock pull node:22-bookworm-slim
docker --host unix:///run/user/1000/docker.sock image inspect node:22-bookworm-slim \
  --format '{{index .RepoDigests 0}}'
# Inserisci la stringa 'node@sha256:...' realmente ritornata:
docker compose --env-file docker/runner/.env -f docker/runner/compose.yml exec -T \
  runner-worker node scripts/rootless-canary.mjs \
  --image=node@sha256:<digest-reale> --confirm
```

La CLI accetta **solo** `--confirm` e un digest `node@sha256:` di 64 hex; usa `--pull=never` (se manca la cache fallisce, senza egress). Prima del container controlla `name=rootless` via daemon Docker. Crea un container identificato da un nome UUID e label esclusivi, con `--network=none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, UID:GID 65534, 128 MiB RAM, 0.5 CPU, 32 PID, tmpfs 16 MiB su `/tmp`, **nessun volume/bind mount**, nessun socket, nessuna variabile segreta iniettata. Verifica anche mediante `docker inspect` i limiti effettivamente applicati, esegue un programma Node fisso che controlla identità, capability, interfacce di rete e tmpfs, poi ricontrolla exit code zero/stato non OOM e rimuove **soltanto** il container appena creato, dopo verifica di ID/nome/label. Timeout o mismatch arrestano il controllo; errori Docker non vengono riportati nel log, e un cleanup incerto richiede verifica manuale degli eventuali container `sf-canary-...` senza usare `docker system prune`.

Un esito `{"status":"passed",...}` **vale solo per quel canary sul daemon locale in quel momento**. Non è un attestato firmato da un host indipendente, né dimostra che build .NET 10/11, npm/Playwright, bind mount effimeri, Cloudflare Tunnel/Access o un job con sorgenti AI funzionino nella VM. Per la #2 servono ancora una prova manuale del workflow completo con job reali, networking e IAM e la documentazione operativa dell'esito. Su GitHub Actions i test unit simulano le chiamate Docker; lo smoke esistente in CI usa un daemon **rootful** e non prova il rootless sulla VM.


## Canary reale su GitHub CI ≠ collaudo VM rootless (#41)

È stato aggiunto lo step `Execute actual canary Docker lifecycle (rootful CI host ONLY, not rootless VM)` nella Factory CI, immediatamente dopo `docker-smoke.mjs`. L'immagine `node:22-bookworm-slim` è già stata scaricata sul runner GitHub; il test seleziona `node@sha256:<digest>` dal suo `RepoDigests` locale, senza scaricare nuovi file, e verifica fisicamente che il canary sia creato con rete `none`, rootfs read-only, UID 65534, capability e risorse limitate, controlla la risposta di `docker inspect`, esegue il codice interno, richiede exit code zero e rimuove il container mirato. Nessun `docker system prune`. Se lascia residui, fallisce.

**Separazione rigorosa:** il runner GitHub hosted usa Docker **rootful**. Per esercitare la sequenza reale, uno script CI dedicato con controlli espliciti `GITHUB_ACTIONS=true`, `CI=true` e processo non root verifica **prima** che il daemon sia rootful e poi sostituisce soltanto nel contesto CI il probe rootless e il socket tramite dependency injection. L'eseguibile operativo `scripts/rootless-canary.mjs` continua a richiedere `--confirm` e il daemon rootless. La CI stampa `CANARY_REAL_DOCKER_ROOTFUL_CI_ONLY_PASS` e non pubblica `dockerRootless:true` come prova.

Questo smoke può rilevare incompatibilità di flag Docker, immagini per digest, UID, tmpfs, inspect, runtime del canary e cleanup prima del deployment; **non** prova il rootless vero né IAM, Docker VM, quote tenant, Cloudflare Tunnel/Access, .NET/Playwright sul daemon di produzione e attestazioni indipendenti. Queste verifiche restano compiti della #2 da eseguire su una VM dedicata.


## Race timestamp della readiness durante un rename heartbeat (#43)

La verifica `GET /v1/execution-readiness` deve leggere il file privato prima di confrontare i timestamp con l'ora della richiesta **al momento della verifica**. Se il worker rinnova `worker-heartbeat.json` fra l'inizio del GET e il completamento della lettura asincrona, confrontare il nuovo `updatedAt` con `Date.now()` catturato prima di I/O produceva un falso 503 per un record più recente e integro. Ora `readWorkerHeartbeat` usa il clock rilevato dopo la lettura e `readDockerExecutionReadiness` controlla la scadenza del probe con un clock anch'esso successivo all'I/O. Il clock di test opzionale è passato identico a entrambe le funzioni; time future reale, probe stale, rootless false e file corrotto restano sempre 503. La suite Node testa due API che leggono mentre il timer aggiorna realmente il file ogni 20ms. Non cambiano intervalli, soglie, autenticazione o significato non-attestante dell'endpoint (#2).


### Readiness: rilettura bounded per snapshot concorrenti (#43)

Per gestire la breve finestra di sostituzione dell'heartbeat durante gli aggiornamenti indipendenti di Node e probe Docker, l'endpoint autenticato `/v1/execution-readiness` ritenta una **verifica integrale** fino a tre volte, separata da 15ms; 200 è possibile soltanto se una singola lettura soddisfa tutte le condizioni (owner 0600, JSON/version/ISO validi, timestamp non futuri, TTL worker/probe e daemon rootless). Se la prova resta assente, corrotta, non-rootless o scaduta, continua a tornare HTTP 503 con `Retry-After: 5`, senza riparare alcun file. Non equivale a readiness transazionale distribuita né a una attestazione off-host.


### Retry-After e abbassamento del cap durante la finestra scorrevole (#46)

Se si riavviano **tutte** le istanze API con `RUNNER_MAX_ACCEPTED_PER_MINUTE` ridotto, il volume può già contenere più accettazioni recenti del nuovo limite. Per la prima nuova accettazione servono meno di C job ancora nella finestra di 60s: con N record recenti e cap C, il controllo ordina i timestamp e utilizza la scadenza del record all'indice `N - C` (zero-based). Per esempio con `now=T`, accettazioni `T-50s`, `T-30s` e `T-10s` e nuovo cap 1, la prima accettazione è possibile a `T+50s`, non a `T+10s`. Su un cap 2 il primo slot si libera a `T+30s`. Rimane inalterata la validazione fail-closed degli `acceptedAt` tramite journal/report verificati, il lock multi-API, la gratuità del replay identico e l'header 429 limitato a 1–60 secondi; orologi host discordanti possono comportare richieste ripetute e non si promette fairness per tenant. Test con due API confermano che nessun job nuovo viene accettato, né creata una directory, con cap ridotto.


### Rename atomico, FD vecchio con nlink=0 e readiness HTTP (#47)

Il worker rimpiazza `worker-heartbeat.json` tramite `rename`. Se un GET autenticato esegue `open(O_NOFOLLOW)` prima del rename e `fstat` subito dopo, il vecchio inode già aperto può risultare con **`nlink=0`**: il nome corrente punta al file nuovo, ma il vecchio FD resta leggibile finché non viene chiuso. Non bisogna accettare quel FD come attestazione di readiness, né classificarlo come manomissione permanente. Il reader distingue il caso specifico `HEARTBEAT_ROTATED` e `GET /v1/readiness` riprova al massimo tre nuove letture complete, separate da 15ms; la execution-readiness conserva il proprio limite di tre verifiche integrali. Il file 0600 deve avere `nlink=1` quando viene effettivamente accettato; symlink, hardlink `nlink>1`, UID/mode scorretti e timestamp/JSON irregolari continuano a dare HTTP 503. Test Node controlla l'inode unlinked deterministico e cento GET su due istanze durante heartbeat frequenti. Il meccanismo non conserva un cached-ready e non esegue test Docker.


### Input Ed25519 offline: file descriptor e trust anchor protetti (#48)

Sulla **postazione separata** che esegue `node src/runner/attest.mjs sign|verify`, la CLI non usa più la sequenza vulnerabile a TOCTOU `lstat(path) → readFile(path)`. Evidence export (massimo 4.000.000 byte), receipt (20.000), private key (20.000) e public trust anchor pinned (20.000) sono aperti ciascuno **una sola volta** con `O_RDONLY|O_NOFOLLOW`; `fstat` sul descriptor verifica file regolare, `nlink=1` e size 1..limite, poi un reader bounded legge dallo **stesso inode** e una seconda `fstat` rifiuta un file modificato o scollegato. La chiave privata deve appartenere all'UID corrente e non avere permessi per gruppo/altri; la pubblica deve appartenere allo stesso UID e non essere scrivibile da gruppo/altri (0644 è consentito). Nessun symlink/hardlink è utilizzabile come chiave o documento, e una piattaforma senza `O_NOFOLLOW` fallisce chiusa. La ricevuta finale resta `0600` con creazione esclusiva e la CLI non emette i percorsi/chiavi in caso di errore. Test Node CLI provano successi e fallimenti reali senza cambiare schema, digest o Ed25519. Queste verifiche proteggono gli input dell'operatore: non generano un'ancora off-host automatica o un'attestazione del Docker Engine.
