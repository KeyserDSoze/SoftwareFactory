# ADR 0136 — GitHub autosync: pin RAW/repository dopo await e ACK fail-closed (#188/#92/#139)

## Contesto
L'autosync legacy verificava il progetto prima del token e del push, ma dopo `publishGithubWorkspace` controllava soltanto che `projectRef.current.id` fosse invariato. Lo stesso progetto può cambiare contenuto (persino con `updatedAt` invariato), ramo/repository, auth mode o opt-in durante una richiesta asincrona. L'ACK poteva essere attribuito a codice o destinazione non corrispondenti a quelli pubblicati.

## Decisione
`prepareGithubAutosyncPin(snapshot,git)` congela il RAW JSON byte-esatto e tutti gli attributi NON segreti della destinazione: owner, repo, branch, authMode, appGateway, privateRepo. Nessun PAT, API key o token nel ticket. `assertGithubAutosyncPin` pretende uguaglianza esatta di ID, JSON in memoria e nello slot per-ID, updatedAt, GitConfig, opt-in, writer lease e assenza di retirement/busy. `LegacyFactoryApp` lo chiama PRIMA del token, DOPO il token ma PRIMA del push e DOPO il push, PRIMA dell'ACK. La preparazione dell'ACK ripete il controllo e valida SHA commit, owner/repo/branch e consenso pubblico dell'operazione.

Se un cambiamento avviene prima del push, blocca l'operazione e non pubblica. Se avviene durante/dopo il push, il commit remoto può già esistere: nessun ACK locale, outbox `blocked`, nessun retry automatico; l'operatore verifica la HEAD tramite recupero manuale. Neanche una modifica locale con lo stesso updatedAt eredita l'ACK vecchio. La risposta GitHub non è attestazione di review, runner o esecuzione di test.

## Limiti
Non è una transazione GitHub↔IndexedDB o CAS cross-device. Web Locks riguardano solo writer cooperativi dello stesso browser/origin. I vecchi client possono modificare localStorage dopo l'ultimo get; il writer locale mantiene il fence #186. No collaudo live PAT/OAuth/Drive/provider, e nessun altro writer del legacy è stato portato su IndexedDB async. #92/#139 restano aperte.

## Verifiche
Vitest: RAW modificato anche con timestamp identico, destinazione/permesso, writer lock, retirement, forged ACK/SHA/consenso, token/push await race e percorso senza conflitto. Chromium reale 2 tab con gli stessi slot localStorage, mutazioni durante attesa e gate di ACK, nessun file segreto o richiesta GitHub reale. Factory CI/Pages/Installer candidate completed/success sullo stesso SHA prima della chiusura. Release skipped non equivale a nuova pubblicazione.
