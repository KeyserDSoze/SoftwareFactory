# ADR 0025 — Il preflight Compose vincola anche codice avviato, contesto build e ambiente Node

- Data: 2026-11-16
- Stato: accettato come policy statica del runner sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/68
- Precedenti: ADR 0022 e ADR 0024

## Contesto

Il preflight già verificava allowlist di servizi, cap/namespace, mount e socket, ma non la **provenienza dei processi**. Un override che sostituisce `runner-worker` con `image: attacker/worker`, un diverso `build.dockerfile`, `dockerfile_inline`, un `entrypoint` o un `healthcheck` può eseguire codice arbitrario con il socket rootless del worker. Anche aggiungere `NODE_OPTIONS=--import=/data/evil.mjs` consente esecuzione di moduli estranei pur mantenendo i comandi Dockerfile immutati.

## Decisione

1. Permettere per `runner-api` e `runner-worker` solo `build` con i due campi `context` (radice del checkout) e `dockerfile` (percorso ufficiale per quel servizio). Vietare immagini sostitutive, context remoti, Dockerfile inline o opzioni build extra, comprese args/ssh/secrets/network/target/entitlements.
2. Imporre l'assenza di override `command`, `entrypoint`, `healthcheck`, `post_start`, `pre_stop`, `develop` e `pull_policy` su API e worker; i CMD del Dockerfile revisionato rimangono l'unico percorso di avvio.
3. Consentire solo le variabili ambiente note ai due servizi, incluse le opzioni già revisionate per chiave API, tenant e registry operatori. Imporre `RUNNER_DATA_DIR=/data`; negare `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD` e ogni altra env non autorizzata.
4. Richiedere nel tunnel l'immagine pubblica dichiarata `cloudflare/cloudflared:latest` e nessun altro build/entrypoint/hook o healthcheck definito da override.
5. Coprire con test Node sia i tentativi di sostituzione/iniezione sia i Compose normali, più preflight sul JSON Compose reale GitHub CI con override operator registry. Non stampare mai il JSON del Compose, che contiene segreti.

## Limiti e conseguenze

Questa è una policy dichiarativa, **non** una prova dell'hash del Dockerfile o delle immagini costruite: un checkout modificato o immagini remote mutate possono alterare il codice effettivamente eseguito. Il tag `cloudflare/cloudflared:latest` non è ancorato a un digest. La verifica di provenienza indipendente e supply-chain, il test su VM Docker rootless reale, Cloudflare Access/Tunnel operativi, il fencing multi-host e le ricevute off-host restano necessari in #2. Ogni nuova opzione legittima di build/runtime richiede review ed esplicito aggiornamento della policy.
