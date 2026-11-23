# ADR 0138 — Bozza non confermata CAS: esportazione di emergenza senza ACK (#194/#139)

## Problema
L'editor IndexedDB isolato conserva bozza testuale e uno snapshot pinned se `tx.oncomplete` non conferma la scrittura. Dopo conflitti, `QuotaExceededError`, `VersionError` o sessione bloccata l'utente può ancora vedere i dati in React, ma i normali backup JSON esportano solo lo snapshot persistito, non il testo mai committato. Refresh/close con consenso possono perdere il lavoro in memoria.

## Decisione
Solo nell'editor CAS opt-in, quando una revisione è selezionata e esiste una bozza non salvata, esporre il pulsante di recupero emergenziale ANCHE se `active.current` è nullo/`blocked`. Il builder **sincrono e puro** prende il RAW byte-esatto della revisione PINNED e i soli campi UI: nome, descrizione, requisiti, stack, selezione fase manuale, output manuale, richiesta Code Agent e JSON di proposta. Validare canonicalità, ID/revisione, bounds dei form, valori stack e massimo 6 MB UTF-8 del file JSON; rifiutare nessuna bozza o input corrotto. Nessun setting/token o uso localStorage/sessionStorage/IndexedDB/fetch.

Il formato dedicato `softwarefactory-cas-uncommitted-draft` v1 contiene `base.id/revision/raw`, `draft`, e marcatori `uncommitted:true`, `authoritative:false`, `automaticRestore:false`. Non è un `FactoryProject`, non può essere letto dal parser JSON di restore #148 o ZIP #189 e non ripropone in automatico gli output AI, Code Agent o runner. È solo una copia in CHIARO da riconciliare manualmente; la revisione potrebbe essere già superata da un'altra scheda. Consenso esplicito PRIMA di `URL.createObjectURL` e link download, nessuna mutazione dopo il download, nessun "saved" attestato (il browser non prova la persistenza del file). UI IT/EN avvisa contenuti sensibili.

## Test
Vitest: RAW e bozza Unicode esatti, stack/manual/Code Agent, ticket stale, invalidità e budget, nessun accesso storage/network, nessun setting serializzato. Chromium in Factory CI: dopo race 2 schede che blocca la scrittura nativa, rifiuto del consenso senza download, consenso e file completo, rival IDB invariato, draft ancora visibile. Marker `FACTORY_CAS_UNCOMMITTED_DRAFT_E2E_PASS`. Gate CI/Pages/Installer sullo stesso SHA prima di chiudere #194.

## Fuori ambito
Non risolve il cutover di tutti i writer React/Code Agent/GitHub/cloud dalla localStorage live (#139), non riapre transazioni bloccate, non rende riutilizzabili evidenze remote, non è automatico, non valida provider reali (#92/#91). Conservare sempre gli archivi offline e far correggere i conflitti esplicitamente dall'operatore.
