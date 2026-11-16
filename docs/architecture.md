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


### Scansione idempotente e integrità durante il repair concurrent start (#28)

La admission del coordinatore conserva il lock globale POSIX, ma un retry di `beginRepairSession` **non può** ignorare i record vicini per aver già trovato un rootJobId corrispondente. Vengono verificati tutti gli snapshot, incluso il checksum della chain, prima della restituzione dell'ID. Una ricognizione anomala può essere ripetuta solo due volte a distanza breve, per distinguere una voce temporanea dalla corruzione persistente. Il sistema fallisce con 409 per un volume incoerente, senza recuperi automatici o cancellazione di evidenze. Non equivale a fencing su host multipli.


### Controllo delle transizioni fra attori distinti sul runner (#29)

Il journal di repair usa la firma logica `actorId` della credenziale operatore per imporre a server-side gli invarianti: proponente del primo evento uguale per tutti i `patch/retest_*`, revisore diverso per tentativo, approvatore diverso da entrambi. L'invariante viene calcolato sia prima dell'atomicWrite sia dopo aver ricostruito la hash-chain da disco: una mutazione che cambia attore dopo la revisione fallisce chiusa con 409. Le sessioni legacy prive di actor restano leggibili ma non possono aggiungere nuove dichiarazioni con un ID retroattivo. La SPA adotta un workflow a tre click, con cambi espliciti di chiave in sessionStorage e senza invio di sorgenti prima del terzo consenso. Le prove restano dichiarazioni di **credenziali**, non identità umane o firme indipendenti. Non è un sistema di IAM federato o multi-tenant.


### Evento started con timestamp atomico logico (#30)

L'hash-chain del registro repair richiede che l'istante di creazione della sessione coincida esattamente con l'istante del primo evento. L'implementazione usa lo **stesso valore ISO** per entrambi, evitando falsi conflitti alla transizione di millisecondo, mentre gli eventi successivi ricevono un timestamp autonomo. La verifica non allenta alcun vincolo e non tenta di correggere history persistite.


### Registro degli operatori riletto per richiesta, fuori dal worker (#31)

`operator-auth.mjs` può leggere il JSON di operatori a ogni chiamata repair da un percorso file assoluto montato **soltanto nel container API**. `O_NOFOLLOW`/fstat e una lettura bounded verificano file privato senza hardlink, schema, credenziali e scope senza loggare segreti. Ogni richiesta carica il registry più recente e invalida dal Bearer vecchio dopo rotazione o revoca; un errore nel file risponde 503 e non influenza le API build/test. Il ledger conserva ID immutabili, preservando la separazione per actor della #29. L'override Compose separato monta la **directory** host read-only, non il singolo file (che pinna l'inode e non osserva `rename`); il preflight garantisce nessun mount verso il worker. Il JSON inline legacy resta statico all'avvio. Le richieste già in-flight non sono retroattivamente cancellabili, e non esiste ancora un IdP/tenant registry esterno.


### Re-autenticazione sotto lock dei checkpoint (#33)

Nel file registry della #31, la lettura all'ingresso della richiesta autorizza l'accesso HTTP ma potrebbe diventare stale mentre il POST attende `jobs/.admission`. Prima di iniziare qualsiasi operazione sul ledger, lo stesso lock richiama una nuova verifica del Bearer (file riaperto con i gate di #31/#32), dello scope e dello stesso `actorId` catturato alla prima autorizzazione. Se la credenziale è ruotata/revocata nel frattempo, non viene prodotto un nuovo evento e si risponde 401/403/503. Non si applica un altro lock ai job o ai GET. Il file di secret e lo snapshot non condividono una transazione: una revoca *successiva* al secondo gate può ancora lasciare completare la mutazione; questo non risolve consistenza multi-host o identità umana verificabile (#2).


### Verifica di tutti i job in admission e replay corrente (#34)

Le quote locali e la deduplicazione della #20 ora usano `verifyJobEvidence` per **ogni** job conservato, entro il lock POSIX: un journal sibling invalido o uno stato terminale alterato non può far passare una nuova ammissione né un replay. In caso di collisione con il breve intervallo journal fsync → report rename del worker, sono ammesse due nuove letture bounded; la corruzione persistente rende l'admission indisponibile con 503 e non provoca cleanup. Il replay dello stesso UUID+digest ritorna lo stato verificato del report esistente, senza inventare `queued`. La SPA considera la receipt solo un binding al job e richiede sempre verifica del report intero prima di affermare che un test sia passato. Il controllo è locale e non sostituisce firma off-host, fencing host o isolamento tenant (#2).


### Budget globale di accettazione dei job (#35)

La serializzazione `/data/jobs/.admission` supporta una policy opzionale di **nuove ammissioni negli ultimi 60 secondi** (`RUNNER_MAX_ACCEPTED_PER_MINUTE`, default 0). La scansione già verificata in #34 rende disponibili `acceptedAt` senza indice secondario: le repliche sul medesimo volume serializzano il conteggio, i replay idempotenti non consumano un nuovo slot e i job terminali recenti rimangono nel budget. Su soglia raggiunta HTTP 429 `rate_limited` con `Retry-After`, nessun nuovo record. Timestamp invalidi falliscono con integrità, quelli futuri contano conservativamente. Questo è un controllo globale su volume conservato, non RBAC tenant/IP né un sistema di rate limit distribuito (ancora #2).


### Finestra di consistenza HTTP per evidence journal (#36)

Il writer del runner segue una sequenza di sicurezza `append+fsync(journal) → rename(report)`, per non dichiarare un risultato non ancora registrato. Non essendo un commit transazionale multi-file, i lettori HTTP senza claim possono vedere brevemente journal nuovo/report vecchio. I due GET di job e bundle riprovano la **verifica completa** fino a tre volte, soltanto su `EVIDENCE_INVALID`, per non bloccare il polling su un falso 409 transitorio. Corruzione persistente e assenza di file restano errori; non esiste sincronizzazione distribuita, auto-healing delle prove o garanzia che i test siano stati effettivamente eseguiti su una VM fidata. Restano in #2.


