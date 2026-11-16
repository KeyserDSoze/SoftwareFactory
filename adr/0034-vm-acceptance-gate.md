# ADR 0034 — Gate locale di acceptance per il runner VM

- Data: 2026-11-16
- Stato: accettato come interfaccia operator-only; non attestazione di deployment
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/77
- Precedenti: ADR 0019, 0020, 0021, 0030, 0031, 0032 e 0033

## Contesto

Il runner espone già tre verifiche separate: `preflight compose` valida la topology statica JSON Docker Compose, `preflight host` controlla la VM reale (UID 1000, socket daemon rootless, permessi e credenziali) e `rootless-canary` esegue una sentinella in un container offline, protetto dalle policy pre/post-inspect. Eseguite manualmente e riportate separatamente, possono produrre acceptance incompleta o riferita a modalità di autenticazione diverse. Nessuna di queste prove equivale a test del Cloudflare Access/Tunnel esterno.

## Decisione

1. Introdurre `src/runner/scripts/vm-acceptance.mjs` operator-only: richiede utente UID 1000, `--confirm`, env private 0600 canonico, digest `node@sha256:<64hex>` pre-cached, esattamente un profilo globale inline/key-file/tenants e operator registry soltanto per globali. L'interfaccia non è accessibile tramite API/worker.
2. Prima eseguire `preflight compose` con i soli file reviewati, poi `preflight host` con gli stessi flag e il medesimo env privato. Verificare `mode/status` e le booleane di security restituiti; solo se entrambe sono verifiche valide continuare. Nessun fallback di credenziali, nessuna esecuzione Docker prima dei gate precedenti.
3. Generare UUID recovery non segreto e scrivere `ROOTLESS_CANARY_ID=<UUID>` sullo stderr *prima* di creare il container. Invocare il canary real Docker sulla socket host fissa `unix:///run/user/1000/docker.sock` e sulla stessa immagine digest; pretendere status passed, rootless, network none, readonly, caps drop e cleanup verified. Restituire una sola ricevuta finale JSON con versione, profilo e gates; no nomi path, chiavi, token o log.
4. Qualsiasi fallimento, check contraffatto, errore del daemon o cleanup incompleta rifiuta la ricevuta. Gli errori pubblici sono statici, per non esporre il contenuto di private env, Docker output o file secret. Test Node su ordine, mismatch di profilo, UID, malformed CLI, errori secret-bearing e fail-closed. CI continuerà a verificare separatamente vero canary Docker e preflight Compose.

## Limiti

Il controllo è point-in-time, non lega atomicamente il daemon al probe successivo, non fornisce firma/autenticità della ricevuta ed è subordinato alla fiducia nel processo e nell'host della VM. Un JSON di acceptance locale non è attestazione off-host e non verifica la raggiungibilità HTTPS, Cloudflare Tunnel/Access o il comportamento off-host del tenant. I workflow GitHub usano Docker rootful: non sono prova del funzionamento sulla VM rootless dedicata. L'epica #2 resta aperta fino a prove operative vere e alle garanzie di fencing e attestazione richieste.
