# SoftwareFactory — architettura

## Obiettivo

Riprendere il modello di BookWriter: tante componenti autonome che trasformano un brief in artefatti, con fasi riprendibili, versionamento, connettori intercambiabili e review. **Factory** e **applicazione generata** hanno confini diversi.

```text
SoftwareFactory SPA (browser)
  ├── domain/       ProjectConfig, Stage, Profile, ServiceBinding
  ├── application/  pipeline per task, prompt, gate, generatore deterministico
  ├── infrastructure/
  │     ├── localStorage per progetto/settings, sessionStorage per token
  │     ├── AI OpenAI-compatible /chat/completions
  │     ├── ricerca: gateway HTTPS + fallback Wikipedia
  │     ├── GitHub REST Git Data + create repo (PAT o App broker)
  │     └── OAuth PKCE Google Drive / MS Graph OneDrive app-folder
  ├── components/    Code Agent / Runner Panel (patch, review, test evidence, repair)
  ├── infrastructure/runner.ts  API client + canonical snapshot hash and report verification
  └── App.tsx        Workspace / AI Factory / Code Agent / Architecture / Settings

SoftwareFactory Runner remoto (sperimentale, opzionale):
  ├── runner-api (Bearer API key, allowlist, queue + SHA-256)
  ├── runner-worker (rootless Docker socket, solo su VM dedicata)
  ├── test containers (network none, CPU/RAM/timeout)
  └── Cloudflare Tunnel (opzionale)

Generato dal composer, salvabile come ZIP o Git commit:
  ├── .github/workflows/ci.yml
  ├── docs/          features, research, architecture
  ├── adr/           0001-modular-ddd.md
  ├── docker/        compose, Dockerfile web e API, env example
  ├── infra/         Terraform bootstrap / Kubernetes scaffolds
  ├── tests/         strategy e gate da implementare
  └── src/
       ├── frontend/web (React + TS)
       ├── frontend/{android,ios,unity,mobile-react-native} (solo placeholder MVP)
       └── backend/
            ├── applications/Api (ASP.NET Core minimal API)
            ├── business/ (use case services)
            ├── domain/ (entità e value objects)
            └── infrastructure/ (adapter da sviluppare)
```

## State machine e persistenza

Le fasi sono in ordine: `features → competitors → technical → architecture → adversarial → implementation`. Ogni task è un'operazione AI distinta e associata a un profilo modello configurabile. Output validati non-vuoti diventano checkpoint. Rigenerare un task invalida i task successivi; cambiare il brief o lo stack invalida l'intera pipeline. Una richiesta AbortController interrompe l'attesa e ne scarta l'output.

Il workspace e le impostazioni (esclusi token e segreti) sono in localStorage. Durante riapertura, uno step con status `running` diventa `pending`. Questo non è un processo 24/7: non ci sono job server-side e non c'è lease distribuito tra dispositivi nel primo MVP.

## Ricerca e adversarial review

La ricerca produce `ResearchSource {title,url,snippet,query,fetchedAt}`, deduplica gli URL e allega gli spunti al contesto AI. Un adapter gateway configurabile consente integrazioni di motori web; Wikipedia è un fallback molto limitato. Le fonti web non sono istruzioni; i prompt vietano di inventare riferimenti e obbligano a distinguere evidenze e ipotesi. Per contesti normativi sono necessarie **fonti ufficiali, revisione umana e date di validità**.

L'adversarial review lavora su piani già scritti e segnala gate critici; la validazione automatica di accettazione di ogni singolo finding sarà aggiunta in una fase futura.

## Stack configurabile

Gli utenti scelgono binding di database, cache, queue, telemetry e storage separatamente per `development` e `production`. Il manifest descrive questa matrice; la runtime dependency injection e il provisioning completo per ogni provider non sono ancora implementati. Docker Compose avvia lo scheletro locale e i servizi selezionati che hanno un template, Terraform contiene bootstrap provider e documentazione di hardening, non è un deployment completo.

.NET predefinito: **11.0** (STS, release 10 novembre 2026); scelta alternativa **10.0 LTS**. Non usare una versione hardcoded come promessa eterna: aggiornare il catalogo alle nuove release.

## GitHub

