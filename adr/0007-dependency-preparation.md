# ADR 0007 — Dipendenze controllate e Docker smoke reale

- **Data:** 2026-11-14
- **Stato:** accettato per runner sperimentale
- **Issue:** https://github.com/KeyserDSoze/SoftwareFactory/issues/4
- **Complementare a:** ADR 0005 (runner remoto), ADR 0006 (digest/report/repair)

## Contesto

La prima implementazione del runner eseguiva `npm install --offline` nel container che avrebbe dovuto compilarne il codice. Questo spesso produce fallimenti di setup, non di codice, quando la cache npm è vuota. Inoltre la suite CI simulava i container e non verificava la corretta sintassi di `docker run` e i volumi. Un test Docker reale ha infatti scoperto un parametro `--mount` sbagliato.

## Decisione

- Dividere la fase `npm-prepare` dagli step di test. La fase di preparazione usa un container Node privo di privilegi con rootfs read-only, mount di workspace, `npm install --ignore-scripts` e zero rete di default. `RUNNER_ALLOW_NET_DEPS=true` è un opt-in **solo dell'amministratore**, mai della richiesta browser.
- Gli script di build e test sono eseguiti esclusivamente in container separati con `--network none`. La preparazione e i test condividono soltanto il filesystem effimero del job.
- Permettere per ora dipendenze npm soltanto con nomi registry e range semver; vietare specifier URL/git/file, workspaces/override e download di lifecycle scripts. Il lockfile è ignorato **deliberatamente nell'MVP**: il fetch non è riproducibile e richiede un sistema di cache/proxy con lockfile controllati per la produzione.
- Registrare nel report la fase `preparation` separatamente. Un suo fallimento provoca uno step `skipped` e stato complessivo `incomplete`, non `failed`; l'AI non deve correggere codice a causa di un errore ambientale.
- Aggiungere un docker smoke integrato nella CI che esegua davvero `docker run`, con step positivo, negativo e blocco di dipendenze offline. Il socket rootful è permesso **solo nella VM CI effimera controllata**; non in softwarefactory-runner-api né nei job del prodotto.

## Limiti

- Un `npm install` online senza egress allowlist e registri privati approvati può ancora interagire con servizi non controllati; richiede VM sacrificabile.
- I packages installati sono risolti da range semver senza lockfile e non sono immuni a supply-chain attacks. Per produzione serve proxy con lockfile e pacchetti attestati/pinnati.
- L'installazione con `--ignore-scripts` può impedire l'uso di alcuni moduli native compilati tramite postinstall: questo è un setup `incomplete`, non va risolto eseguendo script arbitrari nel container con rete.
- Playwright con browser reali e API .NET in Docker rootless su VM dedicata non fanno parte del smoke Node corrente; restano nell'issue #2.
