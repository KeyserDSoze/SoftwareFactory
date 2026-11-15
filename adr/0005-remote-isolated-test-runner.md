# ADR 0005 — Runner remoto isolato con API, Docker rootless e Cloudflare Tunnel

- Stato: **accettato per MVP sperimentale**, non produzione
- Data: 2026-11-14
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/2

## Contesto

La SPA può generare codice ma non può avviare liberamente Docker, .NET SDK completo o più browser Playwright su qualsiasi dispositivo. Un runner remoto permette l'esecuzione reale, mantenendo il control plane nel browser.

## Decisione

Realizzare `src/runner` con due processi/contenitori distinti:

1. `runner-api` riceve snapshot di file attraverso HTTPS (con Cloudflare Tunnel opzionale), verifica Bearer API key con confronto hash a tempo costante, origin CORS allowlist, payload e path.
2. `runner-worker` legge una coda persistente condivisa, prepara un workspace effimero e avvia soltanto test autorizzati con un Docker daemon rootless dedicato. Solo questo worker monta il socket rootless. Nessun socket Docker viene esposto nei job o nella API.
3. Ogni step restituisce esito, exitCode, tempi, log redatti e immagine. Gli skip rendono l'esito complessivo `incomplete`, non `passed`. SHA-256 collega il report all'esatto payload inviato.