Un PAT con permessi minimi può creare una repository privata nel proprio account (se dispone dei permessi) e scrivere su main. Per repo esistenti, il client legge HEAD+tree, crea una tree Git, genera commit e avanza la ref con `force:false`. Per branch diversi da main viene creato un branch a partire da main se assente. Non c'è merge automatico; i conflitti bloccano la pubblicazione. L'installazione GitHub App deve essere gestita da un broker server-side e passare installation token temporanei al browser, mai private keys.

## Evoluzione architetturale

Per diventare una vera code factory autonoma servono: task graph con file ownership, editing del codice per feature, cicli build/test automatici, sandbox isolata, revisori indipendenti, budget AI e rate limiting, PR/merge policy, code execution agent e secret broker. Nessuna di queste capacità è simulata come già pronta nel MVP.

## Verifica del codice generato (issue #3)

Il Code Agent separa tre concetti: review AI (opinione statica), build/test reale (report del runner) e approvazione umana. La seconda fase è collegata a un digest dei sorgenti e alla proposta che la genera, per evitare che un report relativo a file obsoleti venga mostrato come prova per il codice corrente. Il repair guidato dai log è limitato a due tentativi e agli stessi file della feature originale. Una riparazione invalida la review precedente e tutte le evidenze di test; l'approvazione richiede una nuova review e un nuovo build pertinente realmente riuscito.

## Prove browser con vera API ASP.NET Core (issue #6)

La Factory genera due modalità di test Playwright: UI/mock senza backend esterno e integration con ASP.NET Core vero. La seconda esercita HTTP /health e /api/info su una API effettivamente avviata. In CI, tre container Docker (API, Vite, Chromium) comunicano su una rete bridge privata e interna al job senza esporre porte. La CI dello scaffold usa invece backend e Vite su loopback. Il browser non riceve token né socket Docker.

La persistenza non è inclusa in questi risultati: PersistenceOptions è ancora solo un adapter placeholder. Un esito verde non dimostra funzionamento DB, servizi cloud né un deployment rootless sicuro su server dedicato.

## Implementazione PostgreSQL DDD (issue #7)

Lo scaffold con database `postgresql` genera `WorkItem` e `IWorkItemRepository` nel dominio, `WorkItemService` nel business layer e un adapter `PostgresWorkItemRepository` con `NpgsqlDataSource` in infrastructure. La API minimale espone GET/POST/PUT/DELETE su `/api/items`; un componente React permette creazione, elenco ed eliminazione. Gli ID UUID vengono generati dal dominio e le query usano esclusivamente parametri PostgreSQL posizionali, senza interpolazione SQL con dati utente.

Un `PostgresSchemaMigrator` all'avvio controlla `factory_schema_migrations`, serializza le migrazioni sotto un advisory lock PostgreSQL e applica i file SQL incorporati in una transazione, marcando le versioni applicate. Una nuova installazione Postgres deve fornire la connessione tramite env; se manca, l'applicazione non avvia silenziosamente un finto database. PostgreSQL è l'unico backend di persistenza implementato; le altre scelte restano placeholder non testati.

Il test browser d'integrazione verifica i record dopo roundtrip UI→HTTP→DB→HTTP, utilizzando due client separati (pagina e APIRequestContext). In CI, PostgreSQL gira in un container isolato con password casuale, stessa rete Docker privata di API/Vite/Chromium, senza pubblicare porte. La configurazione generata di Docker Compose espone Postgres soltanto su loopback locale in sviluppo, verifica `pg_isready` e inietta il segreto mediante `DB_PASSWORD` esterno al repository. Questa demo **non include auth o segregazione tenant**: non utilizzare l'endpoint CRUD per dati reali esposti su Internet.

## JWT, RBAC, proprietà e audit PostgreSQL (issue #8)

Lo scaffold PostgreSQL richiede Auth:Issuer, Auth:Audience e Auth:SigningKey esterni (almeno 48 byte random); fallisce all'avvio senza di essi. ASP.NET Core verifica JWT HS256, lifetime e claim sub/role. Le route per i WorkItem sono protette da policy reader/editor e filtrano ogni query per owner_id ottenuto dal token firmato: SELECT isola la lista, PUT/DELETE su record altrui restituiscono 404. La migrazione 0002 introduce owner_id, una tabella work_item_audit e mette i record antecedenti sotto l'owner di quarantena legacy-unassigned. Create/update/delete ed evento audit sono nella stessa transazione.

