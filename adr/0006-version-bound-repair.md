# ADR 0006 — Identità dei risultati dei test e repair AI con limiti

- **Data:** 2026-11-14
- **Stato:** accettato per MVP supervisionato
- **Issue:** https://github.com/KeyserDSoze/SoftwareFactory/issues/3
- **Dipende da:** ADR 0004 (Code Agent), ADR 0005 (Remote Runner)

## Contesto

Un runner remoto può restituire un report di test precedenti mentre l'utente cambia brief, frontend, codice o patch. Accettare il primo `passed` visibile sarebbe un bug di integrità. Inoltre i log del runner sono input non fidati per un LLM e non devono provocare cicli di riparazione infiniti o modifiche a nuovi file.

## Decisione

- La request canonica (schemaVersion, label, map di file ordinate per path, steps) viene serializzata come JSON UTF-8. Client browser e server calcolano SHA-256 identico; receipt e report devono combaciare.
- Il binding locale conserva ID, digest, URL endpoint, lista step, proposta ID, revisione, label e timestamp, mai API key. Il report `passed` viene accettato soltanto con tutti gli step richiesti presenti, corretti, realmente eseguiti, exitCode zero, no timeout e ricostruzione dello stesso digest dai sorgenti attuali.
- Un report passato relativo a codice cambiato è visualizzato **stale**, non positivo; i report senza vecchio binding verificabile sono stale.
- Su un report `failed` verificabile e riferito a una patch pendente, l'utente può avviare un repair con prompt specializzato, log troncati e vincolati come dati non fidati. L'AI può restituire soltanto gli stessi file della patch, in forma completa; la validazione della proposta è ripetuta.
- La patch corretta ha un nuovo ID, **perde la review e l'evidenza dei test** e incrementa `repairCount`. Massimo due tentativi; nessun push automatico. Nuova review obbligatoria.
- Per approvare patch riparate il browser interroga nuovamente il runner e ricalcola digest e stato. Richiede `dotnet-build` se tocca C# e `web-build` se tocca React. Il consenso umano resta necessario.

## Limiti e tradeoff

- Il binding è un *content hash*, non una attestazione firmata di un server affidabile: API, database o daemon compromessi possono falsificare risultati.
- Il job resta HTTP polling, il loop AI avviene nel browser, non è un servizio autonomo 24/7.
- I runner condivisi con tanti utenti restano non sicuri finché non si introducono sandbox di livello VM/utenza e quote/audit.
- Due tentativi massimi impediscono runaway cost e di cambiare scope senza review, ma possono richiedere l'apertura di una nuova feature per bug complessi.
- Build offline senza dipendenze preinstallate possono fallire per problemi infrastrutturali: quei log non devono essere interpretati acriticamente come bug del codice.

## Alternative rifiutate

- Marcare la patch come testata dalla review statica: non costituisce prova di esecuzione.
- Applicare automaticamente una patch dopo il primo report `passed`: manca un gate umano e può essere un esito vecchio.
- Consentire al repair di cambiare qualsiasi file o bypassare test falliti: incompatibile con file ownership e safety.
