# ADR 0044 — Installer locale di primo avvio del runner connector (M2 parziale)

- Data: 2026-11-17
- Stato: accettato come primo incremento di onboarding host; NON ancora certificato su VM rootless
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/88
- Epic connector: https://github.com/KeyserDSoze/SoftwareFactory/issues/87
- Epic runner: https://github.com/KeyserDSoze/SoftwareFactory/issues/2
- Precedenti: ADR 0034 (VM acceptance), 0037 (cleanup journal), e note M1 #87

## Contesto

La Factory SPA dispone di un onboarding **read-only** per il runner (M1 di #87). Il runner-api e runner-worker esistono già, con Compose, rootless probe, VM acceptance manuale e canary digest-pinned. L'installazione resta un insieme di passi operatore scollegati: un deployment accidentale può usare un checkout modificato, Docker rootful, env segreta mal configurata, Compose già avviato o produrre una falsa ricevuta di prontezza. Non è sicuro aggiungere SSH arbitrario dal browser o esporre il socket Docker via API.

## Decisione

1. Implementare `src/runner/scripts/host-install.mjs` **esclusivamente per Linux UID 1000**, CLI locale non esposta in HTTP. Richiedere `--env-file=/absolute/private.env`, `--commit=<sha40>` e `--image=node@sha256:<digest>`. L'operatore sceglie `--check` read-only o `--apply --confirm-install`, con profili key-file/tenant/operator registry mutuamente validati.
2. `--check`: verificare checkout Git su `main`, HEAD uguale alla SHA approvata e worktree pulito, file env O_NOFOLLOW e directory host valide, preflight Compose risolto e rootless host. Ritornare `ready_to_install`, **non** installato, senza Docker create, build, canary o rete HTTP.
3. `--apply`: ripetere i controlli della modalità check, richiedere VM acceptance esistente **con canary Docker reale rootless e cleanup verificato** sul digest esplicito; rileggere Git ed env per drift. Acquisire `mkdir .sf-initial-install-claim` in data dir privato per esclusività POSIX, rifiutare ogni container del progetto `sf-runner` già presente. Prima di ogni comando Docker probe rootless corrente, impostare DOCKER_HOST fisso `unix:///run/user/1000/docker.sock`, eseguire soltanto `docker compose --project-name sf-runner ... up --detach --build --no-deps runner-api runner-worker` con gli override credenziali esistenti e senza tunnel.
4. Dopo il deploy, richiedere esattamente due container con label Compose corrette, running e non privilegiati, Docker socket soltanto sul worker rootless; inviare GET via loopback con Bearer derivato dalla private env per confermare che le capabilities richiedano auth (401 senza), protocollo 1/network none, worker heartbeat/readiness e observation rootless recente. Mai inviare codici/token/report a terze parti, non usare healthz da sola come prova. Verificare ancora Git/env prima di produrre receipt minima `installed`.
5. Errori o stack parziali **non** fanno rollback distruttivo: l'operatore deve ispezionare e ripulire manualmente, senza cancellare report o dati di test. Nessun SSH, Tunnel, downloader, script esterno, socket all'API o installazione cloud remota. I test CI usano callback di test Node per canary/Docker/FS, con casi di concorrenza, drift, proof forgery, status e autenticazione; la VM rootless reale rimane un gate operativo successivo.

## Limiti

I check Git e env sono point-in-time, la claim è locale POSIX e non fencing cross-host. La receipt non è firmata né prova della catena di fornitura del software; il commit approvato è una versione riferita dalla CLI, ma l'operatore deve verificare la provenienza del checkout (firma/tag/source). Docker Compose build può scaricare immagini o dipendenze autorizzate dalla configurazione reviewed e non costituisce una supply chain attestata. Nessuna prova reale VM rootless, install/uninstall/update/rollback, service manager user unit, pairing o protezione Cloudflare Access è inclusa nel CI; #87 M2–M5, #2 restano aperte.
