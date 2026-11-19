# ADR 0070 — Custodia privata write-once del rapporto Code Reviewer

**Data:** 2026-11-19  
**Issue:** #116 (parte di #113)  
**Stato:** accepted per integrità locale, non per esecuzione AI attestata.

## Contesto

#115 fornisce approvazione manuale indipendente, ma il digest del rapporto proveniva dal produttore, senza rapporto conservato. #114 verifica invece l'input sorgente del test. Serve conservare realmente il report per permettere verifica del suo contenuto prima dell'approvazione.

## Decisione

La API accetta da Code Reviewer con lease fenced un rapporto strutturato v1, summary/recommendation/findings, con dimensioni e campi bounded e senza sorgente o segreti. Un digest SHA-256 domain-separated deriva dal rapporto e da handoff/task/tenant/owner/generation/sourceFingerprint verificato sul runner. Il documento viene creato una sola volta con O_EXCL, O_NOFOLLOW, 0600 e fsync in una cartella privata, fuori dal manifest. Il server non si fida di digest auto-dichiarati, verifica bytes, UID, link count, mode, mtime/ctime e inode prima dell'uso. Cap globale e una sola creazione per fencing generation; retry identici non mutano.

Per le nuove submission, review_submit richiede documento staged e associa artifactMode stored_review_document_v1. Il successivo review_approve ripete il controllo e il sistema riverifica anche ad ogni GET/claim. L'approvatore indipendente può recuperare il rapporto solo dopo submit tramite actor scoped same-tenant, non via root o chiave tenant. Gli eventi storici privi di artifactMode conservano la sola assurance legacy_external_digest: rimangono leggibili e non vengono promossi a file realmente custoditi.

## Limiti

Controlliamo la provenienza del digest e l'integrità locale, non dimostriamo che un umano abbia letto il rapporto né che un LLM abbia davvero effettuato la review. Il testo è untrusted, non va visualizzato come HTML e la protezione da segreti è best-effort. L'host può reforge hash locali. Gli orfani crash non sono eliminati automaticamente; recovery richiede fermare i servizi e intervento operatore. Attestazione off-host, vero billing provider e agente autonomo restano #113/#109/#105.


**Fail-closed sulla raccomandazione:** per i rapporti conservati, una decisione changes_requested non può produrre l'evento di approvazione. Il controllo è ripetuto all'atto del commit e su manifest già approvati, impedendo che un artefatto con finding pendenti autorizzi downstream. Non si riscrive la decisione: occorre un nuovo ticket di review dopo correzione.
