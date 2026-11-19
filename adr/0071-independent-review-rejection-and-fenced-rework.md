# ADR 0071 — Rifiuto indipendente del Reviewer e nuova generazione di rework

**Data:** 2026-11-19  
**Issue:** #118 (sottoissue #113)  
**Stato:** accepted per decisione manuale locale; non attestazione dell'esecuzione AI.

## Problema

Con #116 un documento Reviewer `changes_requested` può essere custodito e presentato, ma l'approvatore può soltanto rifiutare una richiesta `approve`. Il sistema non registra chi ha chiesto formalmente correzioni, quando e per quale rapporto; la gestione del rework dipende da comunicazioni fuori banda. Bisogna rendere auditabile la decisione senza trasformarla in un test superato.

## Decisione

Aggiungere `action:reject` a `POST /v1/agent-task-reviews`, autorizzata solo a `review_approver` distinto dall'owner e nella stessa tenant. Schema chiuso con submissionId, artifactDigest e sourceFingerprint del report già presentato, e `decision:changes_requested`. Il rapporto staged deve avere la stessa raccomandazione negativa. La API rivalida journal e file input originali #114, documento #116, lease/generation e actor file sotto admission lock. Manifest SHA-chain riceve `review_reject`, con replay esatto idempotente, non la stringa di un presunto verdetto automatico.

`review_reject` chiude la lease del reviewer senza completarne la task; `review_changes_requested` non sblocca i successori. Resta il record `reviewRejection` e il conteggio anche dopo un nuovo `claim` valido. Il Reviewer deve ottenere una **nuova generazione** se `maxAttempts` lo consente, depositare un **nuovo** documento e richiedere un'altra approvazione. I report rifiutati storici rimangono verificati a ogni lettura come audit: cancellazione o tamper sono fail-closed. I vecchi checkpoint legacy digest-only non possono generare il nuovo evento.

## Limiti

La firma è una decisione manuale locale da actor bearer, non prova osservabile che l'approvatore abbia letto i sorgenti o che un AI Reviewer sia stato eseguito. Nessuna nuova esecuzione o costo provider viene registrato; le issue #113/#109/#105 e la prova esterna rimangono aperte. Il volume locale è un dominio di fiducia condiviso, non un sistema di attestazione off-host.
