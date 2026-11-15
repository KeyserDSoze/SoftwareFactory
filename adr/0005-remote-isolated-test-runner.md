# ADR 0005 — Runner remoto isolato con API, Docker rootless e Cloudflare Tunnel

- Stato: **accettato per MVP sperimentale**, non produzione
- Data: 2026-11-14
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/2

## Contesto

La SPA può generare codice ma non può avviare liberamente Docker, .NET SDK completo o più browser Playwright su qualsiasi dispositivo. Un runner remoto permette l'esecuzione reale, mantenendo il control plane nel browser.

## Decisione

Realizzare `src/runner` con due processi/contenitori distinti:

1. `runner-api` riceve snapshot di file attraverso HTTPS (con Cloudflare Tunnel opzionale), verifica Bearer API key con confronto hash a tempo costante, origin CORS allowlist, payload e path.
2. `runner-worker` legge una coda persistente condivisa, prepara un workspace effimero e avvia soltanto test autorizzati con un Docker daemon rootless dedicato. Solo questo worker monta il socket rootless. Nessun socket Docker viene esposto nei job o nella API.
3. Ogni step restituisce esito, exitCode, tempi, log redatti e immagine. Gli skip rendono l'esito complessivo `incomplete`, non `passed`. SHA-256 collega il report all'esatto payload inviato.

Docker usa `--network none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, limitazioni CPU/memoria/pids e timeout. Niente comandi scelti dall'AI: lista fissa `.NET build/test, web build/test, Playwright`. Un solo worker per il MVP.

La SPA usa API key conservata soltanto in sessionStorage; deve chiedere consenso esplicito all'invio del codice.

## Rischi accettati / non-obiettivi

- L'accesso al socket Docker rootless dà comunque ampio controllo sul daemon rootless: isolare su VM sacrificabile, senza credenziali e senza altri workload.
- Non è un sandbox forte contro attaccanti avanzati; seccomp/VM per job, quota disco egress e retention restano attività di hardening.
- Non c'è ancora orchestrazione automatica del loop build-test-repair, né coda robusta multi-worker, né piena gestione dell'autenticazione multi-tenant.
- Installare dipendenze con rete disabilitata richiede cache Node/NuGet pre-popolate; build possono fallire. Playwright dipende da spec/servizi/browser correttamente installati.
- Cloudflare Tunnel è ingress, **non** sostituisce autentificazione applicativa e Cloudflare Access.

## Alternative

- GitHub Actions come runner esterno: più semplice e già esistente, ma meno interattivo e con minore controllo del ciclo agentico.
- .NET/WASM o WebContainers nel browser: valide per snippet e preview, ma non equivalgono a SDK/daemon full-stack.
- Docker daemon rootful con socket su API: rifiutato per rischio troppo elevato.

Vedi `docs/runner.md` per deployment e limitazioni.


## Addendum — claim atomica per job (#18, 15 novembre 2026)

Per evitare esecuzioni duplicate quando un secondo worker viene avviato accidentalmente, una claim `.claim` è acquisita con `mkdir` atomico prima di leggere il report e rilasciata solo dal proprietario in `finally`. Un altro worker non lancia Docker e il poller non modifica `running` claimed, non elimina directory claimed né blocca la coda con `queued` claimed. L'età della claim non è prova di inattività; dopo crash serve riconciliazione manuale dei container prima di rimuoverla, altrimenti il successivo polling segna `failed` senza re-eseguire. Non garantisce HA multi-host, fencing robusto, isolamento multi-tenant o cleanup automatico, ancora previsti in #2.