### Polling resiliente ma fail-closed del client (#37)

La SPA interroga il report del job con `AbortController` e un timer disattivabile. Un `RunnerRequestError` trasporta status HTTP e classificazione di recuperabilità: rete/408/429/5xx permettono al più 5 retry GET con backoff bounded, azzerati dopo un successo; 401/403/404/409 e JSON errato fermano il ciclo e invalidano la visualizzazione di report non più leggibili. Un pulsante riprende solo il GET dello stesso UUID, mai crea o approva job. I timer e le fetch sono cancellati su variazione di credenziali/endpoint/job o unmount. È una misura UX/affidabilità del control plane browser, non affidabilità del daemon, revoca garantita o attestazione off-host (#2).


### Worker readiness separata dall'HTTP API liveness (#38)

La API espone `/healthz` non autenticata soltanto per la propria responsività. Il `runner-worker` aggiorna ogni 5s un file JSON privato tramite rename atomico sul volume condiviso, con instanceId non segreto e timestamp. Un timer indipendente dalla funzione di esecuzione Docker permette segnali di liveness anche mentre il worker aspetta test lunghi. Il GET autenticato `/v1/readiness` apre l'heartbeat con protezioni no-follow/UID/mode/file size e accetta soltanto timestamp canonical ISO entro la soglia 10–300s configurabile (30 default). Altrimenti risponde 503 fail-closed, senza rivelare dettagli, lasciando gli endpoint job e il loro journal indipendenti. Il segnale non autentica il daemon Docker né garantisce che il processo worker terminerà un job, e un crash può restare visibile come ready per l'intera soglia; osservabilità vera/attestation remota e VM rootless richiedono #2.


### Monitoraggio rootless daemon a due segnali (#39)

La responsività del timer Node nel worker (#38) non equivale a disponibilità Docker. Il worker ottiene un segnale **separato** tramite il comando read-only `docker info` sul proprio socket locale e confronta l'array di SecurityOptions con `name=rootless`; non sono ammessi Docker host di rete né Docker credenziali ambientali. Un probe ogni 10s con timeout 5s non blocca il ciclo dei job né il timer heartbeat. Il file versionato 2 con proprietà privata contiene solo stato booleano, timestamp del probe e timestamp del worker, mai sorgente, output Docker o socket. L'API senza socket legge il file con i controlli nofollow/fstat: `/v1/execution-readiness` autenticato risponde 200 soltanto se heartbeat e rootless probe sono recenti, 503 altrimenti; `/v1/readiness` rimane il check meno forte del processo worker (anche con v1 legacy). Il probe non dimostra l'esecuzione di un container né sostituisce sandbox/attestation off-host o controlli Cloudflare su VM reale (#2).


### Canary operator-only del runtime effettivo rootless (#40)

Dopo il probe read-only periodico (#39), un comando **separato, non esposto via API** consente all'operatore sulla VM di provare una vera creazione ed esecuzione di un container su Docker rootless. Il canary richiede `--confirm` e immagine `node@sha256:<digest>` già disponibile, non ha egress/pull automatico, usa un nome UUID e label distintiva, costruisce un set fisso di restrizioni (network none, rootfs read-only, cap-drop, no-new-privileges, UID non-root, CPU/RAM/PID/tmpfs e nessun mount) e ne verifica il risultato anche da `docker inspect`. Dopo esecuzione controlla output sentinella e stato/exit code, e rimuove soltanto il container verificato. Errori di cleanup o identità anomala falliscono chiusi; l'API continua a non avere socket Docker. Il test è un canary Node, non una prova di toolchain completi né attestazione anti-host-compromise, e deve ancora essere **eseguito sulla VM reale** nell'epica #2.


### CI smoke del canary con Docker Engine reale, senza confondere rootful e rootless (#41)

La CLI canary della #40 era verificata con stub: la CI ora chiama un test separato, non raggiungibile via API o worker, su host GitHub non privilegiato ma con accesso al daemon **rootful** effimero. Si ottiene l'immagine Node per digest dalla cache locale e si invoca il flusso canary fisico con iniezione locale del solo probe e del socket, dopo aver accertato via Docker info che il daemon è rootful. Un successo richiede tutti i controlli runtime del canary e cleanup, non genera claims `rootless` e produce soltanto un marker esplicito `ROOTFUL_CI_ONLY`. La CLI operativa `--confirm` continua a rifiutare daemon rootful. Questa verifica di compatibilità di Docker Engine **non** costituisce prova rootless su VM né attesta off-host i risultati (#2).


### Fence di sessione per CRUD React OIDC (#42)

Il componente `WorkItems` dell'app generata conserva un `sessionEpoch` monotono oltre al token attivo. Ogni cambio login/token/refresh/logout, 401 corrente o BroadcastChannel di logout incrementa l'epoch sincronicamente e libera lo stato busy della sessione precedente. Ogni GET e mutazione POST/PUT/DELETE cattura coppia (accessToken,epoch) e verifica entrambe prima di aggiornare dati, errori, editing o disponibilità form; anche i finally obsoleti e i 401 vecchi sono scartati. Non si cerca di revocare o annullare operazioni già accettate dal server: il perimetro protetto è la **UI di un'identità diversa**. Test fullstack Chromium + provider OIDC effimero + ASP.NET/PostgreSQL trattiene una vera risposta POST prima della consegna, emette logout cross-tab, rilascia e verifica assenza di contaminazione. BFF/cookie HttpOnly e revoca off-tab restano fuori e nella #9.


### Coerenza tra clock e rename heartbeat (#43)

Il file heartbeat viene aggiornato da un writer atomico indipendente dai GET. Un `Date.now()` catturato **prima** dell'I/O del lettore, riusato per la verifica del JSON letto dopo un rename, può far apparire un record fresco come proveniente dal futuro. Il controllo execution-readiness ora lascia che il parser misuri il clock dopo la lettura e verifica il TTL del probe con un nuovo clock post-I/O; un clock di test iniettato mantiene invarianti deterministici. Nessuna modifica al contenuto o alla fiducia del segnale: timestamp futuri reali e compromissioni restano errori, la #2 richiede ancora controlli off-host e VM dedicata.


### OIDC RBAC con ruolo applicativo univoco (#44)

Dopo la verifica RS256/JWKS dell'access token, le policy ASP.NET Core dei WorkItems ora controllano sia l'unicità/forma di `sub` sia l'unicità del claim `role`. L'unico ruolo consentito è `reader` o `editor`: più claim, payload multi-role o valori sconosciuti non devono diventare privilegi attraverso `RequireRole` che altrimenti accetterebbe un elemento `editor` nell'elenco. I token firmati senza ruolo applicativo univoco ricevono 403; firma/issuer/audience/exp non validi 401. I provider reali devono emettere un singolo claim normalizzato tramite mapping sicuro, senza scegliere arbitrariamente tra ruoli concorrenti. Test CI su provider RSA effimero + API ASP.NET/PostgreSQL dopo rotation JWKS, senza registrare token. Non aggiunge revoca server-side o IdP reale (#9).


### Logout OIDC non riattivabile da silent refresh tardivo (#45)

`WorkItems` usa una barriera `logoutFence` per documento, settata immediatamente prima di logout locale, 401 corrente, userUnloaded o messaggio BroadcastChannel. Dopo la barriera, né la risposta asincrona di `getUser` iniziale né callback `signinRedirectCallback` né `userLoaded` generato da un refresh già in corso possono riattivare la sessione. Un `userLoaded` tardivo è ignorato e il client elimina l'utente eventualmente già riscritto in sessionStorage senza innescare un altro broadcast. La barriera riparte falsa solo con un documento ricreato dal nuovo login interattivo. Inoltre ogni transizione di token, anche A→B non vuoti, azzera dati, editing, title, draft e busy prima di mostrare la nuova identità, continuando a usare `sessionEpoch` per risultati CRUD obsoleti. La CI intercetta un token refresh reale del provider RSA/PostgreSQL in un browser a due tab e verifica disconnessione persistente dopo rilascio. Il modello non protegge da revoca distribuita, host browser malevolo o token rubati e non è BFF HttpOnly (#9).


### Rate-limit rolling: Retry-After dopo configurazioni ridotte (#46)

La quota di ammissione globale è valutata sotto lo stesso lock POSIX condiviso. Una nuova configurazione più restrittiva può osservare N job recenti dove N supera il nuovo cap C; il calcolo della scadenza usa l'elemento cronologico `N-C` e non il timestamp minimo, perché soltanto dopo la scadenza di N-C+1 accettazioni rimangono meno di C record nella finestra. Ogni timestamp è derivato da report/journal SHA verificato; record futuri continuano a pesare conservativamente e `Retry-After` rimane un hint HTTP 1–60s. Nessuna nuova credenziale, storage o IAM tenant è introdotta e la #2 rimane aperta.


### Inode heartbeat rimpiazzato dopo open e prima di fstat (#47)

La scrittura atomica mediante rename sostituisce l'inode. Su POSIX un FD già aperto sul vecchio file può riportare `nlink=0` pur in presenza del nuovo file regolare; il precedente validator `nlink===1` lo trattava come un heartbeat invalido senza nuovo tentativo, generando 503 intermittenti durante polling rapido. L'API ora identifica il solo caso di inode regolare *unlinked* e ripete la verifica completa con un nuovo FD, fino a tre tentativi, senza mai dichiarare ready su inode non collegati. Hardlink, symlink, permessi e UID errati, JSON invalido, timestamp futuri/scaduti o probe Docker non-rootless non diventano autorizzati. Non cambia il confine di fiducia del daemon né fornisce prove off-host (#2).


### File offline Ed25519 legati all'inode verificato (#48)

L'attestatore non deve fare `lstat` su un percorso e poi un `readFile` distinto: una sostituzione tra le due operazioni può sfuggire al controllo su symlink, ownership e size. Adesso ogni input (bundle, receipt, signing key privata e public key trusted) è aperto mediante `O_NOFOLLOW`, controllato con `fstat` sul descriptor, letto bounded sul medesimo inode e controllato di nuovo dopo la lettura. File regolari con `nlink=1`, dimensione 1..limite, UID/mode specifici delle chiavi e assenza di modifica simultanea sono obbligatori. La verifica pubblica accetta 0644 solo se il file è dell'operatore e non group/world writable. Il signing key PEM rimane esclusivamente nella postazione separata dal worker e dall'API; questa misura non attesta l'esecuzione Docker/VM e non pubblica prove in modo automatico (#2).


### Lettura coordinatore repair su FD fidato e binding dell'ID (#49)

Il repair ledger usa hash-chain di checkpoint, ma una verifica `lstat(path)` prima di `readFile(path)` non garantiva che l'inode letto fosse quello validato. Il coordinatore ora apre un'unica FD `O_NOFOLLOW`, valida owner API, regolarità, nlink=1 e size bounded prima di una lettura dallo stesso FD e controlla nuovamente i metadata; file unlinked durante rename atomico causano soltanto riaperture limitate, mentre symlink, hardlink o file corrotti restano fail-closed. Inoltre `verifyRepairSession` controlla la chain interna e `readSession` vincola esplicitamente `record.id` all'UUID del nome richiesto: un documento B valido non può essere restituito o mutato attraverso route A. Questo mantiene audit locale e compatibility legacy, ma non fornisce proof off-host né transazioni distribuite (#2).


### Evidence per-job letta e verificata su inode sicuri (#50)

Il report di un job e il suo journal SHA-chain non sono autorevoli se `readFile(path)` può seguire symlink, aprire file sostituiti dopo un controllo sul pathname o caricare payload non limitati prima della verifica. Il server e worker usano ora `open(O_NOFOLLOW)` e `fstat` sullo stesso FD per ciascun file con owner UID, regolarità, `nlink=1`, `mode & 022 = 0` e size 1..4MB; la lettura è limitata e seguita da verifica di stabilità dell'inode. File unlinked non sono mai validi, e il retry bounded già esistente riapre per verificare la nuova versione dopo una rename lecita. La hash-chain e il digest esistente rimangono il medesimo modello di fiducia **locale**, non un'ancora indipendente. File insicuri non possono liberare quota, sbloccare checkpoint o risultare `passed` dopo manomissione. #2 rimane aperta per firma indipendente, VM e tenant.


### Runner API file-backed key rotation, senza exposure al worker (#51)

Una modalità opt-in `RUNNER_API_KEY_FILE` sostituisce il singolo segreto env statico: l'API apre con O_NOFOLLOW il file privato a ogni richiesta e usa fstat del **medesimo FD** prima/dopo lettura bounded per validare owner UID, mode owner-only, nlink=1 e size. L'override Compose monta la directory host dei segreti read-only **solo nell'API**; il worker non ha la chiave e non viene modificato il suo socket Docker rootless. Entrambe le API vedono il rename atomico e rifiutano immediatamente i bearer vecchi; se il file non è sicuro non esiste fallback a un segreto precedente. L'ammissione ricarica la chiave sotto lock anche prima del replay e dell'allocazione job, preservando il fail-closed su revoca concorrente. È ancora una singola chiave globale per tutti i job, **non** separazione IAM per tenant e non sostituisce Cloudflare Access/TLS o un'autorità indipendente (#2).


### Perimetro multi-tenant iniziale del runner (#52)

In opt-in, l'API sostituisce la singola key globale con un registry JSON owner-only `RUNNER_TENANTS_FILE` sulla **directory bind-mounted nella sola API**. Ogni invocazione autentica un principal tenant tramite bearer con prefisso ID obbligatorio; l'API non accetta il tenant comunicato dal payload. Sotto il lock POSIX globale, ammissione e replay verificano sempre TUTTI i report hash-chained e applicano sia le quote globali che quelle del tenant: conteggi queued, retained e finestra scorrevole per tenant. Le accettazioni registrano `tenantId` nel primo evento accepted, e `verifyEvidenceExport` impone che ogni record della chain mantenga il medesimo tenant. Le GET di JSON ed evidence sono consentite solo al principal tenant proprietario, con ri-autenticazione dopo eventuale lettura asincrona; gli ID stranieri e le prove corrotte in modalità tenant non rivelano il report. La chiave può essere revocata con rename e la decisione POST viene controllata di nuovo nel lock, insieme alle quote correnti. Job legacy senza tenant restano verificabili dal sistema/worker ma non visibili a client tenant.

Il confine di fiducia rimane una sola API e un solo volume POSIX: tenant non sono namespace POSIX né container diversi, un operatore host con accesso al volume potrebbe riscrivere prove, e l'operatore repair non dispone ancora di scope per tenant (route vietata fino a implementazione). Nessuna promessa di IAM federato, scheduling fairness o isolamenti Cloudflare/VM/multi-host: #2 resta aperta.


### Inode di input del worker verificato prima dell'esecuzione (#53)

Le evidenze del job (#50) e il payload sorgenti non devono avere modelli di lettura incoerenti: ora `executeClaimedJob` apre `input.json` con un'unica FD `O_NOFOLLOW`, controlla owner UID, regolarità, nlink=1, permessi non scrivibili da gruppo/altri e dimensione 1–8MB, legge bounded e verifica che inode/mtime/ctime/size/mode siano invariati. Solo dopo esegue `validateRequest` e il confronto digest con la chain verificata, prima di qualsiasi step Docker. Un symlink, hardlink, inode unlinked o file alterato non diventa codice eseguibile né prova di successo; file legacy 0644 non scrivibili restano accettati. È una difesa locale e non dimostra attestazione, fencing multi-host, rootless VM o identità tenant federata (#2).


### Preflight del worker e classificazione probatoria degli esiti (#54)

Un job con report validato ma input non caricabile, symlink, permessi insicuri o digest diverso non ha eseguito nemmeno uno step di codice: trasformarlo da `queued` a `failed` avrebbe confuso un guasto del runner con un difetto del programma e avviato un possibile repair AI non giustificato. Il worker registra invece una sola transizione `queued → incomplete` con evento `rejected`, summary generica e `finishedAt`, sotto claim atomica e su report/journal verificati; nessun retry automatico o `started` artificiale. La verifica API conferma `accepted,rejected` e il coordinatore richiede `failed` con step fallito realmente eseguito. Restano invariati recovery `running → failed`, audit, quote, rate e idempotenza (#2).


### Separazione tra eccezione del worker e fallimento reale di un test (#55)

Anche dopo `started`, il worker può fallire durante preparazione del filesystem o pianificazione/esecuzione dei passi senza aver ricevuto un risultato di test. In `executeClaimedJob`, un'eccezione inattesa determina `incomplete`, non `failed`, e il summary resta generico per non riversare potenziali segreti di host nel journal hash-chain. `finishedAt`, evento `finished` e cleanup del workspace restano in `finally`; il branch normale conserva `failed` per una ricevuta effettiva di test fallito e `passed` solo con tutti gli step superati. I report `incomplete` non autorizzano AI repair né una riesecuzione automatica. Restano invariati policy di `running` orfano, quote/idempotenza e confini di fiducia rootless/IAM/attestation (#2).


### Scheduling equo tra tenant senza nuove autorità di stato (#56)

Le quote di ammissione della #52 evitano l'overflow per tenant ma una FIFO globale nel worker può comunque ritardare i job di altri utenti dietro molti job più vecchi. Il selettore puro del worker raggruppa i job `queued` senza claim per `tenantId` (con un gruppo `null` per legacy), prende il più vecchio di ciascun gruppo e confronta gli ultimi `startedAt` di report conservati **già verificati** da `verifyJobEvidence`. Preferisce tenant mai serviti, poi il servizio meno recente, risolvendo i pareggi con `acceptedAt` e UUID. Non introduce un nuovo ledger, token, DB o stato effimero inter-worker: due poller vedono la stessa cronologia sul volume POSIX e la claim atomica protegge l'esecuzione. Un `queued` rifiutato prima del primo step non viene contato come servizio; la coda integralmente legacy resta FIFO. Il criterio è best-effort, dipende da retention e timestamp di host e non garantisce latenza, fairness distribuita tra storage indipendenti o isolamento compute. ADR 0013 e #2.


### Un probe rootless precedente non autorizza ogni Docker step futuro (#57)

I controlli `execution-readiness`/heartbeat (#39) sono interrogabili ma non bloccavano il codice dentro `runDockerStep`: un'API poteva accettare job mentre il daemon fosse rootful e il worker avrebbe comunque lanciato il container. Adesso il confine di esecuzione è nel punto immediatamente precedente a `spawn("docker",...)`: ogni step invoca il probe bounded `probeRootlessDocker` che controlla il **daemon attuale** attraverso un socket UNIX locale allowlisted. Solo `=== true` autorizza l'avvio. Falso/errore => eccezione generica e `incomplete` nell'handler worker (#55), mai un `passed` fabbricato. Anche `npm-prepare` viene verificato; nessun token o output Docker del probe entra nel report. La callback opzionale del probe è esclusivamente un seam Node per test; GitHub hosted rootful la inietta nei tre script di smoke CI, con guardia GITHUB_ACTIONS/CI/UID, mentre `runner-worker` usa soltanto il probe reale. Non esiste configurazione remota per disattivare il gate. Il controllo è JIT, non una binding atomico del socket o un attestato di VM: restano in #2 rootless VM, tunnel Access/IAM e attestazione indipendente (ADR 0014).


### Container Docker scaduti: cancellazione per ID e non per nome (#58)

Un timeout può lasciare attivo il container anche dopo SIGKILL della CLI. Il precedente `docker rm -f <name>` era vulnerabile alla riassegnazione del nome e mancava delle prove di identità già richieste alla ricognizione manuale #21. L'automazione verifica ora il container per nome e poi per ID completo a 64 hex tramite due `docker inspect`, confrontando in entrambe le risposte il nome e le tre label (`softwarefactory.runner`, `softwarefactory.job-id`, `softwarefactory.step`); richiede rootless prima e dopo le verifiche, quindi elimina **soltanto** per ID immutabile. Le chiamate sono bounded, senza shell o segreti nei log. Qualsiasi incertezza lascia intatto il container per revisione manuale; il report non viene completato prima del tentativo di cleanup. Non esiste atomicità crittografica tra inspect e rm su host compromesso, né fencing cross-host o attestazione off-host (#2, ADR 0015).


### Riconciliazione operatore: il daemon deve essere rootless anche alla rimozione (#59)

Un `docker info` prima della sola prima chiamata del processo non è un gate di sicurezza: durante una sequenza `ps→inspect→inspect→rm` lo stesso endpoint socket può passare a un daemon rootful, mentre `inspectedHost` conservava il vecchio risultato. La CLI operatore del runner ora verifica `name=rootless` su **ogni comando** attraverso la medesima URI Unix allowlisted, con ambiente minimo (`HOME`, `DOCKER_CONFIG`, `DOCKER_HOST`, `PATH`) e parser strict bounded. Qualsiasi risposta inattesa, daemon rootful o errore CLI termina il comando con errore generico, senza invocare l'operazione successiva. Test con journal reali simulano l'host che cambia solo prima di `rm`, verificando zero rimozioni. Questa misura completa i controlli per-step #57 e per-timeout #58 ma non offre una transazione atomica sul socket, fencing multi-host o attestazione esterna (#2, ADR 0016).


### Registro operatori repair: credenziali derivate soltanto da un inode stabile (#60)

La #31 ha introdotto il registro operatori per API a rotazione hot; tuttavia la lettura controllava `O_NOFOLLOW`, UID e mode prima di `read`, non la stabilità durante una scrittura in place. `loadRepairOperatorsFile` ora usa il medesimo FD per pre-stat, lettura di **esattamente** `size` byte bounded e post-stat; confronta dev/ino/uid/gid/nlink/mode/size/mtimeMs/ctimeMs. Solo uno snapshot invariato passa a `configureRepairOperators`. Con mutazione concorrente la richiesta repair fallisce con codice generico, senza riutilizzare una registry precedente. La sostituzione atomica del pathname non muta l'FD già aperto: quel lettore ottiene un unico snapshot coerente, mentre le nuove richieste vedono il nuovo inode. La logica di reauthorize sotto lock non cambia. Non è una barriera contro il controllo maligno della macchina ospite né un attestatore off-host; ADR 0017 e #2.


### Crash recovery: incompleto non è un test fallito; journal preservato (#61)

Se il worker perde la claim quando un report è ancora `running`, non esiste prova di completamento dei test né garanzia che il container sia stato fermato. Il precedente `recoverUnclaimedJob` segnava `failed` con evento `recovered`; ora, dopo lock/riverifica, registra `incomplete` e mantiene le evidenze degli step già prodotti. Il coordinator controlla anche **l'ultimo tipo evento**, rifiutando AI repair sui recovery `recovered` storici con `failed` (indipendentemente da un eventuale exit code parziale). Il verifier non riscrive journaling legacy: tali report restano leggibili e l'API li presenta come storici.

La retention prima cancellava i job terminali per età anche dopo una recovery, lasciando eventualmente container vivi senza il journal che la CLI operator-only `orphans.mjs` richiede per il cleanup. Adesso la scansione del worker esclude l'ultimo evento `recovered`, ri-verificando la stessa condizione *dentro il lock di admission* prima di ogni rimozione. La protezione è per ultimo evento verificato e vale anche per report legacy `recovered+failed`; terminali normali scaduti si cancellano come prima. Trade-off: quote e storage del recovered vengono trattenuti in modo conservativo finché l'operatore, dopo aver bloccato worker/API e riconciliato i container, non rimuove esplicitamente i dati. Niente cleanup automatico basato su tempo, nessuna garanzia di fencing multi-host o attestazione Docker (ADR 0018, #2).


### Rootless canary: identità del daemon verificata just-in-time per ogni comando (#62)

Il canary di isolamento operatore controlla un container effimero senza privilegi e rete, ma il precedente `probeRootlessDocker` era eseguito solo prima del `create`. Se il daemon che risponde sul socket cambiava fra ispezione, avvio e rimozione, un `rm -f` poteva partire senza attestazione corrente. `runRootlessCanary` ora interroga `probeRootlessDocker({host})` per ogni comando Docker e accetta solo `true`: `create`, primo `inspect`, `start`, `inspect` finale, nuovo `inspect` del cleanup e rimozione per ID completo. Fallimenti/throw del probe non raggiungono `runDocker` e non rivelano diagnostiche del daemon; un fallimento del cleanup forza investigazione manuale, mai un report `passed`. Test Node stateful provano il daemon che diventa rootful prima di `start` o `rm` e il ripristino successivo. Lo script CI rootful rimane isolato nel codice fidato; nessun controllo via API può disattivare la guardia. Il controllo JIT non lega atomicamente l'inode del socket e non sostituisce il collaudo di una VM rootless reale o l'attestazione off-host (ADR 0019, #2).


### Canary di isolamento: riconciliazione controllata dei residui (#63)

Un crash fra `docker create` e la validazione del container può lasciare un residuo marcato `softwarefactory.canary`; per scelta di sicurezza #62 il canary non cancella un oggetto che non è riuscito a ispezionare. La CLI `orphans.mjs` protegge invece soltanto i job con report/journal e label `softwarefactory.runner=job`. Il nuovo tool `canary-reconcile.mjs` è una procedura separata **operator-only** con UUID visibile prima del create, dry-run di default e `--apply --confirm-canary=<UUID>` obbligatorio per il delete. Verifica rootless a ogni comando, trova un solo container con label precisa, valida ID completo, nome, assenza di label runner, configurazione di isolamento e stato non-running, ripete `inspect` per ID prima di eliminare *solo per ID*. Errori/sostituzioni/running non consentono cancellazioni implicite. Nessuna route API, nessun job input e nessuna opzione di produzione bypassano il probe. La scelta non offre un fencing cross-host o un legame atomico del socket (ADR 0020, #2).


### File credenziali di preflight: owner-only, O_NOFOLLOW e pre/post fstat (#64)

`preflight.mjs` è una CLI operator-only che legge `RUNNER_API_KEY` da `--env-file` per verificare il deployment host/endpoint. La vecchia validazione del pathname `lstat` seguita da `readFile` apriva una finestra TOCTOU: il file effettivamente letto poteva non essere quello controllato, e un file senza limite di lunghezza poteva consumare memoria inutilmente. La lettura ora apre **un solo FD con `O_RDONLY|O_NOFOLLOW`**, richiede uid=euid, nlink=1, mode 0600 e size da 1 a 32768 byte; usa lettura per offset dell'esatta dimensione e ripete `fstat` sullo stesso FD confrontando dev/ino/uid/gid/nlink/mode/size/mtimeMs/ctimeMs. Il parser viene eseguito solo per snapshot stabile. L'eventuale fallimento non include pathname, secret o diagnostica FS, non riusa una vecchia configurazione. Rotazione via rename atomico di un file completo è consentita fra invocazioni; non equivale a revoca in tempo reale né attestation del vero host. ADR 0021 e #2.


### Preflight Compose: fallire chiuso per l'intero stack (#65)

L'analisi JSON del Compose risolto verificava solo `runner-api`, `runner-worker` e alcuni privilegi del tunnel, ma **ignorava tutti i servizi sconosciuti**: un override poteva aggiungere un container privilegiato con porta e socket esposti senza invalidare il `passed` del preflight. Il gate ora ammette esclusivamente i due servizi e, se abilitato, `cloudflared`. Il tunnel non può montare host path, volumi, tmpfs, `volumes_from`, `secrets`, `configs` o dispositivi né condividere network/PID/IPC; inoltre API e worker negano i mount impliciti (`volumes_from`, `secrets`, `configs`, `tmpfs`) che potrebbero far ereditare all'API il socket del worker; i mount del runner devono essere bind canonici con sorgenti host non di sistema, data/work disgiunti ed eccezione stretta per il **solo** socket rootless nel worker. Ogni estensione a sidecar passa per revisione e test espliciti. Non viene fornita attestazione runtime, protezione da symlink host o fencing multi-host: il preflight `host` e la VM rootless reale restano indispensabili (#2, ADR 0022).


### Verifica HTTPS Access Service Auth dall'operatore, non dal browser (#66)

La Factory SPA non deve possedere i service token Cloudflare: la loro coppia di header `CF-Access-Client-Id` / `CF-Access-Client-Secret` può attraversare il gateway e non deve essere resa disponibile a JavaScript non fidato. `preflight.mjs endpoint` ora può caricare la coppia da file locale privato `--env-file`, validando formato bounded e completezza. Prima esegue una GET `/healthz` *senza* token (deve essere rifiutata con 302/401/403, senza seguire redirect), poi quattro richieste GET/OPTIONS con token Access che mantengono il protocollo Bearer `RUNNER_API_KEY` separato: la stessa richiesta senza Bearer deve produrre 401 lato API, quella con Bearer 200 e la preflight CORS deve essere esplicita. Output soltanto booleani, nessuna risposta/body/Location o token. La negazione unauth può provenire da altri proxy: da sola **non attesta** Cloudflare, SSO, Zero Trust policy, login browser, CORS per cookie/OPTIONS o deploy VM rootless. I test Node coprono il protocollo mock; l'epica #2 richiede verifica su Access reale. ADR 0023.


### Policy Compose fail-closed su namespace e security options (#67)

La sola allowlist di nomi introdotta dalla #65 non impone isolamento fra i servizi approvati: `runner-api` avrebbe potuto condividere il namespace PID con il worker con `pid: service:runner-worker`, e il gate precedente cercava semplicemente `no-new-privileges:true` in un array che poteva contenere anche `seccomp=unconfined`. La #67 impone una policy identica per API, worker e cloudflared: nessun `network_mode/pid/ipc/uts/userns_mode/cgroup/cgroupns_mode/isolation` esplicito; `security_opt` deve essere l'unica voce `no-new-privileges:true`, `cap_drop` l'unica voce `ALL`. Vietati anche GPU, device requests/cgroup rules, gruppi supplementari, sysctl arbitrari e `expose`; le mount implicite già vietate restano proibite. L'implementazione non interpreta altri namespace come equivalenti benigni, così nuove esigenze richiedono review e policy aggiornate prima del deploy. Test Node su stack validi e override pericolosi; ADR 0024. Validazione statica, non attestazione runtime su daemon rootless reale (#2).


### Compose preflight: vincolo sul codice e sulle opzioni di avvio (#68)

I gate di rete e privilege non sono sufficienti se il codice nel worker può essere sostituito mentre continua a possedere il socket rootless. `inspectComposeConfig` ora valida il `build.context` dei due servizi runner come radice del checkout, il `dockerfile` come `docker/runner/Dockerfile.api` o `docker/runner/Dockerfile.worker` e **nessun altro campo build**, impedendo Dockerfile inline, build args/ssh/secrets/network, immagini alternative e build context remoto. L'assenza di override `command/entrypoint/healthcheck/post_start/pre_stop/develop/pull_policy` è obbligatoria, per preservare i CMD revisionati. Una allowlist delle variabili di ambiente consentite per API/worker blocca `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD` e altre vie di iniezione runtime; i path dati interni restano `/data`. Il tunnel richiede immagine ufficiale Cloudflare dichiarata e nessun override eseguibile o build locale. Gli errori sono costanti e non includono configurazione o token. È una verifica della **topologia dichiarata**, non dei byte del Dockerfile o della provenance delle immagini dopo un checkout compromesso: l'immagine Cloudflare `latest` non è pinned per digest, e permangono i limiti VM/Access/attestation (#2, ADR 0025).


### Consistenza tra preflight Compose e host sulle directory private (#69)

Il runner usa due verifiche separate: `inspectComposeConfig` valida la topologia dei bind, mentre `validateHostEnvironment`/`inspectHost` devono verificare la VM. In precedenza il controllo host rifiutava solo l'uguaglianza dei due path; una struttura `RUNNER_DATA_DIR=/srv/workspaces/evidence` e `RUNNER_HOST_WORK_DIR=/srv/workspaces` poteva passare sul server anche se il Compose la vietava. Il controllo host ora applica `safeHostMountSource` e `overlaps` della policy Compose, inclusi path canonici e segmenti di directory. `inspectHostPath` attraversa con `lstat` ogni componente parent dei due percorsi e del socket rootless per rifiutare symlink intermedi, che il controllo sulla sola leaf non vedeva. Restano verificati UID 1000, permessi dei directory/socket e rootless `docker info` a posteriori. Tradeoff: lstat per componente è una serie di snapshot, non una passeggiata FD atomica, e non garantisce assenza di rename/symlink-swap dopo i controlli; VM rootless reale non attestata dalla CI. ADR 0026, epica #2.


### Controllo dell'intero grafo delle reti Docker Compose (#70)

Bloccare `network_mode: host` non impedisce un collegamento a un bridge/overlay condiviso attraverso `services.*.networks`. Prima della #70 il preflight controllava nomi di servizio, mount, namespace e codice di avvio, ma ignorava la topologia delle reti dichiarate dal progetto: un override avrebbe potuto collegare `runner-api` o il worker socket-enabled a una rete esterna pur mantenendo l'esito `passed`. `safeNetworkTopology` adesso richiede progetto Compose con nome ammesso, una sola rete top-level `default` e nome `<project>_default`, senza `external` true, driver/IPAM personalizzati o opzioni arbitrarie. Il serializzatore JSON Compose v2 può aggiungere un `ipam: {}` vuoto alla default implicita; il controllo ammette soltanto quell'oggetto neutro, non opzioni di subnet/driver. Le service network attachments (API, worker, tunnel) devono riferirsi soltanto alla default, anche quando il Compose v2 la serializza come `{default: null}` o lista `[default]`, e non possono specificare alias/IP/priority. Errori statici senza dump del Compose. Il controllo è solo dichiarativo: una rete con nome standard non offre isolamento crittografico né impedisce mutazioni del daemon dopo l'inspection; resta da verificare runtime, VM rootless/Access e fencing (#2, ADR 0027).

### Preflight dei bind: opzioni allowlisted e secret non raggiungibili dal worker (#71)

La verifica di `type/source/target` non è sufficiente per un bind Compose: campi `bind.propagation`, `bind.selinux`, `consistency` o estensioni future possono modificarne il comportamento nonostante i path invariati. Il gate statico ora permette soltanto `type/source/target/read_only/bind`, con `bind` limitato a `create_host_path` booleano (normalizzazione Compose v2), e verifica che la modalità RW/RO attesa non sia alterata. Il mount RO del registro degli operatori è isolato dal tree del worker anche quando una directory è antenata dell'altra, oltre che quando coincidono. Una directory API-only annidata nel workspace host rimane leggibile dal worker se questo monta l'antenato, anche senza un mount esplicito dei secret nel container; per questo serve il controllo su tutti gli overlap. Errori senza dump del JSON, test parametrizzati e preflight reale nella CI; ciò non è una prova runtime del daemon e non elimina le race fra preflight ed esecuzione (#2, ADR 0028).

### Tunnel command e risoluzione dei service name nel preflight Compose (#72)

La policy della rete `default` (#70) non impediva `cloudflared.extra_hosts` di reindirizzare il nome `runner-api`. Per i tre servizi approvati il preflight rifiuta ora DNS custom, hosts, links e override di identità host/container/MAC. L'argv del tunnel è fissato a `tunnel --no-autoupdate run --token <token>` e il suo runtime è nonroot (1000:1000), rootfs RO e senza environment custom. Il token viene verificato solo nella forma, non come credenziale funzionante; il controllo è statico sul JSON Compose e non attesta l'immagine `latest`, il resolver, la route o il daemon rootless effettivi (#2, ADR 0029).

### Preflight Compose e profili di credenziali mutuamente esclusivi (#73)

I tre profili API di autenticazione (`RUNNER_API_KEY`, `RUNNER_API_KEY_FILE`, `RUNNER_TENANTS_FILE`) erano già implementati con override Compose dedicati, ma soltanto `compose.repair-operators.yml` era ammesso dal gate di deployment. Il validatore ora riconosce i mount esatti di chiave file, tenant registry e operator registry, usa un solo profilo globale o tenant e impone corrispondenza stretta env/target/mode read-only, path host canonici, nessuna sovrapposizione fra segreti e data/workspace del worker. `--runner-key-file` e `--tenants` selezionano solo gli override versionati, con `--operator-registry` consentito solo nelle modalità globali. Il gate resta statico e l'host preflight del contenuto dei file e dei permessi della VM deve essere svolto indipendentemente (#2, ADR 0030).

### Preflight host file/tenant e probe endpoint senza dump del registro (#74)

Il preflight host oltre al Compose statico può selezionare esplicitamente chiave globale inline, file-backed o tenant; carica soltanto il file privato del profilo richiesto su VM come UID 1000. Directory canoniche 0700 e segmenti non symlink, file owner-only nlink=1 O_NOFOLLOW con confronto fstat/snapshot, formato validato prima di un probe rootless. La modalità con operatori usa registry file coerente con chiave globale e resta esclusa per tenant. Il preflight endpoint per key-file/tenant riceve `RUNNER_PROBE_BEARER` via env operatore 0600, evitando di estrarre l'intero tenant registry: la sola evidenza restituita è l'autenticazione della credenziale di prova, il CORS e HTTPS. È punto-in-tempo, non una prova atomica del filesystem o del provider Cloudflare/VM runtime (#2, ADR 0031).

### Canary Docker: script effettivo e profilo namespace verificati (#75)

Un inspect che riporti `Entrypoint=node` e uno stdout con marker di successo non dimostra che il container abbia eseguito i controlli di rete, UID e capability revisionati. Ora la funzione condivisa `safeConfig` controlla la corrispondenza integrale `Config.Cmd=["-e", sentinel]` e ammette solo il profilo NNP esatto, namespace privati e assenza di DNS/hosts, gruppi/device e mount extra. Vale sia per canary sia per riconciliazione degli eventuali residui. La CI con Docker reale usa una simulazione **esplicitamente rootful** del solo gate daemon, non una attestazione VM rootless o del provider Cloudflare (#2, ADR 0032).

### Integrità dell'ambiente di bootstrap del canary Docker (#76)

La corrispondenza integrale di `Config.Cmd` non basta se `Config.Env` permette di pre-caricare moduli Node tramite `NODE_OPTIONS`, di cambiare il percorso di risoluzione moduli oppure di iniettare librerie native tramite loader. Il gate condiviso `safeConfig` vincola ora il container dell'immagine ufficiale Node 22 ai soli default `PATH`, `NODE_VERSION` e `YARN_VERSION`, senza duplicati o voci extra; `Config.Healthcheck` deve essere assente. Eseguire la verifica prima/dopo start e nella riconciliazione. Il risultato dimostra solo coerenza con quanto dichiarato dal daemon, non integrità di un host compromesso o attestazione hardware. Il smoke CI è rootful (ADR 0033, #2).

### Gate di acceptance sulla VM rootless (#77)

I precedenti preflight separati possono essere composti dall'operatore **sulla VM dedicata** con `vm-acceptance.mjs`. È un protocollo sequenziale point-in-time `Compose config → host UID 1000/credenziali/socket rootless → canary real Docker`, con un solo profilo di autenticazione esplicito e senza fallback. Il canary usa la stessa socket host `/run/user/1000/docker.sock`, verifica per comando il daemon e l'isolamento del container, stampa un UUID non segreto prima del create e pretende una cleanup confermata per emettere una ricevuta locale. I passi precedenti non emettono status indipendenti verso il chiamante. Nessun endpoint remoto è interrogato; l'operatore deve effettuare off-host il probe HTTPS/Cloudflare Access distinto. La ricevuta non è firmata/attestata e non prova che il daemon non sia stato sostituito dopo i controlli; la CI rootful verifica solo la logica e i componenti separati (#2, ADR 0034).

### VM acceptance con riconciliazione delle configurazioni private (#78)

Il gate della #77 orchestrava prove Compose, host e canary indipendenti, che possono rileggere lo stesso `--env-file` in momenti diversi. Prima della sequenza la CLI verifica file owner-only 0600 mediante singolo descriptor `O_NOFOLLOW` e legge la configurazione privata completa; dopo ogni gate rilegge e confronta logicamente tutti i valori senza serializzarli in ricevuta/log. Rotazioni nel mezzo impediscono la transizione al gate successivo o lo status `passed`. Non è snapshot transazionale/immutabile del daemon e non chiude il TOCTOU contro un attore ostile che può modificare lo stesso file durante la sequenza (#2, ADR 0035).