Docker usa `--network none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, limitazioni CPU/memoria/pids e timeout. Niente comandi scelti dall'AI: lista fissa `.NET build/test, web build/test, Playwright`. Un solo worker per il MVP.

La SPA usa API key conservata soltanto in sessionStorage; deve chiedere consenso esplicito all'invio del codice.

## Rischi accettati / non-obiettivi

- L'accesso al socket Docker rootless dà comunque ampio controllo sul daemon rootless: isolare su VM sacrificabile, senza credenziali e senza altri workload.
- Non è un sandbox forte contro attaccanti avanzati; seccomp/VM per job, quota disco egress e retention restano attività di hardening.
- Non c'è ancora orchestrazione automatica del loop build-test-repair, né coda robusta multi-worker, né piena gestione dell'autenticazione multi-tenant.
- Installare dipendenze con rete disabilitata richiede cache Node/NuGet pre-popolate; build possono fallire. Playwright dipende da spec/servizi/browser correttamente installati.
- Cloudflare Tunnel è ingress, **non** sostituisce autentificazione applicativa e Cloudflare Access.

## Alternative

- GitHub Actions come runner esterno: più semplice e già esistente, ma meno interattivo e con minore controllo del ciclo agentico.
- .NET/WASM o WebContainers nel browser: valide per snippet e preview, ma non equivalgono a SDK/daemon full-stack.
- Docker daemon rootful con socket su API: rifiutato per rischio troppo elevato.

Vedi `docs/runner.md` per deployment e limitazioni.


## Addendum — claim atomica per job (#18, 15 novembre 2026)

Per evitare esecuzioni duplicate quando un secondo worker viene avviato accidentalmente, una claim `.claim` è acquisita con `mkdir` atomico prima di leggere il report e rilasciata solo dal proprietario in `finally`. Un altro worker non lancia Docker e il poller non modifica `running` claimed, non elimina directory claimed né blocca la coda con `queued` claimed. L'età della claim non è prova di inattività; dopo crash serve riconciliazione manuale dei container prima di rimuoverla, altrimenti il successivo polling segna `failed` senza re-eseguire. Non garantisce HA multi-host, fencing robusto, isolamento multi-tenant o cleanup automatico, ancora previsti in #2.


**Correzione TOCTOU #18:** osservare `running` e poi assenza della claim non basta per decidere di scrivere `failed`: il job potrebbe essere terminato nel frattempo. Il recovery prende una claim esclusiva e rilegge il report sotto lock, marcando `failed` solo se lo stato è ancora `running`. La regression impedisce che una scansione tardiva sovrascriva `passed`.


## Addendum — journal append-only con hash-chain (#19, 15 novembre 2026)

Il digest SHA-256 degli input identifica lo snapshot, ma non dimostra che un report JSON mutabile non sia stato modificato dopo il test. Il runner registra quindi ogni evento in JSONL con numero progressivo, SHA-256 del precedente e uno snapshot del report; il worker scrive soltanto detenendo `.claim`. La API accetta il job e crea la prima entry; prima di mostrare report o esportare il journal verifica l'intera catena e la corrispondenza con `report.evidence.head/count`. Un'incoerenza causa 409 anziché falso successo. Il journal viene fsync-ato prima del report atomico; crash intermedi richiedono riconciliazione manuale. Non è WORM e non protegge da un amministratore che può riscrivere tutti i dati: un'ancora esterna/firma resta in #2.


## Addendum — quota atomica e Idempotency-Key della API (#20, 15 novembre 2026)

Il precedente controllo in lettura `activeJobs()` seguito da una scrittura non serializzata consentiva di superare `maxQueued` con due API. Decisione: directory lock `jobs/.admission` acquisita via `mkdir` atomico sul volume POSIX condiviso, attesa limitata con 503/Retry-After quando occupata, quota e persistenza sotto lock. I lock lasciati da crash non si rubano in base all'età. Il POST può ricevere un `Idempotency-Key` UUID v4: report e ledger iniziale includono solo il relativo hash SHA-256; un retry valido riusa il receipt prima di quota e un payload differente confligge con 409. L'indice è costituito dai job conservati, così il limite temporale coincide con la retention, coordinata sullo stesso lock. Test con due istanze API, quote e retry concorrenti. Le chiavi sono generate dal browser e conservate fino alla conferma della submission. Questa misura non fornisce atomicità tra host/dischi diversi o un DB multi-tenant; #2 resta aperta.


## Addendum — nomi univoci e cleanup Docker fail-closed (#21, 15 novembre 2026)

Il nome Docker iniziale usava soltanto le prime otto cifre dell'UUID job: due job distinti potevano collidere. Usiamo **UUID completo + step allowlisted** nel nome e tre label Docker esatte non segrete. Aggiungiamo una CLI amministrativa del worker per ispezionare i soli container di un job verificato. Il default è dry-run; per cancellare è richiesta conferma completa dello stesso UUID, journal integro, job failed/incomplete, assenza di claim e ulteriore inspect per ogni ID. Mai prune generico, nessun socket sull'API, nessuna modifica alle prove né retry del job. L'operatore deve prima verificare che i worker non siano più vivi e riconciliare eventuali lock orfani. Questa procedura è conservativa, **non** un lease con fencing, un cleanup automatico sicuro o un test rootless VM di produzione: rimangono nella #2.


## Addendum — readiness check senza eseguire workload non fidati (#22, 15 novembre 2026)

Il preflight del runner è separato dall'effettivo deployment: una CLI solo lettura valida Compose risolto (non stampandone configurazione e credenziali), un host con socket/daemon rootless e directory private, e, opzionalmente, l'endpoint HTTPS con autenticazione Bearer e CORS richiesti dalla SPA, senza creare job o seguire redirect. La CI può verificare Compose e simulare risposte Docker/HTTP, ma non autentica un Cloudflare Tunnel reale né certifica una VM rootless. L'operatore deve fornire le evidenze e i segreti del server esterno e completare il collaudo in #2; il parser non esegue un auto-remediation e non include credenziali nei report.


## Addendum — firma dell'export da postazione indipendente (#23, 15 novembre 2026)

La hash-chain del runner (#19) rileva manomissioni non coordinate, ma un amministratore che controlla lo stesso volume può ricostruire journal e report. La decisione aggiunge un export Bearer self-contained e una CLI **offline** che verifica la chain e firma con Ed25519 un manifest con digest SHA-256 del bundle e identificatori dello stato. La private key rimane fuori da runner, API e Docker; il verificatore possiede già una public key pinned ottenuta da canale separato. Dopo una firma esterna, riscrivere l'intero journal non basta a produrre una firma valida senza rubare la chiave. La firma non attesta automaticamente che il contenuto fosse corretto prima di essere firmato, né prova la data o la VM effettiva: pubblicazione/ancoraggio off-host automatico e hardening restano nella #2.


## Addendum — re-test supervisionato, provenance e autorizzazione umana (#24, 15 novembre 2026)

L'UI aveva già repair AI manuale (max 2) con review e test obbligatori, ma la relazione fra job fallito, nuovi step e nuovo snapshot non era esplicita. La policy ora impone report **fresco** dalla API verificata prima del prompt, conserva trail di job/digest/step nei checkpoint del pending e costruisce un piano di re-test che non può escludere gli step precedenti o le build richieste dai file modificati. L'utente deve autorizzare separatamente la condivisione dei log con il modello e la trasmissione del **nuovo** codice al runner. Le receipt restano legate al nuovo SHA-256 del payload e alla proposta/revisione; l'approvazione richiede report reali passed e review positiva, non scatta mai automaticamente. Questa è orchestrazione supervisionata browser-side, **non** un repair agent autonomo o attestazione rootless/VM; le attività di produzione rimangono nella #2.
