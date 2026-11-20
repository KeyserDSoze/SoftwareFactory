# ADR 0083 — Impegno Ed25519 dell'operatore dopo la scelta UUID di deposito Code Reviewer

**Data:** 2026-11-20  
**Issue:** #129 (segue #128 e #113)  
**Stato:** accepted come integrità dell'intenzione offline, non come provider attestation.

## Motivazione

La receipt `softwarefactory.ai-review.observed.v1` dell'osservazione HTTP viene firmata prima che l'operatore abbia scelto `leaseId` e `submissionId`. #128 richiede quindi UUID attesi come input indipendente per la verifica dei payload staged. Senza un attestato successivo alla scelta, un verificatore non può distinguere un UUID legittimamente nuovo da una sostituzione in un file staged non autenticato. La firma della receipt non è la soluzione: deve restare compatibile con gli input del request digest originale e non affermare che la lease fosse attiva.

## Decisione

Una nuova receipt **di intenzione di deposito**, domain-separated `softwarefactory.ai-review.stage-intent.v1`, viene firmata Ed25519 *dopo* l'avvenuta selezione di lease e submission e **dopo** aver verificato la receipt originaria con la sua chiave trusted. Contiene solo versione, contesto, assurance `operator_signed_stage_intent_unverified`, handoff/task/generation/leaseId/submissionId/source fingerprint+digest, SHA del workspace canonico, SHA della receipt canonica e SHA dello stage canonico. Non include file sorgenti, chiavi, API responses, prompt o token.

Le modalità offline `sign-stage-intent` (private signing key off-host, write-once `O_EXCL|O_NOFOLLOW` modo 0600, `fsync`), `verify-stage-intent` (receipt trust key e stage-intent trust key **pinned indipendentemente**) e `verify-stored-intent` (inoltre il readback GET della review custodita secondo il controllo #128) non contattano la rete né invocano mutation nel runner. La verifica confronta **esattamente** lo statement ricalcolato prima di verificare la firma e rifiuta campo aggiunto, receipt/spazio sorgenti mutati, role/tenant/owner o digest non coincidenti. La chiave dell'intento può essere distinta dalla chiave usata per osservare l'HTTPS; la firma NON equivale a un reviewer approver actor-scoped.

## Limitazioni

Una firma dell'operatore protegge solo da alterazioni non autorizzate successivamente alla firma. Non attesta che l'operatore sia affidabile, che la lease esista e sia corrente, che il server abbia davvero conservato i documenti, che il modello abbia realmente eseguito i test o che il provider abbia dichiarato consumi fatturabili certificati. La review richiede comunque `review_submit` e `review_approve` manuali e indipendenti, dietro controllo actor/tenant/fencing della API. #113/#109/#105 rimangono aperte.
