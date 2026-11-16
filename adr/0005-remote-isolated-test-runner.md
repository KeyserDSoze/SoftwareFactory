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


## Addendum — checkpoint repair persistenti senza esecuzione autonoma (#25, 15 novembre 2026)

Per non perdere fra riavvii browser/repliche API le decisioni sui repair supervisionati, il server espone un registro separato dai job Docker. Ogni sessione origina da evidenze verificate di fallimento e da proposalId/path consentiti; consente due al massimo digest di patch, review **dichiarata** con verdict e re-test su job reale con stessa impronta e step/build obbligatori. Il checkpoint terminale `recorded_approval` richiede conferma dell'UUID e riverifica del test: **non** è autorizzazione a modificare i sorgenti né prova del revisore/consenso umano. Eventi hash-chained con snapshot atomici serializzati tramite lock POSIX; capacità conservativa max 100 sessioni, fail-closed su corruzione. Evitiamo di salvare sorgenti, prompt e chiavi nei checkpoint. La API key condivisa non garantisce attribuzione individuale e gli hash possono essere riscritti dall'amministratore del volume: future issue dentro #2 devono implementare identità/approvazione verificabile, ancoraggio off-host, sync della SPA e coordinatore vero unattended.


## Addendum — persistenza condivisa dal browser al coordinatore (#26, 15 novembre 2026)

La #25 ha introdotto una API di checkpoint server-side, ma il Code Agent continuava a usare solo state local-first. Decisione: collegare la UI ai checkpoint sotto **azioni esplicite già autorizzate** (avvio repair, retry test, approvazione), con lettura preventiva dello stato remoto per gestire risposte perse, e conservare solo ID/origin non segreti nel progetto. Il server resta un registro di dichiarazioni, non una fonte di patch, revisioni crittograficamente identificate o una autorizzazione a effettuare Git push. Le transizioni `patch/review/retest/record_approval` sono legate ai digest degli snapshot e richiedono test Docker veri e controllo locale dei path/revisioni. Qualsiasi disaccordo ferma l'azione; non accettiamo tentativi oltre il secondo, né bypass di vecchi repair senza binding. Il lavoro non crea un orchestratore autonomous/unattended né prova la VM rootless in produzione: resta nella #2.


## Addendum — separazione credenziali job/repair e attribuzione dei checkpoint (#27, 15 novembre 2026)

