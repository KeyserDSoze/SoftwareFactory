# ADR 0027 — Rifiutare reti Compose extra o external sul runner

- Data: 2026-11-16
- Stato: accettato come policy statica per deployment sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/70
- Precedenti: ADR 0022, ADR 0024, ADR 0025 e ADR 0026

## Contesto

`inspectComposeConfig` vieta `network_mode` custom e le porte non autorizzate; tuttavia Docker Compose consente di collegare container a reti aggiuntive mediante `services.*.networks` e `networks.*.external`. Un worker socket-enabled avrebbe potuto condividere rete con un container estraneo senza modificare user, cap, read-only, socket mount o Dockerfile, ma superando il preflight.

## Decisione

1. Richiedere `config.name` con la sintassi limitata di un project name Compose e una sola rete in `config.networks`, la `default`. Il nome deve essere esattamente `<project>_default`; non ammettere `external: true`, `driver`, `internal`/altre opzioni, configurazioni IPAM di subnet/driver o una seconda rete; accettare esclusivamente `ipam: {}` vuoto che il serializzatore Docker Compose JSON v2 emette anche per la rete implicita, anche quando la seconda non è ancora usata da un servizio.
2. Per ogni servizio presente (`runner-api`, `runner-worker`, `cloudflared` opzionale), accettare solo la default implicita oppure `["default"]`, `{default: null}` e `{default: {}}`, senza alias, IP espliciti, priority, MAC, link-local IP o altri campi. Rifiutare array/mapping anomali o riferimenti external.
3. Non riportare config, network URL o token nei messaggi d'errore. Test Node su rappresentazioni accettate, override malformed, rinomina/external/driver/IPAM e rete supplementare per tutti i servizi. Conservare la prova sul Compose reale Docker in GitHub Actions con registry override.

## Limiti

Il nome `<project>_default` è una convenzione e non un'attestazione della rete effettivamente istanziata, dei container ad essa collegati o della sua proprietà. Un amministratore del daemon può mutare reti o container dopo la validazione. Non c'è ancora il collaudo su VM Docker rootless/Cloudflare Tunnel/Access reali, né fencing cross-host e attestazione off-host: l'epica #2 rimane aperta.
