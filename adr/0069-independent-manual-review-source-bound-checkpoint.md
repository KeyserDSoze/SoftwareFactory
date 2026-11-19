# ADR 0069 — Revisione manuale source-bound e approvatore indipendente

**Data:** 2026-11-19  
**Issue:** #115, tranche di #113/#109/#105  
**Stato:** Accepted per checkpoint supervisionato, non per attestation AI

## Contesto

Il digest dei file #114 prova soltanto cosa è stato inviato al runner con un job verificato, non cosa è stato letto o compreso da un Code Reviewer. Un semplice `passed` del worker o SHA comunicato da un modello non può essere un verdetto indipendente di review.

## Decisione

Un `code_reviewer` titolare di lease fenced pubblica solo digest SHA-256 del proprio documento esterno, UUID idempotente e fingerprint dei file testati (validato dal server). Un `review_approver` con credenziali indipendenti, revocabili, tenant-bound e un ID diverso dall'owner deve ispezionare fuori banda codice e documento e attestare esplicitamente `manual_inspection`. La API non scarica né esegue codice e non legge il documento: la firma è **logica e manuale**, non crittografica.

Gli eventi `review_submit` e `review_approve` hanno schema chiuso, actor, generation, leaseId, timestamps e SHA-chain append-on-update sotto lock POSIX; proof di ogni `test_verified` riletta a ogni GET/claim/sottomissione. Solo la seconda fase sblocca i successori come `human_approved_review`; il submit `review_submitted` non li sblocca. Replay esatto idempotente, old lease, fonte stale o tamper fail closed. Nessun segreto o codice è nel manifest.

## Limiti

Un attore con bearer può **dichiarare** l'ispezione: il sistema non dimostra che il documento sia stato letto, né un'esecuzione LLM, né firma off-host o consumi provider. `executions` resta zero e `approvedReportedUnits` non cresce. #113 resta aperta per prove d'artefatto review verificabili/indipendenti; #109/#105 per costi AI verificati, e #2/#87 per rootless VM reale.
