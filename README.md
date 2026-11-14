# SoftwareFactory

**SoftwareFactory** è un AI App Studio *local-first* ispirato a [BookWriter](https://github.com/KeyserDSoze/BookWriter). Parte da un brief, produce un piano per feature e ricerca, propone architettura, esegue adversarial review e genera un progetto sorgente modulare.

## Funzionamento della prima versione

- SPA responsive React 19 + TypeScript + Vite; nessun backend centrale richiesto per la factory.
- Pipeline AI con sei fasi, prompt specializzati, salvataggio dei checkpoint sul browser e stop/ripresa.
- Endpoint OpenAI-compatible multipli, routing modello per task e API key solo in sessione.
- Ricerca con gateway configurabile (GET `?q=...` → `results: [{ title, url, snippet }]`); fallback Wikipedia **non adatto a verifiche legali/competitive complete**. La ricerca non viene inventata se il provider è indisponibile.
- Configuration composer: frontend React/React Native/Android/iOS/Unity, .NET 11 o 10 LTS, PostgreSQL o altri database, Azure/AWS/GCP/on-prem, servizi per development/production.
- ZIP sorgenti e pubblicazione GitHub diretta (PAT fine-grained, GitHub App tramite token broker), branch `main` di default oppure branch separato. Il commit usa fast-forward, mai force push.
- Google Drive appDataFolder / Microsoft OneDrive app folder: OAuth 2.0 PKCE con client ID configurabile, backup/ripristino JSON.
- **Code Agent supervisionato**: patch multi-file a sorgenti C#/React, review avversaria indipendente, confronto delle differenze, approvazione, undo, recovery dei conflitti ed export solo degli override approvati.
- Generatore di **scaffold compilabile React + ASP.NET Core** con cartelle `docs/`, `adr/`, `docker/`, `infra/`, `tests/`, `src/backend/{applications,business,domain,infrastructure}/`, `src/frontend/` e GitHub Actions.

**Attenzione:** il Code Agent propone e applica codice dopo review e consenso, ma non esegue ancora autonomamente build, test o remediation nel browser. Non garantisce di implementare tutte le feature o deploy finali. React Native, Android, iOS, Unity e molti provider cloud sono target descritti nel manifest/placeholder, da implementare nelle iterazioni successive. Le integrazioni di ricerca dipendono da CORS e dalle credenziali del provider.

## Avvio locale

```bash
cd src/frontend
npm install
npm run dev
npm run typecheck
npm run test
npm run build
```

Apri l'indirizzo indicato da Vite (normalmente http://localhost:5173). In alternativa: `docker compose -f docker/compose.yml up --build` e visita http://localhost:8080.

## Uso

1. Nel **Workspace** inserisci nome, brief e vincoli.
2. In **Architecture** scegli frontend (anche multipli), database, .NET, deployment e binding dei servizi per development/production.
3. In **Settings** configura endpoint, modello e credenziali temporanee; opzionalmente aggiungi un gateway di ricerca web.
4. In **AI Factory** avvia la pipeline, verifica fonti e risultati, correggi gli output e riprendi quando serve.
5. In **Architecture** esamina e scarica i file generati come ZIP.
6. Se vuoi pubblicare, configura owner/repo/branch GitHub in Settings, controlla la visibilità, autorizza e pubblica. La repository viene creata automaticamente solo se il token lo permette.
7. In **Code Agent** descrivi una feature, controlla la review e i diff, quindi applica la proposta: lo ZIP e GitHub includeranno le modifiche approvate.
8. Per un backup cloud configura OAuth SPA (Google/Microsoft), connetti e scegli Backup.

## Sicurezza e limiti

- Non mettere token nei file: API key, PAT e access token OAuth sono conservati **solo nella sessionStorage**, e non sono inclusi in ZIP, GitHub o Drive.
- Per GitHub App serve un **backend broker attendibile**, che rilasci installation token di breve durata: la chiave privata della App non può vivere in una SPA.
- Per Google/Microsoft occorre registrare un'app OAuth pubblica e autorizzare esattamente l'URL di redirect mostrato in UI.
- La sessionStorage e i token in memoria **non proteggono** da XSS o estensioni del browser malevole. Non usare modelli/API non fidati con dati sensibili.
- La pipeline AI gira **solo mentre la scheda è attiva**. Il salvataggio è locale, non è un worker persistente. Il browser può sospenderla in background.
- Il generatore non garantisce conformità legale, qualità del codice o configurazione cloud pronta per produzione.
- Gli input di ricerca e i contenuti dell'utente possono finire sui provider scelti: verificare privacy, permessi e termini.

Guide: [Code Agent](docs/code-agent.md) · [architettura](docs/architecture.md) · [sviluppo](docs/local-development.md) · [integrazioni](docs/connectors.md) · [roadmap](docs/roadmap.md) · [ADR](adr/0001-local-first-factory.md).

## Branch e contribuzione

Lo sviluppo della factory avviene su **`main`**. Lo scaffold generato usa `main` salvo diversa scelta dell'utente; il merge da un branch di feature viene effettuato in GitHub e non automaticamente dal browser.
