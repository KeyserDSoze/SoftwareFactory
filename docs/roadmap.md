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
