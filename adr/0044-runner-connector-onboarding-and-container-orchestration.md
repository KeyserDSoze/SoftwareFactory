# ADR 0044 — Connector installabile su PC/server, onboarding read-only e sandbox orchestrate

- Stato: **accettato per M1 sperimentale**, installazione one-click non implementata
- Data: 2026-11-16
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/87
- Epica runner: https://github.com/KeyserDSoze/SoftwareFactory/issues/2

## Contesto

La Factory gira nel browser e non può installare liberamente Docker, SDK .NET o Playwright
sull'host. Esistono già API e worker runner separati, Docker rootless, allowlist di
comandi/step, evidenze verificate, preflight Compose/VM e readiness worker/daemon.
Occorre rendere il runner avviabile su PC Linux o VM Linux dedicata e collegabile dalla SPA,
senza inventare un esecutore browser o duplicare il runner.

## Decisione M1: onboarding progressivo, senza installazione remota arbitraria

- Settings espone due target: PC Linux (localhost se browser sullo stesso host) e
  VM/server Linux (HTTPS/Tunnel configurati fuori dal browser).
- Espone una sequenza di comandi per il repository esistente, da eseguire **manualmente**
  sull'host, più i prerequisiti/documentazione. Non genera né trasporta una API key,
  non esegue shell/SSH e non salva credenziali nel progetto.
- Un pulsante `Verifica connector` usa l'API key della sessione e interroga
  **in quest'ordine** `GET /v1/capabilities`, `GET /v1/readiness`,
  `GET /v1/execution-readiness`: tutte Bearer, senza invio di file né creazione di job.
  Validazione fail-closed di protocollo 1, comandi allowlisted, rete default none,
  worker responsive e Docker rootless. Distinzione tra auth, risposta non supportata,
  heartbeat mancante, daemon non confermato e connessione fallita.
- La readiness del daemon è una *misura recente del worker*, non prova che uno specifico
  build, sandbox o SDK funzioni; il run vero rimane separato e richiede consenso.

## Evoluzione M2–M5

Un installer/pairing potrà distribuire il connector su host controllati con artefatti
versionati e verificati, identità iniziale monouso, credenziali scoped, revoca/rotazione,
audit e operazioni dichiarate. Va definita un'autorizzazione **host-side** per install/upgrade
senza dare alla SPA una shell SSH arbitraria. Prima di considerarlo production-ready
servono collaudi su PC Linux, VM rootless e tunnel/Access reali, aggiornamenti, uninstall,
quote e recovery.

Il **worker** può orchestrare più container-sibling effimeri (per esempio ASP.NET Core +
PostgreSQL + Chromium) su rete privata a egress negato, con servizi/immagini/comandi
pre-approvati e cleanup. Non consentire Docker-in-Docker arbitrario nel container non
fidato e non montare il socket Docker nel job: il socket consente di aggirare limiti di
filesystem, rete e privilegi. API e browser non devono possederlo.

## Alternative scartate

- SDK .NET/Playwright/Docker completo nel browser: non equivalente a un host Linux.
- `curl | bash` da link generato dalla SPA o credenziali in query string: supply chain
  e leakage; rifiutati.
- Socket Docker host/rootful esposto ad API o job: escalation privilegi; rifiutato.
- Dichiarare `/healthz` come test del runner: controlla solo liveness HTTP; rifiutato.

## Verifiche

I test del client coprono richieste GET autenticate senza POST/upload, forma capability,
auth negata, worker offline, Docker non confermato, risposta malformata e problemi di rete.
La CI e un futuro collaudo host-specific devono verificare compilazione TypeScript, Vitest
e i gate di sicurezza preesistenti. M1 non certifica deployment rootless reale.
