# Local development

Requisiti: Node.js 22+, npm, un browser recente. Per compilare gli scaffold generati: SDK .NET 11 o 10 (in base alla selezione), Docker/Compose e opzionalmente Terraform.

```bash
cd src/frontend
npm install
npm run typecheck
npm run test
npm run build
npm run dev
```

Docker della factory:

```bash
docker compose -f docker/compose.yml up --build
```

Questo avvia solo la SPA Factory. Per provare un'app generata, scarica il suo ZIP, estrailo ed esegui `docker compose --env-file docker/.env -f docker/compose.yml up --build` dopo aver creato `docker/.env` dall'esempio e sostituito le password. La health API dello scaffold risponde a `/health`; database, migrazioni e logica applicativa non sono ancora collegati.

GitHub Pages: workflow `.github/workflows/pages.yml`. Selezionare **Settings → Pages → Build and deployment → Source: GitHub Actions**. L'azione deploya build statici, non credenziali.

Problemi frequenti: alcuni provider AI non espongono CORS per browser; usa un proxy fidato con gestione sicura dei token. Le richieste HTTP a un modello locale sono permesse soltanto su localhost. I test CI non chiamano API AI né cloud vere.

## Remote Test Runner sperimentale (issue #2)

La API e il worker sono in `src/runner/`; non servono per avviare la SPA.

```bash
cd src/runner
npm run check
npm test
```

I test del runner coprono il protocollo HTTP, autenticazione, allowlist dei file, specifiche di isolamento Docker e report simulati, non lanciano il daemon Docker. La CI verifica anche il build delle immagini API/worker.

Su una VM dedicata con Docker rootless: seguire la guida [Remote Runner](runner.md), comprendendo tunnel Cloudflare, origin CORS, key, gestione socket e limiti delle dipendenze offline. Non usare una VM di produzione condivisa.

## Test browser degli scaffold generati

`npm run fixture` in `src/frontend` genera anche i file `src/frontend/web/playwright.config.ts` e `src/frontend/web/e2e/smoke.spec.ts`. Per eseguire localmente Chromium:

```bash
cd src/frontend
npm run fixture
cd generated-fixture/src/frontend/web
npm install
npx playwright install chromium
npm run test:e2e
```

Lo smoke usa un mock browser dell'endpoint API per controllare due stati UI. La CI della Factory lo esegue dentro `mcr.microsoft.com/playwright:v1.64.1-noble` con Docker; la CI dello scaffold esportato lo esegue sull'host GitHub con Chromium scaricato.

## Test E2E contro ASP.NET Core reale

Per provarli su un progetto generato, eseguire dotnet build -c Release, npm install, npx playwright install chromium, poi avviare Api.dll sulla porta 8080 del loopback. Da un altro terminale avviare Playwright con E2E_MODE=integration, E2E_WEB_ORIGIN=http://127.0.0.1:4173, E2E_API_ORIGIN=http://127.0.0.1:8080 e VITE_API_URL=http://127.0.0.1:8080. La configurazione Playwright avvierà Vite e fermerà il webServer a fine test.

La CI generata avvia e ferma automaticamente l'API. La CI della Factory esegue inoltre src/runner/scripts/fullstack-smoke.mjs su Docker con rete interna. Questi test coprono API + frontend, non il database.

## Persistenza PostgreSQL nello scaffold

Il provider `postgresql` produce un adapter reale Npgsql, non soltanto un manifest. Per avviare lo scaffold in locale usare `docker compose -f docker/compose.yml --env-file docker/.env up --build`, dopo aver impostato `DB_PASSWORD` casuale in `docker/.env` (non committarlo). Docker Compose crea PostgreSQL, ne attende `pg_isready`, passa una stringa di connessione parametrica alla API e avvia le migrazioni `Migrations/0001_create_work_items.sql`.

L'interfaccia React include un modulo **Elementi salvati** con aggiunta, lista, modifica ed eliminazione persistite. `E2E_MODE=integration E2E_DATABASE=postgresql npm run test:e2e` verifica la UI e il database realmente esistente, quando API/PostgreSQL sono raggiungibili sulle URL configurate. La CI generata prepara e ripulisce un PostgreSQL temporaneo su `127.0.0.1:54329`, con password generata al volo.

L'API richiede JWT reader/editor per /api/items e limita l'accesso per utente. Non pubblicare la demo: manca un Identity Provider con login, key rotation e altre misure production. Per altre configurazioni database (SQL Server/MySQL/SQLite) questa integrazione non viene generata: occorre implementare l'adapter specifico.

## Demo token JWT su PostgreSQL (issue #8)

Lo scaffold PostgreSQL richiede `DB_PASSWORD`, `AUTH_ISSUER`, `AUTH_AUDIENCE` e `AUTH_SIGNING_KEY` in un `docker/.env` privato ignorato da Git. Generare una chiave casuale con `openssl rand -hex 48` e conservarla soltanto nell'ambiente o in un secret manager. Se i parametri mancano, l'API fallisce l'avvio; i valori di esempio non sono segreti preimpostati.

Per test locali con accesso alla chiave, il file esportato `tests/security/issue-tokens.mjs` può emettere token di prova firmati da dieci minuti: con `Auth__Issuer`, `Auth__Audience`, `Auth__SigningKey` impostati nella shell, usare `CI=true node tests/security/issue-tokens.mjs editor owner-a`. La variabile CI è **solo un guardiano contro invocazioni accidentali**, non un controllo di sicurezza né un provider di login. Evitare di mostrare token e chiave nei log.

Nel componente React `Elementi salvati` si incolla il JWT nella casella `Token di accesso (sessione)`: il token vive solo in sessionStorage, non in localStorage né nello ZIP. Con ruolo reader si può leggere, con editor si può scrivere. La CI crea automaticamente la chiave e token per due utenti e verifica 401/403 e isolamento. Non utilizzare questo accesso manuale per utenti di produzione; sessionStorage non protegge da XSS/estensioni.

## Login OIDC in uno scaffold PostgreSQL (issue #9)

In `docker/.env` configura `AUTH_MODE=oidc`, `AUTH_AUTHORITY=https://<issuer>`, `AUTH_AUDIENCE=<audience>`, `OIDC_PUBLIC_AUTHORITY=https://<issuer>` e `OIDC_PUBLIC_CLIENT_ID=<client-id-pubblico>`. Registra presso il provider un client SPA pubblico Authorization Code + PKCE con redirect URI esatto `http://localhost:3000/auth/callback` in sviluppo (oppure URL HTTPS pubblico), logout URI `http://localhost:3000/` e CORS per le richieste al token endpoint. Non includere client secret nel web bundle. `AUTH_SIGNING_KEY` non serve in modalità OIDC. L'API non accetta discovery HTTP in Production.

Per le verifiche legacy senza provider, impostare esplicitamente `AUTH_MODE=legacy` in un ambiente ASP.NET Core Development e una chiave di test lunga almeno 48 byte. La modalità legacy **non parte** in Production. Per esercitare la modalita OIDC nella CI della Factory, lo script `oidc-ci-provider.mjs` serve solo da identity fixture effimera sulla rete Docker privata: non esporre né distribuire quella fixture in ambienti pubblici.

Il login demo React tiene access e refresh token in sessionStorage; la gestione dello stato PKCE e nonce usa la libreria client. Non esiste ancora una BFF con cookie HttpOnly né una sessione server revocabile. Per dati sensibili prima del rilascio vanno configurati login reale, CSP, TLS, rotazione token e protezione XSS rigorosa.