L'API applica un rate limit per identità e un massimo di 8 KiB di request body; /health è liveness, /ready è una verifica DB autenticata. In CI si usano secret e JWT di breve durata creati nell'ambiente isolato. La SPA demo consente di inserire manualmente il token e lo tiene nella sessione: **non** c'è Identity Provider/login OIDC o gestione chiavi di produzione. Evitare deployment pubblico senza una soluzione auth completa, TLS e protezione da XSS.

## Nuovo flusso OIDC/JWKS (issue #9)

`AuthStartup` sceglie OIDC come default per lo scaffold PostgreSQL. In produzione l'autorità OIDC deve essere HTTPS e il bearer token è validato esclusivamente con RSA SHA-256 da JWKS/discovery del provider, audience e issuer fissi, firma e durata. Non viene richiesta la chiave di firma al frontend né al repository; l'API tiene la propria configurazione Auth__Authority/Auth__Audience sul server. La modalità legacy HS256 rimane disponibile per il test locale e la CI generata, ma viene rifiutata quando ASPNETCORE_ENVIRONMENT=Production.

React importa `oidc-client-ts` e usa un client pubblico Authorization Code + PKCE; la library gestisce state/nonce, redirect /auth/callback, verifica del profilo, access token in sessionStorage e logout. Un componente non deve mai distribuire client secret o chiavi private nel bundle. L'origin Nginx di produzione serve /auth/callback attraverso una SPA history fallback. Nel test fullstack della Factory un provider OIDC **simulato** gira su rete Docker privata senza Internet, fornisce discovery e JWKS RS256 con chiave RSA effimera e controlla PKCE. Non equivale a un login SSO di un prodotto IdP reale né sostituisce BFF/gestione sessione consigliati per applicazioni sensibili.

### Validazioni OIDC nella Factory CI

La suite browser mantiene la rete Docker privata ma avvia Vite su localhost all'interno del container Chromium: `crypto.subtle` funziona senza flag di sicurezza per origini HTTP. In parallelo, una suite Node dal container web verifica sul provider temporaneo code grant con S256, codice monouso, controllo firma con JWK pubblica, rotazione dei refresh token senza replay e pubblicazione del nuovo `kid`. I risultati restano distinti dalla disponibilità e qualità di un IdP esterno.

### Gate hardening JWT e identità (issue #10)

Le API PostgreSQL generate permettono `Auth:Mode=legacy` esclusivamente in Development, fallendo prima dell'avvio negli ambienti Staging, Production e custom. Le policy `items.read` e `items.write` richiedono esattamente un claim `sub` non vuoto e non oltre 255 caratteri, prima che venga usato come owner del record. Factory CI controlla sia gli avvii vietati .NET sia il rifiuto reale (`403`) di JWT RS256 con `sub` assente o vuoto. Questo non sostituisce revoca, validazione di un IdP esterno o sessioni BFF (issue #9).


### Client OAuth e reazione agli HTTP 401 (#11)