La chiave globale del runner era sufficiente per dichiarare review e approvazioni (#25/#26), nonostante una semplice autorizzazione alla compilazione non debba conferire anche tali capacità. La decisione adotta un **registro privato di chiavi operatore**, ciascuna con un ID e scope espliciti (`propose/review/approve`), autenticazione Bearer timing-safe e rifiuto della chiave globale sulle route repair. La configurazione assente disabilita le sole API repair, non il servizio build/test. Le nuove mutazioni registrano solo l'ID del credential holder nella hash-chain; i vecchi eventi restano legacy senza attribuzione. La SPA mantiene un token separato in sessionStorage e può cambiarlo fra il re-test e l'approvazione. Non usiamo JWT inventati né pretendiamo un'identità reale dell'essere umano: la credenziale è una capability e può essere condivisa, non è MFA o firma di consenso; ancora richiesti two-person enforcement, identity provider, tenant, revoca e collaudo produttivo (#2).


## Addendum — attori distinti sulle decisioni di repair (#29, 16 novembre 2026)

La #27 separa le capacità per credenziale, ma l'operatore con tre scope poteva dichiarare da solo patch, review e approvazione. La decisione aggiunge una **policy server-side di incompatibilità fra ID di operatori nella stessa sessione**: il primo actor è il proponente e resta responsabile di patch/retest, i reviewer non possono coincidere con lui, e l'approvatore finale deve differire anche dal reviewer dell'ultimo tentativo. `enforceActorSeparation` viene usato per convalidare sia la history persistita sia i nuovi checkpoint prima del commit; eventi legacy anonimi sono consultabili ma immutabili. L'interfaccia adotta tre fasi esplicite, cambiando manualmente la chiave di sessione: patch (proponente), review (revisore), nuovo job (proponente); il risultato reale e l'approvazione finale seguono i gate separati. Si preferisce fail-closed su integrazioni legacy piuttosto che attribuire retroattivamente decisioni. Questa è **separazione per ID del portatore della chiave**, non garanzia che vi siano tre esseri umani o che la loro firma sia autentica. Non aggiunge esecuzioni autonome o permessi Git; identità forte e attestazione esterna sono progetti successivi in #2.


## Addendum — revoca operatori tramite file privato con lettura per richiesta (#31, 16 novembre 2026)

Scelta: l'operator registry statico in ambiente (#27) richiedeva restart coordinato di tutte le repliche per revocare un token. Introduciamo la fonte alternativa `RUNNER_REPAIR_OPERATORS_FILE` riletta ad ogni richiesta repair: file JSON privato controllato da amministratore, con ownership del processo API, permessi 0600/0400, protezione no-follow, hardlink=1 e validazione di credenziali/ruoli. La sostituzione atomica dello stesso file in una **directory** montata read-only solo nell'API permette a tutte le repliche di vedere nuove chiavi senza restart; un bind mount **del singolo file** avrebbe pinning dell'inode e non garantirebbe l'aggiornamento. In caso di file mancante o malformato, il coordinatore fallisce chiuso (503) mentre i job continuano. Il ledger non viene modificato, perché gli `actorId` non cambiano alla rotazione del token. Non usiamo un endpoint di gestione chiavi via internet e non promettiamo revoca retroattiva delle richieste già autorizzate né revoca dei JWT/sessioni. La modalità legacy JSON inline resta disponibile ma deve essere riavviata. La #2 copre identità federata, MFA, multi-tenant, notarizzazione e deployment reale.


## Addendum — ownership effettiva del registro privato (#32, 16 novembre 2026)

Per il registry file della #31, il solo controllo dei mode bit `0600/0400` non dimostra che il file appartenga all'identità con cui gira l'API. Aggiungiamo il confronto fail-closed `fstat.uid === process.geteuid()` sul **file descriptor già aperto** prima di caricare chiavi: file di un altro UID vengono rifiutati con 503, mentre le API job restano operative. Non ci fidiamo di `lstat(path)` separato, che introdurrebbe una race al rename. La documentazione richiede di verificare l'UID *dentro* il container in presenza di Docker rootless e user namespace; la VM reale rimane da collaudare in #2. Questa misura non prova autenticazione umana o protezione contro amministratori dell'host.


## Addendum — secondo gate auth dentro il lock repair (#33, 16 novembre 2026)

Problema: anche una credenziale rivista ad ogni richiesta può essere revocata dopo la prima lettura e prima che il POST ottenga il lock filesystem condiviso. Decisione: la funzione che acquisisce `jobs/.admission` esegue una callback di **ri-autorizzazione** in modalità file prima di scandire o scrivere qualsiasi record. Il callback riapre il file privato con gli stessi controlli di ownership, riconfronta il Bearer iniziale, l'actor ID atteso e il ruolo della transizione. Il rifiuto non genera eventi e restituisce 401/403/503. In modalità JSON inline non c'è rotazione live; i call site rimangono compatibili e i GET non richiedono lock. L'operatore continua ad autorizzare esplicitamente ciascuna azione; il guard non lancia test o patch autonomamente.

**Tradeoff:** il lock serializza il ledger, non la sostituzione dell'operator registry, che avviene fuori banda. L'operatore può essere revocato fra gate e `atomicWrite`; non esiste garanzia di annullamento delle richieste già entrate nella sezione critica. Il miglioramento protegge i POST in coda e lascia identità federata, revoca transazionale e distribuzione multi-host alla #2.


## Addendum — admission fail-closed delle evidenze su tutti i job (#34, 16 novembre 2026)

La #20 usava il campo `state` di ogni `report.json` per la quota prima di verificare la catena delle evidenze del solo job eventualmente ritrovato da Idempotency-Key. Un report `queued` riscritto in `passed` avrebbe potuto far apparire slot liberi, mentre il read endpoint del medesimo report avrebbe correttamente risposto 409. La decisione è verificare tutte le catene JSONL dei job conservati **dentro il lock di admission** prima del conteggio e prima di qualsiasi replay: anche un singolo sibling invalido causa 503, mai liberazione automatica della quota. Un piccolo retry bounded solo quando journal e report sono temporaneamente disallineati durante la scrittura del worker riduce falsi 503, ma errori persistenti bloccano la nuova ammissione fino a riconciliazione.

Un retry conserva ID/digest originali ma comunica lo **stato corrente del report validato**, inclusi gli stati terminali, invece di dichiarare `queued` artificialmente. La SPA accetta solo stati enumerati e ricontrolla il report completo e la corrispondenza degli step prima di usare prove build/test. Tradeoff: costo di scansione fino a 100 journal per submission, possibili `503 admission_busy` con code larghe e nessuna protezione contro chi controlla e riscrive coerentemente l'intero volume. Per autenticità effettiva servono firma/ancoraggio indipendente e infrastruttura distribuita; queste restano nella #2.


## Addendum — budget globale rate delle accettazioni (#35, 16 novembre 2026)

Per limitare l'accumulo di workload da una singola API key condivisa, aggiungiamo il parametro `RUNNER_MAX_ACCEPTED_PER_MINUTE` (0 default disabled, 1–100 enabled) applicato nel medesimo lock POSIX della quota e dell'idempotenza. Invece di introdurre un contatore mutabile che può restare divergente dal journal, ricostruiamo il rate dalle prove di job **verificate**: `acceptedAt` negli ultimi 60s tra gli ID conservati. Un replay valido non consuma una nuova ammissione e precede il rate, mentre richieste nuove oltre la soglia ricevono 429 e `Retry-After` bounded. Le date non parseabili sono anomalie di integrità, non elementi da saltare. Conserviamo le due quote esistenti: slot `queued/running` e cap directory.

**Tradeoff:** nessun registro di rate aggiuntivo né nuove credenziali; il rate copre solo job ancora presenti sul volume (la retention minima operativa è 1 ora, salvo cancellazioni amministrative), può bloccare a causa di clock-skew e non funziona su dischi separati. Questa non è una quota per tenant o per utente, un limite per origine IP, un'attestazione off-host o un meccanismo HA/fencing: restano attività della #2.


## Addendum — HTTP read retry su journal/report in aggiornamento (#36, 16 novembre 2026)

Il journal è fsync-ato prima di aggiornare con rename atomico il report. Questo preserva le prove contro una risposta prematura di successo, ma la verifica HTTP non serializzata con `.claim` del worker può incontrare un breve disallineamento e restituire 409 a un polling legittimo, interrompendolo. Si introduce un wrapper di **sole letture HTTP** con un massimo di tre verifiche SHA-256 complete separate da 25ms, e retry **esclusivamente su `EVIDENCE_INVALID`**; le altre letture e i writer mantengono la strict `verifyJobEvidence`. È vietata qualunque riparazione automatica, permesso di continuare con snapshot parziali o nascondimento di una discrepanza persistente.

I test realizzano il momento di transizione con journal autentico aggiornato e report ancora vecchio, verificano il recupero anche sull'export completo e il 409 per troncamento permanente; un job non esistente conserva 404. Tradeoff: fino a 50ms di ritardo aggiuntivo per letture che incontrano inconsistenza, senza garanzia di rootless VM, storage transazionale, trust off-host o fencing cross-host. #2 resta aperta.


## Addendum — polling riprendibile con backoff bounded (#37, 16 novembre 2026)

La #36 riduce i falsi 409 causati da journal/report transitori, ma nel browser una sola eccezione di `fetchRunnerJob` arrestava per sempre il polling, inclusi guasti di rete/Cloudflare o 503. Decisione: distinguere con un errore HTTP tipizzato le condizioni temporanee (network/408/429/5xx) da denial o prove invalide (401/403/404/409), con **massimo cinque nuovi tentativi GET** e ritardi esponenziali limitati a 30s. Un GET riuscito azzera il contatore; dopo la soglia, il browser richiede esplicitamente `Riprova lettura`, che non crea un altro job. Token, origini e UUID sono già legati al contesto; cleanup di timer/fetch a ogni cambio e su unmount. Nessuna condizione di errore produce uno stato `passed` o auto-approval.

Tradeoff: un guasto CORS non è distinguibile dal trasporto dal solo JavaScript; è ricontrollato poche volte prima dello stop manuale. Non sono introdotti service worker/background tasks, rate bypass, rivendicazioni di esecuzione sicura, consenso implicito o identità federata. Il runner remoto resta sperimentale e la #2 richiede isolamento VM, IAM/tenant e prove off-host.


## Addendum — heartbeat worker e readiness operativa (#38, 16 novembre 2026)

Prima di questa modifica, `GET /healthz` indicava soltanto che il processo API era vivo, anche quando non esisteva più alcun worker. Aggiungiamo un `worker-heartbeat.json` periodico (default ogni 5s) e privato sul volume condiviso, aggiornato da un timer indipendente dal poller e dai `await` dei test Docker. Il record contiene soltanto schema version, UUID casuale di istanza e timestamp `startedAt/updatedAt`, mai chiavi, PID, socket, sorgenti o output. Il file viene sostituito con rename atomico mode 0600.

`GET /v1/readiness` richiede Bearer job e rilegge il file usando `O_NOFOLLOW` e `fstat` owner/mode/inode/size, quindi controlla version/UUID/timestamp ISO e freschezza entro `RUNNER_WORKER_HEARTBEAT_MAX_AGE_SECONDS` (default 30, 10–300). Risposta 200 solo per heartbeat credibile, 503 `worker_unavailable` con Retry-After se mancante, falso, futuro o scaduto; `healthz` resta 200 indipendentemente dal worker.

Tradeoff esplicito: l'heartbeat non è una verifica del Docker daemon rootless, un'API healthcheck transazionale, un test dei toolchain o un'autentica firma da un host diverso. Un processo crashato può lasciare un segnale valido per massimo 30s e un amministratore del volume può fabbricarne uno. L'operatore deve verificare la VM, socket rootless, Docker effettivo e Cloudflare Tunnel/Access prima del deployment: #2 resta aperta.


## Addendum — Docker rootless probe indipendente dall'heartbeat (#39, 16 novembre 2026)

Decisione: aggiungere dal **solo worker**, che già possiede il socket rootless, un controllo read-only periodico `docker info --format '{{json .SecurityOptions}}'` eseguito con `execFile`, timeout 5s e massimo 4096 byte. La CLI riceve un ambiente ristretto e non sono ammessi endpoint TCP/SSH o socket diversi dai percorsi UNIX dedicati. Anche se il socket è etichettato rootless, la prova effettiva richiede `name=rootless` nelle `SecurityOptions` restituite dal daemon. Un Docker non raggiungibile, rootful o risposta invalida causa fail-closed e non viene loggato il contenuto della risposta. Il probe non deve bloccare il poller o sovrapporsi a se stesso.

Il file heartbeat versione 2 contiene un sottorecord `docker: {rootless:boolean, checkedAt:ISO|null}`; il timer Node continua indipendente. L'API non ha né riceve il Docker socket, ma espone il nuovo GET autenticato `/v1/execution-readiness` che richiede sia heartbeat Node sia l'ultimo probe positivo **entro la stessa soglia configurata**: HTTP 200 con stato rootless oppure 503 `docker_unavailable`, `Retry-After:5`. Per rolling upgrade `/v1/readiness` accetta ancora un file versione 1 (worker soltanto); tale record non può mai diventare prova del daemon.

Tradeoff: la misura certifica soltanto la risposta del daemon visto dal worker al momento del probe, non la riuscita di `docker run` con rete negata, namespace, filesystem read-only, immagini build/test installate, né prova off-host. Un host compromesso può falsificare il file o la risposta locale, e la disponibilità può cambiare prima del job: restano VM rootless reale, IAM per tenant, external attestation e Cloudflare Access nella #2.


## Addendum — canary manuale isolato su daemon rootless (#40, 16 novembre 2026)

La sola `execution-readiness` della #39 dimostra un `docker info` recente ma non l'esecuzione. Introduciamo una CLI di **verifica operativa su consenso esplicito**, eseguibile soltanto nel contesto del worker rootless e mai tramite endpoint/browser o polling: `node scripts/rootless-canary.mjs --image=node@sha256:<digest> --confirm`. La policy richiede immagine Node verificata e già presente nel daemon (nessun pull durante il canary), socket UNIX locale e risposta `name=rootless`. Il comando costruisce un container con nome/label unici, rete `none`, rootfs read-only, capability zero, no-new-privileges, UID 65534, CPU/RAM/PID limitati, tmpfs /tmp e nessun bind mount. Prima di avviarlo verifica l'oggetto `docker inspect`; poi attende il test interno nonroot/CapEff/network/tmpfs e richiede stato exited+exitCode 0+sentinella esatta, seguito da **cleanup confermato** del solo ID verificato. Non usa `docker system prune`, non emette stderr o configurazioni Docker.

Tradeoff: un daemon malevolo può mentire alla CLI e il risultato non è una firma off-host; il container Node non verifica toolchain .NET/Playwright, host userns/mount di job reali né tunnel e IAM di Cloudflare. La suite GitHub CI testa la logica simulata e il proprio smoke Docker rootful già esistente; solo l'esecuzione manuale sul daemon rootless della VM potrà confermare il canary. Per i lavori rimanenti resta aperta la #2.


## Addendum — smoke effettivo del canary su daemon rootful effimero (#41, 16 novembre 2026)

Testare soltanto con stubs le chiamate Docker del canary #40 lascia il rischio che `docker create`, `inspect`, `start --attach`, UID non-root, tmpfs o cleanup si comportino diversamente sul vero daemon. La CI possiede già un host Docker effimero rootful, perciò aggiungiamo uno step **CI-only** che ricava il digest Node dalla cache, richiede esplicitamente un runner GitHub Actions non-root e un daemon rootful, ed esercita il percorso effettivo del canary #40 tramite sola dependency injection locale per bypassare il check rootless. Rimane vietato quel bypass nell'entrypoint operatore: `rootless-canary.mjs` richiede sempre conferma e Docker rootless.

La prova richiede flag di isolamento, inspect, runtime e cleanup senza risorse residue, ma **non produce attestazioni di rootless**. Il marker CI contiene `ROOTFUL_CI_ONLY`; nessun segreto, attestazione indipendente o credenziale Cloudflare è incluso. Tradeoff: il test individua problemi della CLI in Docker reale, ma solo una prova distinta nella VM rootless e un deployment Access/Tunnel possono dimostrare l'ambiente desiderato (#2).


## Addendum — clock post-I/O per la readiness (#43, 16 novembre 2026)

Una regressione CI su due API e worker heartbeat ha mostrato che un record nuovo, pubblicato tra l'inizio del GET e la `await readFile`, poteva essere rifiutato come timestamp futuro: la execution-readiness passava al lettore un `Date.now()` acquisito troppo presto. La correzione non rilassa le policy: la prima validazione usa un clock acquisito **dopo** l'apertura/lettura e il controllo TTL dell'ultimo probe usa anch'esso un istante post-lettura. L'argomento `nowMs` resta un clock fissato esplicitamente per test negativi. La suite stressa due API mentre il worker pubblica heartbeat veri ogni 20ms; non è una prova di isolamento Docker rootless né attestation off-host (#2).


L'endpoint HTTP della #43 impiega inoltre al massimo tre verifiche **completamente autonome** del record heartbeat con un intervallo di 15ms tra i tentativi quando una revisione viene sostituita in concorrenza. Non memorizza mai un `ready` da uno snapshot precedente e non modifica i file: l'unico 200 consentito richiede tutti i controlli su un record valido durante lo stesso tentativo; l'incoerenza persistente conserva 503.
