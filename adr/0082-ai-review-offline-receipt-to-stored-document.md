# ADR 0082 — Bridge offline tra ricevuta operatore AI Reviewer e custodia del documento

**Data:** 2026-11-20  
**Issue:** #128 (sottoissue #113)  
**Stato:** accepted come controllo di coerenza offline; non provider-attested.

## Contesto

La CLI off-host #123 firma con Ed25519 la propria osservazione HTTP contenente il documento `ReviewDocument`; il backend #116 conserva write-once un rapporto staged nella lease actor-scoped e lo espone, solo dopo `review_submit`, per l'ispezione indipendente #119. La trascrizione manuale del documento dalla receipt nella richiesta `POST /v1/agent-review-artifacts` non è coperta da una verifica meccanica e la successiva GET non viene confrontata con la receipt originaria.

## Decisione

Introdurre tre modalità puramente **offline** della CLI `ai-review-execute.mjs`:

1. `prepare-stage` verifica l'intera receipt contro la snapshot originale e il public key Ed25519 **pinned off-host**, richiede `leaseId` e `submissionId` UUID v4 scelti dall'operatore e produce il body esatto accettato da `validateReviewArtifactStage`, con documento firmato. Output bounded massimo 8192 byte, `O_EXCL|O_NOFOLLOW` 0600, `fsync`. Non esegue HTTP né accede ai segreti provider.
2. `verify-stage` verifica nuovamente la receipt e la corrispondenza esatta del payload staged (nessun campo extra o report sostituito).
3. `verify-stored` riceve una copia della **GET actor-only** `/v1/agent-review-artifacts/:submissionId`, la richiesta staged e i file precedenti, più `expected-owner` e `expected-tenant` espliciti (`-` per tenant null). Ricontrolla snapshot/generation/UUID, documento identico alla receipt, mode, owner/tenant e il digest `stored_review_document_v1` ricalcolato via `makeReviewArtifactRecord`.

La CLI non chiama `review_submit` o `review_approve`, non crea lease, non invia richieste verso provider/runner e non sostituisce i controlli originali sotto lock POSIX con reauthorization actor. I payload non sono salvati nella provenance pubblica e il token dell'actor non viene trattato dall'utility. Le receipt e i digest v1 storici non cambiano.

## Limiti

La firma Ed25519 è dell'operatore, non del provider: può confermare solo la propria dichiarazione, non vera esecuzione AI o costi. Un server compromesso può ricostruire il proprio hash e fingere una GET consistente; per integrità off-host indipendente occorre ancorare realmente il report a un testimone/firma che il server non controlli. `verify-stored` non è una decisione umana indipendente e non sblocca automaticamente successori. Test locali con record simulati verificano il parser/digest, non la presenza del record su una macchina remota. #113/#109/#105 rimangono aperte.


### Amendment dopo la prima CI (#44719842709)

La receipt di osservazione è firmata **prima** del deposito, perciò un `leaseId` o `submissionId` che rispetta soltanto il formato UUID non è legato dalla firma originale. La prima regressione ha rilevato correttamente che `verify-stage` non poteva distinguere un UUID alternativo dal valore originale quando leggeva solo il body potenzialmente mutato. La soluzione richiede che `verify-stage` e `verify-stored` ricevano **gli UUID originariamente scelti da una fonte indipendente** (`--lease-id`, `--submission-id`) e li confrontino con quelli nel file. Non si dichiara che la chiave Ed25519 attesti la lease o renda un ID verificabile senza questa input separata. Il controllo lato API continua a verificare la lease viva con fencing e reauthorization sotto lock; i test includono la sostituzione di entrambi gli UUID.
