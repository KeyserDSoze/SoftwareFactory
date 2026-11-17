# ADR 0051 — Riconciliazione GitHub del commit con acknowledgement perso

Data: 17 novembre 2026 · Stato: **implementato; regressione Chromium browser aggiunta**. Tracciamento [#91](https://github.com/KeyserDSoze/SoftwareFactory/issues/91) e [#92](https://github.com/KeyserDSoze/SoftwareFactory/issues/92). Complementa [ADR 0048](0048-github-pat-project-sync-bookwriter-parity.md) e [ADR 0049](0049-local-project-exclusive-writer-web-locks.md).

## Motivazione

Un push Git Data API con `force:false` può avere aggiornato la branch remota, ma il browser può perdere l'HTTP di conferma, vedere un timeout dopo il `PATCH` o essere chiuso prima del salvataggio dell'ack locale. Il client vede `lastCommit` obsoleto e blocca il successivo push: questo evita il force push ma obbliga a importare il checkpoint, eventualmente sostituendo contenuti locali. Un semplice confronto dello SHA o del checkpoint JSON **non basta**: chiunque possa modificare il repository potrebbe avere cambiato i sorgenti lasciando un vecchio checkpoint.

## Decisione

Implementare un'azione esplicita **«Recupera conferma commit»**, separata da Pubblica, Importa e autosync. Non crea mai repository né invia POST/PATCH, non esporta segreti e non modifica il progetto in remoto.

1. Il browser possiede il Web Lock esclusivo dello **stesso ID progetto**, verificato anche nell'ack finale. Alla conferma utente, legge la HEAD corrente e il checkpoint SoftwareFactory ancorato esattamente a quella SHA con GitHub REST GET.
2. Richiede identità UUID e **contenuto portable completo** del progetto locale e remoto, inclusi brief, config, stage output e patch. Non considera valide vecchie evidence runner o review device-bound: la serializzazione portable le esclude su entrambi i lati.
3. Per progetti già associati alla stessa owner/repo/branch, richiede che il commit remoto corrente abbia **un solo genitore ed esattamente la precedente `lastCommit` locale**. Se un altro device ha avanzato la branch più volte, nessuna riconciliazione automatica: usare confronto e importazione manuale.
4. Per primo push il genitore non è attestato: si può solo confermare che la HEAD corrente **contiene esattamente i file di questo workspace**, non che il commit sia stato scritto dall'utente o dalla Factory. La UI segnala esplicitamente questa limitazione, non attribuisce autori.
5. Recupera commit e albero Git con `GET /git/commits/{sha}` e `GET /git/trees/{tree}?recursive=1`. Rifiuta SHA, genitori, tree, tipo/mode o JSON invalidi, alberi troncati, file mancanti, duplicati e oltre i limiti configurati. Per **ogni** path di `workspaceFiles(project)` **e** `.softwarefactory/workspace-state.v1.json`, calcola localmente l'object ID Git `SHA-1("blob " + UTF8.length + "\\0" + UTF8.bytes)` e confronta con lo SHA Git del blob remoto. SHA-1 è il formato degli object ID Git tradizionali, **non** una firma/autenticazione dell'autore; l'origine REST e HTTPS restano la base del modello di fiducia. Eventuali file extra non sono attestati: la conferma riguarda solo i file che la Factory avrebbe scritto.
6. Rilegge la HEAD con GET **dopo** la prova dei blob e **una seconda volta dopo la conferma nel popup**, perché il popup potrebbe restare aperto mentre un altro device avanza il ref. Se il progetto/settings cambia durante la verifica o la conferma, non salva ack. È un controllo puntuale, non una CAS globale; il lock della scheda è complementare alla baseline localStorage.
7. Mostra in UI repository, branch, HEAD, parent, numero di file verificati e warning se la repo è pubblica, **poi chiede una seconda conferma**. Aggiorna solo `githubSync` e `githubDestination` nello stesso progetto, lascia intatti contenuti e `updatedAt`, disabilita autosync e pulisce metadata outbox. **Il consenso pubblico ai futuri push non viene creato**; può essere mantenuto soltanto se la destinazione prima autorizzata è esattamente la stessa.
8. Non usa questo percorso nell'autosync; il push normale continua a fallire in caso di branch remoto avanzato, nessun force push.

## Verifica e limiti

`github-ack-recovery.test.ts` copre caso già associato e primo push, parent diverso, checkpoint di un altro progetto, stage/patch mismatch, blob alterato, albero troncato, assenza checkpoint, HEAD cambiata dopo verifica, consenso pubblico limitato alla destinazione, zero metodi write, vector standard Git blob ID. La Factory CI esegue typecheck, Vitest, build, generated Playwright e fullstack .NET/OIDC/PostgreSQL.

Senza PAT/cliente con permessi Contents read e accesso a GitHub REST non è possibile verificare; il recupero fallisce chiuso. Le API possono cambiare fra lettura HEAD finale e ack locale: la conferma è una *osservazione puntuale*, non un lease globale multi-device; il successivo push deve sempre ripetere il controllo HEAD. Non recupera commit se c'è qualsiasi differenza in locale, un interleaving di più commit, branch cambiata o tree senza tutta la snapshot. Restano aperti test PAT/browser/provider reali e firma supply-chain.

## Verifica end-to-end della UI di recupero (17 novembre 2026)

La Factory include anche una prova Chromium reale nel container Docker isolato della CI (script `src/runner/scripts/factory-browser-lock-smoke.mjs`). Il test prepara un progetto locale valido, genera i blob Git effettivi tramite `src/runner/scripts/github-ack-browser-fixture.ts` usando `workspaceFiles` e `encodeGithubWorkspace` del generatore (non dati inventati manualmente) e simula via Playwright **soltanto le risposte REST GitHub**; nessuna credenziale live. Dimostra che rifiutare il consenso iniziale non legge la repo; alterare il blob di un sorgente lascia l'ack locale vuoto; correggere il tree permette il recupero solo dopo **due conferme**, HEAD riletta dopo conferma, autosync spento e stesso snapshot dopo reload. Nessuna chiamata POST/PATCH al remoto, il test fallisce se ne intercetta una.

Non equiparare questa prova mock REST a un collaudo PAT/GitHub reale o a una transazione cross-device; i rischi documentati sopra restano aperti. Esito CI da verificare sul commit che introduce lo scenario.
