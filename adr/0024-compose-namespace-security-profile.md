# ADR 0024 — Escludere namespace condivisi e profili Docker contraddittori nel preflight

- Data: 2026-11-16
- Stato: accettato per deployment sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/67
- Precedente: ADR 0022, #65

## Contesto

Un Compose con soltanto servizi previsti dalla allowlist poteva indebolire l'isolamento tramite override dei namespace; il preflight rifiutava solo il valore `host` per `network_mode`, `pid` e `ipc`, non valori `service:...` / `container:...` né `uts`, `userns_mode` o `cgroup`. I controlli di `security_opt` e `cap_drop` cercavano un elemento presente, ignorando opzioni aggiuntive di disattivazione (es. `seccomp=unconfined`).

## Decisione

1. Rifiutare ogni override esplicito di `network_mode`, `pid`, `ipc`, `uts`, `userns_mode`, `cgroup`, `cgroupns_mode` e `isolation` per tutti i servizi consentiti dal Compose. La rete viene gestita dal default Compose approvato, non da override nascosti.
2. Richiedere `security_opt: ["no-new-privileges:true"]` e `cap_drop: ["ALL"]` con **cardinalità uno e stringa esatta**, senza aggiunte, duplicati o tipi diversi. Non consentire altri valori di `privileged` oltre ad assenza/booleano false.
3. Negare gruppi supplementari, `cap_add`, device rules/requests, GPU, sysctl arbitrari e ulteriori porte esposte, oltre ai mount impliciti già vietati dalla #65. I rifiuti sono statici, senza includere dettagli del Compose/credenziali.
4. Coprire tutti i servizi, anche il tunnel, con test deterministici su namespace `service:`/`container:`, host, security_opt multipli e override non previsti; conservare la compatibilità con lo stack approvato, tunnel opzionale e registry override.

## Trade-off

La policy è conservativa: anche un namespace personalizzato teoricamente sicuro richiede una review esplicita e modifica documentata. Un JSON Compose passato non equivale a certificare che Docker stia eseguendo rootless, che non sia stato alterato fra preflight e startup o che il tunnel sia protetto da Cloudflare Access. La #2 resta aperta per verifica reale VM, IAM/fencing, attestazione off-host e audit operativo.
