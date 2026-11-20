# ADR 0076 — Firma Ed25519 off-host di un rapporto Reviewer e dei sorgenti testati

**Data:** 2026-11-20  
**Issue:** #122, milestone della #113  
**Stato:** accepted per *integrità del pacchetto firmato*, non come attestazione di una review AI.

## Problema

La #116 preserva un rapporto Reviewer legato a una generation e alla fingerprint del Tester, mentre la #119 espone gli stessi file testati all'approvatore indipendente. Ma entrambi gli artefatti vivono nel contesto del runner e non esiste un trust anchor **indipendente dal server** che riconosca modifiche successive al materiale visto dall'operatore. Una firma del solo digest del rapporto è insufficiente: va incluso il contenuto sorgente che ha informato il rapporto, non una stringa SHA fornita dal client.

## Decisione

Estendere la GET actor-only \`/v1/agent-review-artifacts/:submissionId\` con \`tenantId,owner,generation\` del record custodito già verificato, senza ampliarne gli ACL. Si potrà così ricalcolare **offline** il digest del record con \`makeReviewArtifactRecord\`.

Aggiungere \`src/runner/review-attest.mjs\` standalone: accetta un bundle \`{version:1,artifact:<GET #116>,sources:<GET #119>}\`. Prima di firmare/verificare, controlla schema rigoroso, IDs/submission/tenant/owner/generation, \`artifactMode\`, digest del documento custodia ricalcolato, canonicalizzazione del file set, conteggi byte e numero, digest file-only \`runner-input-files-v1\`, e la stessa fingerprint sorgenti in entrambe le viste. Una statement domain-separated \`softwarefactory.review.inspection.v1\` contiene campo recommendation (che può essere \`changes_requested\`) e SHA256 di **tutto** il bundle canonicalizzato, non il testo in chiaro. La firma Ed25519 deriva da una **chiave privata mantenuta off-host** e la verifica richiede public key pinned indipendentemente. Usare la libreria di lettura sicura di \`attest.mjs\`: FD \`O_NOFOLLOW\`, size/UID/mode/nlink stabilizzati, output write-once 0600, nessun output di file sorgenti, key, prompt o response provider.

Nessuna route server riceve/accetta automaticamente la receipt: \`review_approve\` esistente continua a richiedere approvatore actor-only indipendente e validazione della custodia e delle prove Tester. Non avviare LLM, non registrare \`executions>0\` e non produrre cost accounting.

## Perimetro e limiti

Il pacchetto esportato contiene file sorgenti potenzialmente proprietari, che devono essere custoditi off-host con controllo di accesso e poi eliminati secondo retention. L'host esterno non ha modo di verificare, tramite il pacchetto soltanto, che il runner abbia detto la verità prima della firma; l'operatore deve verificare fonte TLS/tenant e le prove esterne del Tester. La firma **non prova comprensione umana, execution AI o provider billing** e non autentica un'identità legale senza un trust anchor esterno. Mancano non-repudiation a livello workflow, receipt remota con scadenza/revoca, riconciliazione con provider e policy di ancoraggio; restano #113/#109/#105.
