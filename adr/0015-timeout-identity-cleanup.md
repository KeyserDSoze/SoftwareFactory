# ADR 0015 — Cleanup Docker timeout con identità verificata e ID immutabile

- Stato: accettato per runner sperimentale su singolo daemon
- Data: 2026-11-16
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/58
- Precedenti: ADR 0005, ADR 0014, issue #21

## Contesto

Dopo SIGKILL della CLI Docker, un container può continuare a occupare risorse. Il vecchio timer chiamava `docker rm -f` basandosi solo sul nome costruito dal job. Un altro container avrebbe potuto acquisire quel nome prima del cleanup.

## Decisione

1. Il worker attende la conclusione del tentativo bounded di cleanup dopo il timeout, anche se la CLI non notifica la chiusura; il job non deve essere finalizzato prima.
2. Ricostruire l'identità dall'UUID e dallo step consentito, leggere `docker inspect --type container` per nome, verificare ID completo e label, poi ripetere `inspect` per ID. Eliminare esclusivamente per l'ID confermato, mai per nome.
3. Richiedere probe rootless positivo prima del primo inspect e immediatamente prima del comando rm, senza cached readiness. Usare CLI senza shell, ambiente minimo, timeout 5s, maxBuffer 8192 byte e nessun log di errore Docker nel report.
4. In presenza di un dubbio non rimuovere nulla; il job rimane terminale per timeout, ma la pulizia residua compete all'operatore con le verifiche di #21. Test negativi su nome, ID, label, rootful, daemon indisponibile e close tardivo/assente.

## Limiti

Le due ispezioni non forniscono un lock transazionale sul Docker daemon. Un host malevolo o un socket sostituito fra inspect e rm restano fuori dal modello; servono VM rootless dedicata, IAM, fencing e attestazione off-host ancora previsti dalla #2. La CI GitHub-hosted rootful non certifica il deployment.
