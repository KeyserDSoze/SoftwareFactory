# ADR 0030 — Preflight Compose per i profili di autenticazione del runner

- Data: 2026-11-16
- Stato: accettato come policy statica per deployment sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/73
- Precedenti: ADR 0022, 0025, 0028, 0029

## Contesto

I profili già implementati `RUNNER_API_KEY_FILE` (#51) e `RUNNER_TENANTS_FILE` (#52) possiedono override Compose API-only distinti, ma il preflight accettava soltanto il registro operatori. La combinazione legittima non poteva essere certificata dal gate prima del deployment. Saltare manualmente il preflight avrebbe indebolito i controlli su socket, immagine, rete e credenziali.

## Decisione

1. Consentire su `preflight compose` i flag mutuamente esclusivi `--runner-key-file` e `--tenants` e l'opzionale `--operator-registry` per le sole modalità globali. La CLI inserisce soltanto i file Compose revisionati e rifiuta combinazioni/repetizioni non ammesse prima di eseguire Docker.
2. L'API deve avere **una** credenziale primaria: `RUNNER_API_KEY` globale inline non vuota, oppure `RUNNER_API_KEY_FILE` con `RUNNER_API_KEY=""`, oppure `RUNNER_TENANTS_FILE` con entrambe le variabili di chiave globale vuote. Il registro operatori con file è consentito solo in modalità globale; la modalità file disabilita gli operatori JSON inline, la modalità tenant disabilita ogni repair operator.
3. I mount di credenziali possono comparire soltanto nell'API, usando directory host canoniche non di sistema, bind read-only e path container esatti: `/run/secrets/runner-api/runner-key`, `/run/secrets/runner-tenants/tenants.json` e `/run/secrets/runner-operators/operators.json`. Le directory sono disgiunte fra loro, dalla data dir e dal workspace montato nel worker, così il path parent non consente esposizione accidentale dei secret. Montaggi extra o non coerenti all'env falliscono chiusi senza secret leak.
4. Aggiungere test Node per tutti i profili e gli override ostili, e CI con `docker compose config` reale per base, key-file, tenant, operator e key-file+operator.

## Limiti

Il JSON Compose non dimostra ownership dei file reali né il daemon Docker rootless, Cloudflare Tunnel/Access, fencing e attestazione off-host. `preflight host` mantiene una propria policy attuale orientata alla chiave inline: l'estensione host per file/tenant è lavoro futuro distinto e non si deve attribuire questa verifica allo static preflight. L'epica #2 resta aperta.
