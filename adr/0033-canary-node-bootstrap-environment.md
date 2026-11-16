# ADR 0033 — Canary Docker: vincolare le variabili di bootstrap Node e negare healthcheck

- Data: 2026-11-16
- Stato: accettato per il runner sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/76
- Precedenti: ADR 0019, 0020, 0032

## Contesto

Il controllo `safeConfig` introdotto nella #75 confronta integralmente `Config.Entrypoint` e lo script `Config.Cmd`, ma non l'ambiente ereditato dal processo. Con `NODE_OPTIONS=--require=...` o `--import=...`, `NODE_PATH` o `LD_PRELOAD`, un processo Node potrebbe caricare codice prima della sentinella anche se comando e messaggio `SF_ROOTLESS_CANARY_OK` coincidono. Un `Config.Healthcheck` custom potrebbe introdurre ulteriore esecuzione fuori dallo script revisionato. La CLI di riconciliazione usa lo stesso gate prima di eliminare un residuo.

## Decisione

1. Il canary revisionato è associato all'immagine ufficiale `node:22-bookworm-slim` usata dal Docker smoke. Richiedere nell'inspect esattamente tre voci `Config.Env`: `PATH` predefinito e fisso `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `NODE_VERSION` nel formato `22.minor.patch`, `YARN_VERSION` nel formato `1.22.patch`. Consentire ordine arbitrario, negare nomi duplicati, valori inattesi e qualsiasi aggiunta, anche `NODE_OPTIONS`, `NODE_PATH` e variabili del loader. Non riportare mai l'env in errori/receipt.
2. Richiedere che `Config.Healthcheck` sia nullo o assente. Controllare l'intero profilo `safeConfig` prima dello start, alla fine e prima della cleanup. La riconciliazione manuale applica lo stesso criterio, preferendo rifiuto a eliminazione automatica di un container inatteso.
3. Suite Node con casi positivi, reorder e tampering prima/dopo start, stdout spoofing e healthcheck custom; test di riconciliazione. Lo smoke Docker reale in GitHub Actions conferma la compatibilità con `node:22-bookworm-slim` usando solo il wrapper test-only su host rootful.

## Conseguenze e limiti

Il controllo dell'env è intenzionalmente legato alla major Node 22 e all'immagine ufficiale revisionata: richiede aggiornamento esplicito quando cambia il digest/major o il contenuto dei default. `docker inspect` resta una risposta del daemon e non può attestare un host compromesso. La prova GitHub **rootful** non equivale a collaudo su VM rootless dedicata, Cloudflare Access/Tunnel reali, fencing o attestazione off-host indipendente; l'epica #2 resta aperta.
