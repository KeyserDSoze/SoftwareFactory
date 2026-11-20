# ADR 0084 — Contratto opzionale di evidenza di consegna HTTP firmata da una chiave provider

**Data:** 2026-11-20  
**Issue:** #130 (progresso a #113 e #109)  
**Stato:** accepted come verificatore offline di signature e binding, **non** integrazione provider reale.

## Contesto

Le receipt dell'esecuzione opt-in #123 e i commitment di stage #129 sono firmati da chiavi dell'operatore. Questo permette di rilevare manomissioni successive ma non distingue da una falsa risposta inventata dall'operatore, né crea una prova di esecuzione, di modello o di fatturazione. Un futuro provider può offrire una dichiarazione di consegna firmata con la **propria** chiave, che il client può verificare se il public key e il provider identity sono stati validati da un canale diverso dal payload.

## Decisione

Introdurre `src/runner/provider-delivery-attestation.mjs` come **sola verifica offline**. Il documento JSON opzionale v1 contiene `algorithm:Ed25519`, uno statement domain-separated `softwarefactory.ai-review.provider-delivery.v1`, `assurance:provider_key_signed_delivery_claim_not_execution_or_billing`, `providerId`, `providerHost`, `providerEndpointSha256`, `requestedModel`, `requestSha256`, `responseSha256`, `usage`, `issuedAt` UTC ISO canonical, e i campi top-level `signerKeySha256` e `signature`. Il verificatore usa **public key provider pinned fuori banda** + SHA256 SPKI previsto **fuori banda**, oltre a provider ID e hostname attesi. Confronta i campi con una receipt osservata verificata offline rispetto ai file workspace originari e alla chiave pubblica operatore. I due key fingerprint devono essere distinti.

La signature Ed25519 è verificata sulla serializzazione JSON `canonical(statement)`; i documenti con campi extra, valori mismatch, timestamp invalidi, signature malformate o keys errate falliscono chiusi. La CLI non scrive file e apre read-only via `readAttestationFile` (O_NOFOLLOW + fstat) gli input; non richiama provider, runner o GitHub. I test hanno un provider signer **sintetico esclusivamente nei test**; nessun provider private key, sign endpoint o comando `sign-provider` viene distribuito.

## Non garanzie

Il formato NON è uno standard /chat/completions e non è adottato implicitamente da vendor reali. Il verificatore può dimostrare solo che chi controlla la chiave configurata ha firmato i metadati; associarla a un provider commerciale resta responsabilità di un canale fidato esterno. Neppure una firma commerciale prova in senso matematico che sia girato un modello, che il timestamp sia corretto, l'unicità della richiesta, i token effettivamente consumati o una invoice riconciliata. Non integra billing, stage, submit, approve o deploy e non modifica il DAG. Le issue #113/#109/#105 restano aperte fino a trust anchor vendor reale, supporto provider e accounting indipendente.
