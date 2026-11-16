# ADR 0016 — La CLI operatore non memorizza l'esito rootless del daemon

- Stato: accettato per MVP sperimentale
- Data: 2026-11-16
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/59
- Precedenti: ADR 0005, ADR 0014, ADR 0015, issue #21

## Contesto

La riconciliazione operatore (dry-run, inspect, eventuale rm selettivo) aveva una cache in-memory `inspectedHost` che conservava il risultato positivo della prima ispezione Docker. Se un daemon sullo stesso `DOCKER_HOST` diventava rootful o veniva rimpiazzato, il processo poteva continuare a usare un risultato obsoleto ed eseguire `docker rm -f` senza un controllo fresco. Il worker già impone un probe per step (#57) e un cleanup timeout vincolato a identità (#58).

## Decisione

1. Eliminare la cache del daemon nella CLI operatore: ogni comando deve eseguire prima una verifica rootless via `docker info --format '{{json .SecurityOptions}}'`.
2. Verificare socket Unix locale allowlisted e stretta risposta JSON array di stringhe bounded che includa `name=rootless`. Probe fallito, socket non ammesso, timeout o risposta rootful fermano l'operazione prima del comando.
3. Eseguire info e comando con lo stesso host/env minimo, senza shell, `HOME=/tmp`, `DOCKER_CONFIG=/tmp` e limiti di timeout/output; restituire errori generici senza mostrare stderr Docker, che potrebbe contenere dettagli dell'host.
4. Non modificare le prove hash-chain, claim, conferma UUID, matching di nome/ID/label e rimozione solo per ID. Test Node provano ogni comando, input invalidi e rootless→rootful appena prima di `rm`. I callback fake sono iniezioni di codice test fidato, non configurazione remota.

## Limiti

Un probe precedente a un comando non vincola l'inode del socket né impedisce la sostituzione del daemon nella finestra TOCTOU: la CLI non certifica un host malevolo. Rimangono necessari VM rootless dedicata, Cloudflare Access, IAM, fencing multi-host e attestation off-host (#2). La CI rootful GitHub è una simulazione utile, non una prova operativa di produzione.
