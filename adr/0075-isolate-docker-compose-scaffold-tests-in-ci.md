# ADR 0075 — Isolare il probe Docker Compose dal pool parallelo Vitest in CI

**Data:** 2026-11-20  
**Issue:** #117  
**Stato:** accepted come mitigazione test orchestration, non prova della causa originale.

## Contesto

Il 19 novembre 2026 `scaffold.test.ts` è fallito sulla GitHub Actions Factory CI al probe di `docker compose version` con status 255 e stderr non informativo. Il rerun sul medesimo SHA è passato senza modifiche, dimostrando intermittenza. La diagnostica è stata migliorata su #117, ma il probe viene ancora avviato da uno dei worker che Vitest lancia in parallelo con tutti gli altri test frontend. Un test che spawna la Docker CLI in un processo non necessita di tale concorrenza.

## Decisione

Mantenere il contratto locale `npm run test` (esegue **tutti** i test frontend). La GitHub Factory CI esegue due **step obbligatori** in sequenza nello stesso job:
1. `npm run test:ci-units` = `vitest run --exclude '**/scaffold.test.ts'`: tutte le suite non-scaffold.
2. `npm run test:ci-scaffold` = `vitest run src/application/scaffold.test.ts --maxWorkers=1 --no-file-parallelism`: **tutti** i test scaffold, inclusi `docker compose version` e configurazioni OIDC/Compose effettivamente renderizzate.

Non impostare `continue-on-error`, `--passWithNoTests`, `it.skip` o retry che trasformino fallimenti di Docker in successi; ogni step deve essere `completed/success` per proseguire. Il gate obbligatorio continua ad avere inoltre prove Compose topology e smoke Docker in step separati. Il test mantiene i messaggi diagnostici limitati e non rende stdout del Compose config.

## Tradeoff e limiti

La suite scaffold ora usa un solo worker e aggiunge il tempo di bootstrap di una seconda istanza Vitest. Elimina la concorrenza del pool Vitest che poteva influire sulla disponibilità del comando `docker compose`, ma **non dimostra** che la contesa fosse la causa dell'exit 255. Un problema GitHub-hosted runner o plugin può ancora far fallire lo step; il gate rimane fail-closed e l'evidenza verrà raccolta nella #117. La prova non sostituisce collaudi rootless VM/Cloudflare (#2/#87).
