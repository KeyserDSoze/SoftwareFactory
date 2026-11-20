# ADR 0089 — Preflight singolo e diagnosi fail-closed per Docker Compose CLI nei test scaffold

**Data:** 2026-11-20  
**Issue:** #135  
**Stato:** accepted come mitigazione mirata di un timeout CI, non prova di root cause.

## Contesto

Il run [Factory CI #44746058641 attempt 1](https://github.com/KeyserDSoze/SoftwareFactory/actions/runs/44746058641/attempts/1) ha fallito nello step obbligatorio `Generated scaffold and Docker Compose contract tests`. La chiamata `spawnSync docker compose version` ha segnalato `ETIMEDOUT` in 8188 ms (timeout 6000 ms), mentre **175/175 frontend Vitest passavano** e lo scaffold non era cambiato. Il rerun [attempt 2](https://github.com/KeyserDSoze/SoftwareFactory/actions/runs/44746058641/attempts/2) sullo SHA identico ha superato lo stesso gate, senza modifiche. Non è possibile stabilire con queste prove la causa esatta dell'intermittenza sul runner GitHub.

## Decisione

- `dockerComposeAvailable()` verifica la CLI **una sola volta per processo** di test scaffold, anziché in ciascuno dei due test con file/variant Compose. Mantiene il risultato del preflight *solo* in memoria per il worker; non memorizza né salta nessun `docker compose config`. Questa riduzione evita una seconda inizializzazione inutile del plugin e diminuisce l'esposizione a cold-start intermittente.
- Timeout del preflight portato da 6000 a **15000 ms**, con diagnostica JSON bounded `status/signal/errorCode/errorErrno/durationMs/timeoutMs`, senza raw Compose output o env secrets. Nessun auto-retry, nessuna `continue-on-error`, nessuna modifica al codice generato.
- I sei controlli reali `docker compose -f ... --env-file ... config --format json` restano eseguiti dopo il preflight e richiedono **exit 0 e asserzioni su env/ports/volumes**; il timeout per ogni config resta **12000 ms**. Un plugin non disponibile, timeout, exit nonzero, JSON invalido o schema non conforme continua a fallire chiuso in CI. Fuori CI soltanto `ENOENT` locale permette di eseguire le pure asserzioni string template.
- Test di diagnosi ETIMEDOUT sintetico, budget complessivi dei due test allineati ai subprocess obbligatori (55/75 secondi).

## Limiti e convalida

Questo modifica la probabilità di flake e la diagnosi, **non** la natura del test: le configurazioni generate richiedono ancora Docker Compose presente e funzionante. Non si attribuisce una causa root dimostrata ai GitHub-hosted runners. Validare con CI completa sullo stesso SHA e un secondo tentativo indipendente; non dichiarare risolta #93 (race OIDC/PostgreSQL) e non scambiare l'esecuzione Docker rootful CI per VM rootless/Cloudflare reale (#87/#2).
