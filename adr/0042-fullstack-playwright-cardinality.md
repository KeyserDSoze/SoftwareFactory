# ADR 0042 — Verifica cardinalità dei test Playwright rispetto al fixture generato

- Data: 2026-11-16
- Stato: accettato nella Factory CI
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/85
- Origine: https://github.com/KeyserDSoze/SoftwareFactory/issues/84

## Contesto

Il test fullstack CORS introdotto nella #84 è realmente passato assieme a tutti gli altri test: Playwright ha riportato **18 passed (17.8s)**. L'orchestratore CI `src/runner/scripts/fullstack-smoke.mjs`, tuttavia, conteneva `/17 passed/` e una diagnostica `all 17 assertions`, dando esito CI `failure` al commit `fbe6d28a`. Un semplice update da 17 a 18 renderebbe il problema ricorrente a ogni nuovo test e lascerebbe possibili conteggi e skipped sottovalutati.

## Decisione

1. Leggere il testo del test spec **effettivamente generato e montato** nello stesso job fullstack. Contare le dichiarazioni top-level `test("...")` (non `test.skip`, `test.only` né nested/interne) e richiedere cardinalità 1..80.
2. Separare un validatore puro `verifyFullstackPlaywrightOutcome(spec, outcome)`: rifiuta stato diverso da `passed`, exit code non zero, timeout/non definito, stdout assente, conteggio dei passed diverso dai test dichiarati, riepilogo non ancorato o presenza di failed/skipped/flaky/interrupted. Il match è ancorato al summary completo: `118 passed` non significa `18 passed`.
3. Se il gate fallisce, il wrapper stampa diagnostica già redatta di Playwright e marca la CI rossa. Se passa, continua con verifiche transazionali PostgreSQL, logout OIDC, rollover JWKS/protocollo. Il messaggio finale mostra il conteggio verificato senza hardcoding.
4. Test Node isolati coprono N=1,17,18,19,42,80; file invalidi, status/exit code/timeout, output troncato e test saltati/falliti/flaky. Successivamente factory CI deve eseguire la vera integrazione Chromium.

## Limiti

Il gate verifica la corrispondenza fra dichiarazioni top-level e reporter, non assicura che ogni assertion abbia qualità adeguata. Test generati programmaticamente all'interno di `test.describe` non sono supportati da questa regola e vanno gestiti con un aggiornamento esplicito e testato. Il confronto di cardinalità non rende Playwright resistente a una CI compromessa, né certifica provider OIDC esterno o infrastruttura TLS.
