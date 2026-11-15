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
