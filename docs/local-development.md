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
