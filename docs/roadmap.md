# Roadmap di sviluppo

## v0.1 — Foundation (presente in main)

- Workspace React/TypeScript desktop/mobile e settings local-first
- Routing di modelli AI per task, OpenAI-compatible
- Pipeline feature → competitor research → technical research → architecture → adversarial → implementation
- Gateway ricerca browser-compatible + Wikipedia come fallback limitato; fonte e URL tracciati
- Configurazione multi-frontend e routing servizi dev/prod, .NET 11 / 10, Azure/AWS/GCP/K8s/Docker
- Scaffold ZIP: API ASP.NET Core DDD + web React TS, docs/adr/docker/infra/tests e CI
- GitHub PAT e GitHub App tramite broker HTTPS, scrittura su main/branch, creazione repo sul proprio account
- OAuth2 PKCE e backup Google Drive appDataFolder / OneDrive app folder
- Test dominio/generazione e CI GitHub Actions

## v0.2 — Code generation agent (fase 1 implementata — issue #1)

- Code Agent con patch JSON multi-file controllate, confronto diff, review indipendente, approvazione esplicita, cronologia e undo
- Override approvati integrati in ZIP e GitHub; proposte ancora in review non pubblicate
- Conflitti di configurazione rilevati prima di esportare/push; risoluzione guidata con drop dei file in conflitto
- Documentazione `docs/code-agent.md` e ADR 0004
- **Ancora da fare:** loop edit/build/test automatico in sandbox isolata, patch repair e test dinamici

## v0.2 — Remote runner (MVP, issue #2)

- API HTTP separata dal worker con API key, CORS esplicito, quote payload e coda persistente sul server
- Worker Docker rootless con step fissi: build/test .NET, build/test web e Playwright quando configurato
- Isolamento per job: rete off, caps dropped, no-new-privileges, pids/CPU/RAM/timeout, workspace temporaneo
- UI Code Agent: invio del workspace o della proposta, polling esiti e log, senza dichiarazioni di test non eseguiti
- Compose opzionale con `cloudflared` e documentazione Cloudflare Tunnel/Access
- **Non ancora production-ready:** host VM dedicato, cache dipendenze egress-controlled, hardening/isolamento più forte e ciclo di autoriparazione

## v0.2 — Snapshot integrity e repair (implementato in #3)

