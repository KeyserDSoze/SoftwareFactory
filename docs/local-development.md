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
