# ADR 0014 — Rootless Docker verificato a ogni step nel percorso di esecuzione

- Data: 2026-11-16
- Stato: accettato per MVP sperimentale, non attestazione
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/57
- Precedenti: ADR 0005, #39, #40, #55

## Problema

Il worker produce un heartbeat con `docker.rootless`, e l'API espone `/v1/execution-readiness`. Ma la sola readiness, consultata separatamente e soggetta a timeout/riconfigurazioni, non impedisce a un worker di lanciare direttamente `docker run` su un daemon rootful. Il socket Docker rootful concede un potere troppo elevato, anche se il container job usa `--cap-drop=ALL`.

## Decisione

1. Mettere un controllo fail-closed direttamente dentro `runDockerStep`, prima di ogni spawn: richiedere `probeRootlessDocker() === true`, con comando read-only allowlisted, timeout e output bounded. Non riusare il booleano del file heartbeat.
2. Se il probe fallisce, lanciare soltanto un'eccezione generica, senza riportare errori o percorso del socket. Il worker (#55) produce `incomplete` e journal hash-chain valido; nessun test `passed` e nessuna AI repair può partire.
3. Applicare il gate a ogni step, incluso npm-prepare, .NET e Playwright. Un daemon che passa da rootless a non disponibile fra due step impedisce il secondo.
4. Conservare una callback `probeDocker` come seam di codice Node, non accessibile tramite API o input. I test e i tre script di smoke del runner GitHub hosted iniettano esplicitamente un controllo alternativo; quest'ultima eccezione richiede CI/GITHUB_ACTIONS e UID non-root. Il worker distribuito non modifica `probeDocker`.
5. Conservare UID, socket ed env minimi; `DOCKER_CONFIG=/tmp` anche sul subprocess per allinearsi al probe.

## Rischi residui e trade-off

Un `docker info` just-in-time aggiunge latenza bounded a ogni step. Se il daemon cambia/socket viene sostituito **tra** probe e spawn (TOCTOU), non c'è un legame crittografico o di inode; per evitare host malevoli servono deployment dedicato, rootless VM, operazioni OS controllate, IAM, fencing e un attestatore off-host. La CI GitHub hosted resta rootful e non è un certificato rootless. Questi criteri dell'epica #2 richiedono prove su una VM reale.
