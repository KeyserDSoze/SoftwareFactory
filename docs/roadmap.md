# Roadmap di sviluppo

## v0.1 — Foundation (presente in main)

- Workspace React/TypeScript desktop/mobile e settings local-first
- Routing di modelli AI per task, OpenAI-compatible
- Pipeline feature → competitor research → technical research → architecture → adversarial → implementation
- Gateway ricerca browser-compatible + Wikipedia come fallback limitato; fonte e URL tracciati
- Configurazione multi-frontend e routing servizi dev/prod, .NET 11 / 10, Azure/AWS/GCP/K8s/Docker
- Scaffold ZIP: API ASP.NET Core DDD + web React TS, docs/adr/docker/infra/tests e CI
- GitHub PAT e GitHub App tramite broker HTTPS, scrittura su main/branch, creazione repo sul proprio account
- OAuth2 PKCE e backup Google Drive appDataFolder / OneDrive app folder
- Test dominio/generazione e CI GitHub Actions

## v0.2 — Code generation agent (fase 1 implementata — issue #1)

- Code Agent con patch JSON multi-file controllate, confronto diff, review indipendente, approvazione esplicita, cronologia e undo
- Override approvati integrati in ZIP e GitHub; proposte ancora in review non pubblicate
- Conflitti di configurazione rilevati prima di esportare/push; risoluzione guidata con drop dei file in conflitto
- Documentazione `docs/code-agent.md` e ADR 0004
- **Ancora da fare:** loop edit/build/test automatico in sandbox isolata, patch repair e test dinamici

## v0.2 — Remote runner (MVP, issue #2)

- API HTTP separata dal worker con API key, CORS esplicito, quote payload e coda persistente sul server
- Worker Docker rootless con step fissi: build/test .NET, build/test web e Playwright quando configurato
- Isolamento per job: rete off, caps dropped, no-new-privileges, pids/CPU/RAM/timeout, workspace temporaneo
- UI Code Agent: invio del workspace o della proposta, polling esiti e log, senza dichiarazioni di test non eseguiti
- Compose opzionale con `cloudflared` e documentazione Cloudflare Tunnel/Access
- **Non ancora production-ready:** host VM dedicato, cache dipendenze egress-controlled, hardening/isolamento più forte e ciclo di autoriparazione

## v0.2 — Snapshot integrity e repair (implementato in #3)

- Digest SHA-256 canonico su sorgenti + test, verifica della receipt e del report effettivamente eseguito
- Report superati ma non corrispondenti alla revisione corrente marcati come **stale**
- Repair AI su log di test falliti, massimo due tentativi, gli stessi file, prompt con input non attendibili
- Nuova review avversaria e nuovo test effettivo su .NET/React come requisito per approvare codice riparato
- Test di regressione del lifecycle e della report validation
- Ancora da fare: worker autonomo 24/7 e ripetizione dei test senza browser, isolamenti per-tenant e cache attendibili (issue #2)

## v0.2 — Runner real Docker CI e preparazione dipendenze (issue #4)

- Docker smoke in CI con runner Node vero: build/test positivo, errore di test intenzionale, dipendenze offline mancanti
- Separazione fra installazione npm e test senza rete (e conservazione del risultato di preparazione)
- Opt-in esplicito dell'amministratore per npm via rete soltanto durante la preparazione
- Restrizione dei package specifier e lifecycle scripts disabilitati, cache/preparazione workspace effimero
- Distinzione `incomplete` per errori di infrastruttura/setup, anziché incoraggiare false riparazioni AI
- **Ancora aperto:** provisioning cache immutabili con dependency lock, Playwright completo con browser reali, egress whitelist, daemon rootless production test (#2)

## v0.2 — Playwright E2E in browser reali (issue #5)

- Scaffold React con `@playwright/test` 1.64.1 pinato, configurazione webServer localhost e due smoke test Chromium sugli stati /health 200/503 (API mock)
- CI dello scaffold con install Chromium e comando `npm run test:e2e` dopo build
- Runner Playwright pinato all'immagine browser `v1.64.1-noble`, stesso path di esecuzione previsto per worker Docker, network off
- Docker smoke browser vero in CI di SoftwareFactory, oltre ai test mockati del protocollo
- Limiti: mock API, non verifica DB/integrazioni; offline npm ancora richiede cache, VM rootless e browser multipli da collaudare

## v0.2 — Code generation agent (milestone successive)

- Task graph con dipendenze, feature implementate come commit incrementali su file
- Agent loop Plan → Edit → Build → Test → Adversarial review → Repair
- Sandbox locale/container o runner remoto, limiti CPU/rete/file e permessi espliciti
- Hook all'esecuzione test con output verificato (no claim senza esecuzione)
- Controllo di qualità, codice e test per backend e frontend; merge di revisioni approvate
- Manifest di proprietà dei file, checkpoint atomici, possibilità di rollback/recovery Git

## v0.3 — Cloud adapters

- Provider reali per Postgres/SQL Server/MySQL, Redis, RabbitMQ/Kafka, OpenTelemetry/Prometheus/Jaeger e cloud gestiti
- Terraform modules per Azure, AWS, GCP, K8s/on-prem con secret management
- Matrice dev/staging/prod e più provider deploy con per-environment overrides
- Monitoring locale vs Application Insights / CloudWatch / Google Cloud Monitoring
- Docker Compose testabile con unit, integration, e2e e testcontainers

## v0.4 — Ricerca professionale e governance

- Browser research via servizi con fonti primarie, licenze e timestamp; ricerca normative con giurisdizione
- App catalog, OAuth GitHub App completo, RBAC e branch protection
- Human approval gates: normative, minacce, costo cloud, migrazioni e pubblicazione
- Budget token, audit trail immutabile, job runner 24/7 con worker, multi-device locking
- Native mobile templates completi e Unity pipelines

## Acceptance criteria prima della produzione

Nessun task AI può affermare che il prodotto è compilato/testato senza un risultato di esecuzione. Nessuna credenziale in Git o nei file generati. Ogni configurazione deve propagarsi ai template e agli adapter oppure essere segnalata chiaramente come non implementata. Provisioning cloud e migrazioni richiedono review/approvazione esplicita.