- Digest SHA-256 canonico su sorgenti + test, verifica della receipt e del report effettivamente eseguito
- Report superati ma non corrispondenti alla revisione corrente marcati come **stale**
- Repair AI su log di test falliti, massimo due tentativi, gli stessi file, prompt con input non attendibili
- Nuova review avversaria e nuovo test effettivo su .NET/React come requisito per approvare codice riparato
- Test di regressione del lifecycle e della report validation
- Ancora da fare: worker autonomo 24/7 e ripetizione dei test senza browser, isolamenti per-tenant e cache attendibili (issue #2)

## v0.2 — Runner real Docker CI e preparazione dipendenze (issue #4)

- Docker smoke in CI con runner Node vero: build/test positivo, errore di test intenzionale, dipendenze offline mancanti
- Separazione fra installazione npm e test senza rete (e conservazione del risultato di preparazione)
- Opt-in esplicito dell'amministratore per npm via rete soltanto durante la preparazione
- Restrizione dei package specifier e lifecycle scripts disabilitati, cache/preparazione workspace effimero
- Distinzione `incomplete` per errori di infrastruttura/setup, anziché incoraggiare false riparazioni AI
- **Ancora aperto:** provisioning cache immutabili con dependency lock, Playwright completo con browser reali, egress whitelist, daemon rootless production test (#2)

## v0.2 — Playwright E2E in browser reali (issue #5)

- Scaffold React con `@playwright/test` 1.64.1 pinato, configurazione webServer localhost e due smoke test Chromium sugli stati /health 200/503 (API mock)
- CI dello scaffold con install Chromium e comando `npm run test:e2e` dopo build
- Runner Playwright pinato all'immagine browser `v1.64.1-noble`, stesso path di esecuzione previsto per worker Docker, network off
- Docker smoke browser vero in CI di SoftwareFactory, oltre ai test mockati del protocollo
- Limiti: mock API, non verifica DB/integrazioni; offline npm ancora richiede cache, VM rootless e browser multipli da collaudare

## v0.2 — Playwright con API reale e rete privata (issue #6)

- Doppia modalità E2E: mock API per il test base, integration per health/info ASP.NET Core reali
- Rete bridge Docker --internal per API/Vite/Chromium nella CI Factory, senza pubblicazione porte
- Test di integrazione anche nella CI degli scaffold generati: ASP.NET Core locale + Playwright
- Setup Vite con allowedHosts limitato a web nel test Docker, CORS esplicito sulla API
- Database reale, isolamento worker remoto multi-container e servizi cloud ancora da implementare

## v0.3 — PostgreSQL reale nel backend generato (issue #7)

- Npgsql 10.0.3 pinato nello scaffold PostgreSQL, interfaccia dominio, servizio business e repository ADO.NET parametrizzato
- Migrazione `0001_create_work_items.sql` come embedded resource, versionamento nel DB con advisory lock e applicazione transazionale all'avvio
- Endpoint CRUD completo GET/POST/PUT/DELETE `/api/items`, React `WorkItems` e test browser CRUD reale in modalità integration
- CI Factory: quattro container Docker (PostgreSQL, API .NET, Vite e Chromium) con rete `--internal` e password effimera
- CI degli scaffold: Postgres 17 effimero, readiness, processo API con connessione esterna, browser E2E e cleanup
- Restano aperti: provider identità/login OIDC e rotazione chiavi, migrazioni rollback, provider SQL Server/MySQL/SQLite, runner remoto su VM rootless e servizi di produzione

## v0.2 — Code generation agent (milestone successive)

- Task graph con dipendenze, feature implementate come commit incrementali su file
- Agent loop Plan → Edit → Build → Test → Adversarial review → Repair
- Sandbox locale/container o runner remoto, limiti CPU/rete/file e permessi espliciti
- Hook all'esecuzione test con output verificato (no claim senza esecuzione)
- Controllo di qualità, codice e test per backend e frontend; merge di revisioni approvate
- Manifest di proprietà dei file, checkpoint atomici, possibilità di rollback/recovery Git

## v0.3 — Cloud adapters

- Provider reali per Postgres/SQL Server/MySQL, Redis, RabbitMQ/Kafka, OpenTelemetry/Prometheus/Jaeger e cloud gestiti
- Terraform modules per Azure, AWS, GCP, K8s/on-prem con secret management
- Matrice dev/staging/prod e più provider deploy con per-environment overrides
- Monitoring locale vs Application Insights / CloudWatch / Google Cloud Monitoring
- Docker Compose testabile con unit, integration, e2e e testcontainers

## v0.4 — Ricerca professionale e governance

- Browser research via servizi con fonti primarie, licenze e timestamp; ricerca normative con giurisdizione
- App catalog, OAuth GitHub App completo, RBAC e branch protection
- Human approval gates: normative, minacce, costo cloud, migrazioni e pubblicazione
- Budget token, audit trail immutabile, job runner 24/7 con worker, multi-device locking
- Native mobile templates completi e Unity pipelines

## Acceptance criteria prima della produzione

Nessun task AI può affermare che il prodotto è compilato/testato senza un risultato di esecuzione. Nessuna credenziale in Git o nei file generati. Ogni configurazione deve propagarsi ai template e agli adapter oppure essere segnalata chiaramente come non implementata. Provisioning cloud e migrazioni richiedono review/approvazione esplicita.

## v0.3 — API protette e audit (issue #8)

- JWT Bearer con validazione issuer/audience/signature/expiration e secret esterno senza default
- Policy reader/editor e identità sub obbligatoria, isolamento owner_id nel repository, 404 su ID di altri utenti
- Migrazione 0002 per owner e audit transazionale; record legacy non assegnati a utenti arbitrari
- Limite request body 8 KiB, rate limiter, errori generic JSON e readiness DB protetta
- Test Chromium reali per 401/403/ownership, JWT CI di dieci minuti e audit PostgreSQL
- **Rimane da fare:** Identity Provider OIDC/JWKS, login PKCE, refresh/revoca, rotazione chiavi, threat assessment e hardening production

## v0.3 — OIDC/JWKS e accesso PKCE (issue #9, in sviluppo)

- AuthStartup seleziona OIDC RS256/JWKS di default, HTTPS obbligatorio in Production; il percorso HMAC legacy è consentito solo in Development
- Template frontend oidc-client-ts 3.5.0 con Authorization Code + PKCE, state/nonce, user session e callback/login/logout, parametri pubblici via VITE_
- Nginx SPA fallback /auth/callback e configurazioni Compose senza segreti hardcoded
- Provider OIDC RSA effimero **solo per CI** su Docker bridge --internal, con discovery/JWKS, code grant PKCE S256, token e endpoint per test
- Restano da completare/collaudare: login Chromium completo con redirection, logout/refresh con provider reale, JWKS key rollover in produzione, CSP e BFF opzionale

### Copertura raggiunta per #9

- Sei prove Chromium con API .NET e PostgreSQL reali, fra cui login/logout code+PKCE tramite provider RSA/JWKS di prova
- Test protocollare separato su rete privata: RSA/JWK pubblica, codice monouso, PKCE invalido, refresh token rotante con replay negato, logout e rotazione `kid`
- Frontend browser su loopback per usare Web Crypto in un contesto attendibile, senza disabilitare sicurezza Chromium
- Da verificare ancora prima della produzione: issuer terzi, TLS di rete, refresh/logout e revoca federata effettivi e key rotation ASP.NET Core contro provider reale
- Hardening di #10: JWT HMAC legacy fail-closed fuori da Development, vincolo `sub` unico/non vuoto, test negativi 403 sul backend reale e gate di startup .NET in CI.


## v0.3 — Fail-closed delle sessioni PostgreSQL (issue #11)

- Gestione uniforme dei 401 in GET/POST/PUT/DELETE: rimozione del token OIDC o demo, dati nascosti, re-login manuale; 403 mantiene l'identità corrente.
- Guard per evitare che risposte tardive di un token obsoleto invalidino una nuova sessione.
- E2E in Chromium con API reale: 401 sia su lettura sia su modifica, 403 reader su create; nessun mock dei risultati HTTP in questi casi.
- IdP federato e sessioni BFF/CSP restano in issue #9; VM rootless indipendente in issue #2.


## v0.3 — Rollover JWKS sul backend live (issue #12)

- CI con API .NET/PostgreSQL già avviata, provider RSA di test, `kid` iniziale e successivo dopo rotazione della fixture.
- Il backend accetta il nuovo token senza restart dopo refresh bounded di JWKS; il test richiede firma corretta, 401 su firma falsificata e 403 su scrittura `reader`.
- Aggiorna il vecchio gate limitato al provider con prova di interoperabilità sul backend: non prova revoca immediata, BFF, TLS né IdP esterno; restano aperti in #9.


## v0.3 — Sessione OIDC browser: refresh e logout federato (issue #13)

- Chromium invoca `oidc-client-ts` autentico per ottenere un nuovo access token via refresh grant: verifica rotazione di access/refresh token, storage aggiornato, replay del vecchio refresh negato e autorizzazione sulla vera API PostgreSQL.
- Il reload conserva la sessione rinnovata; il logout verifica un 302 dell'endpoint remoto e la rimozione del profilo locale.
- L'orchestratore Factory impone contatori di refresh e logout del provider **prima** dello smoke protocollo Node; il runner fullstack ora richiede 10 test Chromium.
- Rimangono non verificati IdP terzi HTTPS, revoca cross-session, logout distribuito, CSRF/XSS/CSP e scelta BFF (issue #9).


### Correzione OIDC temporale — issue #14

- Il primo test di refresh via browser ha rivelato che la fixture CI modificava erroneamente `auth_time` al rinnovo; `oidc-client-ts` ha rigettato l'ID token.
- Il provider di test ora conserva `auth_time` originale sui refresh successivi, distinta da `iat`, e il protocol smoke ne verifica la continuità con rotazione monouso.
- Verificare nuovamente il percorso fullstack Chromium #13 prima di chiudere le issue.


## v0.3 — Rifiuto refresh token e guasti di rete (#15)

- Rinnovo OIDC esplicito con rimozione fail-closed su `invalid_grant`/`login_required`/`invalid_token`; mantenimento della sessione sui soli errori transitori finché l'access token è valido.
- Eventi `silentRenewError` e `userUnloaded` nel componente React per rinnovi automatici; protezione delle sessioni recenti dalle risposte tardive.
- E2E con reale identity fixture e Chromium: refresh monouso già consumato (deny reale) e token endpoint temporaneamente irraggiungibile; 12 test browser nel gate CI.
- Da verificare: IdP terzo HTTPS, coordinamento cross-tab/device, revoca di access token, BFF/CSP e gestione completa del logout federato (#9).


## v0.3 — Content-Security-Policy build-time sul Nginx generato (#16)

- `Content-Security-Policy` applicata dal Nginx delle app PostgreSQL: script solo same-origin (no inline/eval), API/IdP normalizzati nella `connect-src`, frame/base/object limitati e callback SPA funzionante.
- Configurazione rigenerata dal Dockerfile con input pubblici validati; rigetto di credenziali, injection, query, fragment, HTTP remoto non consentito; compatibilità con path issuer Keycloak.
- Verifica Factory CI con Nginx **e Chromium reali** nella rete privata e test di blocco script inline; il gate sale a **13 test browser**.
- Stili React ancora compatibili via `style-src 'unsafe-inline'`; rischi XSS/CSRF, progettazione BFF/HttpOnly, revoca federata e IdP esterno nella #9.


## v0.3 — Logout OIDC tra schede dello stesso origin (#17)

- Segnalazione `BroadcastChannel` di sole invalidazioni `logout` per logout volontario, 401 server e refresh token definitivamente rifiutato; i token non attraversano il canale e restano nel `sessionStorage` di ogni scheda.
- Schede riceventi eliminano utente OIDC, dati CRUD e sessione locale senza redirect provider e senza echo-loop; listener chiuso allo smontaggio React.
- Factory CI fullstack: **15 test Chromium**, due test nuovi con due pagine dello stesso browser context, login PKCE separato, logout reale e 401 ASP.NET Core reale propagati, reload senza credenziali.
- Limiti: solo schede attive stesso origin/browser, non revoca server dei JWT e nessun coordinamento cross-device. IdP esterno HTTPS e BFF/HttpOnly restano in #9.


## v0.2 — Acquisizione atomica dei job del runner (#18)

- Claim `.claim` tramite `mkdir` condiviso: due worker non lanciano simultaneamente lo stesso job.
- Polling e retention rispettano lock; i job claimed non bloccano la coda e non vengono marcati prematuramente falliti.
- Recovery fail-closed di crash con intervento operativo: nessun timeout per rubare lock, nessuna riesecuzione o `passed` artificiale.
- Rimanenti #2: fencing multi-host, coda/quote transazionali, audit append-only, cleanup dei container orfani, fix loop e VM rootless reale.


## v0.2 — Evidenze append-only SHA-256 del runner (#19)

- Journal JSONL privato per job, con eventi accettazione, avvio, preparazione, step, conclusione/recovery e SHA-256 concatenati.
- `report.evidence` lega report, conteggio e head; endpoint di export autenticato e letture fail-closed HTTP 409 su alterazioni/troncamenti.
- Fsync dei record prima del report, output redatti e test di manomissione oltre a smoke Docker effettivo. Restano #2: attestazione off-host, fencing distribuito, quote/idempotenza transazionali, rootless VM e fix loop supervisionato.


## v0.2 — Admission atomica e idempotenza runner (#20)

- `mkdir .admission` serializza quota/creazione di job tra istanze API sulla stessa directory; default quattro job in coda/esecuzione, massimo 100 directory incluse le esecuzioni passate non ancora scadute.
- HTTP `Idempotency-Key` UUID v4 opzionale con hash nel journal, replay stesso digest/job ID, conflitto 409, formato 422, lock occupato 503 con Retry-After e fail-closed su report corrotti.
- Frontend conserva la chiave sino ad accettazione confermata e la riusa dopo errore di rete; nuove esecuzioni confermate usano UUID diverso. Retention prende lo stesso lock. Test concorrenti su due API con filesystem comune.
- Restano #2: isolamento runner su VM rootless reale, fencing multi-host, rate limit per client/IP, audit off-host, recovery container orfani e orchestration repair supervisionata.


## v0.2 — Ricognizione e cleanup conservativo dei container orfani (#21)

- Container identificati da nome con UUID completo e label Docker statiche per job/step: niente collisioni per job con uguale prefisso di otto caratteri.
- Strumento amministrativo solo lato worker: dry-run, `--apply --confirm-job` esplicito, report/journal verificati, claim assente, stato failed/incomplete e nuova verifica nome/label prima di `docker rm -f`.
- Test di sicurezza per spoofing e lock più smoke Docker reale con container non appartenente al job mantenuto intatto.
- Rimangono in #2: riconciliazione unattended con fencing cross-host, attestazione esterna, VM rootless reale, quote tenant e orchestrazione repair supervisionata.


## v0.2 — Preflight VM rootless, topology Compose e HTTPS (#22)

- Nuova CLI read-only: ispeziona Compose risolto senza stamparne i segreti, verifica soltanto il worker con socket, UID e cap/drop, API su loopback, no privilegi extra.
- Modalità host: verifica filesystem privato e Socket Unix uid 1000 e `docker info` con `name=rootless`; modalità endpoint HTTPS: 401 senza token, capabilities Bearer, CORS preflight e redirect non seguiti, nessun job creato.
- Test di regressione su configurazioni rootful/public port/volumi insicuri, permessi, redirect e Origin wildcard; CI esegue Compose preflight con il solo env placeholder.
- Resta nella #2 la verifica **reale** su VM e Cloudflare Tunnel/Access, l'attestazione off-host, fencing cross-host e repair loop.


## v0.2 — Bundle di evidenze offline e firma Ed25519 (#23)

- Export autenticato con report intero, head/count e entry journal; validatore offline puro senza rete/credenziali runner, fail-closed su modifiche, tagli e stato non coerente.
- Firma Ed25519 opzionale su postazione indipendente del firmatario: digest del bundle, input digest, stato, identificatore job e fingerprint public key. Verifica pubblica con chiave pinned, non suggerita dalla ricevuta.
- CI con chiavi temporanee, test di riscrittura completa del journal vs firma già emessa, CLI mode 0600 senza sovrascritture e integrazione API.
- Non confondere firma manuale post-export con prova di Docker rootless o timestamp affidabile. Restano #2 ancoraggio remoto automatico, VM/tunnel reale, fencing e repair loop.


## v0.2 — Ciclo AI repair / re-test supervisionato (#24)

- Per ogni repair massimo 2 tentativi: conferma utente per invio log a modello, ricarica del report autenticato e verifica di stato fallito/digest/proposta prima del prompt, stesse path della patch.
- Provenienza `repairTrail` con ID, hash e step del fallimento. Nuova review avversaria, re-test deterministico con tutti gli step precedenti più build obbligatorie; nuovo consenso esplicito per invio dello snapshot riparato.
- Receipt UUID/digest verificata, rete/idempotenza del runner già operativa; approvazione solo manuale dopo report `passed` corrente su tutti gli step richiesti, zero push o apply automatico.
- Rimane aperta la #2 per coordinatore background 24/7, fix loop autonomo server-side con policy/approvazioni, deployment rootless/Cloudflare reale, fencing e attestazione indipendente automatizzata.


## v0.2 — Coordinatore checkpoint server-side per repair (#25)

- API Bearer autenticata per creare/leggere/avanzare una sessione di repair associata a un report `failed` verificato, senza invocare AI o creare job Docker.
- Stati persistenti con 2 tentativi massimi; patch con digest e path in allowlist, review dichiarata da operatore, re-test con job reale + stesso digest e step obbligatori, registrazione manuale di approvazione senza apply/push.
- Eventi SHA-256 chained, JSON aggiornato atomicamente sotto volume comune, lock POSIX di admission, 100 sessioni conservate, input body max 4KiB; due API condividono la stessa storia. Test concorrenti e anti-tamper.
- Resta #2: collegare la UI e l'AI al nuovo registro, coordinatore unattended con policy di approvazione verificabile, RBAC/multi-tenant, real rootless VM/Tunnel, ancoraggio off-host e fencing distribuito.


## v0.2 — Sync Code Agent e repair ledger remoto (#26)

- Binding non segreto della sessione persistente salvato nel pending Code Agent, creato/ripreso su consenso dopo prova fresca di fallimento; riuso stessa root/sessione nei due tentativi massimi.
- Al consenso per re-test, registrazione idempotente di patch digest, review dichiarata e step obbligatori in API prima del job; polling di report verificati sincronizza il checkpoint di retest. Fallback di recupero sul successivo retry/approvazione se la risposta era incerta.
- Gate di approvazione ulteriormente ristretto: verifica preventivamente apply locale, report passed sul digest giusto e nuovo checkpoint remoto `recorded_approval` prima di applicare la patch; mai autopush o autoapprovazione.
- Test Vitest con mock HTTP su retry/mismatch e CI invariata con Node runner, Docker reale e Chromium. Restano #2: account e consenso attestato per operatore, coordinatore autonomo policy-based, VM rootless/Cloudflare collaudati, ancoraggio esterno.


## v0.2 — Credenziali di ruolo e audit operatore del ledger (#27)

- Separazione tra chiave job Docker e operator key dei checkpoint; registro privato `RUNNER_REPAIR_OPERATORS_JSON` bounded, fail-closed, ruoli `propose/review/approve`, nessuna API di repair accessibile con la global key.
- Nuovi eventi ledger con `actorId` non segreto nella hash-chain; lettura delle vecchie entry senza actor come legacy. Nessun token negli export, nel progetto o nei log.
- Campo di sessione dedicato nella SPA e uso della operator key nelle azioni di create/patch/review/retest/approval; review/approval senza scope bloccate dal server. Test Node credenziali, ruoli, CORS/invalid token e integrità, suite CI su Docker effimero.
- Residui #2: vera identità operatore, controlli two-person e OIDC/SSO, rotation/revocation distribuite, tenants/quote e attestazione esterna automatica, VM rootless Cloudflare reali.


## v0.2 — Fix scansione idempotente del repair ledger (#28)

- Regole di recupero conservativo su filesystem condiviso: scansioni bounded per record transitori, verifica di **tutti** i sibling prima di un 201, file persistenti difformi causano 409 e non sono cancellati o riparati automaticamente.
- Test reali di avvii concorrenti su due istanze API e fixture temporaneo vs corrotto; CI fullstack richiesta sullo stesso SHA di main.
- Restano in #2 fencing cross-host e prove su filesystem/VM dedicati con daemon Docker rootless reale e Cloudflare Tunnel.


## v0.2 — Policy di indipendenza dei checkpoint repair (#29)

- Server-side separation of duties per **ID del Bearer**: solo il proponente iniziale può registrare patch/retest; review e approvazione richiedono ID distinti dal proponente e l'approvatore deve essere distinto anche dal revisore.
- Policy ricontrollata sia sulla proiezione in scrittura sia sul replay della hash-chain, compresi retry, secondi tentativi e sessioni legacy (leggibili ma read-only). Nessun auto-commit, auto-job o bypass via token con più ruoli.
- SPA: checkpoint patch, review e invio test in **azioni distinte** con feedback, cambio chiavi via Settings, retry dopo risposta persa, sincronizzazione manuale esito se necessario. Suite Node multi-API + Vitest e fullstack CI.
- Restano #2: OIDC/WebAuthn con persona verificata, MFA/firme per approvazione, revoca/rekey/rotazione e multi-tenant, vero daemon Docker rootless/Cloudflare Tunnel, attestation off-host indipendente.


## v0.2 — Coerenza dei timestamp di creazione delle sessioni (#30)

- Fix falsi 409 `repair_integrity` al cambio di millisecondo: primo evento con timestamp condiviso con `createdAt`, nessuna modifica alle evidenze/privilegi.
- Regressione deterministica con clock di test che attraversa il confine .999/.000 e verifica JSON/hash-chain dall'altra istanza API. Non confondere questo difetto con la scansione del filesystem (#28).


## v0.2 — Revoca e rotazione chiavi del coordinatore, file privato condiviso (#31)

- Aggiunta configurazione opt-in `RUNNER_REPAIR_OPERATORS_FILE`, riletta ad ogni richiesta API repair, con apertura no-follow, inode singolo, lettura e permessi limitati, schema dei ruoli verificato. Esclusione reciproca con JSON inline statico; errore file indisponibile => 503 fail-closed, job API indipendenti.
- Rotazione delle chiavi a **ID costante** e revoca con eliminazione dal JSON, rilevate da entrambe le istanze API senza riavvio; test di mount ostile, symlink/hardlink, dir, permessi, JSON corrotto, accesso vecchi token e integrità audit.
- Compose override opzionale con mount **directory** read-only soltanto API e preflight/CI per configurazione finale, mai socket Docker/segretistica nel worker. Non è una gestione centralizzata di account umani o MFA.
- Rimane #2: identità OIDC/SSO, second-person verification reale, revoca delle richieste già avviate e dei JWT/app, RBAC multi-tenant, osservabilità, attestazioni esterne e VM rootless Cloudflare reali.


## v0.2 — Controllo credenziali in attesa del lock repair (#33)

- In modalità registry file i checkpoint repair ricontrollano Bearer, `actorId` e scope **dentro il lock di admission**, dopo eventuali attese: vecchie chiavi non possono iniziare la mutazione quando già revocate, senza scrivere snapshot o hash-chain.
- HTTP 401 per key revocata, 403 per scope/identità modificati, 503 per file inaccessibile. Test per begin e advance con guard sotto lock, cambio registry atomico su due API, job capability invariato.
- Limiti: non è commit/revoca transazionale con registry file, non annulla richieste dopo il secondo gate; non sostituisce IAM federato, firma umana o fencing cross-host. #2 resta aperta.


## v0.2 — Admission integra e retry semantici (#34)

- Prima di contare quota o rispondere a replay, il runner verifica SHA-256 journal/report **di tutti i job UUID conservati**: alterazioni su qualsiasi job causano 503 `admission_integrity`, non liberano falsamente slot e non mascherano corruzione dei sibling.
- Retry breve in caso di transizione journal→report in corso; non recuperare o cancellare automaticamente evidenze. Test con due API e journal/report falsificati/troncati, più verifica della quota.
- Receipt idempotente con ID/digest immutati ma stato del job verificato corrente; browser accetta enum valido ma richiede comunque GET e controlli build/test prima di qualsiasi approvazione.
- Rimangono #2: trust anchor off-host, storage transazionale vero, fencing multi-host, limiti tenant e collaudo VM rootless/Cloudflare reali.


## v0.2 — Rate limit globale per job ammessi (#35)

- Limite opzionale `RUNNER_MAX_ACCEPTED_PER_MINUTE` (default 0 disattivato, 1–100 abilitato) su rolling 60s, condiviso via lock POSIX fra due API, su job nuovi anche se i vecchi sono terminati.
- Dopo verifica completa journal/report, conservare la precedenza di replay valido (202)/conflitto (409), poi quote di coda e rate (429 + `Retry-After` 1–60s); timestamp errati => 503; config invalida => startup fail-closed.
- Suite Node di concorrenza su due server e scadenza deterministica della finestra; config Compose/.env e guide aggiornate.
- Restano in #2: quota per tenant/identità, rate distributed su storage esterno, server rootless/Cloudflare reali e attestation off-host.


## v0.2 — GET job/evidence coerenti durante i commit del worker (#36)

- Bug transitorio: journal fsync già eseguito, report rename non ancora eseguito può produrre falso 409 e interrompere polling del client.
- Entrambi i GET protetti ritentano al massimo due volte su `EVIDENCE_INVALID` (25ms tra tentativi), senza bypassare la verification strict, senza mutate/repair automatici; 409 persistenti e 404 invariati.
- Test Node con vera chain e disallineamento controllato su due istanze API, export verificato e prova che errori persistenti non diventano 200.
- Nessuna attestation/lock cross-host aggiunta; #2 resta aperta.


## v0.2 — Ripresa bounded polling browser (#37)

- Evitare che il primo guasto di rete/503 del runner interrompa per sempre la lettura dei test; classificare HTTP e rete con errore tipizzato e retry deterministico bounded 5 tentativi (2.5s → 30s).
- Interrompere immediatamente 401/403/404/409, JSON invalido, ID non valido e abort; riprovare solo GET sullo stesso job, con bottone manuale dopo interruzione. Mai trattenere esiti vecchi come passed.
- Test Vitest su politica decisionale, stato HTTP, rete, abort e limiti backoff, con verifiche CI React/TypeScript e fullstack. L'orchestrazione autonoma autenticata e i veri workload su VM rootless restano nella #2.


## v0.2 — Worker readiness con heartbeat privato (#38)

- Nuovo segnale periodico atomico owner-only `/data/worker-heartbeat.json` aggiornato ogni 5s anche quando il worker attende test lunghi; nessun token, codice, log o socket nel file.
- `GET /v1/readiness` autenticato con Bearer job: 200 su heartbeat valido/fresco, 503 + Retry-After su worker assente/stale/futuro/JSON ostile/permission mismatch. `healthz` resta pura liveness non autenticata.
- TTL configurabile con `RUNNER_WORKER_HEARTBEAT_MAX_AGE_SECONDS` 10–300 (default 30), Compose, test two-API e validazione file; liveness non è prova Docker rootless o attestation esterna.
- Restano #2: vero isolamento VM rootless, verifica engine/SDK/Cloudflare Access su deployment reale, storage/quote per tenant, fencing e prove off-host.


## v0.2 — Probe daemon Docker rootless dalla worker VM (#39)

- Misurare nel worker la vera risposta a `docker info` via CLI read-only, comando fissato, socket UNIX locale allowlist, timeout 5s, output limitato e obbligo `name=rootless`; non inferire la modalità dal solo socket.
- Heartbeat v2 su volume privato: ultimo stato rootless e timestamp probe, refresh indipendente ogni 10s e heartbeat Node ogni 5s; niente env o log nel record. Lettura v1 legacy soltanto per worker readiness.
- `GET /v1/execution-readiness` autenticato e fail-closed se heartbeat/probe non fresh o daemon non rootless; API continua a non montare Docker. Test unit/integrazione su due API e negativi rootful/malformed/timing.
- Restano in #2: collaudo effettivo daemon **rootless** in VM con Docker containers reali .NET/Playwright, Cloudflare Tunnel/Access, fencing, IAM/quote per tenant e trust anchor off-host.


## v0.2 — Canary rootless isolato con consenso operatore (#40)

- CLI manuale nel worker con immagine Node ufficiale pre-caricata e **pinata per digest**, conferma esplicita, rootless daemon attestato da `docker info`, socket UNIX locale e nessuna richiesta API remota.
- `docker create` con rete none, readonly, cap-drop, no-new-privileges, UID non privilegiato, limiti CPU/RAM/PID/tmpfs, zero bind mounts; inspect prima/dopo e verifica dei controlli interni; cleanup mirato su ID/label. Niente auto-esecuzione o pull runtime.
- Test Node deterministici per piano, sicurezza/config, retry, errori e cleanup; documentazione comandi operatori su VM, senza affermare che GitHub hosted rootful CI certifichi rootless.
- Resta in #2 eseguire davvero il canary e un job .NET/Playwright su VM dedicata e Cloudflare Tunnel/Access reale, oltre a IAM, multi-tenancy, attestation esterna e fencing.


## v0.2 — Canary con vero Docker CI, dichiaratamente rootful (#41)

- Aggiungere nella Factory CI uno step reale `docker create/inspect/start/inspect/rm` per il canary #40, usando immagine Node già pullata e digest locale, senza pull né prune; fallire su esito invalido o risorse residue.
- Il codice di smoke CI è esclusivamente per runner GitHub effimero, controlla ambiente CI non root e daemon effettivamente rootful e bypassa la verifica rootless **solo** tramite dipendenza locale iniettata; la CLI operator-only rimane fail-closed su rootful.
- Verifiche Node per selezione digest, guardia di lancio e rifiuto modalità daemon diversa; doc/ADR aggiornati. Lo smoke reale CI **non sostituisce** il collaudo su VM rootless (#2).


## v0.3 — Fence delle risposte stale tra sessioni OIDC (#42)

- `WorkItems.tsx` generato: token + generazione incrementale a ogni sostituzione/invalidazione di sessione, guard su GET e POST/PUT/DELETE dopo await, catch, finally e 401. Logout e sostituzioni svuotano immediatamente busy e i dati della sessione precedente.
- Test Vitest di copertura per tre mutazioni e 401; Chromium con due tab OIDC e PostgreSQL reale per response POST trattenuta dal browser dopo commit, logout remote e rilascio senza ripopolamento della UI. Nessuna sostituzione delle policy lato API.
- Mancano IdP HTTPS reale, revoca JWT distribuita, BFF e cookie HttpOnly/XSS hardening completo: #9 resta aperta.


## v0.2 — Fix della finestra di lettura del timestamp readiness (#43)

- Elimina false 503 quando `readDockerExecutionReadiness` confronta un heartbeat aggiornato durante il GET con un `now` catturato prima dell'I/O. Usa due clock post-read, oppure clock iniettato coerente per i test.
- Test con due API e 80 GET in parallelo agli heartbeat periodici reali: nessun falso stato future quando il probe è rootless fresco; resta il rifiuto fail-closed per file malformati, vecchi o rootful. Lo stato operativo VM rootless reale resta nella #2.


## v0.3 — JWT role claim univoco e fail-closed (#44)

- Politiche WorkItems: singolo `sub` e singolo claim `role` esattamente `reader`/`editor` più `RequireRole`; le forme ambigue, duplicate, sconosciute, vuote o mancanti non autorizzano read/write nonostante JWT RSA valido.
- Prove reali con l'Identity Provider RSA effimero che firma cinque varianti malformate, `GET/POST /api/items` su API .NET/PostgreSQL post-JWKS-rollover devono essere tutti 403, mantenendo 200 reader GET, 403 reader POST e 201 editor POST; Vitest sullo scaffold generato.
- Rimangono nella #9 integrazione HTTPS IdP production, validazione mapping ruoli in deployment esterni, BFF/HttpOnly e revoca/cross-device.


## v0.3 — Fence di logout contro silent renew OIDC tardivo (#45)

- Rendere il logout terminale per il documento browser fino a nuovo login interattivo: `userLoaded`/getUser/callback arrivati dopo disconnessione multi-tab non possono reinserire credenziali; lo storage riscritto da una vecchia risposta viene ripulito senza broadcast loop.
- Pulizia di dati e bozze a **ogni** transizione token (anche account A→B), mantenendo le barriere `sessionEpoch` per mutate/401 già introdotte.
- E2E Chromium con provider OIDC effimero, due tab, `signinSilent` e risposta refresh ritardata fino a logout; fullstack gate da 16 a 17 test. Non è revoca server-side o sessione BFF: l'epica #9 rimane aperta.


## v0.2 — Retry-After esatto con cap globale ridotto (#46)

- Calcolo di backoff dopo riduzione `RUNNER_MAX_ACCEPTED_PER_MINUTE` da 3 a 1 senza scartare job già accettati: attendere la scadenza del record ordinato `N - cap` nella finestra, non `min(recent)`.
- Prove su cap 0, scadenze esatte, array non ordinati, acceptedAt duplicati/futuri e due API con tre journal/report SHA validi; HTTP 429 e nessuna directory aggiunta. Limite global POSIX, non tenant/IP e non un token bucket distribuito: #2 resta aperta.


## v0.2 — Reader POSIX heartbeat resilient a rename atomico (#47)

- Distinguere l'FD aperto prima di un rename (`fstat.nlink=0`) da un hardlink o un file persistentemente insicuro. Non accettare inode unlinked: soltanto l'errore mirato può provocare fino a tre nuovi `open+verify` in `/v1/readiness`.
- Test Node controllano l'effetto POSIX reale e due API con cento GET mentre il writer esegue rename a 20ms. Continuano i rifiuti fail-closed per permessi errati, hardlink, timestamp e daemon rootful; l'epica #2 rimane aperta.


## v0.2 — Hardening dei file Ed25519 sulla postazione esterna (#48)

- Eliminare `lstat→readFile` su evidence, receipt e key PEM: aprire una FD con `O_NOFOLLOW`, verificare `fstat`, leggere con limite, ripetere `fstat` per rilevare modifica/unlink durante la lettura, chiudere FD sempre.
- Vincoli owner/mode, hardlink e lunghezza per private signing key e public trust anchor; export JSON fino a 4 MB, receipt limitata a 20 KB. La firma/manual verification rimangono retrocompatibili, senza alcuna chiave privata nel runner.
- CI con file realmente symlinked/hardlinked, chiavi pubbliche scrivibili, evidence oversize e file validi; prove VM rootless, servizio di firma remoto e anchor indipendente persistente ancora in #2.


## v0.2 — Repair sessions: inode-bound reads e session ID invarianti (#49)

- Eliminare path TOCTOU e letture JSON non bounded nel coordinatore repair: un'unica FD O_NOFOLLOW, fstat pre/post con owner/link/size/stability, limite 64KB, rifiuto di hardlink/symlink e retry limitato solo per inode unlinked durante rename atomico.
- Un ledger internamente valido ma il cui ID non coincide con il pathname è `REPAIR_INTEGRITY`, anche su GET/replay/advance; test Node con due API, file swap, over-limit, ID diverso e ripristino.
- Retrocompatibilità di sola lettura per sessioni legacy e limiti #2 persistenti (firma indipendente, transazioni IAM, VM rootless, quote tenant).


## v0.2 — Confinamento dei report e journal evidence (#50)

- Eliminare `readFile(path)` non bounded nella prova per-job: report e journal devono usare FD `O_NOFOLLOW`, `fstat` pre/post, UID/links/mode/size e lettura limitata a 4MB, senza accettare inode sostituiti durante rename.
- Test su 2 API con symlink/hardlink, file con permessi insicuri, oversize e ripristino, mantenendo 404 soltanto per report mancante, 409 proof corrotta e 503 admission fail-closed; nessuna modifica a digest o schema/numero di step.
- Firma off-host, VM Docker rootless reale, IAM tenant e Cloudflare Access rimangono in #2.


## v0.2 — API job key ricaricabile senza restart (#51)

- `RUNNER_API_KEY_FILE` privato, mutuamente esclusivo con la chiave inline, con O_NOFOLLOW/fstat pre/post, owner UID, nlink=1, mode owner-only e lunghezza bounded. Reload per ogni richiesta su due repliche API: dopo rename, vecchia chiave 401; file unsafe/missing 503.
- Sotto lock di ammissione, nuova verifica della chiave prima di idempotent replay e directory job: revoca durante l'attesa non autorizza nuove esecuzioni. Compose override API-only read-only directory bind mount, worker senza secret.
- Test HTTP su due processi/repliche, rotazione, negative file e revoca durante lock. Restano IAM tenant, Cloudflare Access, Docker rootless reale e firma indipendente in #2.


## v0.2 — Primo isolamento credenziali/job e quote per tenant (#52)

- Registry `RUNNER_TENANTS_FILE` opt-in O_NOFOLLOW, owner-only, univocità tenant/chiavi con prefisso e quote bounded, hot rename senza restart delle repliche; esclusivo rispetto alla API key globale.
- Il bearer determina `tenantId` hash-chained del report; GET di ID altrui 404, replay idempotente per tenant, quota queued/retained/minuto tenant-specific in aggiunta al tetto globale, reauthorization e reload quote sotto lock POSIX.
- Test Node con due API e due tenant dimostrano isolamento JSON/evidence, rifiuto letture incrociate, quote separate, chiave revocata, rate 429, replay e rifiuto del registro non sicuro. Route repair disabilitate in modalità tenant, in attesa di ruolo operator approver specifico.
- Mancano IAM di utenti e organizzazioni, scheduling/fairness per tenant, multi-host fencing, VM rootless, Cloudflare Access e attestazioni remote indipendenti: #2 resta aperta.


## v0.2 — Input del worker letto da FD stabile, limitata e non-follow (#53)

- Protezione `jobs/<id>/input.json` in worker con `O_NOFOLLOW`, `fstat` pre/post, UID owner, hardlink/symlink vietati, mode non group/other writable, cap 8MB e lettura bounded sulla stessa FD; rifiutare JSON e inode instabili.
- Controllo digest invariato contro report/journal hash-chain, niente Docker su input unsafe, errori generici senza sorgenti. Test Node di lettura POSIX e integrazione `executeJob`; legacy 0644 non scrivibili compatibili.
- Resta #2 per attestazione off-host, VM Docker rootless, IAM tenant, fencing distribuito e Cloudflare Access realmente verificati.


## v0.2 — Preflight worker: incomplete anziché false failed (#54)

- `rejectQueuedJob` chiude in `incomplete` i `queued` non eseguibili, con evento journal `rejected` e senza inventare codice testato o esito `failed`.
- Prove Node di polling su symlink, permessi, digest mismatch, mancata esecuzione Docker e mancata ripresa dopo ripristino; GET API report/evidence continua a verificare il journal; repair AI rifiuta `incomplete`.
- No cambiamenti alla recovery di `running`, né alle quote, idempotency e ai limiti #2: Docker rootless VM, Cloudflare Access, identità e attestation off-host ancora da verificare.


## v0.2 — False failure su eccezioni worker dopo avvio (#55)

- `executeClaimedJob` classifica come `incomplete` le eccezioni di workspace/planner/test-runner senza esito di test codice verificato, anche dopo `started`, e non salva l'errore grezzo nei report.
- Preservare i veri `failed` da ricevute di test, journal `started → finished`, cleanup, assenza di auto retry e rifiuto del repair AI su `incomplete`. Test Node e API HTTP con eventi/receipt reali.
- #2 rimane aperta per VM Docker rootless + Cloudflare, identità tenant federata, fencing e trust anchor indipendente.


## v0.2 — Fair scheduling multi-tenant senza storage ulteriore (#56)

- Derivare ultimo servizio per tenant dai `startedAt` dei report già verificati e conservati; scegliere prima tenant mai serviti, poi quelli serviti meno recentemente, FIFO tra job di uno stesso tenant. UUID tie break.
- Job `queued` claimed esclusi, report terminali/running con `startedAt` validi utilizzati, rejected senza avvio non contati. Gruppo legacy FIFO globale in assenza di tenant, quote/admission/claim e classificazione esiti invariati.
- Node test unitario e integrazione worker con giornali SHA, A-B-A-B-A, claim, legacy e no retry. ADR 0013; fairness best-effort su volume POSIX singolo, non SLA o fencing multi-host. #2 aperta per VM rootless e Cloudflare/IAM/attestazione.


## v0.2 — Fail-closed rootless immediatamente prima di docker run (#57)

- Invocare `probeRootlessDocker` obbligatoriamente e just-in-time in `runDockerStep` per ogni step reale, compresa preparazione npm; negare Docker senza `true` esatto. Nessun risultato `passed`, né leakage del messaggio originale quando manca il daemon.
- Verifiche Node su no-spawn rootful/probe fallito, positivo, secondo step dopo rootless loss; job terminale `incomplete` con journal hash-chain e AI repair negato. Nessun bypass configurabile dal payload utente.
- Gli smoke Docker/Chromium/fullstack su GitHub hosted sono rootful per definizione e usano una seam test Node esplicita nei soli script CI (CI/GITHUB_ACTIONS, uid nonroot), senza modificare il worker di produzione. ADR 0014; restano rootless VM reale e attestazione off-host nella #2.


## v0.2 — Timeout: cleanup Docker vincolato a ID immutabile (#58)

- Sostituire `rm -f <name>` con due inspect vincolate a nome completo, ID completo e tutte le label del job, seguite da secondo probe rootless e rimozione per ID verificato soltanto.
- Se esiste un dubbio (nome riassegnato, falso container, rootful, risposta non valida, Docker non disponibile) non cancellare e richiedere la procedura operatore #21. Attendere il tentativo bounded prima di finalizzare timeout/claim anche senza evento `close`.
- Test Node su casi positivi/negativi, perdita del daemon, SIGKILL e mancata notifica; mantenere la CI Docker rootful distinta dal test reale VM rootless. ADR 0015; #2 ancora aperta.


## v0.2 — Rootless check JIT per tutte le operazioni della CLI orfani (#59)

- Rimuovere `inspectedHost` e obbligare `docker info --format SecurityOptions` prima di ogni `ps/inspect/rm` dell'operatore sul socket Unix rootless allowlisted; JSON array tipizzato, output 4KiB, timeout 5s sul probe e 12s sui comandi.
- Non ereditare `HOME`/config Docker o segreti dell'host; usare `DOCKER_CONFIG=/tmp` ed errori generici senza diagnostic leak. Conservare claim, prova evidenze, conferma job e verifica label; callback soltanto Node test trusted.
- Test Node simulano info ripetute, rootful/JSON malformato/socket remoto e daemon cambiato a metà cleanup con nessun `rm`. ADR 0016; #2 resta aperta per VM rootless reale, Cloudflare Access e attestazione/fencing.


## v0.2 — Pre/post fstat vincolato per file operatori repair (#60)

- Estendere l'autenticazione degli operatori repair con lettura size-pinned dal solo FD `O_NOFOLLOW`, verifiche owner-only, inode/link/size/timestamps/mode prima e dopo. Fallire chiuso per EOF, append/truncate, riscrittura in place (anche JSON valido, stessa lunghezza), chmod/link concorrenti, senza esporre path e chiavi.
- Mantenere la rotazione atomica fra richieste e la reauth all'interno dei lock; niente cache o sessione di token, niente bypass tramite job payload. Test Node deterministici tramite FD wrapper con mutazioni nel mezzo della lettura, oltre alle API due-replica preesistenti.
- ADR 0017, issue #60. Non collauda identity federation, VM Docker rootless, Cloudflare Access, fencing o attestazione off-host, ancora in #2 e #9.


## v0.2 — Recovery incompleta e retention conservativa per job orfani (#61)

- Cambiare la recovery senza claim da `failed` a `incomplete` con evento SHA-chain `recovered`, preservando step parziali, idempotenza terminale e claim esclusiva. Non trasformare un crash in codice fallito o test `passed`.
- Il coordinatore non deve iniziare repair su ultimo evento `recovered` anche se vecchi report portano `failed` con exit code di step precedente: respingere con `REPAIR_NOT_FAILED`.
- La retention controlla l'ultimo evento del journal verificato prima e *sotto il lock* di cancellazione; i `recovered` scaduti si conservano finché un operatore non riconcilia container/journal con worker e API fermati. I terminali normali scaduti rimangono eleggibili per retention.
- Test Node con export, API GET, journal legacy/moderni, repair negato, claimed job, no retry e retention. ADR 0018; quota preservata a costo di spazio non limitato per orfani finché non interviene l'operatore. #2 aperta per fencing e VM Docker rootless reale.


## v0.2 — Canary rootless con probe fresco prima di ogni comando (#62)

- Non affidarsi al probe iniziale del canary: richiedere `probeRootlessDocker({host}) === true` appena prima di ogni `create`, `inspect`, `start --attach` e `rm`, senza session cache.
- Negare l'esecuzione anche con daemon che cambia a metà ciclo, output diverso da `true`, errori o timeout, senza secret leak. Se il container non è stato verificato o il daemon non è più rootless al cleanup, non cancellare e lasciare investigazione manuale operator-only.
- Test Node deterministici per tutte le transizioni, mantenimento degli argomenti Docker immutabili e CI real-Docker rootful via script di smoke trusted. ADR 0019. La #2 richiede ancora VM rootless e Cloudflare Tunnel/Access reali, fencing e attestazione indipendente.


## v0.2 — Canary rootless: cleanup operator-only del container residuo (#63)

- Aggiungere CLI di riconciliazione canary separata dal cleanup dei job, con UUID non segreto emesso prima di `create`, dry-run di default, `--apply --confirm-canary` esplicito e divieto di cleanup generico.
- Verificare che ogni `ps`/`inspect`/`rm` usi un probe rootless fresco e lo stesso socket Unix locale. Accettare un unico container con label/nome/ID completi, configurazione di sicurezza esatta, stato `created/exited` non-running; doppia ispezione e `rm -f <ID completo>` soltanto dopo conferma.
- Test Node positivi/negativi su rootful/lost daemon, credenziali nei messaggi Docker, rimpiazzo ID e stato, container malevoli, parsing CLI e non-root. Nessun delete per label falsa o job container. ADR 0020; l'epica #2 resta aperta per host rootless effettivo e attestazione indipendente.


## v0.2 — Preflight .env privato con file descriptor stabile (#64)

- Proteggere `preflight.mjs --env-file`: un solo FD O_NOFOLLOW, owner euid, mode esatto 0600, nlink=1, dimensione 1..32768 byte, lettura esatta e secondo fstat vincolato a inode, permessi e timestamp; errori statici senza leak di credenziali.
- Test Node deterministici su symlink, mode/link/owner/size invalidi, mutate durante read (rewrite same-size, append/truncate/chmod/hardlink), short read e fstat spoof; mantenere parser e preflight host/HTTPS preesistenti.
- ADR 0021. La prova vera su VM Docker rootless, Cloudflare Tunnel/Access, IAM, fencing e firma off-host resta in #2.


## v0.2 — Preflight Compose: allowlist dei servizi e isolamento mount (#65)

- Rifiutare ogni servizio aggiuntivo al Compose risolto oltre a API, worker e tunnel opzionale; impedire il falso `status:passed` di un progetto con sidecar privilegiato o porte pubbliche non validate.
- Denegare a `cloudflared` qualsiasi mount incluso `volumes_from`, `secrets`, `configs`, `tmpfs`, device o namespace condiviso; negare questi mount impliciti anche a API/worker per evitare che l'API erediti il socket del worker; imporre path host canonici sicuri e data/work non sovrapposti. Preservare solo il socket dedicato `/run/user/1000/docker.sock` del worker.
- Regressioni Node su override sidecar, tunnel host mount, path traversal e profili validi, più smoke Compose CI. ADR 0022; VM rootless e Cloudflare Access reali non ancora attestati (#2).


## v0.2 — Preflight Access service-to-service con doppia autenticazione (#66)

- Aggiungere al comando operator-only `preflight endpoint` supporto facoltativo a `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` da file 0600 O_NOFOLLOW, separati da `RUNNER_API_KEY`, mai distribuiti alla SPA. Pair required/bounded/ASCII, nuovi secret `cfast_` e 64-hex legacy supportati.
- Prima verificare `GET /healthz` senza Access non 200 (solo 302/401/403, non seguire redirect), poi check 4 richieste già esistenti con entrambi gli header Access, mantenendo validazione API 401/200 e CORS. No POST e nessun token in result/log.
- Test mock di gateway/HTTP con negativa, credenziali incomplete e injection, token scaduto, CORS, CLI `--env-file` e compatibilità senza Access. ADR 0023; prova vera Cloudflare Access browser + rootless VM ancora in #2.


## v0.2 — Compose namespace e profili di sicurezza senza override (#67)

- Rafforzare `inspectComposeConfig` rifiutando namespace personalizzati per API, worker e tunnel: network, PID, IPC, UTS, userns, cgroup e isolation, inclusi riferimenti `service:`/`container:`.
- Validare `security_opt` `["no-new-privileges:true"]` e `cap_drop` `["ALL"]` **esatti**, non come inclusione; rifiutare ulteriori profili seccomp/AppArmor, device/GPU/extra group/sysctls, privilegi non-boolean e mount già vietati.
- Test Node positivi e negativi su tutti i servizi, mantenendo il Compose preflight reale e override operator-registry. ADR 0024; mancano VM rootless/Access reali, IAM/fencing e attestazione off-host (#2).


## v0.2 — Preflight del codice runtime Compose e build provenance (#68)

- Rifiutare modifiche a `image`, `build.context`, `build.dockerfile` e tutte le altre build options del runner: worker e API devono essere costruiti solo dal checkout e dai due Dockerfile revisionati; vietati comandi/entrypoint, healthcheck e lifecycle hooks sostitutivi.
- Controllare le variabili di ambiente runtime tramite allowlist delle chiavi del Compose approvato e dei suoi override di credenziali, bloccando `NODE_OPTIONS`, `LD_PRELOAD` e `NODE_PATH`; `RUNNER_DATA_DIR=/data` nei servizi. Anche tunnel con immagine ufficiale e nessun build/entrypoint/hook estraneo.
- Test Node su override maliziosi con socket montato e config normale; verificare Compose reale con registry opzionale in CI; documentare ADR 0025. Non equivalgono ad attestation di digest o alla prova reale VM Docker rootless, Cloudflare Access e fencing (#2).


## v0.2 — Allineamento host/Compose su path e symlink (#69)

- Il preflight host deve imporre path assoluti canonici e non di sistema per le directory dati e workspace, senza sovrapposizioni parent/child. Permettere prefissi simili ma non nested.
- Verificare via `lstat` ogni componente parent dei due host path e del socket Unix Docker, negando symlink intermedi o segmenti non directory prima del probe del daemon. Controllare owner UID 1000 e permessi leaf come prima.
- Test Node su nesting, percorsi non canonici, prefissi simili, parent symlink reali e Docker non contattato in caso di errore; ADR 0026. Corsa TOCTOU e attestazione VM/Cloudflare reali rimangono aperte in #2.


## v0.2 — Preflight dei network attachment Docker Compose (#70)

- Limitare il JSON Compose risolto a una sola rete top-level `default`, non external, senza driver/IPAM configurato o nomi custom (ammesso solo `ipam: {}` vuoto emesso da Compose v2), nominata come `<project>_default` con sintassi progetto ammessa.
- Per runner API, worker e tunnel opzionale consentire soltanto la default implicita o esplicita senza alias, priority, IP statici o reti aggiuntive. Vietare reti condivise/external pur quando `network_mode` non è impostato.
- Test Node parametrizzati e controllo del Compose reale CI con override; documentare ADR 0027. Resta da attestare isolamento della rete/daemon su VM Docker rootless vera, insieme a Cloudflare Access e fencing (#2).

## v0.2 — Bind mount Compose opzioni e isolamento registry operatori (#71)

- Per ogni volume bind risolto di runner API/worker consentire soltanto `type/source/target/read_only/bind` e `bind.create_host_path` booleano: bloccare propagation, SELinux, consistency, volume/tmpfs e campi sconosciuti; proteggere read-only registry e read-write di data/work/socket.
- Impedire che l'API operator registry abbia una source host identica, parent o child di directory data/workspace visibili al worker. Test Node positivi, negativi e controllo Compose v2 standard nella CI. ADR 0028; non sostituisce host rootless/Cloudflare e attestazione (#2).

## v0.2 — Preflight DNS/hosts e comando tunnel (#72)

- Rifiutare DNS, extra_hosts/links e nomi host/container/MAC personalizzati su API, worker e cloudflared, per impedire redirect del nome `runner-api` sotto la singola rete default.
- Vincolare cloudflared al solo argv normalizzato `tunnel --no-autoupdate run --token <token>`, UID 1000, rootfs read-only e assenza di environment custom; test Node, Compose v2 reale e ADR 0029. Non prova provider Cloudflare, daemon rootless VM, fencing o attestazione off-host: epica #2 ancora aperta.

## v0.2 — Preflight Compose delle modalità auth file/tenant (#73)

- Supportare `--runner-key-file` e `--tenants` mutuamente esclusivi, e operator registry solo in modalità global-inline/file. Selezione esatta degli override approvati, senza bypass del check dell'intero Compose.
- Mount API di `runner-key`, `tenants.json` e `operators.json` read-only, path host canonici disgiunti da dati/workspace e tra di loro, ambiente e target file coerenti, nessuna credenziale sul worker. Suite Node negativa e positiva + Compose v2 reali in CI. ADR 0030.
- Non sostituisce verifica UID/mode di file e directory host, runtime Docker rootless VM, Cloudflare Access o attestazione off-host: #2 resta aperta.

## v0.2 — Host preflight autenticazione file/tenant e endpoint probe dedicato (#74)

- Supporto ai flag espliciti host/endpoint `--runner-key-file` e `--tenants`, no fallback alla key inline. Validazione directory private host UID 1000, mode 0700, parent no-symlink, non-overlap e lettura sicura di key/tenant/operator file con FD O_NOFOLLOW, metadati stabili e rotazione tramite rename.
- Per endpoint remoto usare soltanto `RUNNER_PROBE_BEARER` off-host in env 0600 del singolo operatore: nessuna lettura o esposizione del tenant registry completo. Suite test reali/simulati + ADR 0031. I controlli non attestano Cloudflare o VM rootless reale; #2 resta aperta.

## v0.2 — Canary con provenienza dello script e namespace limitati (#75)

- `docker inspect` del canary e reconciler verifica `Config.Cmd` esatto, non soltanto l'entrypoint e un marker stdout contraffabile.
- Security_opt univoco `no-new-privileges`, solo namespace privati, nessun DNS/hosts custom, gruppo/device/mount/sysctl/cgroup extra; nuovi test Node di tampering e smoke vero Docker rootful CI-only, ADR 0032. Test VM rootless/Cloudflare reali e attestazione off-host ancora aperti in #2.

## v0.2 — Bootstrap canary Docker e policy Env fail-closed (#76)

- Dopo l'ispezione del comando e dei namespace (#75), verificare anche `Config.Env` contro i soli tre default dell'immagine `node:22-bookworm-slim`, negando override `NODE_OPTIONS`/`NODE_PATH`/`LD_PRELOAD`, duplicati, input malformati e qualunque healthcheck non revisionato.
- Test Node con injection pre/post-start e riconciliazione, smoke vero Docker rootful CI-only, documentazione e ADR 0033. L'epica #2 resta aperta per test VM rootless e Cloudflare veri e attestazione indipendente.

## v0.2 — Acceptance locale VM rootless composita (#77)

- Nuova CLI manuale/operator-only con UID 1000, flag `--confirm`, env 0600 e digest Node immutabile pre-cached; controlla sequenzialmente Compose, host e canary reale **sulla socket del daemon rootless host**. Tutti i gate devono passare e la cleanup essere verificata prima di emettere receipt minimale priva di segreti.
- Test Node su profili, ordering, cancellazione/abort, receipt e no secret leak; ADR 0034, README e runner guide. Non è prova VM reale finché non è eseguita da un operatore sulla VM; CI usa Docker rootful solo per component smoke. Sono ancora aperti la verifica HTTPS/Cloudflare off-host, il fencing cross-host e l'attestazione indipendente in #2.

## v0.2 — Acceptance VM con rilevamento rotazione env tra gate (#78)

- `vm-acceptance` valida subito il private env con single-FD stabile, mode 0600 e UID del proprietario; confronta tutti i valori dopo Compose, host e canary. Fail-closed su rotazione, eliminazione, path non sicuro e read errors; nessuna credenziale/impronta in ricevuta.
- Test Node per differenze, reordered equivalenti, failure con segreti, rename atomico reale su filesystem privato; ADR 0035. Resta da collaudare sulla vera VM rootless e dietro Cloudflare esterno, senza fingere transazioni/fencing atomici (#2).

## v0.2 — Timeout Docker e retention dei job da riconciliare (#79)

- Registrazione del risultato di cleanup sui timeout; `cleanupVerified:true` soltanto dopo esito positivo verificato. Report `incomplete` e summary di riconciliazione se cleanup incerto.
- Retention fail-closed su step Docker e preparazione npm scaduti con `timedOut:true` e `cleanupVerified !== true` (anche legacy), più check dentro il lock admission. Test Node di timeout, eccezioni e journal TTL, ADR 0036. L'epica #2 mantiene VM rootless live, Cloudflare Access/Tunnel e fencing/attestazione distribuiti come attività aperte.

## v0.2 — Finalizzazione operator-only dei journal Docker orfani (#80)

- Claim POSIX esclusiva per ogni cleanup applicata; `--finalize` richiede `--apply --confirm-job`, rimozione per full Docker ID e conferma finale zero container etichettati tramite daemon rootless.
- Nuovo evento append-only `reconciled` nella chain con stato e output di test immutati; repair continua a rifiutare qualunque job recuperato storicamente. I journal vecchi e finalizzati possono tornare alla retention normale dopo esportazione dell'audit necessario.
- Test Node per concorrenza, idempotenza, integrità, report falliti non promossi, retention, e smoke Docker CI reale, ADR 0037. Da fare: prova VM rootless e Cloudflare live, fencing/attestazione off-host, job autonomy reali (#2).

## v0.3 — Anti-cache e validazione pubblica OIDC nello scaffold (#81)

- Nginx statico e generato applicano `Cache-Control: no-store` con CSP e referrer policy su tutte le risposte, compresa la callback PKCE; trade-off esplicito: cache asset statici disabilitata.
- Build fail-closed se `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_AUDIENCE` sono parziali o whitespace-only; restano i vincoli URL HTTPS già presenti e l'eccezione soltanto per CI privata.
- Test Vitest sul vero script Nginx generato e Chromium sul vero header HTTP per `/` e `/auth/callback`; ADR 0038. Epica #9 aperta per federazione con IdP esterno, revisione threat model browser/CSP/BFF, CDN/TLS e rollout operativo.

## v0.3 — Compose local-only e configurazione deploy OIDC esplicita (#82)

- Frontend generato non più su `0.0.0.0:3000`: bind `127.0.0.1:3000:80`, API/database già loopback. `APP_ENVIRONMENT` mappato all'ASP.NET Core runtime (default Development solo per locale), `PUBLIC_API_URL` impostabile per browser HTTPS e CSP.
- `OIDC_PUBLIC_AUDIENCE` separata da `AUTH_AUDIENCE` per eliminare la regressione #81 in build legacy/dev; validazione CSP 0-o-3 completa preservata. Aggiornati `docker/.env.example` e README dello scaffold.
- Test Vitest della generazione e `docker compose config --format json` in CI sulle modalità locale/HTTPS senza avviare servizi; ADR 0039. Per l'epica #9 restano IdP reale su HTTPS, edge TLS/CORS/CDN certificati, BFF e modello sessione production.

## v0.3 — Validazione schema Compose con services + volumes (#83)

- Risolto il bug segnalato dalla CI della #82: la sezione top-level `volumes:` viene scritta dopo tutti i servizi (compresi Jaeger, Redis, RabbitMQ e MinIO) e solo per database con named volume.
- Management ports RabbitMQ/Jaeger/OTLP ora bindate loopback; quattro varianti database e servizi opzionali verificate tramite `docker compose config --format json` nella Factory CI.
- ADR 0040. Si tratta di controllo sintattico/di configurazione, non prova della salute o sicurezza di immagini/servizi né deploy production-ready; l'epica #9 rimane aperta.

## v0.3 — Allowlist CORS HTTPS per API OIDC generata (#84)

- Nuovo `BrowserCorsStartup.cs` nello scaffold PostgreSQL: `Web:AllowedOrigins` esplicito e obbligatorio in Production/Staging/QA, solo HTTPS e senza wildcard/credentials; default HTTP soltanto loopback o host CI web in Development.
- Configurazione Compose `WEB_ALLOWED_ORIGINS`, `docker/.env.example`, README applicazione generata aggiornati; distinguere frontend origin da `PUBLIC_API_URL` dell'API browser.
- Test Vitest dei template, fail-closed sul binario compilato ASP.NET Core e preflight OPTIONS allow/deny su API fullstack con Playwright/IdP CI. ADR 0041. Da fare nell'epica #9: IdP HTTPS esterno reale, protezioni BFF/sessione, TLS e CORS effettivo su reverse proxy/CDN produzione.

## v0.3 — Gate fullstack Playwright dinamico e fail-closed (#85)

- Rimosso il controllo hardcoded del reporter `17 passed`: il test CORS della #84 porta il browser smoke completo a 18 casi. Il gate ora conta i test del fixture generato, richiede esattamente N passed, stato/exitCode/timeout corretti e zero skipped/flaky/failed/interrupted.
- Test Node per cardinalità 17/18/N e negativi contro riepiloghi manipolati, timeout, skip, file spec non valido; CI con Playwright, PostgreSQL e IdP locale reale. ADR 0042. L'epica #9 resta aperta per validazione IdP/TLS production.

## v0.3 — Test Production TLS OIDC/JWKS con CA e issuer SAN effimeri (#86)

- Alla suite Chromium↔ASP.NET Core/PostgreSQL/OIDC via HTTP privato si aggiunge un test di backend **Production con authority HTTPS** verificata: provider su `identity-tls:9443`, CA+cert SAN ephemeral, API trusted CA e API senza CA (401 obbligatorio).
- Node senza CA deve respingere la connessione; con CA, l'API trusted deve validare JWT RS256 original/rotated kid, alterazioni firma, reader/editor e negare ruoli ambiguamente firmati. Ripulire i materiali CA privati e tutte le istanze Docker a fine CI.
- Test Node delle sole origini di issuer consentite, `npm check` e integrazione Docker reale, ADR 0043. Fuori scope: IdP HTTPS commerciale esterno, revoca certificati CRL/OCSP, ingress TLS/CORS production e simulazione VM rootless (#9/#2).

## v0.2 — Installazione iniziale locale runner connector, M2 parziale (#88/#87)

- CLI operator-only per Linux UID 1000: `--check` read-only su Git main SHA immutabile, private env 0600 e preflight Compose/host; `--apply --confirm-install` richiede VM acceptance canary rootless digest-pinned, claim esclusiva, assenza di stack esistenti e `docker compose up --build` del solo runner-api/runner-worker, senza Tunnel/SSH/host rootful.
- Controlli runtime post-avvio sui container esatti, mount socket solo nel worker e GET rootless readiness autenticati via loopback; receipt locale e segreti mai mostrati. Test Node deterministici su policy, mutazioni dell'env, concorrenza, Docker rootful/sostituito, percorsi falsificati e profili credenziali; CI Factory tradizionale conferma non regressione.
- **Resta in #87 M2:** collaudo reale su PC/VM Linux con rootless e lifecycle di packaging/version pin, update/rollback, uninstall e revoke; #87 M3 pairing temporaneo, M4 topologie fullstack amministrate, M5 attenuazione rischi multi-host/off-host. ADR 0044.


## Software house multi-ruolo BookWriter-style + installazione host (#89, 17 novembre 2026)

Prima tranche su `main`:
- 23 ruoli dichiarati con responsabilità e routing endpoint/modello/thinking.
  Sei ruoli eseguono le fasi AI Factory, developer/reviewer/fix sono
  effettivamente usati dal Code Agent; gli altri sono configurabili ma inattivi.
- L'API AI riceve il modello per ruolo e un `reasoning_effort` esplicito
  per low/medium/high/xhigh; automatic non lo invia. Ancora da allineare
  a BookWriter su discovery `/models`, capabilities provider, streaming,
  token limits, costi, output e interfaccia di manutenzione endpoint.
- Bootstrap CLI su Linux uid 1000 per generare config privata e avviare la
  stack runner preflightata; tunnel/reverse proxy ancora da configurare
  manualmente; non è un installer dal browser.
- Il backup app folder esistente trasferisce settings non segreti,
  ora comprensivi di runnerEndpoint e agentRoutes anche al ripristino.
  Non c'è vault cifrato, sync automatico/versionato né merge multi-device.

**Milestone aperte**: scheduler PM persistente con timeline, handoff
analista→architect→developer→tester→fix→review→re-test; model inventory e
reasoning capabilities BookWriter; installer host versionato/firmato e pairing
con scadenza/revoca; cloud profile E2EE e CAS/conflict management; sandbox
multi-container governate dal worker; collaudo on-prem/VM/tunnel reali.
Tracciamento in [#89](https://github.com/KeyserDSoze/SoftwareFactory/issues/89)
e [#87](https://github.com/KeyserDSoze/SoftwareFactory/issues/87).