Il client PostgreSQL svuota stato applicativo e credenziale locale se l'API protegge i dati restituendo 401; evita redirect forzati e richiede nuovo login esplicito. L'identity store di `oidc-client-ts` viene rimosso tramite `removeUser()` (non è una revoca presso l'IdP). Un `useRef` protegge dalle risposte tardive associate a token precedenti. I 403 restano segnalati come errori RBAC senza logout. Le prove E2E inoltrano richieste con Authorization manipolato a un vero backend .NET/PostgreSQL, distinguendo queste risposte dai mock offline.


### Rollover delle chiavi JWKS in ASP.NET Core (#12)

Dopo il test browser fullstack con JWT RSA/JWKS, la Factory CI usa un client Node interno alla stessa bridge `--internal` per chiamare l'API ASP.NET Core già avviata. Conserva un riferimento al `kid` JWKS originale e verifica un token valido; ruota la chiave RSA temporanea nel provider, attende con un budget temporale massimo che JwtBearer esegua il refresh JWKS quando incontra il nuovo `kid`, poi prova un token valido, una firma manomessa (401) e un token reader su scrittura (403). Questa prova non resetta il processo .NET e non condivide chiavi private. I token prima della rotazione possono sopravvivere fino a scadenza/cache: non si presume una revoca immediata delle credenziali vecchie. La validazione con un vero IdP HTTPS e il modello BFF/CSP restano in #9.


### Refresh OAuth e logout nella SPA realmente eseguita (#13)

La Factory CI usa l'istanza effettiva di `oidc-client-ts` nella pagina Chromium autenticata via PKCE, invoca `signinSilent()` con refresh token e verifica che l'app riceva due credenziali ruotate, aggiorni lo storage, neghi il riuso del vecchio refresh e chiami ASP.NET Core/PostgreSQL col nuovo JWT. Il test reload prova la persistenza della sessione rinnovata. Il logout attraversa l'endpoint HTTP del provider CI e la callback browser, quindi elimina lo user store. Gli assertion restituiscono solo booleani/status HTTP, mai token o chiavi. La CI legge i contatori refresh/logout **prima** del client Node del test protocollare, distinguendo così le prove browser. Un provider terzo HTTPS e la revoca federata su più applicazioni non sono certificati.


### Distinzione tra rinnovo OIDC definitivo e indisponibilità temporanea (#15)

Nel modulo OIDC generato `isTerminalOidcRenewError` riconosce soltanto codici di protocollo `ErrorResponse` espliciti (invalid_grant/login_required/invalid_token), senza interpretare testi liberi del provider. `renewOidcSession()` elimina lo user store solo se il refresh token ancora conservato appartiene alla stessa sessione che ha fallito il grant. Il componente React ascolta `silentRenewError` per il rinnovo automatico e `userUnloaded` per disattivare CRUD quando il client svuota le credenziali. Un errore di rete non invalida subito un access token ancora valido, ma la scadenza o un 401 dalla vera API ripristinano il comportamento fail-closed. I test di regressione eseguono entrambi gli scenari contro il provider temporaneo su rete privata, senza introdurre logout automatici o trasmissione di credenziali nei log. Questo non equivale a revoca server-side di JWT non scaduti o sicurezza browser BFF/CSP.


### CSP Nginx con allowlist pubblica build-time (#16)

Il builder generato `src/frontend/web/scripts/build-nginx.mjs` legge solo `VITE_API_URL` e le impostazioni pubbliche OIDC, valida schema/host e credenziali/query/fragment, normalizza a `URL.origin` e genera un `nginx.conf` per il Dockerfile web dopo la compilazione Vite. La SPA non deve conoscere segreti; la CSP vieta script inline/eval, embedding, object e base, limitando `connect-src` a URL espliciti. I path di autorità OIDC sono ammessi per compatibilità con realm Keycloak ma non vengono incorporati nella allowlist. HTTP su origin interni di CI richiede eccezione esplicita e l'immagine di produzione non la abilita. Un container Nginx reale nella bridge `--internal` serve la SPA compilata e i test Chromium verificano CSP effettiva, callback SPA e blocco inline. Stili inline React restano consentiti: non equivale a protezione XSS completa né a modello BFF con cookie HttpOnly.


### Invalidazione OIDC same-origin con BroadcastChannel (#17)

La Factory genera un modulo `oidc.ts` con `broadcastOidcLogout` e `subscribeOidcLogout`, che comunicano esclusivamente la stringa statica `logout` tramite `BroadcastChannel` del medesimo origin, senza esposizione di JWT o profilo utente. Lo stato `sessionStorage` rimane indipendente per scheda. Il componente `WorkItems` si sottoscrive durante il ciclo React e si disiscrive in cleanup: quando una scheda riceve l'evento cancella credenziali locali con `UserManager.removeUser()`, dati e form e richiede login esplicito, senza inviare un secondo evento. Inviano l'evento il logout esplicito, l'invalidazione API 401 e il fallimento definitivo del rinnovo token. Il test Chromium reale usa due schede e due login PKCE per verificare propagazione, storage vuoto e persistenza dopo refresh della pagina. È un segnale best-effort locale, non un IdP back-channel logout, un BFF, né revoca di JWT distribuiti.


**Correzione della pubblicazione locale:** un modulo OIDC mantiene un solo oggetto `BroadcastChannel` per documento e lo condivide per emettere e ricevere. La specifica non consegna un messaggio ai listener sull'oggetto mittente, mentre oggetti diversi creati nello stesso documento si notificano reciprocamente: separare i due avrebbe trasformato un 401 della scheda in una falsa disconnessione remota. I listener sono contati e il canale chiuso all'ultima disiscrizione; prove Chromium pregresse verificano che l'errore 401 locale resti visibile.


**Collaudo cross-tab nella CI:** due tab Chromium richiedono più memoria e shared memory del singolo browser; il solo coordinatore Factory per la rete privata incrementa i limiti del suo container Playwright, lasciando invariato `planStep` del runner pubblico e senza modificare la superficie di rete/capability. I crash del browser sono fallimenti della suite, non vengono falsamente conteggiati come successi.


### Claim esclusiva sul volume runner (#18)

`executeJob` acquisisce via `mkdir` non ricorsivo una `.claim` per job prima di verificare `queued`; soltanto il proprietario avvia Docker e scrive report. La claim si libera in `finally`. L'API resta senza socket; worker multipli sullo stesso filesystem non devono duplicare job o falsificare transizioni di stato. Il polling ignora job claimed e la retention li preserva. Dopo crash la claim residua blocca il job finché l'operatore riconcilia processi/container e la rimuove; un `running` privo di claim passa a `failed`. Questa è una sicurezza conservativa, non un lease con fencing distribuito.


La recovery di `running` privo di claim è serializzata da una nuova `mkdir(.claim)` e da una **seconda lettura del report mentre la claim è detenuta**: questa evita che un poller con stato obsoleto sovrascriva come `failed` il `passed` appena scritto dal worker che ha terminato e rilasciato il lock. Il recupero viene saltato se un altro processo ha già acquisito la claim.


### Integrità locale verificabile delle evidenze job (#19)

La API crea l'entry `accepted` nel journal JSONL all'accettazione della snapshot e salva `report.evidence.head/count`. Il worker serializza l'accesso con `.claim`, e registra ciascuna fase e i risultati redatti con hash SHA-256 che include quello precedente; le recovery scrivono eventi propri e non modificano silenziosamente report e prove. L'aggiunta del record è fsync-ata prima del replace atomico di `report.json`. Gli endpoint Bearer `GET /jobs/{id}` e `/evidence` verificano hash, sequence, digest, conteggio e snapshot finale; una divergenza è un 409 (non `passed`) e blocca il worker. Il registro non include sorgenti né credenziali. Il medesimo disco non conferisce autenticità contro compromissioni amministrative: l'ancoraggio remoto firmato e un daemon rootless VM sono ancora obiettivi della #2.


### Admission atomica e idempotency key HTTP (#20)

Le istanze del runner API condividono una directory POSIX `/data/jobs/.admission`, acquisita con `mkdir` esclusivo, prima del conteggio di job attivi e directory trattenute e prima di persistere il nuovo job con journal. Il controllo è unico anche fra processi API distinti; risposte dopo timeout del lock non cancellano lock altrui. Il `Idempotency-Key` UUID v4 è trasformato in SHA-256 e scritto nel report/journal iniziale, senza un indice secondario non bounded; un replay entro la retention riutilizza il job ID prima di applicare quote. Il poller usa lo stesso lock durante la cancellazione per non interferire con un replay. Il browser genera un UUID per tentativo, lo mantiene sui retry della stessa snapshot senza conferma e lo resetta dopo successo. Questa è una semantica di admission per filesystem condiviso locale; non equivale a fencing distributed/DB serializable, né autentica gli esiti su un server compromesso.


### Identità completa e recovery operator-only dei container runner (#21)

Ogni container di build/test usa nome derivato dall'intero UUID job e uno step fissato dal runner, più tre label Docker senza dati sensibili. Il tool separato del worker `orphans.mjs` identifica gli orfani attraverso label e `docker inspect`, con dry-run iniziale e doppia verifica prima del cleanup esplicito. Sono necessari journal integro, stato `failed/incomplete`, assenza di claim e conferma dell'UUID completo; qualunque difformità blocca la rimozione. Non esistono API pubbliche per Docker, non si cancellano prove e non si riavviano test. Questo riduce il rischio operativo dopo crash ma non sostituisce fencing multi-host, recovery automatica sicura o l'audit di un daemon rootless su VM dedicata.


### Attestazione offline di export runner, senza chiavi in API (#23)

Il bundle autenticato `GET /v1/jobs/{id}/evidence` include il report completo e la chain di journal. Una verifica pura `verifyEvidenceExport` controlla sequenza, snapshot, hash e report anche senza accesso al server. L'operatore può firmare *offline* con Ed25519 un manifest minimale contenente job ID, digest, stato, head/count e digest SHA-256 canonico del bundle; la private key resta fuori dall'infrastruttura runner, ed il destinatario verifica con una public key pinned separatamente. Nessuna chiave è trasmessa dalla API, e nessun nuovo endpoint può firmare per conto di un runner compromesso. Questa soluzione impedisce di riutilizzare firme preesistenti per un journal riscritto, ma non attesta che Docker sia stato eseguito né protegge da firme di output falsificati a monte: #2 rimane aperta per attestation off-host automatica e deployment reale.


### Checkpoint del re-test fra Code Agent e runner (#24)

Il repair AI resta un flusso supervisionato **dentro la SPA**: l'interfaccia ricarica il report dall'API protetta prima del prompt, poi registra nel pending `repairTrail` con jobId/digest/step del fallimento e invalida la vecchia review. Dopo nuova review indipendente, la policy pura `planRepairRetest` propone gli step obbligatori (precedenti + build per file .cs/web/E2E); l'utente concede nuovamente il consenso alla trasmissione del codice. `RunnerPanel` calcola il nuovo hash dello snapshot e non associa ricevute con digest o UUID difformi, preservando la chiave idempotente sui retry. La verifica di approvazione si basa su **un nuovo report terminale** del digest del codice corrente e su tutti gli step del piano, non sulle affermazioni del modello. Non esiste un processo in background che possa modificare repository o server senza approvazione.


### Registro server-side dei checkpoint del repair (#25)

`src/runner/coordinator.mjs` registra un workflow finito sotto `/data/repair-sessions/{UUID}.json` sullo stesso volume delle prove Docker. Le API Bearer `POST /v1/repair-sessions`, `GET /v1/repair-sessions/{UUID}` e `POST /v1/repair-sessions/{UUID}/checkpoints` sono separate dai job: non possono lanciare Docker, invocare modelli AI, approvare sorgenti o scrivere GitHub. Transizioni esplicite `awaiting_patch/review/retest/approval`, fallimenti e max 2 tentativi, con prova di re-test reale verificata dal journal del job. Concorrenza serializzata via lock admission e eventi hash-chained scritti con rename atomico. La history conserva identificatori e digest, **non** codice/log/credenziali. Il badge `recorded_approval` è una dichiarazione del titolare della API key, non una prova esterna di consenso e non apre nuove capacità. Il client SPA rimane supervisionato separatamente: la sincronizzazione automatica con le nuove API è un lavoro successivo. È un ledger locale senza isolamento multi-tenant/fencing e senza attestazione hardware.


### Browser ↔ checkpoint repair persistenti (#26)

La SPA passa ora dal puro stato volatile ai checkpoint `/v1/repair-sessions` della #25 durante le operazioni supervisionate. Il binding `repairSession` nel pending conserva soltanto UUID e origin (mai bearer), attraversa i due tentativi e viene scartato con la patch. Il client consulta lo stato remoto prima di ogni checkpoint e rifiuta collisioni di stato/digest/endpoint, prepara `patch` e `review` al consenso del re-test e sincronizza lo stato terminale reale dai job verificati. Prima dell'apply locale richiede anche il checkpoint remoto `recorded_approval`, riverificato dal server. Questo evita approvazioni basate soltanto sulla memoria volatile del browser, senza conferire al coordinatore il potere di eseguire AI, Docker o Git. Il registro continua a contenere **dichiarazioni** della API key comune, non attestazioni di identità o consenso indipendenti; #2 rimane aperta.


### Perimetro di autenticazione degli operatori repair (#27)

Le API Docker execution mantengono la API key legacy ma il coordinatore `/v1/repair-sessions*` usa ora un registro **server-side** di credenziali operatore separate e con ruoli `propose/review/approve`; con registro assente il coordinatore fallisce chiuso e i job rimangono disponibili. Il nuovo modulo `operator-auth.mjs` valida ruoli/ID/segreti unici e ricava in modo timing-safe l'identità della chiave; l'API autorizza lo scope prima di accedere ai file del ledger. Ogni nuovo checkpoint contiene `actorId` e il suo SHA-256 lo include nella chain, senza registrare il token. I checkpoint precedenti restano leggibili come legacy/unattributed; il frontend usa un secondo token in sessionStorage solo per il ledger. **Non** è OIDC, RBAC multi-tenant, autenticazione personale, né two-person rule: un token con più scope può firmare dichiarazioni diverse. Approvazioni indipendenti firmate, revoca distribuita e governance restano nella #2.
