# SoftwareFactory

**SoftwareFactory** è un AI App Studio *local-first* ispirato a [BookWriter](https://github.com/KeyserDSoze/BookWriter). Parte da un brief, produce un piano per feature e ricerca, propone architettura, esegue adversarial review e genera un progetto sorgente modulare.

## Funzionamento della prima versione

- SPA responsive React 19 + TypeScript + Vite; nessun backend centrale richiesto per la factory.
- Pipeline AI con sei fasi, prompt specializzati, salvataggio dei checkpoint sul browser e stop/ripresa.
- Endpoint OpenAI-compatible multipli, routing modello per task e API key solo in sessione.
- Ricerca con gateway configurabile (GET `?q=...` → `results: [{ title, url, snippet }]`); fallback Wikipedia **non adatto a verifiche legali/competitive complete**. La ricerca non viene inventata se il provider è indisponibile.
- Configuration composer: frontend React/React Native/Android/iOS/Unity, .NET 11 o 10 LTS, PostgreSQL o altri database, Azure/AWS/GCP/on-prem, servizi per development/production.
- ZIP sorgenti e pubblicazione GitHub diretta (PAT fine-grained, GitHub App tramite token broker), branch `main` di default oppure branch separato. Il commit usa fast-forward, mai force push.
- Google Drive appDataFolder / Microsoft OneDrive app folder: OAuth 2.0 PKCE con client ID configurabile, backup/ripristino JSON.
- **Repair guidato dagli errori**: report associati al digest SHA-256 del codice; patch AI di correzione con massimo due tentativi, vincoli sui file e nuova review/test prima dell'approvazione.
- **OIDC/JWKS + PKCE nello scaffold PostgreSQL**: validazione JWT asimmetrici RS256 via discovery/JWKS, login/logout React con oidc-client-ts e authorization code PKCE; JWT HMAC legacy solo in sviluppo. Restano RBAC reader/editor, isolamento dati per owner e audit.
- **Playwright Chromium E2E**: test browser con API simulata e integrazione React↔ASP.NET Core su rete Docker privata.
- **Runner verificato con Docker reale in CI**: preparazione npm separata dai test senza rete, dipendenze online solo con opt-in dell'amministratore e riconoscimento degli errori di setup.
- **Remote Test Runner (MVP sperimentale)**: API autenticata con API key, worker Docker rootless separato, job isolati e report con exit code e log; Cloudflare Tunnel opzionale ([guida](docs/runner.md)).
- **Code Agent supervisionato**: patch multi-file a sorgenti C#/React, review avversaria indipendente, confronto delle differenze, approvazione, undo, recovery dei conflitti ed export solo degli override approvati.
- Generatore di **scaffold compilabile React + ASP.NET Core** con cartelle `docs/`, `adr/`, `docker/`, `infra/`, `tests/`, `src/backend/{applications,business,domain,infrastructure}/`, `src/frontend/` e GitHub Actions.

**Attenzione:** il Code Agent propone e applica codice dopo review e consenso, ma non esegue ancora autonomamente build, test o remediation nel browser. Non garantisce di implementare tutte le feature o deploy finali. React Native, Android, iOS, Unity e molti provider cloud sono target descritti nel manifest/placeholder, da implementare nelle iterazioni successive. Le integrazioni di ricerca dipendono da CORS e dalle credenziali del provider.

## Avvio locale

```bash
cd src/frontend
npm install
npm run dev
npm run typecheck
npm run test
npm run build
```

Apri l'indirizzo indicato da Vite (normalmente http://localhost:5173). In alternativa: `docker compose -f docker/compose.yml up --build` e visita http://localhost:8080.

## Uso

1. Nel **Workspace** inserisci nome, brief e vincoli.
2. In **Architecture** scegli frontend (anche multipli), database, .NET, deployment e binding dei servizi per development/production.
3. In **Settings** configura endpoint, modello e credenziali temporanee; opzionalmente aggiungi un gateway di ricerca web.
4. In **AI Factory** avvia la pipeline, verifica fonti e risultati, correggi gli output e riprendi quando serve.
5. In **Architecture** esamina e scarica i file generati come ZIP.
6. Se vuoi pubblicare, configura owner/repo/branch GitHub in Settings, controlla la visibilità, autorizza e pubblica. La repository viene creata automaticamente solo se il token lo permette.
7. In **Code Agent** descrivi una feature, controlla la review e i diff, quindi applica la proposta: lo ZIP e GitHub includeranno le modifiche approvate. Se il runner segnala un fallimento associato a una proposta corrente, puoi chiedere una correzione AI limitata a due tentativi; per approvarla sarà necessaria una nuova review e una nuova verifica positiva.
8. Facoltativo: collega un [runner remoto](docs/runner.md) in **Settings → Remote runner** per inviare il codice al worker e leggere i risultati di compilazione/test.
9. Per un backup cloud configura OAuth SPA (Google/Microsoft), connetti e scegli Backup.

## Sicurezza e limiti

- Non mettere token nei file: API key, PAT e access token OAuth sono conservati **solo nella sessionStorage**, e non sono inclusi in ZIP, GitHub o Drive.
- Per GitHub App serve un **backend broker attendibile**, che rilasci installation token di breve durata: la chiave privata della App non può vivere in una SPA.
- Per Google/Microsoft occorre registrare un'app OAuth pubblica e autorizzare esattamente l'URL di redirect mostrato in UI.
- JWT HMAC legacy nelle app PostgreSQL generate ammessi **soltanto in Development**: gli ambienti Staging, Production e custom devono usare OIDC/JWKS. L'accesso ai dati richiede un solo `sub` firmato, non vuoto e di lunghezza massima 255. Gate testati da Factory CI (issue #10).
- La sessionStorage e i token in memoria **non proteggono** da XSS o estensioni del browser malevole. Non usare modelli/API non fidati con dati sensibili.
- L'E2E in modalità mock usa /health simulato; in modalità integration verifica l'API .NET e, per il provider PostgreSQL, crea, legge ed elimina un record reale. **Solo PostgreSQL ha un adapter runtime funzionante**: MySQL, SQL Server e SQLite restano configurazioni/placeholder. Gli endpoint dati PostgreSQL ora richiedono un JWT valido, ruolo e proprietà del record. Lo scaffold supporta ora login OIDC PKCE verso un provider configurato dall'operatore. La CI usa un **provider di prova**, non un servizio identità di produzione. Restano da verificare refresh, logout federato e rotazione con IdP reale, oltre a CSP, TLS e sicurezza delle sessioni browser prima di un deploy pubblico.
- La pipeline AI gira **solo mentre la scheda è attiva**. Il salvataggio è locale, non è un worker persistente. Il browser può sospenderla in background.
- Il generatore non garantisce conformità legale, qualità del codice o configurazione cloud pronta per produzione.
- Gli input di ricerca e i contenuti dell'utente possono finire sui provider scelti: verificare privacy, permessi e termini.

Guide: [Remote runner](docs/runner.md) · [Code Agent](docs/code-agent.md) · [architettura](docs/architecture.md) · [sviluppo](docs/local-development.md) · [integrazioni](docs/connectors.md) · [roadmap](docs/roadmap.md) · [ADR](adr/0001-local-first-factory.md).

## Branch e contribuzione

Lo sviluppo della factory avviene su **`main`**. Lo scaffold generato usa `main` salvo diversa scelta dell'utente; il merge da un branch di feature viene effettuato in GitHub e non automaticamente dal browser.

## Gestione sessione scaduta (issue #11)

Le applicazioni PostgreSQL generate ora rimuovono la sessione browser quando la API risponde HTTP 401 su list/create/update/delete: cancellano l'access token locale e nascondono i dati fino a un nuovo login esplicito. Il 403 non disconnette l'utente (permessi insufficienti). La CI verifica 401/403 reali tramite Chromium e API .NET+PostgreSQL: Playwright modifica solo gli header delle richieste nel test, non simula le risposte HTTP. Questo **non** implementa revoca federata, BFF cookie HttpOnly o difesa XSS/CSP adatta a un ambiente pubblico (issue #9).

## Rotazione JWKS verificata sulla API in esecuzione (issue #12)

La Factory CI ora esercita anche la **vera API ASP.NET Core già in esecuzione**: accetta un JWT RSA iniziale, fa ruotare il provider di test, verifica l'accettazione di un nuovo `kid` **senza riavviare** il backend (con retry limitati per il refresh metadata/JWKS), nega una firma manomessa con 401 e continua ad applicare RBAC 403. Lo script `src/runner/scripts/oidc-api-rollover-smoke.mjs` viene eseguito solo nella rete Docker effimera interna alla CI e non registra JWT o secret.

Questo gate **non significa revoca immediata dei vecchi JWT**, né dimostra comportamento con Identity Provider reali, interruzioni della rete, picchi di carico, logout federato o un deployment sicuro: la #9 rimane aperta.

## Refresh token e logout federato testati nel browser (issue #13)

Nella CI fullstack, Chromium esegue adesso **il vero `oidc-client-ts` generato** e invoca un rinnovo esplicito della sessione OIDC attraverso il grant refresh-token del provider RSA effimero: si verificano la rotazione di access e refresh token, l'aggiornamento dello storage browser, il rifiuto del replay del refresh token precedente (HTTP 400) e l'accesso ai dati sulla vera API .NET/PostgreSQL con il token rinnovato. Un reload mantiene la sessione aggiornata. Il test di logout controlla anche il redirect HTTP al provider, la callback e la rimozione delle credenziali locali; l'orchestratore controlla i contatori del provider **prima** del test protocollare Node. I token non vengono esposti nei log dei test.

Questa prova usa un **Identity Provider fittizio nella rete Docker interna**, non un IdP aziendale o pubblico. Non verifica revoca degli access token già emessi, logout globale da più client, disponibilità di servizi HTTPS reali o difese XSS/CSP/BFF: la issue #9 resta aperta.

### Correttezza OIDC `auth_time` nella fixture CI (issue #14)

Il nuovo test browser della #13 ha rilevato un difetto del provider di test: al rinnovo cambiava `auth_time`, perciò `oidc-client-ts` rifiutava correttamente l'ID token. La fixture conserva ora l'istante di autenticazione originario attraverso più rotazioni di refresh token (mentre i nuovi ID token ricevono il proprio `iat`). La prova protocollare controlla due refresh successivi, stabilità del claim e rifiuto del replay. Questa correzione riguarda **solo il provider CI**, non una garanzia di sicurezza o correttezza degli Identity Provider reali.

## Errori terminali e temporanei nel refresh OIDC (#15)

Le app PostgreSQL generate distinguono gli errori protocollari definitivi di rinnovo (`invalid_grant`, `login_required`, `invalid_token`) dai guasti di rete temporanei. Sul rifiuto definitivo la SPA elimina la sessione OIDC locale, nasconde i dati CRUD e richiede una nuova autenticazione, senza redirect automatici. Una richiesta di refresh fallita per rete non disponibile, con access token ancora valido, non cancella lo user store. Si ascoltano anche gli eventi di errore del rinnovo automatico, oltre al rinnovo esplicito tramite `renewOidcSession()`.

La Factory CI effettua due prove nel **browser Chromium reale**: prima consuma il refresh token con il provider RSA temporaneo e verifica che il successivo rinnovo riceva `invalid_grant`, poi interrompe soltanto la connessione al token endpoint e verifica la conservazione della sessione valida. Il test restituisce solo booleani/status, senza JWT o refresh token nei log. Non costituisce revoca distribuita di access token già emessi, IdP esterno certificato o sessioni BFF/CSP sicure in produzione; resta aperta la #9.


## CSP Nginx per le SPA PostgreSQL generate (#16)

Il Dockerfile web genera una **Content-Security-Policy enforced** durante la build, validando gli URL pubblici API/issuer OIDC e normalizzandoli agli origin HTTPS (HTTP consentito solo su loopback o per la rete di test CI isolata). Rifiuta URL contenenti caratteri speciali, credenziali, query o fragment; i percorsi dei provider (ad esempio realm Keycloak) sono supportati ma esclusi dagli origin della policy. `script-src 'self'` vieta gli script inline e eval, mentre `connect-src` consente solo app, API e IdP. Il file `src/frontend/web/nginx.conf` nel sorgente è un esempio per localhost: il Dockerfile lo **rigenera da VITE_API_URL/VITE_OIDC_AUTHORITY** con `scripts/build-nginx.mjs`. Occorre ricostruire l'immagine quando cambiano gli origin e predisporre reverse proxy/TLS in produzione.

La Factory CI verifica l'header sul server **Nginx reale** e sulla callback `/auth/callback`, controlla il caricamento della SPA compilata e in Chromium dimostra il blocco di uno script inline. Lo styling React usa tuttora `style-src 'unsafe-inline'` (solo stili, non script); la CSP mitiga alcune classi di XSS, ma **non** protegge da tutti gli attacchi a sessionStorage e non sostituisce BFF/HttpOnly, policy CSRF e test con IdP reale (issue #9).


## Logout OIDC tra schede dello stesso browser (#17)

Nelle app PostgreSQL generate, un **logout esplicito**, un **401 della vera API** oppure un rinnovo OIDC fallito definitivamente (`invalid_grant`) pubblicano un segnale `BroadcastChannel` alle altre schede dello **stesso origin**. Il messaggio contiene esclusivamente la costante `logout`, mai JWT, refresh token, identificatori utente o dati PostgreSQL; non usa `localStorage`. Le altre schede eliminano autonomamente il proprio `sessionStorage` tramite `oidcManager().removeUser()`, nascondono dati e form protetti e chiedono un nuovo login senza avviare redirect automatici o un loop di notifiche.

La Factory CI usa ora **15 prove Chromium fullstack** su API ASP.NET Core e PostgreSQL reali: due test aprono due schede con login PKCE indipendenti, verificano logout federato dalla prima scheda e propagazione di un 401 reale, anche dopo reload della seconda. Il meccanismo è **best-effort locale**: non garantisce notifica per schede sospese/chiuse, altri browser o dispositivi, non revoca JWT già emessi ed è distinto dal logout back-channel dell'Identity Provider. BFF/HttpOnly, CSRF e prove con IdP HTTPS reale rimangono nella #9.


## Runner: claim atomica contro esecuzioni doppie (#18)

Il worker crea una claim esclusiva sul volume condiviso **prima** di leggere il report. Altri worker non riavviano il job né marcano erroneamente `failed` un'esecuzione in corso. Il blocco si libera anche dopo un'eccezione gestita, mentre dopo un crash richiede verifica manuale di worker/container orfani: nessun furto di lock basato su timeout. La coda prosegue con i job liberi. Non equivale a fencing distribuito o a deployment rootless certificato, ancora da completare nella #2.


## Evidenze dei test del runner con hash-chain (#19)

Ogni job remoto produce un registro append-only `evidence.jsonl`: accettazione, avvio, preparazione, step e risultato finale, con SHA-256 concatenati e snapshot dei report. `GET /v1/jobs/{id}` e `GET /v1/jobs/{id}/evidence` (API key Bearer) validano la catena, il suo `head` e il report. Una manomissione, un journal mancante o troncato dà **409 `evidence_invalid`**, non `passed`. Il runner salva output e comandi redatti; la CI include regressioni di manomissione e smoke Docker reale. **Non è un'attestazione crittografica esterna:** con controllo completo del disco si possono rigenerare catena e report; firme e ancoraggio off-host restano nella #2.


## Coda runner: admission atomica e retry idempotenti (#20)

Le richieste `POST /v1/jobs` vengono serializzate da una claim condivisa prima del controllo quota (**4 job attivi** di default, configurabili con `RUNNER_MAX_QUEUED`, massimo 100 directory conservate). Due API sullo stesso filesystem non possono accettare contemporaneamente oltre quota. Il client invia `Idempotency-Key` UUID v4: una richiesta ripetuta con lo stesso payload riceve lo stesso job ID anche dopo il completamento; il server conserva soltanto il fingerprint SHA-256 della chiave. Un payload differente con la stessa chiave riceve 409, chiavi non valide 422. Il browser riutilizza la chiave quando ritenta un invio non confermato, senza duplicare un test già accettato. Il lock è fail-closed su crash (503 finché non riconciliato). L'idempotenza dura fino alla retention del job, non è una coda transazionale multi-host né un sistema multi-tenant; la #2 resta aperta.


## Sicurezza dei container orfani del runner (#21)

I container di compilazione e test usano ora nomi `sf-<UUID completo>-<step>` e tre label Docker statiche per runner, ID job e step, **mai segreti o sorgenti**. Un comando operator-only sul worker, `node src/runner/orphans.mjs --job=<UUID>`, verifica il registro di evidenze e mostra i container del job in **dry-run**. Solo `--apply --confirm-job=<stesso-UUID>` consente di rimuovere container con nome e label corrispondenti, appartenenti a job `failed/incomplete` senza claim; è vietato per job `queued/running/passed`. Non fa prune, non modifica report, non riavvia test. Serve un socket Docker rootless e una verifica umana dei worker/lock residui. Dettagli nella [guida runner](docs/runner.md).


## Preflight VM rootless / Docker Compose / endpoint TLS (#22)

Il nuovo controllo non distruttivo `node src/runner/preflight.mjs compose|host|endpoint` valida rispettivamente l'isolamento dichiarato nel Compose, i permessi della VM e l'identità **rootless** del daemon, e i controlli HTTPS/Bearer/CORS di un runner raggiungibile. Non stampa configurazioni o segreti e non crea job. La CI verifica il Compose risolto con credenziali placeholder e simula controlli host/TLS; il vero collaudo della VM rootless e del Cloudflare Tunnel **non è stato ancora effettuato** e rimane nella #2. Consulta [docs/runner.md](docs/runner.md) per comandi e prerequisiti.


## Firma offline Ed25519 delle evidenze del runner (#23)

Il runner permette di esportare l'intero bundle verificato da `GET /v1/jobs/{id}/evidence` (report **e** journal), e uno script indipendente `src/runner/attest.mjs` può firmarne il digest con **Ed25519**, usando una **chiave privata custodita fuori dal runner**. Un secondo operatore verifica il bundle scaricato e la ricevuta con una **chiave pubblica pinned**, anch'essa ottenuta da fonte fidata indipendente dal runner. La firma lega job ID, digest input, stato, conteggio/head del journal e SHA-256 dell'export; modifiche o riscritture complete di journal/report non possono riutilizzare una ricevuta precedente senza la chiave privata. La CLI non carica le chiavi sulla API e non stampa output dei test o segreti. I dettagli e i limiti sono in [docs/runner.md](docs/runner.md). È una **firma dell'export da parte dell'operatore**, non una prova che Docker abbia realmente eseguito il codice, né una marca temporale fidata o un ancoraggio automatico remoto. La #2 resta aperta.


## Re-test supervisionato dopo una correzione AI (#24)

Quando una proposta non ancora approvata fallisce un test **reale** del runner, il Code Agent rilegge il report autenticato dal server (che verifica l'hash-chain) e propone una correzione circoscritta **agli stessi file**, con massimo **due tentativi**. Ogni tentativo conserva nel progetto la provenienza del job fallito (ID, digest, step eseguiti) e invalida review e risultati precedenti. Dopo una **nuova review avversaria positiva**, il pannello mostra il piano di re-test: tutti gli step del job fallito **più** le build .NET/React o Playwright pertinenti ai file modificati, anche se l'utente li ha deselezionati. Solo un nuovo consenso permette di trasmettere lo snapshot aggiornato. L'invio usa Idempotency-Key e la receipt deve corrispondere esattamente al nuovo digest. L'approvazione resta **manuale** e richiede un report terminale `passed` sullo snapshot attuale per tutti gli step obbligatori. I casi `incomplete`, `stale` e setup fallito non attivano AI repair; non esiste un loop 24/7 o auto-push.


## Coordinatore persistente dei checkpoint repair (#25)

Il runner aggiunge un **registro server-side** di repair supervisionati, senza AI autonoma: `POST /v1/repair-sessions`, `GET /v1/repair-sessions/{id}` e `POST /v1/repair-sessions/{id}/checkpoints`. Il registro vive su volume condiviso e serializza i cambiamenti fra istanze API. Una sessione nasce solo da un job `failed` con journal verificato e test realmente fallito, una proposta identificata da UUID e 1–8 path Code Agent consentiti. L'operatore può dichiarare patch, review, re-test e un'eventuale approvazione **soltanto attraverso richieste esplicite**, e ogni re-test deve corrispondere a un job reale sul nuovo digest, con tutti gli step precedenti più le build obbligatorie passati. Massimo due tentativi; registro con hash-chain locale e quote bounded. Nessun codice, token o output di test viene salvato nel checkpoint e **nessuna chiamata crea/esegue job o applica/pusha patch**. Le review e le approvazioni nel registro sono *dichiarazioni dell'operatore*, non prova crittografica del consenso umano o dell'indipendenza del revisore. È una base persistente per una futura orchestrazione, non un processo 24/7; vedi [docs/runner.md](docs/runner.md). La #2 resta aperta.


## Sincronizzazione Code Agent ↔ checkpoint persistenti (#26)

Il flusso supervisionato del Code Agent ora utilizza direttamente le API della #25. Dopo il consenso all'invio dei log del job fallito, il client **crea o riprende** la sessione di repair sul runner e salva nel progetto **solo** sessionId, UUID originali ed endpoint; API key e token rimangono in sessionStorage. Dopo la correzione e una nuova review indipendente positiva, un secondo consenso esplicito prepara il re-test: il client registra sul server il **digest dell'intero payload** e la review dichiarata, poi invia il codice al runner, riutilizzando l'Idempotency-Key in caso di risposta incerta. Il risultato passed/failed viene sincronizzato dal report verificato; un altro repair può partire solo da un fallimento reale registrato, entro due tentativi. Prima dell'applicazione locale, l'API deve riverificare il job superato e registrare `recorded_approval` per la sessione corretta: se API, digest, path o checkpoint sono incoerenti, la patch **non** viene applicata. Nessun push automatico, nessun codice sorgente nel ledger e nessuna esecuzione AI in background. I repair legacy privi di binding al ledger devono essere rigenerati/ripetuti nel flusso supervisionato prima dell'approvazione.


## Ruoli e credenziali degli operatori repair (#27)

La chiave generale `RUNNER_API_KEY` serve soltanto per le API dei job e delle capabilities, **non** può più accedere a `/v1/repair-sessions*`. Per usare il coordinatore serve il registro server-side `RUNNER_REPAIR_OPERATORS_JSON` con chiavi distinte (minimo 32 caratteri) e scope `propose`, `review`, `approve`. La SPA ha un secondo campo **Operatore repair** in Impostazioni: il token resta soltanto in `sessionStorage` e può essere cambiato dall'operatore durante il workflow. Le mutazioni registrano l'**ID** dell'operatore nel journal hash-chained, mai il token. Senza registro, le API repair restituiscono **503** e i job continuano a funzionare. Questa è **attribuzione alla chiave posseduta**, non autenticazione personale, two-person enforcement o OIDC: un operatore con più ruoli può rappresentarli tutti. Per credenziali e limiti consulta [docs/runner.md](docs/runner.md); la #2 resta aperta.


## Separazione dei checkpoint fra tre operatori (#29)

Le autorizzazioni per **chiave** della #27 sono ora accompagnate da controlli server-side su **ID operatore**: chi crea una sessione è il proponente e deve essere lo stesso che registra patch e re-test; la review di ogni tentativo richiede un operatore **diverso**; l'approvazione finale richiede un terzo ID distinto sia dal proponente sia dal revisore dell'ultimo tentativo. Possedere contemporaneamente tutti i ruoli non consente di aggirare questi controlli. Ogni evento è ricontrollato durante la verifica della hash-chain e un conflitto produce `409 repair_actor_conflict`. Gli eventi prima della #27, privi di autore, rimangono consultabili ma le relative sessioni sono **di sola lettura** (`409 repair_legacy_readonly`). La SPA esegue tre passaggi separati con consenso esplicito: registra patch con credenziale proponente, registra review con credenziale revisore, poi dopo un ulteriore click invia i test con la chiave job; al termine il proponente sincronizza l'esito e un approvatore distinto può registrare il checkpoint finale. Cambiare credenziale avviene in Settings, non nei file. Sono separazioni fra **ID di chiavi**, non prove che tre esseri umani diversi le abbiano usate; restano necessari identità forte, approvazione firmata e governance (#2).


## Rotazione e revoca senza riavvio delle credenziali repair (#31)

Le API del coordinatore possono usare `RUNNER_REPAIR_OPERATORS_FILE` invece del precedente `RUNNER_REPAIR_OPERATORS_JSON` statico. In modalità file, **ogni richiesta** apre e verifica da capo un registro JSON privato degli operatori: una chiave sostituita o un ID rimosso non sono più accettati **dalla richiesta successiva** da nessuna delle istanze API che legge la stessa directory. Se il file manca, ha permessi errati, contiene JSON malformato o non è un file normale, i checkpoint rispondono `503 repair_auth_unavailable` (fail-closed); i job Docker restano disponibili. Il registro non entra nei log, nei checkpoint, nel frontend o nel worker Docker. Il deployment Compose opzionale usa `docker/runner/compose.repair-operators.yml` per montare **una directory segreta**, non il singolo file, read-only soltanto sull'API, rendendo visibile una sostituzione atomica del file. L'ID dell'operatore resta stabile nell'audit anche quando ruota la sua chiave. La modalità JSON inline continua a funzionare ma **richiede riavvio di tutte le repliche** per revocare un token; non usarla quando serve revoca immediata. Guida e limiti in [docs/runner.md](docs/runner.md). La #2 resta aperta per autenticazione personale forte, revoca di eventuali richieste già in corso, SSO e gestione di tenant.


## Re-autorizzazione dei checkpoint dopo attesa del lock (#33)

I POST del coordinatore repair con registro a file ricaricano ora la credenziale **anche dentro il lock di scrittura condiviso**, dopo l'eventuale attesa: una chiave ruotata/revocata prima di questo gate non può più registrare una patch, review, un re-test o un'approvazione sul ledger. L'API risponde 401 per credenziale invalida, 403 per actor/scope cambiato e 503 quando il registry è inaccessibile; non scrive nuovi checkpoint in questi casi. I job restano disponibili e il registro JSON inline legacy non cambia durante il processo. Rimane una finestra non transazionale *dopo* il secondo controllo, quindi questo non è un meccanismo di revoca garantita per ogni richiesta in-flight, né una prova di identità personale o consenso umano (#2).


## Admission fail-closed delle evidenze e replay veritiero (#34)

Prima di accettare un nuovo job, l'API del runner controlla la hash-chain **di tutti i job conservati** sotto il lock condiviso: se anche un solo report/journal è incoerente, restituisce 503 `admission_integrity`, senza liberare capacità sulla base di stati falsificati. Sono previsti retry brevi soltanto per la finestra di aggiornamento journal→report del worker; errori persistenti richiedono intervento dell'operatore. Un POST idempotente con UUID e digest uguali restituisce sempre lo **stesso job**, ma ora con lo stato verificato corrente, anche se è già terminato. Lo stato della ricevuta non certifica il successo: i controlli del Code Agent continuano a richiedere un GET del report completo e la validazione di tutti gli step. La hash-chain è locale, non un'attestazione crittografica da macchina indipendente (#2).


## Limite globale opzionale ai nuovi job per minuto (#35)

Il runner supporta `RUNNER_MAX_ACCEPTED_PER_MINUTE` (0 predefinito = disabilitato, interi 1–100): sotto il medesimo lock POSIX condiviso dalle API, considera le accettazioni degli ultimi 60 secondi tra i job conservati, inclusi quelli già terminati. Oltre soglia restituisce HTTP `429 rate_limited` con `Retry-After`, senza creare job. I retry idempotenti sullo stesso snapshot restano permessi anche quando il limite è raggiunto; la convalida del journal rimane obbligatoria per tutti i job. Configurazione in `docker/runner/.env.example` e guida in [docs/runner.md](docs/runner.md). Il limite è **globale** e non definisce quote per tenant/utente/IP né protegge da cancellazioni manuali dei job o volumi separati; per quelle garanzie resta aperta la #2.


## Letture del runner resilienti durante la scrittura delle prove (#36)

Il worker scrive prima e sincronizza il journal delle evidenze, poi aggiorna il report con rename atomico. Un polling HTTP che cade nel brevissimo intervallo può vedere journal e report di due revisioni diverse: i GET `/v1/jobs/{id}` e `/v1/jobs/{id}/evidence` effettuano ora **solo in quel caso** un retry bounded (massimo tre letture, pause da 25ms), per non interrompere il polling con falsi `409 evidence_invalid`. Le prove continuano a essere verificate a ogni tentativo, senza ricostruzioni o scritture automatiche. Una manomissione persistente restituisce ancora 409 e un job inesistente 404; il miglioramento non equivale ad attestazione indipendente o fencing multi-host (#2).


## Polling resiliente dei job esistenti (#37)

Il pannello Test e compilazione reali riprende automaticamente la **lettura del report** in caso di guasti temporanei al tunnel, alla rete o di HTTP 408/429/5xx, con massimo cinque retry consecutivi e backoff crescente (2,5–30 secondi). La lettura riuscita riattiva il normale polling senza avviare un nuovo job. Per 401/403/404/409 o report non validi il polling si ferma, senza mostrare esiti precedenti come verificati. Dopo un'interruzione prolungata o un errore permanente è disponibile `Riprova lettura`, che invia soltanto GET e **non** riesegue Docker, AI o GitHub. Cambio di job/endpoint/API key e chiusura del pannello annullano le letture precedenti. Non è un meccanismo di alta disponibilità o di attestazione remota (#2).


## Readiness autenticata del runner worker (#38)

Il servizio distingue ora **liveness API** (`GET /healthz`, 200 anche se il worker è offline) e **readiness del worker** (`GET /v1/readiness` con Bearer dei job). Il worker aggiorna ogni 5 secondi un piccolo file di heartbeat privato, atomico, sul volume condiviso; anche mentre attende un test Docker, un timer indipendente mantiene il segnale. L'API risponde `200 {"status":"ready","worker":"responsive"}` soltanto se il file è regolare, privato, owned dall'UID API e recente (default 30 secondi); altrimenti `503 {"error":"worker_unavailable"}` con `Retry-After: 5`. Il TTL è configurabile con `RUNNER_WORKER_HEARTBEAT_MAX_AGE_SECONDS=30` (10–300) in Compose/.env. La readiness **non** certifica Docker rootless, che gli SDK e Playwright funzionino, che i job siano integri o che Cloudflare Tunnel/Access raggiunga la VM. Per quelli servono ancora prove operative indipendenti (#2).


## Probe Docker rootless e readiness di esecuzione (#39)

Oltre alla [readiness del worker](docs/runner.md), il servizio espone il nuovo **`GET /v1/execution-readiness`** autenticato. Dal **solo worker** un probe periodico interroga il daemon attraverso il Docker CLI con `docker info` (timeout, comando fisso, socket locale consentito) e verifica l'opzione `name=rootless` restituita dal daemon. Il risultato minimo, senza segreti o identificativi host, entra nel heartbeat privato versione 2: `rootless` e istante dell'ultima verifica. La API non monta né accede al socket Docker. Se heartbeat o probe non sono recenti, il daemon è rootful, non raggiungibile o la risposta è scorretta, la nuova route risponde HTTP **503 `docker_unavailable`** con `Retry-After: 5`; quando entrambi sono validi restituisce **200 `{status:"ready",worker:"responsive",docker:"rootless"}`**. `/healthz` e `/v1/readiness` restano invariati, inclusa la lettura dei vecchi heartbeat v1 per il solo worker. **Non** è una prova che un container, gli SDK, .NET, Playwright o Cloudflare Access funzionino nella VM reale: rimane necessaria la validazione su macchina dedicata (#2).


## Canary manuale di container isolato su Docker rootless (#40)

Per avanzare oltre la sola verifica di `docker info` (#39), il progetto include il comando **operator-only** `src/runner/scripts/rootless-canary.mjs`. Su una VM dedicata, dopo aver pre-caricato nel daemon rootless un'immagine ufficiale Node **identificata da digest**, eseguilo dentro `runner-worker` con `--confirm --image=node@sha256:<digest>`. Non viene invocato dalla SPA, dalle API o dal polling e non richiede la creazione di job. Il comando controlla il daemon rootless, crea e ispeziona un container senza rete/mount, rootfs di sola lettura, UID non privilegiato, capability azzerate e quote; ne verifica l'esecuzione e il cleanup mirato. Se una qualunque prova fallisce non dichiara successo. I test GitHub Actions verificano la logica con stub deterministici, **non attestano un run rootless su VM**. Procedura e limiti in [docs/runner.md](docs/runner.md); il deployment reale e le attestazioni indipendenti restano nella #2.


## Canary: test Docker Engine reale in GitHub Actions (#41)

La CI, dopo lo smoke dei job, esegue ora **anche** il ciclo Docker del canary `#40` contro un **vero Engine su macchina GitHub Actions effimera**. Recupera il riferimento `node@sha256` dalla cache locale, controlla il risultato del Docker `create/inspect/start/inspect/rm` e rifiuta residui. Lo script è riservato alla CI e dichiara esplicitamente `ROOTFUL_CI_ONLY`: la sua iniezione di test bypassa la prova rootless per verificare la compatibilità del percorso Docker, ma **non modifica la CLI operatore**, che continua a rifiutare un daemon rootful. Il successo della CI non costituisce quindi prova di un daemon rootless, VM dedicata, Cloudflare Access o attestazione off-host: resta aperta la #2.


## Protezione dalle risposte HTTP tardive dopo logout OIDC (#42)

Le app PostgreSQL generate ora legano le risposte delle letture e delle **mutazioni crea/modifica/elimina** al token e alla generazione di sessione che le ha avviate. Logout, cambio account, rinnovo credenziali o invalidazione da un'altra scheda annullano immediatamente l'autorizzazione delle vecchie risposte a modificare l'interfaccia, gli errori o lo stato dei form. Anche un vecchio 401 non può cancellare un login successivo. La CI verifica con Chromium, OIDC temporaneo, ASP.NET Core e PostgreSQL che un POST già completato dal server ma consegnato al browser **dopo** il logout cross-tab non faccia ricomparire dati privati. Questo non revoca token né annulla transazioni già autorizzate sul server; restano aperti BFF/cookie HttpOnly e IdP di produzione nella #9.


## Readiness Docker stabile durante gli aggiornamenti heartbeat (#43)

La readiness del runner è stata corretta per evitare falsi **503 `docker_unavailable`** quando un heartbeat viene sostituito mentre l'API lo legge: il tempo di confronto viene rilevato dopo la lettura asincrona del file, non prima. Resta obbligatorio rifiutare timestamp realmente futuri, probe scaduti o non-rootless. Test Node eseguono molte GET su due API mentre il worker aggiorna il file, senza alterare la sicurezza né le limitazioni del deployment remoto sperimentale (#2).


## Ruoli OIDC univoci nelle app generate (#44)

La API PostgreSQL generata non concede più permessi per la sola presenza di `editor` in un elenco ambiguo di ruoli JWT. Ogni token firmato deve avere **esattamente un claim `role`**, con valore `reader` oppure `editor`, e un soggetto `sub` univoco. Token con ruoli doppi, misti, assenti o sconosciuti sono negati con HTTP 403; i token invalidi crittograficamente continuano a ricevere HTTP 401. Il provider OIDC temporaneo della CI firma queste varianti e la vera API ASP.NET Core le verifica anche dopo il rollover JWKS. Per gli IdP esterni è necessaria una mappatura esplicita del singolo ruolo applicativo: non è un'integrazione IdP production e la #9 resta aperta.


## Logout OIDC resistente a refresh tardivi (#45)

Le app React/PostgreSQL generate ora trattano il logout come una **barriera terminale per la scheda corrente**. Un refresh OIDC partito prima della disconnessione non può far ricomparire token o elementi nella UI dopo un logout in un'altra scheda; eventuali credenziali riscritte in ritardo dal client OIDC vengono eliminate. La sostituzione di un token con un altro pulisce immediatamente dati e bozze della sessione precedente. Un test Chromium usa due tab e un vero provider OIDC di test: blocca la consegna della risposta di rinnovo fino al logout e verifica che login e dati non siano ripristinati dopo il rilascio. Questo protegge solo il browser: **non revoca JWT già emessi**, né implementa BFF/cookie HttpOnly o sessioni server-side, ancora nella #9.


## Retry-After corretto dopo riduzione del rate limit (#46)

Riducendo `RUNNER_MAX_ACCEPTED_PER_MINUTE` mentre ci sono ancora job accettati nel minuto precedente, il runner continua a contare **tutti** i job conservati e ora indica un `Retry-After` coerente con il nuovo limite. Con 3 job recenti e nuovo limite 1, aspetta che scadano abbastanza accettazioni, non soltanto quella più vecchia. L'header resta limitato a 1–60 secondi e non crea alcuna prenotazione. La suite Node prova due API con volume condiviso e catene di evidenza valide, senza modificare idempotenza o permessi. Non è un rate limiter per tenant o multi-host (#2).


## Letture heartbeat senza falsi 503 durante rename atomico (#47)

Sui filesystem POSIX un'API può aprire il vecchio heartbeat poco prima che il worker lo sostituisca: `fstat` sul file già aperto vede allora `nlink=0`, pur se il nuovo heartbeat è perfettamente valido. Il runner ora distingue questa rotazione da un hardlink sospetto e ripete brevemente **l'intera lettura sicura** del nuovo inode, senza mai accettare l'inode scollegato. I casi di file non sicuri, danneggiati, scaduti o daemon non rootless restano 503. Test Node coprono l'inode POSIX e due API sotto aggiornamenti rapidi; non è verifica di Docker rootless su VM reale (#2).


## Attestazione offline con letture sicure della chiave (#48)

Il comando `src/runner/attest.mjs` per firmare e verificare le prove con Ed25519 legge ora export, ricevuta, chiave privata e chiave pubblica **dallo stesso file descriptor che ha verificato**, senza seguire symlink. Impone dimensioni limitate, rifiuta hardlink e controlla proprietario/permessi dei file-chiave; la chiave pubblica di fiducia non può essere scrivibile da altri. Eventuali modifiche o sostituzioni del file durante la lettura provocano un errore, senza esporre materiale sensibile nei log. Le firme precedenti restano compatibili: questo hardening non equivale a firma remota automatica o prova di isolamento rootless, ancora nella #2.


## Integrità dei ledger repair contro swap di file e ID errati (#49)

La API del runner legge ora i checkpoint repair attraverso un unico file descriptor `O_NOFOLLOW`, con controlli su inode, proprietario, numero di link, dimensione e modifiche concorrenti. Un symlink, hardlink, ledger troppo grande o sostituito non può aggirare i controlli con una modifica fra verifica e lettura. Il server impone inoltre che l'ID interno verificato nel journal coincida con quello richiesto dall'endpoint: uno storico repair valido, ma copiato sotto un ID diverso, viene rifiutato con HTTP 409. Snapshot legacy restano leggibili, mentre test Node su due API verificano il fail-closed e il recupero dopo ripristino. Le prove locali non equivalgono a una firma indipendente off-host (#2).


## Verifica evidence del runner senza file-swap e letture illimitate (#50)

I file `report.json` e `evidence.jsonl` vengono ora letti e verificati **dallo stesso file descriptor sicuro**: nessun symlink, hardlink, permesso group/world writable o file oltre 4 MB può essere utilizzato come prova per report, esportazioni, quote o checkpoint. La verifica conferma che inode e contenuti siano stabili durante la lettura. L'integrità locale rimane fail-closed: HTTP 409 per prove corrotte, 503 per ammissioni bloccate e 404 solo se il report non esiste. Test su due istanze API provano casi manipolati e recupero dopo ripristino. Non è una firma indipendente né un'attestazione rootless: #2 rimane aperta.


## API runner: hot rotation delle credenziali (#51)

È disponibile la modalità opzionale `RUNNER_API_KEY_FILE`, alternativa alla precedente `RUNNER_API_KEY`. La chiave viene letta da un file privato e verificata per ogni richiesta, con reload immediato al rename atomico, senza reboot delle API. Due repliche possono rifiutare la chiave vecchia (401) e usare quella nuova; un file mancante o insicuro blocca l'autenticazione (503), mai fallback. I POST sono riautenticati anche nel lock condiviso prima di creare job, così una richiesta in attesa non può usare una chiave revocata. L'override Compose monta **solo nella API** la directory dei segreti, non nel worker. È un hardening dell'unico segreto globale, non un'implementazione IAM multi-tenant o Cloudflare Access (#2).


## Runner multi-tenant sperimentale (#52)

La runner API supporta ora una modalità opt-in `RUNNER_TENANTS_FILE` con credenziali differenti per tenant e quote di ammissione autonome, **aggiuntive** ai limiti globali. Ogni job registra un `tenantId` derivato dalla chiave verificata nel journal SHA, e GET report/evidence respinge con 404 gli ID di altri tenant. La stessa chiave idempotente può essere usata da tenant diversi senza confondere i job. Un registry privato `O_NOFOLLOW` si ricarica a ogni richiesta, consentendo rotazione e revoca senza riavviare due API; la chiave è montata solo nel container API. Il primo milestone **disabilita gli operatori repair** in modalità tenant finché non avranno un IAM esplicito per ambito; modalità a chiave globale rimane invariata. Sono ancora necessari Cloudflare Access, ruoli/identità utenti, approvazioni per tenant, rootless VM reale e attestation off-host (#2).


---
## Avanzamento #53 — input del worker letto su inode fidato (16 novembre 2026)

L'hardening del runner prosegue con la [#53](https://github.com/KeyserDSoze/SoftwareFactory/issues/53): `input.json` viene letto dal worker con `O_NOFOLLOW`, `fstat` prima/dopo e lettura bounded (8MB), senza seguire symlink/hardlink o file sostituiti. Il digest sorgenti viene comunque confrontato col report verificato prima dell'esecuzione; un input non fidato non autorizza Docker o un esito `passed`. Test Node POSIX proteggono file owner/permessi/inode/dimensioni, rollback e integrazione worker. Le prove locali/CI non certificano un host Docker rootless di produzione, attestazioni indipendenti o IAM tenant: la #2 resta aperta.


---
## Avanzamento #54 — rifiuto del job prima dei test (16 novembre 2026)

La [#54](https://github.com/KeyserDSoze/SoftwareFactory/issues/54) elimina un falso `failed`: se il worker rifiuta il job quando è ancora `queued` per input symlink/permessi non sicuri, digest differente o configurazione invalidata, salva l'esito terminale `incomplete`, il timestamp di chiusura e l'evento hash-chain `rejected`, **senza affermare che un test di codice sia fallito**. Il runner non rilancia automaticamente il job, continua a verificare API/evidenze e il coordinatore repair non accetta questi esiti come origine di AI repair. Restano separati l'esito di test di codice realmente fallito e la recovery di un `running` orfano; #2 rimane aperta per VM rootless e attestazione indipendente.


---
## Avanzamento #55 — errori infrastrutturali dopo started (16 novembre 2026)

La [#55](https://github.com/KeyserDSoze/SoftwareFactory/issues/55) estende la correzione della #54: eccezioni di workspace, piano o invocazione del runner verificatesi dopo `started` ma senza un vero fallimento di test verificato chiudono il job con `incomplete`, mai con un falso `failed`. Gli eventi append-only `accepted → started → finished` restano verificabili; report, journal e messaggi non contengono i dettagli delle eccezioni né segreti. I test di codice con un reale exit code non-zero continuano a essere `failed`. Nessun retry automatico o repair AI per `incomplete`; rimane aperta #2 per isolamento VM rootless e attestazione indipendente.


---
## Avanzamento #56 — fairness multi-tenant del worker (16 novembre 2026)

I limiti di ammissione per tenant della #52 non garantivano una selezione equa dei job: il worker consumava una sola coda FIFO globale. La [#56](https://github.com/KeyserDSoze/SoftwareFactory/issues/56) seleziona ora un turno per il tenant meno recentemente servito fra i report conservati con evidenze hash-chain verificate; un tenant mai servito viene preferito e ogni tenant mantiene FIFO per data di accettazione. La cronologia deriva dai `startedAt` realmente registrati, non da memoria volatile né da nuovi contatori controllabili dal client. Test Node verificano A-B-A-B-A, claim, storico, assenza di retry e compatibilità con coda legacy FIFO. È scheduling best-effort sullo stesso volume POSIX, non orchestration multi-host o VM rootless attestata: #2 resta aperta.


---
## Avanzamento #57 — esecuzione Docker condizionata a probe rootless fresco (16 novembre 2026)

La [#57](https://github.com/KeyserDSoze/SoftwareFactory/issues/57) chiude una differenza pericolosa tra readiness ed esecuzione effettiva. Ora **ogni** invocazione di `runDockerStep` verifica direttamente che il daemon locale attivo dichiari `name=rootless`, con socket allowlisted e probe bounded, **prima** di avviare `docker run`. Daemon rootful, irraggiungibile, probe in errore o host non autorizzato impediscono qualunque step, con report `incomplete` e senza false evidenze o dettagli riservati. Anche un secondo step verifica nuovamente il daemon. I test unitari provano no-spawn e lo scenario in cui il primo step passa e il daemon non è più rootless. Gli smoke Docker/Playwright/fullstack della CI GitHub hosted rimangono deliberatamente **rootful** tramite callback di test *solo nei trusted script CI*, non esposta all'API. Questo gate è una mitigazione locale, non una prova VM rootless realmente certificata (#2).


---
## Avanzamento #58 — cleanup Docker verificato su timeout (16 novembre 2026)

La [#58](https://github.com/KeyserDSoze/SoftwareFactory/issues/58) corregge la rimozione dei container di job terminati per timeout: il vecchio `docker rm -f <name>` poteva eliminare un container estraneo il cui nome fosse stato riutilizzato. La nuova procedura controlla due volte con Docker inspect il nome atteso, l'ID completo immutabile e tutte le label del job, ricontrolla il daemon rootless e rimuove **solo l'ID** verificato. In mancanza di una corrispondenza non elimina nulla: occorre la riconciliazione manuale #21. Il worker attende il tentativo di cleanup prima di chiudere il timeout, anche quando la CLI non invia l'evento `close`. I test Node verificano errori, scambio d'identità, perdita del rootless e SIGKILL. Non è fencing multi-host o attestazione VM rootless reale (#2).


---
## Avanzamento #59 — operatore Docker con rootless JIT senza cache (16 novembre 2026)

La [#59](https://github.com/KeyserDSoze/SoftwareFactory/issues/59) corregge il comando di pulizia manuale dei container orfani. La precedente cache `inspectedHost` evitava di rifare il probe rootless dopo la prima richiesta al medesimo socket, permettendo di arrivare a `docker rm -f` anche se il daemon fosse cambiato. Ora **ogni** chiamata operatore (ps, inspect, rm) è preceduta da una nuova verifica rootless sul medesimo socket Unix allowlisted, con output/timeout bounded e ambiente CLI senza segreti. Risposte rootful, host non permessi o errori Docker interrompono l'operazione senza eliminazioni né messaggi diagnostici sensibili. I test provano la perdita della modalità rootless prima della rimozione e preservano journal/claim, conferma esplicita e identità del container. Non sostituisce il collaudo VM rootless o fencing multi-host della #2.


---
## Avanzamento #60 — lettura atomica verificata del registro operatori repair (16 novembre 2026)

La [#60](https://github.com/KeyserDSoze/SoftwareFactory/issues/60) elimina una finestra d'incoerenza nel file delle credenziali repair: prima veniva verificato solo l'inode **prima** della lettura. Ora l'API legge esattamente i byte indicati dal `fstat` iniziale e confronta un secondo `fstat` dello stesso descriptor prima di accettare il registro. Scritture in place anche di pari dimensione, append/truncate, modifiche ai permessi o link e letture incomplete falliscono con `repair_auth_unavailable`; le chiavi non vengono esposte. La rotazione via rename atomico resta operativa fra richieste e le altre verifiche di segregazione proponente/revisore/approvatore rimangono attive. Test Node riproducono i casi senza race temporali artificiali. Questo non certifica identità federate o MFA di persone reali e la #2 resta aperta.


---
## Avanzamento #61 — recovery incomplete e protezione delle prove degli orfani (16 novembre 2026)

La [#61](https://github.com/KeyserDSoze/SoftwareFactory/issues/61) corregge due effetti di un crash del worker. Un job `running` ritrovato senza claim non viene più dichiarato `failed` senza prova: si registra un evento `recovered` terminale `incomplete`, mantenendo tutti i risultati già verificati. Il coordinatore rifiuta AI repair anche sui vecchi report `recovered` che portano lo stato storico `failed`. La retention non cancella automaticamente i job con ultimo evento `recovered`, nemmeno quando sono scaduti, per non perdere le evidenze necessarie alla riconciliazione manuale dei container potenzialmente rimasti vivi (#21). I test verificano journaling, claim e assenza di retry, consultazione API, blocco AI repair e conservazione rispetto a normali job terminali scaduti. È una scelta fail-closed con costo operativo: le directory e quote dei job recuperati restano occupate finché un operatore, a servizi fermati, non ne certifica la riconciliazione e le rimuove esplicitamente. Rimangono da realizzare VM rootless e fencing multi-host/attestation off-host (#2).


---
## Avanzamento #62 — rootless canary JIT su tutti i comandi Docker (16 novembre 2026)

La [#62](https://github.com/KeyserDSoze/SoftwareFactory/issues/62) rende il canary operatore resistente al cambio di daemon durante il suo ciclo di vita. Prima la verifica `name=rootless` veniva fatta una sola volta, poi `create`, `inspect`, `start` e `rm` usavano il risultato già vecchio. Adesso **ognuna** di queste operazioni verifica nuovamente il socket Unix locale e richiede rootless positivo immediatamente prima della chiamata. Se il daemon è cambiato o irraggiungibile, il canary non prosegue e non cancella un container senza identità verificata; un cleanup bloccato richiede l'operatore e non diventa un successo. Nuovi test riproducono rootless perso prima di inspect, start e rm. La CI Docker hosted resta rootful e usa solo il percorso di smoke esplicitamente fidato: non sostituisce la prova su una VM rootless dell'epica #2.


---
## Avanzamento #63 — riconciliazione manuale dei container canary residui (16 novembre 2026)

La [#63](https://github.com/KeyserDSoze/SoftwareFactory/issues/63) aggiunge un comando operator-only per recuperare selettivamente un container di prova rootless lasciato da una canary interrotta. La CLI di test ora emette `ROOTLESS_CANARY_ID=<UUID>` prima della creazione; con quell'UUID si può eseguire il **dry-run** `node src/runner/scripts/canary-reconcile.mjs --canary=<UUID>`. Solo dopo aver fermato eventuali altre canary ed esaminato il risultato è consentito `--apply --confirm-canary=<UUID>`. Il tool accetta soltanto un container spento con nome, label e isolamento attesi, doppia ispezione per ID completo e nuovo probe Docker rootless prima di ogni operazione; non esiste cleanup automatico, né un'API per cancellare container. In caso di dubbio, non rimuove nulla. Nove test Node coprono rimozioni autorizzate, daemon degradato, identità contraffatte e operazioni vietate. La CI rootful non equivale al collaudo di una VM rootless reale dell'epica #2.


---
## Avanzamento #64 — lettura sicura del file di preflight VM (16 novembre 2026)

La [#64](https://github.com/KeyserDSoze/SoftwareFactory/issues/64) protegge la configurazione privata del preflight di deploy (`--env-file`), che può contenere `RUNNER_API_KEY`: la precedente sequenza `lstat(path)` / `readFile(path)` poteva controllare un inode e leggerne un altro dopo una sostituzione concorrente, senza alcun limite di dimensione. Ora la CLI usa **un solo file descriptor `O_NOFOLLOW`** con owner/euid, mode esatto 0600, nlink=1, massimo 32KiB e confronto pre/post lettura di inode/metadati. Un file modificato nel mezzo, troncato, allungato o sostituito non produce una configurazione utilizzabile. I test simulano race e letture corrotte, senza stampare credenziali. La CLI conserva i controlli rootless/HTTPS esistenti; occorre ancora eseguirli su VM reale con Cloudflare Access e attestazione indipendente (#2).


---
## Avanzamento #65 — preflight Compose completo senza sidecar inattesi (16 novembre 2026)

La [#65](https://github.com/KeyserDSoze/SoftwareFactory/issues/65) corregge un bypass del preflight di deployment: prima era possibile aggiungere un servizio Compose non previsto, anche privilegiato e con porte pubbliche, e ottenere comunque `status:passed` perché il verificatore ignorava i sidecar. Ora il Compose risolto può contenere **solo** `runner-api`, `runner-worker` e l'eventuale `cloudflared`. Il tunnel non può montare volumi o directory host, `secrets`, `configs`, `volumes_from`, dispositivi o namespace di altri servizi; l'API e il worker rifiutano anch'essi mount impliciti (`volumes_from`, `secrets`, `configs`, `tmpfs`); le mount API/worker richiedono sorgenti canoniche non di sistema e directory data/work separate. L'unico socket rootless ammesso è quello montato dal worker. I test rifiutano configurazioni con debug proxy, container estranei, secret mount e path non canonici. La validazione statica non equivale a una prova di isolamento su VM rootless o Cloudflare Access reale (#2).


---
## Avanzamento #66 — probe amministrativo Cloudflare Access Service Auth (16 novembre 2026)

La [#66](https://github.com/KeyserDSoze/SoftwareFactory/issues/66) aggiunge al preflight HTTPS del runner un controllo opzionale **a due credenziali separate**: il service token di Cloudflare Access per attraversare il gateway e la `RUNNER_API_KEY` per accedere all'API. L'operatore passa `CF_ACCESS_CLIENT_ID` e `CF_ACCESS_CLIENT_SECRET` via file locale `0600` (mai nella SPA). Il preflight richiede che una GET senza Access non ottenga risposta 200, poi esegue health/API Bearer/CORS con entrambi i livelli nel corretto ordine, senza POST, redirect o stampa di credenziali. Coppie incomplete, token con caratteri di controllo o endpoint troppo permissivi sono rifiutati. Questa è una verifica delle risposte **service-to-service**, non un collaudo del login/browser Cloudflare Access, delle cookie `CF-Authorization`, né della VM Docker rootless reale (#2). Documentato in ADR 0023 e test Node con gateway simulato.


---
## Avanzamento #67 — isolamento dei namespace verificato nel Compose risolto (16 novembre 2026)

La [#67](https://github.com/KeyserDSoze/SoftwareFactory/issues/67) completa il precedente gate #65: un servizio Compose con nome consentito poteva ancora condividere PID/IPC/rete o forzare `userns_mode: host`, oppure aggiungere `seccomp=unconfined` alla lista già contenente `no-new-privileges:true` ottenendo un esito statico `passed`. Ora `runner-api`, `runner-worker` e l'eventuale `cloudflared` accettano soltanto il networking standard e profili `security_opt` / `cap_drop` esatti; override di namespace, gruppi extra, device requests, GPU, sysctl e opzioni di sicurezza contraddittorie falliscono in modo statico e senza esporre la configurazione. Test negativi e positivi coprono tutti e tre i servizi. Le verifiche Docker/CI non sostituiscono ancora la prova su una VM Docker rootless e Cloudflare Access reali (#2).


---
## Avanzamento #68 — preflight verifica anche il codice avviato dal runner (16 novembre 2026)

La [#68](https://github.com/KeyserDSoze/SoftwareFactory/issues/68) chiude un bypass del controllo Compose: privilegi, namespace e socket potevano risultare corretti, ma il worker poteva comunque essere sostituito con un'immagine remota, un diverso Dockerfile oppure un comando/entrypoint arbitrario **con accesso al socket Docker rootless**. Il preflight ora vincola i due servizi al checkout e ai Dockerfile conosciuti e nega modifiche alle opzioni di build, ai comandi di avvio, healthcheck e hook. Le variabili ambiente delle applicazioni hanno una allowlist esplicita: `NODE_OPTIONS`, `LD_PRELOAD`, `NODE_PATH` e altre opzioni non revisionate non possono essere introdotte da override. Il tunnel non può essere sostituito con un'immagine o entrypoint diverso. Test Node di regressione controllano override ostili e configurazioni legittime, documentati con ADR 0025. L'origine del testo di build non prova l'identità crittografica dell'immagine costruita e il tag Cloudflare `latest` resta mutabile; il collaudo VM/Cloudflare reale e l'attestazione indipendente restano nell'epica #2.


---
## Avanzamento #69 — preflight host coerente con i mount del Compose (16 novembre 2026)

La [#69](https://github.com/KeyserDSoze/SoftwareFactory/issues/69) corregge un'incoerenza fra il preflight del Compose e quello della VM: il primo negava directory dati/workspace sovrapposte, il secondo controllava soltanto l'uguaglianza dei path. Ora anche `preflight host` rifiuta directory annidate in entrambe le direzioni, percorsi non canonici o di sistema e symlink in qualunque componente parent del path. Prima del probe Docker, ogni segmento viene verificato con `lstat`, mantenendo controlli UID/permessi delle directory e del socket rootless. Tre test Node riproducono nesting, prefix simili, path traversal e parent symlink reali; documentati con ADR 0026. Il controllo non è un lock atomico sul filesystem né sostituisce un collaudo su VM rootless reale (#2).


---
## Avanzamento #70 — preflight delle reti Docker Compose (16 novembre 2026)

La [#70](https://github.com/KeyserDSoze/SoftwareFactory/issues/70) chiude un bypass del controllo di rete: `network_mode: host` era già vietato, ma gli override Compose potevano aggiungere `networks: [external]` al runner API/worker o al tunnel mantenendo `status: passed`. Adesso il preflight del JSON Compose risolto ammette soltanto una rete `default` nominata secondo il progetto (`<project>_default`), senza flag external/driver/IPAM personalizzati (il normale `ipam: {}` di Compose v2 è accettato), e ogni servizio può collegarsi soltanto a tale rete senza alias o opzioni aggiuntive. Nuovi test Node coprono extra network, rete rinominata, external, alias/priority e configurazioni malformed. La CI esegue anche il preflight sul vero Compose risolto, compreso l'override del registro operatori. Questa è una policy statica: la presenza di container estranei sulla rete o il reale daemon rootless non sono provati; #2 resta aperta.

---
## Avanzamento #71 — opzioni bind e separazione segreti nel preflight Compose (16 novembre 2026)

La [#71](https://github.com/KeyserDSoze/SoftwareFactory/issues/71) impedisce che un override `volumes` alteri il comportamento dei mount pur mantenendo sorgente e target ammessi: `bind.propagation`, relabel SELinux, `consistency`, opzioni di volume/tmpfs e campi non revisionati vengono rifiutati, mentre il normale `bind.create_host_path` booleano del JSON Docker Compose v2 rimane accettato. Il registro privato degli operatori deve essere completamente disgiunto da directory dati e workspace: non può trovarsi dentro il workspace montato dal worker, né esserne un parent. Regressioni Node e preflight sul Compose reale in CI. Questa resta una policy statica, non prova dell'isolamento VM Docker rootless o dei permessi host al deploy; #2 aperta.

---
## Avanzamento #72 — DNS e comando Cloudflare Tunnel bloccati nel preflight (16 novembre 2026)

La [#72](https://github.com/KeyserDSoze/SoftwareFactory/issues/72) chiude un bypass della configurazione Compose: pur usando soltanto la rete Docker `default`, un override `extra_hosts` poteva reindirizzare `runner-api` dal tunnel verso un altro host; inoltre il comando di cloudflared non veniva validato. Il preflight ora nega opzioni DNS/hosts/link, hostname e MAC custom per API, worker e tunnel. Il servizio cloudflared è configurato con UID 1000 e rootfs read-only e può avviarsi solo con il comando token normalizzato di Docker Compose v2, senza variabili ambiente o flag extra. Test Node e Compose reale in CI; non è una verifica di route, token o rootless VM effettivi (#2).

---
## Avanzamento #73 — profili auth file/tenant verificabili nel preflight Compose (16 novembre 2026)

La [#73](https://github.com/KeyserDSoze/SoftwareFactory/issues/73) rende verificabili con `node src/runner/preflight.mjs compose` anche gli override già previsti per `RUNNER_API_KEY_FILE` (`--runner-key-file`) e `RUNNER_TENANTS_FILE` (`--tenants`), senza dover saltare i gate di sicurezza. Il registro operatori può coesistere soltanto con la chiave globale inline o da file. I mount di credenziali API-only devono essere read-only, in directory host canoniche disgiunte fra loro e da data/work del worker, con variabili d'ambiente e target esatti. La CI controlla Compose v2 reale per ogni modalità e la combinazione key-file/operatori, oltre ai test Node di errori e bypass. Questa è una verifica **statica**: non attesta file/UID host, contenuto delle credenziali, VM rootless o Access/Tunnel reale (#2).

## Avanzamento #74 — host preflight file/tenant e probe endpoint off-host (16 novembre 2026)

L'issue [#74](https://github.com/KeyserDSoze/SoftwareFactory/issues/74) allinea il controllo host al profilo Compose selezionato. Il comando `preflight host --runner-key-file` o `--tenants` usa directory host dedicate, controlla ogni segmento dei percorsi contro symlink, UID 1000, permessi riservati e verifica file privati con apertura `O_NOFOLLOW`, metadati stabili e lettura bounded. La rotazione atomica viene riletta senza cache. Il registro operatori è opzionale solo per chiave globale. Per `preflight endpoint --runner-key-file|--tenants`, un env operatore 0600 fornisce `RUNNER_PROBE_BEARER` dedicato: il probe non legge il file di chiavi né il tenant registry sul server, non avvia job e non restituisce credenziali. La verifica continua a richiedere un vero host rootless e Cloudflare Access separati prima del deploy (#2).

## Avanzamento #75 — Canary Docker vincolato allo script sentinella (16 novembre 2026)

La [#75](https://github.com/KeyserDSoze/SoftwareFactory/issues/75) impedisce a `rootless-canary` e alla riconciliazione manuale di considerare valido un container che dichiari `Entrypoint=node` e stampi il marker corretto, ma esegua uno script diverso: `Config.Cmd` deve ora contenere l'argomento Node `-e` con lo **script sentinella esatto** (UID, CapEff, rete e tmpfs). L'inspect rifiuta inoltre `SecurityOpt` extra come `seccomp=unconfined`, namespace host/container e deviazioni di DNS/hosts, device e mount/tmpfs. La suite Node e il ciclo Docker reale eseguito su runner GitHub (host rootful **solo per CI**) preservano il divieto di simulare un collaudo rootless VM (#2).

## Avanzamento #76 — Canary Docker senza preload del runtime Node (16 novembre 2026)

La [#76](https://github.com/KeyserDSoze/SoftwareFactory/issues/76) completa il controllo su `docker inspect` del canary già vincolato al comando Node dalla #75. Il processo deve ereditare **solo** le tre variabili documentate dell'immagine ufficiale `node:22-bookworm-slim` (`PATH` approvato, `NODE_VERSION=22.x.y` e `YARN_VERSION=1.22.x`); qualsiasi `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD` o altra variabile non prevista, mancante, duplicata o malformata viene rifiutata. Un `Config.Healthcheck` aggiuntivo è vietato perché potrebbe eseguire comandi fuori dalla sentinella. I test verificano anche mutazioni fra pre/post-start e la riconciliazione manuale di un residuo. Il ciclo Docker effettivo in GitHub CI è **rootful**, non attesta la sicurezza della VM rootless di produzione (#2).

## Avanzamento #77 — Acceptance locale della VM del runner (16 novembre 2026)

La [#77](https://github.com/KeyserDSoze/SoftwareFactory/issues/77) introduce `npm run vm-acceptance --` nel runner per un **controllo locale sull'effettiva VM dedicata**: richiede utente UID 1000, `--confirm`, env 0600 su path assoluto e digest `node@sha256` già presente nel daemon Docker rootless. Esegue in sequenza `preflight compose` per il profilo selezionato, `preflight host` (UID/mount/credenziali/socket rootless) e il canary Docker reale sulla socket host `/run/user/1000/docker.sock`. Pubblica `ROOTLESS_CANARY_ID` per la riconciliazione manuale se il canary resta residuo, e solo a successo totale una ricevuta locale priva di segreti. Non avvia servizi, non esegue una chiamata endpoint e non attesta off-host la VM. **La CI GitHub non può convalidare una VM rootless reale**: verifica la logica di composizione con test Node e i gate Compose/canary Docker separatamente su host CI rootful. L'epica #2 resta aperta per esecuzione VM e Cloudflare reali.

## Avanzamento #78 — private env stabile per l'acceptance VM (16 novembre 2026)

La [#78](https://github.com/KeyserDSoze/SoftwareFactory/issues/78) rafforza la CLI locale `vm-acceptance` della #77: lo stesso env privato dell'operatore (UID proprietario, mode 0600 e FD `O_NOFOLLOW`) viene letto **prima** di Compose e ricontrollato **dopo** Compose, host e canary. Se le credenziali, gli origin o qualsiasi altra variabile cambiano tra i gate, la sequenza si interrompe senza produrre ricevuta `passed`. I confronti non escono in log o nella ricevuta e riconoscono anche le rotazioni di file tramite rename atomico. La suite Node include la prova reale su file privato; GitHub CI non equivale a acceptance su VM rootless dedicata né a verifica Cloudflare live (#2).

## Avanzamento #79 — Timeout Docker e journal orfani (16 novembre 2026)

La [#79](https://github.com/KeyserDSoze/SoftwareFactory/issues/79) impedisce che la retention automatica elimini il journal e l'UUID di un job Docker terminato per **timeout senza conferma di cleanup**. Il risultato dello step conserva `timedOut:true` e `cleanupVerified:true|false`: solo il booleano `true` del cleanup d'identità autorizza la retention ordinaria; `false` e i risultati legacy senza campo richiedono `orphans.mjs` manuale. La protezione include timeout della preparazione npm, è ricontrollata sotto lock admission prima della cancellazione e non permette di spacciare un timeout per errore di codice o test passato. La CI Docker è rootful e non attesta una VM rootless reale (#2).

## Avanzamento #80 — finalizzazione audit per container orfani (16 novembre 2026)

La [#80](https://github.com/KeyserDSoze/SoftwareFactory/issues/80) aggiunge `--finalize` alla CLI operatore `src/runner/orphans.mjs`, esclusivamente dopo `--apply --confirm-job=<UUID>`. La cleanup acquisisce una claim esclusiva sul job; prima della finalizzazione Docker viene interrogato **nuovamente** per assicurare che non restino container etichettati con l'UUID. Solo allora la hash-chain del journal riceve **una sola voce `reconciled`**, senza cambiare il verdetto o i risultati dei test. Un journal già vecchio e riconciliato può poi essere rimosso dalla retention normale: esportare prima le prove se servono a lungo termine. Senza finalizzazione il blocco retention di #61/#79 resta attivo. Sono incluse verifiche Node e uno smoke Docker CI reale, che NON costituisce collaudo VM rootless o Cloudflare (#2).

## Avanzamento #81 — Anti-cache HTTP per callback OIDC (16 novembre 2026)

Lo scaffold PostgreSQL ora genera Nginx con `Cache-Control: no-store` su tutte le risposte statiche, compresi `/` e `/auth/callback`: riduce il rischio che cache HTTP conservino HTML o callback di autenticazione. La CSP, `Referrer-Policy: no-referrer` e gli altri header restano allo stesso livello server Nginx anche per il fallback SPA. Lo script di build esige che `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID` e `VITE_OIDC_AUDIENCE` siano tutte configurate o tutte assenti; un asset web con OIDC parziale non viene generato con successo. Le build con un IdP HTTPS e il test browser su Nginx reale sono verificati nella CI; un provider esterno di produzione non è certificato (#9). Il no-store globale sacrifica cache degli asset statici e non elimina dati già presenti in browser history/sessionStorage o CDN esterni.

## Avanzamento #82 — Compose OIDC con esposizione locale e origin browser esplicito (16 novembre 2026)

Il Compose generato binda ora **frontend Nginx su `127.0.0.1:3000`**, come la API su `127.0.0.1:8080`, anziché pubblicare HTTP su tutte le interfacce. `APP_ENVIRONMENT` seleziona l'ambiente ASP.NET Core (default `Development` solo per locale; impostare `Production` dietro un vero proxy HTTPS per attivare i vincoli HTTPS/legacy già implementati). `PUBLIC_API_URL` passa l'origin API raggiungibile dal browser al build React e al validatore CSP; il valore predefinito resta `http://localhost:8080` **solo per sviluppo**, HTTP remoto è rifiutato dal builder CSP. L'audience pubblica `OIDC_PUBLIC_AUDIENCE` è ora distinta da `AUTH_AUDIENCE`, così i demo legacy locali non generano una combinazione OIDC parziale vietata dalla #81. Test Vitest e, se Docker è presente, `docker compose config --format json` sul Compose generato verificano configurazioni locali e HTTPS. Rimangono necessari TLS, reverse proxy e IdP esterno reale; questa modifica non certifica un deploy production (#9).

## Follow-up #83 — Correzione schema Compose con servizi opzionali (16 novembre 2026)

La #83 è stata rilevata da un **fallimento reale** della Factory CI sul primo commit della #82. Il generatore creava la root `volumes:` **prima** di aggiungere Jaeger e altri servizi opzionali, facendo fallire `docker compose config` con `volumes.jaeger additional properties 'image', 'ports' not allowed`. Ora Redis, RabbitMQ, Jaeger e MinIO sono sempre dentro `services:`; gli eventuali named volumes PostgreSQL/MySQL/SQL Server vengono emessi **alla fine**, senza root `volumes:` per SQLite. RabbitMQ management e i porti Jaeger sono limitati al loopback, come il Web e la API. Nuovi test controllano davvero quattro varianti Compose con servizi opzionali, senza avviare container. Non è una verifica di TLS/proxy/IdP produzione (#9).

## Sottoissue #84 — API CORS OIDC configurabile HTTPS (16 novembre 2026)

Lo scaffold PostgreSQL genera ora `BrowserCorsStartup.cs` con una allowlist CORS esplicita e separata dall'autenticazione JWT. In `Production`, `Staging` e `QA` è **obbligatorio** impostare `WEB_ALLOWED_ORIGINS=https://app.example` nel file locale `docker/.env`, eventualmente con più origin HTTPS separati da virgole **senza spazi**. I valori devono essere origin canonici (scheme+host+porta opzionale), senza wildcard, credenziali, path, query o fragment. Il Compose mappa tale valore su `Web__AllowedOrigins`; l'API **rifiuta l'avvio** se la variabile manca o è malformata. Solo `Development` senza configurazione usa le origini predefinite localhost e il container Vite CI, e permette HTTP esclusivamente da loopback o dal nome host `web` della CI. CORS non usa cookie credentials, non equivale ad autenticazione e non sostituisce i JWT. `WEB_ALLOWED_ORIGINS` identifica l'origine del **frontend browser**, mentre `PUBLIC_API_URL` della #82 identifica l'API raggiunta dal browser; per produzione servono anche TLS/reverse proxy e IdP reale. La Factory testa la generazione, 17 startup fail-closed con il binario .NET compilato e preflight allow/deny reali in fullstack Chromium/ASP.NET/PostgreSQL; non certifica un IdP HTTPS esterno (epica #9).

## Sottoissue #85 — Gate CI Playwright agganciato ai test dichiarati (16 novembre 2026)

Il nuovo test CORS (#84) ha portato la suite fullstack da 17 a 18 test Chromium; tutti erano passati ma `fullstack-smoke.mjs` conteneva `/17 passed/` e segnava la CI rossa. La #85 aggiunge una funzione pura `verifyFullstackPlaywrightOutcome` che conta i test **top-level realmente dichiarati** nel fixture `smoke.spec.ts` eseguito e richiede uno stato passed, exit code zero, nessun timeout, esattamente N test `passed` nel summary e nessuna indicazione di failed/skipped/flaky/interrupted. La suite di regression test runner verifica i casi N=17/18/19, conteggi falsi e report incompleti; non basta ritoccare un numero costante. Dopo i test browser, la verifica CI continua con audit PostgreSQL, rollover JWKS e prove OIDC esistenti. Questa modifica certifica solo la CI privata, non un IdP HTTPS esterno.

## Avanzamento #86 — JWKS OIDC HTTPS verificato con CA di CI (16 novembre 2026)

La Factory ora esercita **due modalità distinte** nel fullstack Docker privato: il browser Chromium continua a verificare login PKCE, refresh, logout e isolamento PostgreSQL col provider HTTP effimero (solo CI); dopo gli E2E avvia **un secondo issuer TLS** `https://identity-tls:9443` con CA e certificato server con SAN `identity-tls` generati sul momento. Una API ASP.NET Core **Production** che conosce solo la CA testata deve accettare RS256/JWKS, gestire il rollover del `kid`, validare firma/ruoli e applicare RBAC; una seconda API Production identica **senza** la CA deve rifiutare lo stesso JWT. Anche un client Node senza CA deve rifiutare l'issuer TLS; non viene mai usato `NODE_TLS_REJECT_UNAUTHORIZED=0`. Certificati e chiavi sono effimeri e cancellati dopo il test, CA privata mai montata nei container, nessuna porta pubblicata sull'host. La CI resta Docker rootful su host GitHub: **non certifica** un IdP HTTPS commerciale esterno, una PKI pubblica, revoca certificati, TLS edge/reverse proxy, Cloudflare o VM rootless. Sottoissue [#86](https://github.com/KeyserDSoze/SoftwareFactory/issues/86) dell'epica #9.


## Installazione guidata del connector Docker (#87)

In **Settings → Runner Docker remoto** è disponibile un onboarding per PC Linux o VM/server
Linux dedicati: istruzioni di installazione del runner esistente e controllo autenticato in
sola lettura di API, heartbeat worker e osservazione recente del daemon Docker rootless.
Non richiede di mettere SDK o Docker nel browser, ma **non** è ancora un installer
one-click e non prova che un build/test sia riuscito. I test rimangono job espliciti con
report vincolati al digest dello snapshot. I container multi-servizio orchestrati dal worker e il pairing
sicuro host↔app sono previsti nell'[issue #87](https://github.com/KeyserDSoze/SoftwareFactory/issues/87);
vedi [guida runner](docs/runner.md) e [ADR 0044](adr/0044-runner-connector-onboarding-and-container-orchestration.md).

## Installazione locale del connector su Linux — #88 (M2 di #87)

La prima CLI **operator-only** `src/runner/scripts/host-install.mjs` consente di verificare senza modifiche un server Linux con Docker rootless e di avviare, **solo dopo doppio consenso**, i due servizi esistenti runner-api e runner-worker. Richiede UID 1000, checkout Git `main` **pulito** fissato con SHA-40, file `.env` privato e digest immutabile `node@sha256:...` per il canary. `--check` esegue solo preflight read-only Git/Compose/host e restituisce `ready_to_install`, non una prova di esecuzione. `--apply --confirm-install` richiede canary rootless con cleanup verificato e nessun Compose preesistente, avvia solo i due servizi su Docker rootless, poi controlla i container e le tre API di readiness **autenticate via loopback**. Segreti non devono essere scritti in CLI/URL/repo e non vengono mostrati nei risultati; il tunnel non è avviato. Errori e stack parziali richiedono ispezione manuale, senza cancellazioni automatiche. Seguire [la guida operatore](docs/runner.md). La CI usa mock del daemon per questi flussi, **non certifica** installazione su PC o VM rootless reale; M2-M5 di #87 restano aperte per collaudo host, update/uninstall/revoke, pairing e fullstack multiservizio. ADR 0044.


## Software house multi-ruolo e profilo cloud (#89, prima iterazione)

**Settings → Modelli e ruoli:** oltre alle sei fasi AI è disponibile un catalogo di
23 ruoli (business analyst/developer, software/cloud/on-prem architect,
PM, developer, tester, QA, fixer, reviewer, DevOps, release, writer ecc.).
Puoi impostare per ciascun ruolo endpoint, modello e thinking (automatic,
low, medium, high, xhigh), con ereditarietà dalla fase e dall'endpoint
come in BookWriter. Le sei fasi e le operazioni Code Agent di sviluppo,
review e fix **usano già il routing selezionato**. Gli altri ruoli sono
*soltanto configurabili*: non esiste ancora un PM/scheduler persistente
né un tester autonomo che chiuda il ciclo senza browser. Thinking esplicito
invia `reasoning_effort`, automatico non lo invia; discovery /models e
capability-specific routing restano previsti per la #89.

Il backup manuale Google Drive appDataFolder / OneDrive app folder conserva
settings (incluso URL runner, router dei ruoli e thinking) e progetto;
il ripristino li applica anche su altro dispositivo. **Non conserva
credenziali runner/AI/GitHub**: oggi restano in sessionStorage; vault E2EE
con passphrase, revision/CAS e sync fra dispositivi come BookWriter
sono da sviluppare. Non inserire chiavi di produzione nella SPA.

**Setup host su PC/server Linux:** dopo avere installato Docker Engine rootless,
Compose e Node.js sull'account dedicato uid 1000, si possono eseguire
`node src/runner/scripts/host-setup.mjs setup --origin=https://<origin-della-spa>`
e quindi `node src/runner/scripts/host-install.mjs --env-file=/absolute/private.env --commit=<SHA40> --image=node@sha256:<DIGEST64> --apply --confirm-install`.
Il primo genera localmente credenziali e file privati, il secondo verifica
host/Compose e avvia API+worker. La configurazione del tunnel HTTPS/
Cloudflare Access resta un'attività dell'operatore; GitHub Pages non trova
automaticamente server privati. Vedi [guida runner](docs/runner.md),
[ADR 0045](adr/0045-bookwriter-style-role-router-and-host-bootstrap.md)
e [issue #89](https://github.com/KeyserDSoze/SoftwareFactory/issues/89).

## Installer Docker/Cloudflare, risorse in tempo reale e cloud vault (#89)

**Aggiornamento sperimentale.** Nella pagina `Settings → Remote runner` è presente una guida con un nuovo wizard interattivo da eseguire **sul PC/server Ubuntu o Debian dedicato** come utente Linux UID 1000. Dopo avere installato Node.js e clonato il repository:

```bash
node src/runner/scripts/interactive-install.mjs
```

Il wizard richiede conferma prima dei privilegi sudo, installa Docker Engine rootless e Docker Compose via apt con GPG verificata, domanda origin GitHub Pages e URL HTTPS del runner, **token Cloudflare in input nascosto**, API key personalizzata (almeno 32 caratteri) o random. Salva credenziali in `.env` 0600; abilita user systemd Docker + linger per i riavvii e avvia nello stesso Compose API, worker e `cloudflared` (restart automatico). Nel Cloudflare dashboard configura un **Published application** sul dominio scelto, usando servizio interno **`http://runner-api:8787`**, non localhost del container. Non inserire token Cloudflare nel browser. Il codice ha test automatizzati, **non è ancora validato sul server rootless né con reboot e Tunnel reali**. Non eseguire su server condivisi.

`Settings` e il pannello runner espongono **CPU, RAM, disco, uptime e temperatura CPU se misurabile** attraverso `GET /v1/host-metrics` autenticata. Le misure sono aggregati visibili dal worker e non consumi energetici misurati. Un popup in basso a destra, ispirato a BookWriter, segue la fase AI e i task/test noti realmente al frontend (non streaming LLM né schedulazione autonoma).

Puoi **cifrare e salvare URL + API key del runner** in un file vault separato dentro Google Drive appDataFolder o OneDrive App Folder, quindi sbloccarlo con passphrase su un altro dispositivo. Utilizza WebCrypto PBKDF2/AES-GCM: passphrase e token Cloudflare non vengono spediti al cloud, il file cloud conserva il solo ciphertext. Funzione manuale e a **connettore singolo**, senza gestione dei conflitti cloud/merge e senza recupero passphrase. [Guida runner](docs/runner.md), [ADR 0046](adr/0046-interactive-runner-installer-telemetry-cloud-vault.md), [feature #89](https://github.com/KeyserDSoze/SoftwareFactory/issues/89).

## Installer in Release + GitHub Actions come seconda opzione test (#90)

La Factory espone in **Settings → Remote runner** il catalogo della **GitHub Release pubblica più recente** di SoftwareFactory, verificando nome/tag/URL degli asset prima di mostrare il download di `softwarefactory-runner-installer.tar.gz` e `.sha256`. Non occorre un PAT per scaricare il pacchetto. Le guide [Italiano](INSTALLER.it.md) e [English](INSTALLER.en.md) spiegano verifica SHA-256, prerequisiti Ubuntu/Debian/Node.js/UID1000, token Cloudflare, API key, tunnel HTTP interno `runner-api:8787` e riavvio. La SPA offre un selettore lingua IT/EN con localizzazione **dei nuovi flussi**; altre sezioni legacy non sono ancora tradotte. Il browser non installa nulla da remoto.

**La release viene pubblicata solo quando il manutentore avvia manualmente** la Action [Publish Linux runner installer](.github/workflows/release-installer.yml) su `main` con versione SemVer stabile (per esempio `v0.2.0`). Il workflow prepara bundle sorgente + checksum SHA-256, rifiuta la sovrascrittura di Release esistenti e richiede `contents:write` al solo job di pubblicazione. Se non è ancora presente una Release che contiene questi asset, l'interfaccia mostra correttamente "non disponibile" e collega all'elenco Releases; non inventa link funzionanti.

**In Code Agent → Test execution** puoi selezionare *Server Docker* oppure **GitHub Actions**. La pubblicazione del codice tramite PAT/Git Data fast-forward era già disponibile. Ora ogni scaffold generato include anche `.github/workflows/softwarefactory-tests.yml` (`workflow_dispatch`, cinque selezioni booleane allowlisted per build/test .NET, build/test React e Playwright) e `scripts/softwarefactory-tests.mjs`. Dopo aver pubblicato il workflow sul branch predefinito del repository dell'app, scegli i test e autorizza il dispatch da SPA col PAT fine-grained (**Contents:read e Actions:read/write**). Non passare il PAT a job/script come variabile: il checkout del workflow usa `persist-credentials:false` e `contents:read`.

La SPA correla il run con un UUID, l'esatto SHA del branch, il run ID e l'attempt. Alla fine legge (ove CORS del download lo consente) lo ZIP artifact **`softwarefactory-test-report`**, contenente `report.json` schema v1: step, exit code, esito, durata e frammento log; controverifica i conteggi e la conclusione GitHub. Se il browser non riesce a seguire il redirect dell'artifact, scarica lo ZIP dal link GitHub e importalo manualmente nel pannello: la validazione continua localmente, ma il file importato non ha autenticità crittografica indipendente. Le prove sono **legate al commit pubblicato**, non allo stato corrente dei file locali, e `incomplete` non equivale mai a `passed`. Test .NET/React assenti sono indicati `incomplete`. Gli smoke Playwright nel nuovo workflow usano API mock, non DB/OIDC reali. Un eventuale report `failed` può preparare **su conferma** un testo di richiesta fix da revisionare prima di inviarlo all'AI; nessuna modifica, push, review o retest parte da sola. Vedi [ADR 0047](adr/0047-release-installer-and-actions-test-backends.md) e [#90](https://github.com/KeyserDSoze/SoftwareFactory/issues/90).

## GitHub e PAT in stile BookWriter — issue #91

In **Settings → GitHub** ora puoi digitare una sola volta il PAT fine-grained e scegliere: **Cifra sul dispositivo** (WebCrypto AES-256-GCM con chiave non estraibile nell'IndexedDB locale) oppure **Usa solo questa sessione**. Quando riapri l'app premi **Sblocca PAT salvato**. Il token è condiviso tra i progetti locali, mai salvato nel progetto, nei sorgenti, nel backup normale, negli artifact di test o nel repository. Rimuoverlo in SoftwareFactory non lo revoca su GitHub: per revocarlo usa GitHub Settings → Developer settings → Personal access tokens.

La nuova sezione **Trova repository del PAT** legge solo i metadata GitHub (fino a 500), mostra owner, nome, branch predefinito, visibilità e possibilità di push dell'account. La selezione non crea commit. I campi manuali restano disponibili sotto **Avanzato**. Verifica i permessi PAT prima della prima scrittura: `Contents:read/write` per pubblicazione/import, `Actions:read/write` anche per i test workflow dispatch. Il permesso di push mostrato dai metadata non certifica da solo il scope effettivo del PAT. Le repository pubbliche richiedono conferma esplicita della divulgazione dei sorgenti e dei checkpoint AI.

**Più progetti**: nel Workspace usa **I tuoi progetti locali** per aprire i progetti salvati sul dispositivo (limite 40), ciascuno con la propria destinazione GitHub. La configurazione PAT è condivisa e rimane cifrata. Un primo push autorizzato pubblica il codice **e** `.softwarefactory/workspace-state.v1.json`: checkpoint ripristinabile del progetto, output AI e sviluppo in corso, **non cifrato**, visibile ai lettori della repository. Non inserire segreti nei requisiti o nei log. Su un nuovo dispositivo scegli repository e premi **Importa checkpoint GitHub**. L'importazione sostituisce il progetto aperto solo dopo conferma; non fonde codici divergenti e disattiva l'autosync.

**Autosync opzionale**: solo dopo un primo push confermato, abilita **Sincronizza checkpoint automaticamente dopo i task**. Mentre la pagina è aperta/visibile e il PAT è sbloccato, il client verifica cambi locali e pubblica al massimo una volta ogni due minuti, mediante Web Locks, outbox metadata locale e recheck della HEAD GitHub. Se un altro PC ha avanzato il branch, il processo si ferma con un conflitto — nessun force push. Le modifiche non approvate possono far parte del *checkpoint*, ma non vengono inserite nei sorgenti finché la review/appprovazione non le applica. Autosync non è un agent 24/7: chiudendo la pagina smette di funzionare.

**PAT multi-device**: collega Google Drive o OneDrive nelle Settings, apri **PAT cifrato nel cloud**, immetti una passphrase separata (minimo 12 caratteri), salva ciphertext nel file dell'app `softwarefactory-github-pat-v1.json`; su un secondo PC accedi allo stesso account cloud, digita la passphrase e seleziona **Importa sul dispositivo**. La chiave passa in chiaro solo nella memoria e nella sessione del browser dopo sblocco. OneDrive protegge l'aggiornamento del vault con eTag condizionale; Google Drive ha solo version-check best-effort **non CAS atomico**: evitare salvataggi simultanei dallo stesso profilo. La passphrase non è recuperabile, e la cifratura lato client non protegge da JavaScript malevolo sulla stessa origin.

**GitHub Actions**: dopo il push puoi selezionare test .NET, React e Playwright nel Code Agent. Il report JSON dello SHA pubblicato è separato dalla snapshot Docker. Un report fallito può preparare una richiesta di fix solo se lo SHA del report coincide con il checkpoint locale, e sempre dopo approvazione esplicita; restano necessari nuova review e test. Guida tecnica: [ADR 0048](adr/0048-github-pat-project-sync-bookwriter-parity.md), [docs/connectors.md](docs/connectors.md) e [#91](https://github.com/KeyserDSoze/SoftwareFactory/issues/91).

Questa parità è **parziale e non certificata in provider reali**: rimangono test end-to-end su PAT e vault cloud, CAS atomico Google, lease inter-device, i18n integrale, migrazione dei repository precedenti e gestione avanzata della recovery. L'app è static-only su Pages.

### Release candidate Linux installer: automatico dopo CI verde (#90)

Il workflow [Publish Linux runner installer](.github/workflows/release-installer.yml) mantiene la pubblicazione manuale per tag stabili `vX.Y.Z`. Per test controllati è ora disponibile anche il marker versionato `.github/installer-release.version`: quando contiene un tag `vX.Y.Z-rc.N`, **solo** una Factory CI riuscita su `main` nello stesso repository può generare automaticamente un **prerelease sperimentale** sullo SHA esatto verificato. Il workflow rifiuta tag già esistenti e non ripunta release pubblicate; SHA-256, archivio completo e guide IT/EN sono allegati. In assenza di marker non pubblica nulla. La UI GitHub Pages mostra una Release stabile se disponibile oppure il prerelease più recente con un avviso esplicito **non certificato per produzione**. Non si installa né si esegue nulla nel browser; l'operatore scarica, verifica checksum e installa solo su VM Linux dedicata.

Restano necessari il collaudo manuale su Ubuntu/Debian UID 1000, Docker rootless e Cloudflare Tunnel/Access dopo reboot e la security acceptance. Una Factory CI verde non sostituisce il test su host reale.

## Modifica progetti fra schede: writer lock esclusivo (#92)

SoftwareFactory mantiene **un solo editor attivo per progetto e browser profile/origin**. Quando apri un progetto, la SPA acquisisce un **Web Lock** esclusivo `softwarefactory:local-writer:<project-id>` e lo conserva fino al cambio progetto o alla chiusura della scheda. Una seconda scheda che apre **lo stesso progetto** entra in modalità di blocco per quel progetto e non può avviare AI Factory, Code Agent, autosync o pubblicazione GitHub finché non ottiene il lock; **può però scegliere un altro progetto esistente o crearne uno nuovo**, ciascuno con il proprio lock. Non aspetta in background: chiudi la prima scheda e nel pannello «Conflitto locale tra schede» usa «Salva backup e carica versione aggiornata». Prima di rileggere la libreria vengono richiesti il download del JSON di recupero e una seconda conferma.

I progetti **diversi** possono essere aperti contemporaneamente in schede diverse: i lock sono separati per ID. I cambi progetto e i restore (GitHub/cloud) acquisiscono il nuovo lock **prima** di sostituire il progetto aperto. Se il browser non supporta Web Locks, il comportamento è fail-closed per scritture locali anziché cadere su un salvataggio non sincronizzato.

Un Web Lock non è un CAS remoto GitHub, né protegge browser diversi, versioni legacy della SPA che non lo rispettano, dispositivi diversi o codice malevolo nella stessa origin. Resta necessario l'HEAD check GitHub + no force push e la libreria localStorage con baseline. Test unitari in `project-writer-lease.test.ts`; test vero Chromium multi-tab in Factory CI tramite `src/runner/scripts/factory-browser-lock-smoke.mjs` (container offline/read-only). [ADR 0049](adr/0049-local-project-exclusive-writer-web-locks.md).

Il marker `.github/installer-release.version` per l'RC `v0.2.0-rc.1` è stato rimosso dopo la pubblicazione riuscita, per evitare trigger ripetuti: per pubblicare una **nuova** Release candidate, inserire **un nuovo** marker SemVer `-rc.N` in un commit su `main` e attendere CI verde; il workflow rifiuta sempre il riutilizzo di tag esistenti.


## Ripristina una conferma GitHub persa senza un nuovo push (#91)

Se la Factory ha inviato un commit ma la connessione è caduta, oppure la pagina si è chiusa prima di salvare lo SHA, la HEAD remota può risultare avanzata rispetto al checkpoint locale. **Non riprovare ripetutamente «Pubblica»**: il controllo fast-forward rifiuterà un branch che è già cambiato.

Apri **Settings → GitHub → Recupera conferma commit**. Dopo il primo consenso, il browser esegue soltanto richieste GitHub REST **GET**: legge il checkpoint alla HEAD esatta, esige che l'intero stato portable coincida con quello del progetto aperto, verifica il commit (genitore esattamente uguale alla HEAD prima confermata, se presente) e tutti i Git blob SHA-1 calcolati localmente per sorgenti generati e checkpoint. Rilegge la HEAD al termine per evitare di riconoscere un ref nel frattempo cambiato. Mostra repo/branch/SHA/parent/file verificati, avvisa se la repository è realmente **pubblica**, poi richiede una seconda conferma.

Se e solo se tutto corrisponde, aggiorna **soltanto** il binding locale `githubSync`, senza riscrivere o importare il brief, le fasi o le patch. Disattiva l'autosync, che andrà autorizzato nuovamente. Il consenso a futuri push su repo pubbliche **non viene creato** dal recupero. L'operazione non crea repo, non invia patch, non fa merge né force push e non prova l'autore del commit: certifica solo la corrispondenza dei file locali con la **HEAD attuale**. Un branch avanzato da un altro dispositivo con altri commit, un solo file differente o un checkpoint storico devono essere gestiti con **Verifica HEAD remota** e import manuale con backup, non con l'ack. Web Locks proteggono la scheda locale; non sono un lease remoto multi-device.

[ADR 0051](adr/0051-github-lost-ack-tree-reconciliation.md) · [Issue #91](https://github.com/KeyserDSoze/SoftwareFactory/issues/91).

## #95 — Download Release verificabile e avvio runner senza bypass del canary (18 novembre 2026)

Il wizard `interactive-install.mjs` e il bootstrap `host-setup.mjs` non possono più avviare API/worker con il vecchio `host-setup start`: quel percorso eludeva la VM acceptance #88. Il wizard **prima di modificare l'host** verifica il sorgente approvato (checkout `main` pulito SHA40, oppure un archivio Release con SHA256 verificata e manifest bytewise dei file), richiede conferma esplicita della SHA40 e del digest immutabile `node@sha256:...`, e poi usa `host-install --apply --confirm-install` per canary rootless, lock, preflight, Docker Compose API+worker e readiness autenticata. Solo dopo chiede l'avvio del tunnel con una command separata `host-setup tunnel --confirm-tunnel` che rifiuta daemon non rootless o API non pronte e non avvia altri servizi.

Il packaging Release adesso emette `.sf-installer-source.json` con commit SHA40 e checksum SHA-256 di ogni file estratto, e controlla offline l'archivio prima della pubblicazione. Il wizard chiede il percorso assoluto del `tar.gz` e la SHA256 approvata dall'operatore: questi valori non sono segreti e **non sostituiscono una firma indipendente** del publisher. La precedente Release **`v0.2.0-rc.1` non ha manifest ed è esclusa dai download consigliati dell'app**; usare `rc.2` o release compatibili. Non confondere una CI verde su Docker rootful effimero con un vero collaudo Linux rootless, reboot, Cloudflare Tunnel e Access. Guide [IT](INSTALLER.it.md), [EN](INSTALLER.en.md), ADR 0054, issue #95.

## #96 — Audit rootless prima e dopo il riavvio Linux (18 novembre 2026)

La CLI operator-only src/runner/scripts/host-reboot-audit.mjs prova localmente il restart del connector con due passaggi. BEFORE richiede UID/EUID 1000, private env O_NOFOLLOW, preflight host/Compose, Docker user service active con linger, daemon rootless just-in-time, due container esatti API+worker running non privilegiati (API solo loopback senza socket, worker con il socket rootless) e readiness HTTP Bearer. Solo allora salva una witness locale 0600 senza token. AFTER richiede un **boot ID Linux differente** dal precedente e ripete tutti i gate; non avvia né arresta Docker e non cancella dati. L'opzione --require-tunnel aggiunge un terzo container Cloudflared running senza Docker socket; NON prova DNS/HTTPS/Cloudflare Access esterni. Modalità key-file/tenants richiedono private RUNNER_PROBE_BEARER; la witness è locale non firmata, non attestazione off-host. Test Node su stubs deterministici, non reboot VM reale. Guida docs/runner.md e ADR0055; issue #96, #87 resta aperta.


## Handoff dei task della software house (#98 — 18 novembre 2026)

Nella scheda **AI Factory** è visibile il nuovo **piano di handoff PM**: le sei
fasi AI, la proposta di codice, la review indipendente, la verifica dei test e
l'approvazione umana hanno responsabile, prerequisiti e stato derivato dai
checkpoint esistenti. I blocchi, una patch obsoleta o una review respinta non
vengono spacciati per attività completate. La vista non salva uno stato
parallelo e segue il progetto selezionato dopo il reload.

**Non è un orchestratore autonomo**: il browser non esegue nuovi ruoli,
né il ruolo Tester attiva automaticamente il runner. Un job inviato vale solo
come ricevuta e non come test passato; è necessario leggere e validare il report
in Code Agent. Dopo un repair è sempre obbligatoria la verifica runtime
sul codice corrente prima dell'approvazione. I gate Code Agent sono invariati.
Task DAG persistenti sul server e coordinamento PM automatico restano in #89.
[ADR 0056](adr/0056-checkpoint-derived-pm-handoff-board.md) ·
[Issue #98](https://github.com/KeyserDSoze/SoftwareFactory/issues/98).


## PM execution plan server-side (#99 — 18 novembre 2026)

La API del runner dispone ora di `GET /v1/jobs/<uuid>/plan`, autenticata come il report.
Il piano evidenzia gli step di test nell'ordine richiesto, la loro dipendenza,
e solo le prove realmente registrate nel journal SHA-256. In Code Agent
la vista è mostrata soltanto quando `id`, digest e head dell'evidence
corrispondono al report appena recuperato; se mancano, il piano non viene
presentato come verificato. Le fasi in coda non vengono spacciate per test avviati.

La API non esegue task aggiuntivi e non possiede un PM autonomo. Il risultato è
osservabile fino alla retention del job, non è un'attestazione indipendente o una
schedulazione multi-agent. Vedi [ADR 0057](adr/0057-runner-verified-pm-execution-view.md),
[issue #99](https://github.com/KeyserDSoze/SoftwareFactory/issues/99).



## Registro multi-job PM persistente (#100)

Il runner supporta `POST /v1/workflows` e `GET /v1/workflows/<uuid>` per registrare con consenso un **DAG immutabile di 2–6 job già ammessi**. L'API richiede la stessa credenziale runner dei job e un header `Idempotency-Key` UUIDv4. La registrazione richiede `consent: true`, una `label` e task con `id`, `role`, `jobId`, `digest`, `dependsOn`. Ruoli sono annotazioni, non worker autonomi.

Esempio: `{"consent":true,"label":"Build e test","tasks":[{"id":"build","role":"devops_engineer","jobId":"<uuid-già-restituito>","digest":"<sha256>","dependsOn":[]},{"id":"test","role":"tester","jobId":"<secondo-uuid>","digest":"<secondo-sha256>","dependsOn":["build"]}]}`. Le due chiamate a `POST /v1/jobs` avvengono **prima**, con consenso autonomo dell'operatore; registrare un piano **non avvia job**. GET ricostruisce gli stati da journal verificati (head/count) e segnala `out_of_order` se un job dipendente è partito troppo presto. I manifest sono privati/limitati, associati al tenant, recuperabili dopo restart, non firmati e conservati sino alla manutenzione manuale. Se i job sono stati rimossi dalla retention, GET fallisce senza inventare esiti. Non esiste ancora scheduler multi-job che imponga l'ordine, né un PM AI non supervisionato. [ADR 0058](adr/0058-multi-job-observational-workflow-ledger.md) e [#100](https://github.com/KeyserDSoze/SoftwareFactory/issues/100).


## Retry GitHub Pages senza artefatti duplicati (#101)

Il workflow statico distingue ora build-and-upload e deploy. Se fallisce soltanto il deploy Pages, usare **Re-run failed jobs** in GitHub Actions: il build già completato non ricarica un secondo artifact github-pages nello stesso run. I permessi Pages e il controllo sulla disponibilità rimangono invariati. Solo un workflow completato con successo prova la pubblicazione.


## Enforced workflow gate (opt-in, #102)

`POST /v1/workflows` con `{"consent":true,"enforced":true,"label":"…","tasks":[…]}` registra un **manifest v2** con i job già ammessi, ma obbligatoriamente `queued` e privi di claim nel momento della registrazione. È richiesto `Idempotency-Key` UUID come in #100. V2 non permette di assegnare un job già governato da un altro workflow enforced. I vecchi manifest v1, senza `enforced`, restano **soltanto osservativi**.

Il worker legge il registro sul volume condiviso, salta i job con predecessori non ancora verificati come `passed` e li rivaluta dopo il completamento. Il controllo definitivo e la creazione della claim del job avvengono insieme sotto il lock POSIX dell'admission per impedire race tra API e worker multipli. Il gate non trasforma un'attesa in un errore dei test e non deve bloccare i job indipendenti della coda. Se il manifest o le prove dei predecessori sono illeggibili, il worker non deve eseguire il job.

**Non è un nuovo servizio AI autonomo:** i job vanno comunque sottomessi esplicitamente dall'operatore *prima* dell'iscrizione; il gate governa solo l'avvio di quelli accodati, non genera codice, non promette budget/lease multi-host e non approva patch. Per progetti in cui un worker potrebbe iniziare subito, sospendere l'worker prima di inviare i job, registrarli in enforced e quindi riavviarlo. [ADR 0059](adr/0059-enforced-queued-job-worker-gates.md), [issue #102](https://github.com/KeyserDSoze/SoftwareFactory/issues/102).


## Workflow batch atomico con recupero controllato (#103, 18 novembre 2026)

Con `POST /v1/workflows/batch` si possono registrare **2–6 job e il loro DAG enforced** in un'unica chiamata con consenso esplicito, senza fermare preventivamente il worker. Richiede la stessa Bearer dell'API runner, header `Idempotency-Key` UUIDv4 persistente tra retry e questo corpo JSON:

```json
{"consent":true,"enforced":true,"label":"Build e test","tasks":[
  {"id":"build","role":"devops_engineer","dependsOn":[],"request":{"label":"Build","files":{"src/backend/domain/Test.cs":"namespace Example; public class Test {}"},"steps":["dotnet-build"]}},
  {"id":"test","role":"tester","dependsOn":["build"],"request":{"label":"Test","files":{"src/backend/domain/Test.cs":"namespace Example; public class Test {}"},"steps":["dotnet-test"]}}
]}
```

Ogni `request` usa la stessa validazione, allowlist, controllo credenziali, digest e limite file di `/v1/jobs`. Il batch consuma **N** posti delle quote globali e tenant e del rate limiter, non un solo posto. Il server prepara i report/journal `accepted` fuori dalla coda, crea un marker di commit privato e pubblica directory e manifest enforced con lo stesso lock POSIX della claim worker. Solo dopo la verifica rimuove il marker; il worker passa un job dipendente solo con journal `passed` dei predecessori. Non viene eseguito un agente AI né approvata una patch. GET `/v1/workflows/:id` resta una proiezione verificata, e una risposta `queued` non equivale a un test riuscito.

Il client TypeScript `submitRunnerWorkflowBatch` è disponibile nell'SDK frontend, ma non avvia l'esecuzione senza una chiamata esplicita dell'operatore. Sul retry usare il medesimo `Idempotency-Key`: un ack perso non crea duplicati, un contenuto diverso dà conflitto 409.

**Crash tra commit e pulizia:** un marker `workflows/.pending-UUID` blocca nuove claim fino a decisione operatore. Con API/worker **fermati** e volume locale POSIX verificato, eseguire dal package runner:

```bash
npm run batch-reconcile -- --data-dir /absolute/runner/data --batch-id UUID --finalize
# oppure, solo se il manifest non esiste e TUTTI i job risultano mai avviati:
npm run batch-reconcile -- --data-dir /absolute/runner/data --batch-id UUID --abort
```

Il comando ricontrolla UID, permessi, marker, digest, claim e journal; rifiuta di eliminare job avviati, di finalizzare un manifest mancante o di abortire uno già committed. Se un crash ha lasciato `.admission`, un amministratore deve prima arrestare i processi e verificare manualmente il lock; **mai** cancellarlo durante lavoro attivo. Staging abbandonato *prima* del marker non è eseguibile e richiede pulizia amministrativa separata. Non c'è auto-recovery silenziosa e non è attestazione off-host. Vedi [ADR 0060](adr/0060-atomic-runner-workflow-batch.md) e [#103](https://github.com/KeyserDSoze/SoftwareFactory/issues/103).


### Recupero di staging non pubblicato
Se un crash avviene **prima** della pubblicazione del marker, nessun job del batch è mai diventato eseguibile. Il comando offline `npm run batch-reconcile -- --data-dir /absolute/runner/data --batch-id UUID --discard-stage` elimina solo lo staging incompleto; rifiuta l'operazione se trova un manifest, un marker o un job con lo stesso UUID già pubblicato in `jobs/`. Ferma comunque API e worker prima della manutenzione; non usare `--discard-stage` per bypassare un marker pendente.


## UI per DAG di test protetto (#104)

Nella scheda **AI Factory → Code Agent → Server Docker**, espandi **Piano test multi-job verificato**. Seleziona da due a cinque controlli, verifica l'ordine delle dipendenze e il numero di file inclusi, quindi seleziona la checkbox di consenso e conferma il runner destinatario. Un solo click esplicito invia il batch `enforced:true` creato dalla #103. La vista segue il risultato server journal-bound dei job (queued, blocked, running, passed, failed, incomplete, out_of_order) e non attribuisce alcuna approvazione automatica di patch.

Il pannello **non invia patch pendenti**: per un repair sono obbligatori il percorso separato di review indipendente e i suoi re-test. Se il progetto cambia dopo l'invio, il DAG diventa **storico**, non verificato per il codice corrente. Una risposta HTTP persa consente un retry con lo stesso UUID/idempotency, senza duplicazione intenzionale dei job. Solo endpoint, UUID, revisione e digest del payload sono registrati in `sessionStorage` locale; nessuna chiave runner o sorgente del progetto entra in questa persistenza. `fetchRunnerWorkflow` rifiuta un DAG con identità/ruoli/head/evidence o dipendenze non coerenti: un report malformato non viene presentato come passed.

Le stringhe sono aggiunte alle traduzioni IT/EN centrali in `src/frontend/src/i18n.ts`, come previsto dalla #90. Vedi [ADR 0061](adr/0061-operator-consented-batch-ui.md) e [#104](https://github.com/KeyserDSoze/SoftwareFactory/issues/104).


## Project Manager AI: proposta di DAG verificato (#106, 18 novembre 2026)

Nella scheda **Code Agent → Server Docker → Piano test multi-job** puoi ora selezionare 2–5 test e scegliere **Proponi DAG con Project Manager AI**. La richiesta è facoltativa e ha un consenso separato: invia al modello assegnato al ruolo `project_manager` solo dati di progetto sintetici e nomi dei test scelti, **non gli snapshot dei sorgenti**. Il provider può addebitare token. Profilo/modello/thinking provengono da Impostazioni → Router dei ruoli (fallback sulla fase implementation) e la chiave AI resta nella sessione corrente.

Il PM restituisce solo una proposta JSON con motivazione, task e dipendenze. Il validatore rifiuta ogni step extra, omissione, duplicato, ordine circolare/non topologico, ruolo/comando imposto dall'AI, prerequisito build→test saltato o Playwright senza i predecessori scelti. Per l'esecuzione i ruoli devops/tester sono determinati dal programma, non dal testo AI. L'operatore può visualizzare motivi e ordine, tornare al piano manuale oppure approvare una **seconda conferma separata** prima dell'effettivo POST batch. Nessuna patch pending viene inclusa né autorizzata automaticamente; il risultato dei test resta solo quello del journal verificato dal runner. Cambiando workspace, revisione, test o modello, la proposta AI non è più utilizzabile.

La proposta PM non è ancora uno scheduler indipendente con budget per token, persistenza cross-device, task leases multi-host o attestation off-host: questi requisiti rimangono nell'epica #89. [ADR 0062](adr/0062-human-supervised-ai-pm-test-dag.md), [issue #106](https://github.com/KeyserDSoze/SoftwareFactory/issues/106).



## Registro handoff AI durevole, senza esecuzione automatica (#107)

Il runner offre un **registro indipendente dai test Docker** per dichiarare un piano di responsabilità multi-ruolo, con consenso e limiti preventivi. La richiesta `POST /v1/agent-handoffs` usa la consueta autenticazione Bearer, CORS consentito, `Content-Type: application/json` e **`Idempotency-Key` UUIDv4**:

```json
{
  "consent": true,
  "label": "Piano supervisionato del team",
  "budgetUnits": 10,
  "tasks": [
    {"id":"plan","role":"project_manager","owner":"pm-worker","dependsOn":[],"estimatedUnits":3,"maxAttempts":2},
    {"id":"review","role":"code_reviewer","owner":"reviewer-1","dependsOn":["plan"],"estimatedUnits":4,"maxAttempts":1}
  ]
}
```

`GET /v1/agent-handoffs/:uuid` restituisce la dichiarazione e lo stato **`declared`** con task `ready` (nessun predecessore) o `blocked` (dipendenze dichiarate). **Non esiste ancora un agente in esecuzione, un lease o un task riuscito**: `owner` è solo un identificatore dichiarato, NON una credenziale. Il `budgetUnits` è una stima di pianificazione con somma dei task controllata, **non** un contatore verificato di token/crediti reali. Il backend non consente di usare il registro per avviare AI, Docker, patch o approvazioni.

Il file privato salvato su volume POSIX contiene soltanto identità, ruoli, dipendenze, limiti, digest e consenso, senza prompt/sorgenti/token; è verificato tramite hash locale, owner/permessi e invarianti di inode/hardlink/symlink. Due API condividono il lock di admission; risposte perse possono essere recuperate con lo stesso UUID e identico contenuto. Un file sospetto blocca nuovi handoff, senza creare falsi successi. Consulta [ADR 0063](adr/0063-read-only-ai-role-handoff-registry.md) e la [#107](https://github.com/KeyserDSoze/SoftwareFactory/issues/107). **Le lease/fencing, identità per actor, budget reali e scheduler agenti restano #105 e #89.**




## Agenti multi-ruolo: lease scoped con fencing e revoca (#108)

La dichiarazione immutabile dei task AI (#107) supporta ora un gate separato di **presa in carico**. Configurare nella **sola API runner**, non nel worker Docker, \`RUNNER_AGENT_ACTORS_FILE=/percorso/assoluto/actors.json\`, un file privato \`0600\` di proprietà dell'UID API:

\`\`\`json
{
  "version": 1,
  "actors": [
    {
      "id": "pm-worker",
      "tenantId": null,
      "role": "project_manager",
      "key": "agent.pm-worker.REPLACE_WITH_32_OR_MORE_RANDOM_BASE64URL_CHARS"
    }
  ]
}
\`\`\`

Usare chiavi casuali **diverse** dalla chiave generale del runner e da quelle dei tenant. In modalità multi-tenant, impostare \`tenantId\` con l'identificatore esatto del tenant. Il registry viene riletto e verificato sotto lock a ogni mutazione; la sostituzione atomica del file revoca immediatamente le vecchie credenziali. Le chiavi non vengono salvate nei manifest né incluse nelle risposte.

\`POST /v1/agent-task-leases\` richiede la Bearer dell'**attore**, non la chiave globale. Per \`claim\`: \`{"action":"claim","handoffId":"UUID","taskId":"plan","ttlSeconds":60}\`. Per \`renew\`: \`{"action":"renew","handoffId":"UUID","taskId":"plan","ttlSeconds":120,"leaseId":"UUID-DALLA-CLAIM"}\`. Per \`release\`: \`{"action":"release","handoffId":"UUID","taskId":"plan","leaseId":"UUID-DALLA-CLAIM"}\`.

Il server verifica identità tenant+owner+ruolo, predecessori, limiti di tentativi, journal hash-chained e stessa claim-lock POSIX delle ammissioni. Ogni nuova claim aumenta \`generation\`; ticket vecchi o scaduti non possono più rinnovare/rilasciare la lease. \`leaseId\` è riservato al detentore della credenziale e non appare nella GET di piano. Il record è persistente e letto anche dopo riavvio. I task dipendenti restano bloccati: **non esiste ancora un protocollo di completamento verificato**, pertanto una lease non è prova di esecuzione né di test riusciti. BudgetUnits resta una stima riservata, non spesa AI contabilizzata. Non vengono avviati provider AI, Docker, apply o push automatici. [ADR 0064](adr/0064-actor-scoped-fenced-agent-task-leases.md) · [issue #108](https://github.com/KeyserDSoze/SoftwareFactory/issues/108).



## Checkpoint PM AI con approvatore indipendente (#110, 19 novembre 2026)

Nel runner, il registro handoff ora permette di distinguere **la presa in carico di un task** dalla **revisione umana di un documento**. Questa funzionalità è volutamente limitata ai task con ruolo \`project_manager\`. Il producer conserva la propria lease fencing (#108); l'amministratore configura nel file privato \`RUNNER_AGENT_ACTORS_FILE\` anche un **altro** attore, con \`id\` differente, ruolo \`checkpoint_approver\` e lo stesso tenant. Le credenziali root/tenant del runner non sono accettate da questo endpoint e il PM non può approvare il proprio checkpoint.

L'operatore esamina fuori dal runner il documento del PM e ne verifica manualmente il digest SHA-256. Il PM, con la sua Bearer actor-scoped, presenta la **sola impronta** e unità di lavoro autodichiarate:

\`\`\`json
{"action":"submit","handoffId":"UUID-HANDOFF","taskId":"plan",
 "leaseId":"UUID-LEASE","submissionId":"UUIDv4-STABILE",
 "artifactDigest":"64-caratteri-esadecimali-sha256",
 "reportedUnits":2}
\`\`\`

Alla route \`POST /v1/agent-task-checkpoints\` l'approvatore umano invia con la **propria** Bearer scoped il digest del documento effettivamente controllato:

\`\`\`json
{"action":"approve","handoffId":"UUID-HANDOFF","taskId":"plan",
 "submissionId":"LO-STESSO-UUIDv4","artifactDigest":"LO-STESSO-SHA256"}
\`\`\`

Nessun documento, prompt, sorgente o token è salvato nel registro; anche la lettura autenticata \`GET /v1/agent-handoffs/:id\` non espone il \`leaseId\`. Prima dell'approvazione il task appare \`awaiting_human_approval\` con \`evidence:not_started\`, e i dipendenti restano bloccati. Dopo il controllo indipendente appare \`human_approved_checkpoint\` e il successivo handoff di **revisione** può acquisire una lease. **Non viene dichiarato alcun test come \`passed\` e non viene invocato automaticamente alcun agente AI.** Replay identici di submit/approve non duplicano eventi né unità riportate; una lease revocata/scaduta o un ticket di generazione precedente non possono essere approvati.

\`approvedReportedUnits\` è una somma controllata delle **unità autodichiarate e approvate**, limitata da \`estimatedUnits\` per task e dal \`budgetUnits\` del piano. **Non equivale al consumo verificato dei token o agli addebiti del provider AI**. L'API verifica solo che gli attori con scope appropriato abbiano registrato l'approvazione dell'impronta: non può verificare da sola l'esistenza, il contenuto, la qualità del documento né l'identità legale della persona. Le prove tecniche dei Tester, un eventuale billing firmato e l'orchestrazione autonoma restano nella [#109](https://github.com/KeyserDSoze/SoftwareFactory/issues/109) e nella [#105](https://github.com/KeyserDSoze/SoftwareFactory/issues/105). Vedi [ADR 0065](adr/0065-human-approved-pm-digest-checkpoints.md).



## Tester AI: completamento vincolato al journal dei test Docker (#111)

Il coordinatore AI distingue ora tre stati: task **assegnato** (lease temporanea), checkpoint di progetto **approvato manualmente** (#110) e task Tester con **prova di test Docker passata**, ricontrollata dal runner. Non è ancora un Tester AI autonomo: un operatore autorizzato o un adapter supervisionato deve acquisire una lease Tester e preparare e inviare il job di test con il protocollo runner esistente.

Per associare il job a un task di ruolo \`tester\`, inviare con la chiave actor-scoped del Tester:

\`\`\`http
POST /v1/agent-task-verifications
Authorization: Bearer agent.tester-one.<chiave-segreta>
Content-Type: application/json
\`\`\`

\`\`\`json
{
  "handoffId": "UUIDv4-HANDOFF",
  "taskId": "test",
  "leaseId": "UUIDv4-LEASE-ATTIVA",
  "submissionId": "UUIDv4-IDEMPOTENZA",
  "jobId": "UUIDv4-JOB",
  "jobDigest": "sha256-richiesta-64-caratteri",
  "jobHead": "sha256-evidence-64-caratteri",
  "jobCount": 5,
  "step": "dotnet-test"
}
\`\`\`

Il runner ignora qualsiasi dichiarazione di esito dell'attore: confronta \`jobId\`, digest, head/count e step con \`report.json\` ed \`evidence.jsonl\` letti con FD/inode protetti, SHA-chain completa e \`projectVerifiedJobPlan\`. Richiede stato terminale \`passed\`, ogni step realmente passato (senza skipped/timeout), ultimo evento \`finished\`, tenant corretto e job **accettato dopo** la claim del Tester. Uno stesso job non può attestare due task AI distinti. Un job in coda, fallito, incompleto o precedente alla claim non completa nulla.

\`GET /v1/agent-handoffs/:id\` mostra \`runner_verified_test\` con identificativo del job e head dell'evidenza, senza \`leaseId\`. I task downstream diventano assegnabili solo se il journal resta leggibile e valido. Se il job viene eliminato per retention o l'evidenza è alterata, la lettura e la schedulazione falliscono **in modalità fail-closed**, senza mostrare un successo storico non attestato. Le prove sono locali al runner e non costituiscono firma off-host, dimostrazione della qualità del codice, consumo token o completamento di una code review AI. Il ruolo \`code_reviewer\` non può ottenere un completion con la sola suite test. [ADR 0066](adr/0066-tester-completion-from-verified-runner-journal.md), [issue #111](https://github.com/KeyserDSoze/SoftwareFactory/issues/111).


## Osservazioni usage AI (non billing) — #121

La Factory legge, quando forniti dalla risposta reale `/chat/completions`, i token input/output/totali dichiarati dal provider e li mostra **soltanto nella sessione browser** nei log della pipeline e nella sezione Code Agent (generazione, review, repair). I conteggi sono marcati `provider_reported_unverified`: nessuna stima quando mancano dati, nessun prezzo dedotto e nessuna fatturazione certificata. Le chiamate con risposta AI priva di `usage` continuano a funzionare. I contatori non vengono salvati nei progetti, nei backup o in GitHub. Per ricevute provider attestabili e budget consuntivo restano aperte #109/#105.


## Verifica offline di review e sorgenti (#122)

Dopo la submission di un rapporto Code Reviewer, un `review_approver` autorizzato può esportare separatamente il documento custodito e i file esattamente testati dalle API `/v1/agent-review-artifacts/:submissionId` e `/v1/agent-review-sources/:submissionId`. Su un **PC indipendente**, può formare un bundle JSON e firmarlo con `node src/runner/review-attest.mjs sign`. La verifica Ed25519 vincola il testo del rapporto, il digest del record e tutti i byte del file set al public key che l'operatore ha installato come trust anchor. È una firma dell'artefatto presentato, **non prova che il codice sia stato realmente letto** e non sblocca automaticamente task, review o billing. [Istruzioni e rischi](docs/runner.md).


## Code Reviewer AI off-host, con consenso esplicito (#123)

È disponibile l'esecutore opzionale `src/runner/ai-review-execute.mjs`: il Code Reviewer esporta la **snapshot realmente passata ai test** dalla GET actor-only pre-submit (#120), poi può far eseguire a un provider OpenAI-compatible una revisione tramite HTTPS da una macchina esterna, **solo se autorizza esplicitamente l'invio dei file**. La risposta JSON è validata come rapporto strutturato #116 e associata a una ricevuta Ed25519 **firmata dall'operatore** e verificabile offline, non dal provider. Nessun segreto, prompt completo o sorgente è inserito nella ricevuta. Non modifica il DAG né approva la review automaticamente; il proprietario e l'approvatore indipendente continuano a usare i gate esistenti. I token restituiti sono `provider_reported_unverified`, senza importi certi. Vedere [guida runner](docs/runner.md) e ADR 0077.


### Protezione DNS del Code Reviewer off-host (#125)

La CLI con consenso `ai-review-execute` ora risolve il nome del provider **prima di aprire la connessione**, nega tutti gli indirizzi IPv4 special-use/non pubblici (inclusi insiemi misti DNS pubblico/privato) e **fissa un IPv4 validato alla stessa socket TLS** con verifica del certificato sul nome originario. Non segue redirect e non fa un secondo DNS lookup non verificato. Per questa fase richiede che il provider abbia un record A IPv4 pubblico; provider IPv6-only non sono supportati. Non è un certificato dell'identità commerciale del provider né una prova della sua fatturazione: verificare sempre provider/contratto prima di autorizzare il trasferimento di codice. [ADR 0079](adr/0079-public-ipv4-pinned-ai-review-egress.md).


### Gate di completamento della risposta AI Reviewer (#127)

Prima di firmare l'osservazione HTTP, la CLI `ai-review-execute` richiede una sola risposta `choices[0]` da un messaggio `assistant` e `finish_reason: "stop"`, senza rifiuto o chiamata a tool. Anche un JSON valido con `finish_reason:"length"` o `"content_filter"` è rifiutato senza retry. La ricevuta precedente mantiene lo stesso formato ed è solo un'osservazione firmata dall'operatore, non una garanzia del provider o un'approvazione della review. [ADR 0081](adr/0081-ai-review-completion-envelope-gate.md).


### Collegamento verificabile del report AI al deposito Reviewer (#128)

`ai-review-execute.mjs` può ora produrre offline `review-stage.json` direttamente dalla ricevuta Ed25519 operatore dopo verifica con chiave pubblica pinned (`prepare-stage`, `verify-stage`). Quando il Reviewer deposita il JSON attraverso la propria API actor-scoped e un approvatore autorizzato rilegge il rapporto conservato, `verify-stored` confronta identità del task, generation, documento, source fingerprint e digest del record salvato con la ricevuta e gli owner/tenant attesi. Il deposito e la revisione restano **azioni manuali**, senza auto-submit né auto-approval; non c'è una attestazione del provider o del billing. Istruzioni in [docs/runner.md](docs/runner.md), ADR 0082.


### Impegno firmato di deposito Code Reviewer (#129)

Un secondo artefatto Ed25519 `stage-intent`, prodotto *dopo* la scelta degli UUID, firma la relazione tra ricevuta operatore, documento staged, lease e submission. Con una chiave pubblica pinnata indipendentemente, la CLI verifica che la richiesta di deposito e la risposta di custodia corrispondano all'intenzione firmata, senza dover adottare gli UUID da un JSON non firmato. I comandi sono esclusivamente offline e non avviano API, provider, approvazioni o billing. Istruzioni nella [guida runner](docs/runner.md), ADR 0083.


### Verifica di una dichiarazione firmata di consegna AI (#130)

Se il proprio provider offre **esplicitamente** una dichiarazione di consegna compatibile firmata Ed25519, il comando offline `src/runner/provider-delivery-attestation.mjs verify` può confrontarla con la receipt locale del Code Reviewer. Occorre un public key **autenticato dal contratto/provider con un canale indipendente**, non recuperato dall'evidenza da verificare, e conoscere in anticipo provider ID, hostname e fingerprint della chiave. Il verificatore collega gli hash della richiesta/risposta HTTPS e gli usage dichiarati senza contattare il provider né autorizzare automaticamente task o spese. Nessuna API OpenAI-compatible standard fornisce automaticamente questo formato e **non è ancora attestato alcun provider live**. Una firma valida non prova, da sola, esecuzione LLM o fatturazione. Vedi [guida](docs/runner.md) e [ADR 0084](adr/0084-provider-signed-delivery-evidence-contract.md).


### Versione minima dell'installer e nuova prerelease CI-gated (#131)

Il pannello delle Releases nella SPA non propone versioni precedenti a `v0.2.0-rc.2`, che introduce il manifest sorgente e il canary obbligatorio, e seleziona deterministicamente la versione SemVer più alta (priorità alle **stable** quando disponibili, altrimenti alle **RC**). Richiede sempre entrambi gli asset `tar.gz` e `.sha256` con URL GitHub esatti. Il marker `v0.2.0-rc.4` richiede una nuova prerelease automatica **solo dopo Factory CI verde**; l'esistenza effettiva degli asset va verificata nella pagina [Releases](https://github.com/KeyserDSoze/SoftwareFactory/releases). Il checksum non è una firma indipendente; installazione reale rootless/Cloudflare non è attestata dalla CI. [ADR 0085](adr/0085-installer-minimum-version-and-release-rc4.md).


### Gate delle risposte AI incomplete nella Factory browser (#132)

La Factory ora rifiuta risposte HTTP 2xx che dichiarano esplicitamente una generazione `length`, `content_filter`, `tool_calls` o un altro esito diverso da `stop`, nonché risposte multiple, refusals e tool calls nel messaggio. Un testo apparentemente valido non raggiunge la pipeline, Code Agent o il contatore volatile dei token quando il provider dichiara una risposta incompleta. Per compatibilità, i backend OpenAI-compatible che omettono completamente `finish_reason`/`role` continuano a funzionare, **senza che ciò attesti una terminazione normale**. Nessun retry o costo inventato. [ADR 0086](adr/0086-browser-ai-completion-fail-closed.md).


### Protezione contro risposte AI troppo grandi nella SPA (#133)

La Factory legge ora le risposte HTTP dei provider AI con limiti in byte **prima del parsing JSON**: 4 MiB per `/chat/completions`, 512 KiB per `/models`. La verifica applica sia il controllo anticipato di `Content-Length` sia il limite sui byte effettivamente ricevuti attraverso lo stream (anche senza header o quando il provider dichiara una lunghezza sbagliata). Il browser interrompe il flusso su overflow o JSON non valido e non registra il token usage di una risposta rifiutata. Provider con output oltre le soglie richiedono richieste più piccole o un backend esplicitamente progettato per risultati estesi. Questa protezione non autentica il provider né prova consumi fatturabili. [ADR 0087](adr/0087-browser-ai-bounded-response-streams.md).


### Libreria locale resiliente agli aggiornamenti concorrenti di schede diverse (#134)

Se due schede modificano progetti distinti, entrambe possono legittimamente detenere i rispettivi Web Locks. Per evitare che una scrittura tardiva dell'indice condiviso nasconda una voce, il selettore locale ricostruisce ora l'elenco dalle copie per-progetto effettivamente salvate; non considera più l'indice globale l'unica fonte di verità. Inoltre ogni scheda conserva in `sessionStorage` soltanto l'ID del progetto selezionato: dopo un reload non apre inavvertitamente il progetto che un'altra scheda ha attivato. Resta possibile aprire i progetti storici con il vecchio puntatore. Non è una transazione tra dispositivi né un merge automatico; i conflitti di salvataggio continuano a richiedere backup e decisione umana. [ADR 0088](adr/0088-per-tab-local-project-selection-and-library-index-reconstruction.md), #92/#91 ancora aperte.


### Robustezza dei controlli Docker Compose in CI (#135)

I test dello scaffold generato validano sempre la configurazione reale con Docker Compose quando la CLI è presente, e **obbligatoriamente in GitHub Actions**. Il preflight `docker compose version` è ora condiviso tra i due gruppi di test, con un margine di 15 secondi per l'avvio della CLI sugli host GitHub; tutti i comandi `docker compose config` rimangono eseguiti per ciascuna configurazione generata, senza retry automatici e senza salti/false green. Un timeout produce diagnostica delimitata che non include il file Compose completo o segreti. [ADR 0089](adr/0089-docker-compose-cli-preflight-isolation.md). La variabilità dell'host CI non sostituisce l'acceptance su VM Docker rootless.


### Protezione contro il cambio su copie obsolete della libreria locale (#136)

Quando apri un altro progetto dalla libreria, la Factory registra la **versione esatta prima di chiederti conferma**. Dopo aver ottenuto il lock esclusivo verifica che nessun'altra scheda abbia modificato quel progetto durante il messaggio di conferma; lo rilegge prima di applicarlo e blocca il passaggio in caso di conflitto. La stessa verifica prima/dopo l'attesa del lock è applicata ai cambi ID dovuti a import GitHub e restore cloud. La copia aggiornata non viene sovrascritta silenziosamente: torna al progetto precedente e richiede una nuova scelta umana. Rimangono necessari Web Locks, backup e guard della snapshot. [ADR 0090](adr/0090-local-project-switch-pre-consent-snapshot-fencing.md). Non equivale a CAS globale fra dispositivi.


### Salvataggi locali leggibili e recuperabili sotto quota (#137)

SoftwareFactory ora impedisce di salvare come riuscito uno snapshot locale che non potrebbe riaprire: controlla prima della scrittura la struttura essenziale e il limite di **1.000.000 caratteri JSON** usato dal lettore. Se il progetto supera la soglia, l'editor blocca il checkpoint prima di sovrascrivere la versione salvata; è necessario ridurre gli artefatti e conservare un backup JSON. Dopo ogni scrittura, verifica che la **copia per-progetto** sia realmente rileggibile e identica. Un errore di quota sulla copia autorevole fa fallire il salvataggio; un errore sui due **metadati ricostruibili** (indice o puntatore globale) non fa più segnalare come fallita una copia già confermata. La selezione per scheda viene comunque tentata, e la libreria rimane il percorso di recupero. Sono controlli locali, non una transazione IndexedDB o una garanzia multi-device. [ADR 0091](adr/0091-local-project-reopenability-and-cache-failure.md).


### Fondazione CAS IndexedDB per futuri salvataggi transazionali (#138)

È disponibile un nuovo modulo **separato** `project-cas.ts` che esegue compare-and-swap all'interno di una singola transazione `readwrite` IndexedDB: una sola delle due schede che tenta di creare o aggiornare la stessa revisione può vincere. I dati vengono limitati a **1.000.000 caratteri JSON**, si rifiutano versioni obsolete o record corrotti, e le cancellazioni producono una revisione tombstone per evitare di riutilizzare un vecchio token dopo ricreazione. In assenza di IndexedDB non viene effettuato un falso salvataggio di ripiego su localStorage. La primitiva viene collaudata in Chromium reale, nello smoke Docker senza rete. **L'editor corrente continua tuttavia a usare localStorage e Web Locks:** questo incremento non migra i progetti esistenti e non protegge ancora le scritture del percorso principale. Migrazione esplicita, integrazione asincrona dei salvataggi e verifiche cross-device restano nella [#92](https://github.com/KeyserDSoze/SoftwareFactory/issues/92) e [#91](https://github.com/KeyserDSoze/SoftwareFactory/issues/91). [ADR 0092](adr/0092-indexeddb-project-cas-primitive.md).


## Preparazione libreria IndexedDB in sola lettura (#140, verso #139)

La nuova API listCasProjects legge in una singola transazione readonly i progetti CAS e ne mostra soltanto id, nome, aggiornamento, destinazione GitHub e revisione; esclude tombstone, rifiuta dati corrotti e non nasconde un eventuale 41esimo progetto. La CI include prove Chromium reali su due schede, reload, corruzione e superamento del limite. Non scrive o cancella dati.

**Solo prerequisito infrastrutturale**: il live editor e la libreria visibile restano su localStorage. Non esiste ancora migrazione automatica, backup implicito, CAS multi-device o cutover a salvataggi asincroni. La #139 e le #91/#92 rimangono aperte.


## Copia volontaria legacy in IndexedDB (#141, anteprima)

Nella libreria dei progetti il comando bilingue Copia in IndexedDB (anteprima) esporta il JSON esatto del progetto locale corrente. Richiede una conferma di download e una conferma separata che il file sia stato effettivamente salvato; poi esegue un inserimento IndexedDB never-seen con transazione, verifica le collisioni (anche tombstone), tutte le righe e il limite di 40 progetti. Se il progetto legacy cambia prima o durante la copia, viene segnalato un conflitto; una copia CAS già inserita potrebbe essere obsoleta e va verificata manualmente. Non viene cancellato alcun dato e non esiste fallback a localStorage per i fallimenti IndexedDB.

**L'editor continua a scrivere su localStorage**, anche dopo la copia; non è un passaggio automatico a IndexedDB, una garanzia multi-device o un backup cloud. Il click di conferma non prova che il backup sia fisicamente presente su disco. Conserva il file JSON fuori dal browser. La Factory CI verifica il file scaricato in Chromium, il consenso, la non modifica del progetto e race su due schede; ADR 0094. #139, #92 e #91 rimangono aperte per il vero cutover asincrono e i collaudi provider.


## Riconciliazione read-only delle copie locali (#142; ADR 0095)

Nel pannello dei progetti è possibile utilizzare **Confronta copia IndexedDB (sola lettura)** (IT/EN). La verifica legge il raw JSON legacy e la riga IndexedDB due volte, distingue copia assente, tombstone, identica e divergente, e rifiuta fonti modificate durante la lettura. In caso di divergenza l'utente può autorizzare il download di un **JSON IndexedDB storico**: la revisione e il raw vengono ricontrollati prima della creazione del file. Nessun merge, recupero automatico, cancellazione o push viene effettuato.

Il confronto è una fotografia puntuale, **non** una transazione atomica tra localStorage e IndexedDB. Una scheda può modificare una fonte subito dopo la verifica. Il download non prova la persistenza fisica del file. Il live editor continua a usare localStorage; la #139 deve ancora convertire i write-path async end-to-end e selezione/reload autorevoli. #91/#92 ancora aperte.


## Sessione editor CAS asincrona (solo infrastruttura, #143)

Il modulo `src/frontend/src/infrastructure/project-cas-editor-session.ts` prepara il futuro cutover dell'editor a IndexedDB (#139). `openCasEditorSession(id)` accetta esclusivamente progetti IndexedDB già esistenti con JSON canonico; non importa, crea, ripristina né resuscita progetti eliminati. `commit(project, expectedSnapshot)` richiede un token **id + revision + raw** esatto, rifiuta scritture simultanee, valida la destinazione e invoca la vera transazione `compareAndSwapCasProject`. Il token interno passa alla revisione successiva **solo dopo** il `tx.oncomplete` della primitiva CAS. Un fallimento o una conferma ambigua blocca la sessione e impone un'ispezione e riapertura esplicite, senza fallback o retry sul vecchio token.

**Non è ancora attiva nel live editor**: `App.tsx`, pipeline, Code Agent, ACK GitHub, import/export e restore continuano a usare localStorage. Abilitare uno solo di questi writer a CAS lascerebbe un sistema ibrido potenzialmente distruttivo. La #139 resta aperta finché tutti i writer, switch, bootstrap, reload e recovery non condividono la stessa fonte asincrona; non è sync cloud/multi-device (#91/#92). ADR 0096 e gate Chromium `FACTORY_INDEXEDDB_ASYNC_EDITOR_E2E_PASS` con due schede, writer CAS non cooperativo, aggiornamento token, rifiuto di doppio click, reload, delete/tombstone e zero scritture legacy.


## Selezione progetti IndexedDB con ticket di revisione (infrastruttura, #144)

Il componente `src/frontend/src/infrastructure/project-cas-selection.ts` prepara il futuro cambio di progetto sull'archivio IndexedDB (#139). Non viene ancora usato dall'editor React attuale. `openCasSelectionController(id)` crea un controller che racchiude l'unica sessione CAS scrivibile, espone token `id/revision/raw`, e permette la lista read-only delle copie IndexedDB. `prepareSwitch(targetId)` cattura la fotografia *prima* del consenso umano (origine, destinazione, generazione del controller); `confirmSwitch(ticket)` riapre e verifica **esattamente** l'ID, revisione e JSON della destinazione **dopo** il consenso. Se una scheda modifica la destinazione nel frattempo, la selezione viene annullata e il progetto precedente resta attivo nel controller, senza scrivere in alcun archivio.

`commit(next, expected)` rifiuta token obsoleti e avvia una sola operazione alla volta: niente cambio progetto durante un salvataggio, né salvataggi durante uno switch. Dopo un commit la generazione cambia e tutti i precedenti ticket di selezione diventano inutilizzabili. Se il CAS del writer fallisce, il controller viene bloccato fino a riapertura esplicita. L'API **non** modifica localStorage, non completa un cutover, non importa automaticamente progetti e non è un CAS multi-device. La SPA live continua a usare il proprio codice legacy; passaggio atomico coordinato di tutti i write-path, reload/switch, UI consent/recovery e rollback restano nella #139. ADR 0097; smoke Chromium `FACTORY_INDEXEDDB_SELECTION_E2E_PASS` con due schede, target modificato dopo il ticket, switch bloccato durante commit, tombstone e reload.


## Libreria di recupero IndexedDB indipendente dal legacy (#145, ADR 0098)

Nel pannello dei progetti locali è disponibile **Mostra copie IndexedDB recuperabili** (IT/EN), un elenco **solo in lettura** delle copie salvate in IndexedDB, incluse quelle il cui slot `localStorage` legacy è stato perso o corrotto. Non serve aprire il progetto per recuperarne lo storico: per ogni copia è possibile autorizzare un download JSON che preserva i byte esatti del raw originale (brief e checkpoint AI inclusi). Il download non importa il JSON e non cambia il progetto selezionato, la libreria legacy, la copia IndexedDB, i segreti di sessione o GitHub.

Per evitare un file stale, l'operazione verifica la revisione vista nell'elenco, prepara **prima del consenso** un ticket completo di ID/revisione/JSON esatto e dopo il consenso rilegge IndexedDB due volte. Anche se un writer non cooperativo modifica il raw **senza incrementare** la revisione, la differenza viene rifiutata. Corruzione, tombstone, archivio oltre 40 progetti o IndexedDB non disponibile interrompono la verifica senza ricostruzioni automatiche. La libreria va aggiornata volontariamente per avere una vista recente.

**Limiti:** gli elenchi/controlli sono fotografie non bloccanti; un writer può agire immediatamente dopo il confronto. Non esiste transazione con `localStorage`. Un download avviato non prova che il file sia stato salvato sul disco. Il JSON storico può includere dati progettuali sensibili e va protetto. L'editor attuale resta su `localStorage`; la #139 deve ancora convertire tutti i write path, i checkpoint GitHub e la selezione/reload in modo coerente. Non c'è restore automatico né sync multi-device (#91/#92). Test Chromium: `FACTORY_INDEXEDDB_ORPHAN_RECOVERY_E2E_PASS`.


## Lifecycle IndexedDB: cancellazione e ripristino tombstone (solo infrastruttura #146)

Per il futuro editor IndexedDB, `project-cas-selection.ts` supporta ora `delete(expected, consent)` quando la sessione è pronta: esige il token esatto (ID, revisione e JSON), consenso esplicito, impedisce switch/salvataggi durante la cancellazione e conferma soltanto dopo il `tx.oncomplete` della transazione di `deleteCasProject`. Il controller diventa **bloccato** dopo la cancellazione, e anche dopo un ack di cancellazione ambiguo: mai continuare a scrivere sul token precedente.

`project-cas-lifecycle.ts` aggiunge `prepareCasTombstoneRestore(id, backedUpRaw)` (solo lettura) e `confirmCasTombstoneRestore(ticket, true)` (consenso separato), che verificano backup JSON **byte-esatto e canonico**, identità del progetto e revisione della tombstone. `restoreCasTombstoneProject` opera in **un'unica transazione readwrite IndexedDB**, confronta la stessa revisione della tombstone, conta fino a 40 progetti attivi, ripristina i byte originali e incrementa la revisione solo dopo commit. Se nel frattempo un'altra scheda ha ricreato il progetto o la libreria è piena, l'operazione abortisce e non sovrascrive nulla. I backup possono contenere brief e checkpoint AI: non sono prove attuali di test né autorizzazioni a pubblicare.

**Confini**: la primitiva CAS `compareAndSwapCasProject(project,null)` dalla #147 **non può più ricreare tombstone** e ammette soltanto ID mai visti; un restore di tombstone richiede backup, revisione e consenso #146. Il percorso specifico #146 è l'unico previsto per la futura UX di restore con backup+consenso; non è attualmente collegato all'editor React, che continua a usare localStorage. Non c'è UI automatica di cancellazione/ripristino, né cambio del source of truth, né sync cloud/multi-device. La #139 resta aperta. ADR 0099; Chromium `FACTORY_INDEXEDDB_TOMBSTONE_RESTORE_E2E_PASS` verifica race a due schede, revision ABA, cap 40 e nessuna modifica legacy.


## CAS insert sicuro e protezione delle tombstone (#147)

`compareAndSwapCasProject(project,null)` ora crea **solo progetti con ID mai visto**: anche una tombstone è un record esistente e genera conflitto, senza modificare i dati. La creazione valida tutte le righe e controlla il limite di 40 progetti attivi **nella stessa transazione readwrite IndexedDB**. Un aggiornamento a un progetto già presente con `id/revision/raw` esatto è ancora consentito a capacità massima. Per ripristinare un eliminato serve solo la procedura #146 con backup JSON canonico, consenso e revisione della tombstone; non esiste restore implicito. La SPA live rimane su `localStorage` fino alla #139. ADR 0100 e gate Chromium `FACTORY_INDEXEDDB_STRICT_INSERT_E2E_PASS`.


## Ripristino manuale di progetti IndexedDB eliminati dalla SPA (#148, ADR 0101)

Nel pannello progetti locali è disponibile **Ripristina progetto IndexedDB eliminato da backup JSON** (IT/EN). L'operatore sceglie un file già salvato: il progetto JSON grezzo proveniente da esportazione IDB o dal backup legacy, oppure un backup envelope `softwarefactory-local-recovery` schemaVersion 1 già esportato dalla Factory. Il controllo dimensionale massimo di 1,5 MB avviene **prima** di leggere il file. La struttura JSON e l'identità del progetto sono verificate e normalizzate dal serializer CAS; il testo non viene mostrato in log o inviato a servizi esterni.

Prima della conferma, la SPA verifica **solo IndexedDB** e prepara un ticket della tombstone contenente ID, revisione e JSON canonico. Il popup di consenso mostra nome, ID e revisione, chiarendo che il file può contenere vecchie evidenze AI e brief sensibili; annullare non scrive nulla. Dopo il consenso, `confirmCasTombstoneRestore` rilegge la tombstone e `restoreCasTombstoneProject` esegue la transazione IndexedDB con capienza massima di 40 progetti attivi e ACK soltanto a `tx.oncomplete`. Una seconda scheda può aver ripristinato nel frattempo: il ticket obsoleto **fallisce senza retry né overwrite**.

**Importante:** il ripristino scrive **esclusivamente nello storico IndexedDB**; non apre, cambia o rimpiazza il progetto attivo nell'editor React basato su `localStorage`, non effettua restore cloud, push GitHub né riapprova test o review. La lista di backup IndexedDB è invalidata dopo il tentativo e deve essere aggiornata manualmente. Un backup envelope viene trasformato nel JSON canonico del *progetto*, non salvato come envelope; la conferma riguarda i dati del progetto indicato. I backup da conservare in sicurezza possono contenere checkpoint e output storici. La migrazione completa di tutti i writer resta sulla #139; #91/#92 restano aperte. Test Chromium: `FACTORY_INDEXEDDB_UI_TOMBSTONE_RESTORE_E2E_PASS`.


## Editor IndexedDB isolato (anteprima opt-in, #149)

Nel pannello **LOCAL / PROJECTS** è disponibile il nuovo riquadro **Editor IndexedDB isolato — anteprima** (IT/EN). È il primo percorso di modifica React che salva *davvero* un progetto con la sessione CAS transazionale IndexedDB, e rimane volutamente un **editor separato**: non sostituisce il progetto attivo, le chiamate `changeProject`/`persistProjectIfUnchanged` dell'editor principale o la pipeline/Code Agent/GitHub. Un IDB snapshot storico può divergere dalla copia localStorage; non assume equivalenza né sincronizzazione fra le due.

1. Apri intenzionalmente il pannello e ricarica la libreria **IndexedDB**. L'apertura iniziale verifica una revisione prima del consenso e verifica nuovamente **ID, revisione e raw** dopo il consenso. Il cambio fra due copie usa `prepareSwitch`/`confirmSwitch`, che rifiuta destinazioni cambiate e non perde bozze in silenzio. L'elenco non apre automaticamente alcuna copia.
2. Modifica **soltanto nome e descrizione**. Prima di un commit, il generatore puro `buildCasIsolatedConfigEdit` valida i limiti (nome 120, descrizione 8.000 caratteri), costruisce un nuovo `FactoryProject` dalla revisione **esatta** attesa e invalida i checkpoint e le fonti delle fasi AI dello snapshot IndexedDB. Non interpreta vecchi report runner o ricevute GitHub come test ancora validi.
3. Il commit richiede due consensi distinti: scaricare un JSON **byte-esatto pre-modifica** (ID e revisione nel nome file), poi confermare di aver effettivamente salvato il file sul dispositivo. Solo allora `CasSelectionController.commit` fa il compare-and-swap nativo; il form aggiorna revisione e contenuto soltanto dopo `tx.oncomplete`. **Quota, conflitto, tombstone, writer non cooperativo o ACK ambiguo bloccano** la sessione e richiedono una nuova selezione esplicita dopo verifica. Nessun retry, merge, overwrite automatico o fallback localStorage.

La libreria e l'editor IndexedDB sono **infrastruttura di prova isolata e una funzione facoltativa**, non il cutover #139: il workspace Factory principale continua a funzionare da localStorage, e le modifiche IDB **non entrano** nella generazione ZIP, pipeline, GitHub o backup cloud live. I backup possono contenere brief e output sensibili. Il cutover generale di tutti i writer deve essere atomico e verificato separatamente. ADR 0102, marker Chromium `FACTORY_INDEXEDDB_ISOLATED_EDITOR_E2E_PASS`.


## Creazione nativa di progetti solo IndexedDB (#150, ADR 0103)

Nel pannello sperimentale **Editor IndexedDB isolato** è possibile creare un progetto **nuovo** direttamente nell'archivio IndexedDB, senza prima creare o migrare un progetto dell'editor live. La nuova schermata IT/EN chiede nome (massimo 120 caratteri) e brief (massimo 8.000), costruisce un progetto Factory completo con un **UUID fresco**, configurazione iniziale e sei fasi **pending senza output o prove AI/GitHub**, e mostra nome e ID in un consenso esplicito di creazione. Annullare il consenso non tocca gli archivi.

Il modulo `application/cas-isolated-create.ts` prepara un ticket **canonico e immutabile** e, soltanto dopo conferma, chiama `compareAndSwapCasProject(project,null)`: è una transazione nativa **insert-only per ID mai visto**, serializzata anche contro schede non cooperative, con controllo della capienza massima di 40 progetti attivi e record corrotti nella stessa transazione. Una collisione con un altro tab, ID già presente o tombstone, quota esaurita e IndexedDB indisponibile interrompono la creazione senza fallback su `localStorage` e **senza retry automatico con un nuovo UUID**: un ACK perso potrebbe aver già eseguito l'insert. La UI mostra il risultato soltanto dopo l'ACK `tx.oncomplete`, rilegge la stessa revisione/raw e aggiorna l'elenco; **non apre automaticamente** il progetto nell'editor isolato: la selezione successiva richiede il proprio consenso.

Il processo non copia impostazioni private, PAT, cloud, repository GitHub, checkpoint storici, runner né evidence. Nessun progetto live viene selezionato o modificato. Chi ha già un progetto IDB aperto nel pilota deve abbandonare esplicitamente la selezione prima di crearne uno nuovo, proteggendo anche eventuali bozze non salvate. Le due librerie **non sono sincronizzate** e l'editor principale resta su `localStorage` fino al cutover coordinato della #139. Test Chromium `FACTORY_INDEXEDDB_NATIVE_CREATE_UI_E2E_PASS`; ADR 0103. #91/#92 non sono completate.


## Eliminazione protetta delle copie IndexedDB dal pilota (#151, ADR 0104)

Nell'**Editor IndexedDB isolato** puoi eliminare una copia selezionata, senza eliminare né cambiare il progetto aperto nella Factory principale `localStorage`. Per evitare perdite accidentali l'azione è disabilitata se nome/descrizione hanno bozze non salvate oppure se la sessione CAS è bloccata. Non avviene alcuna cancellazione automatica quando si cambia scheda o progetto.

La procedura richiede **tre conferme distinte**: (1) autorizzazione a scaricare un **backup JSON byte-esatto** dello snapshot IDB con ID e revisione nel nome file, inclusi eventuali checkpoint storici; (2) dichiarazione esplicita di aver realmente salvato il file; (3) consenso distruttivo finale che mostra nome, ID e revisione esatta. Negare una qualsiasi conferma non modifica lo store. Il download non è considerato prova di scrittura su disco: conservare e verificare manualmente il file.

Solo dopo la terza conferma il componente chiama `CasSelectionController.delete(expected,true)` (API introdotta in #146): la transazione native CAS verifica ID, revisione e JSON raw, crea la tombstone con `revision+1` e riconosce successo **solo su `tx.oncomplete`**. In caso di conflitto tra tab, write concorrente, errore quota o ACK incerto, il token viene bloccato senza retry, merge o fallback legacy; è obbligatoria una nuova ispezione prima di proseguire. Dopo la tombstone confermata la selezione viene invalidata e si rilegge l'elenco IDB; errori di lettura dell'elenco non annullano una cancellazione già attestata.

Le tombstone non si ripristinano tramite una nuova creazione: il ripristino richiede il backup JSON e un **nuovo consenso esplicito** nella funzione *Ripristina progetto IndexedDB eliminato da backup JSON* della libreria locale (#148). Il recupero è IDB-only e non rimette automaticamente lo snapshot nell'editor attivo. I backup possono contenere brief/output sensibili ed evidenze AI/test solo storiche. #139 rimane aperta per la migrazione completa degli editor e dei writer live; #91/#92 ancora aperte. Test Chromium `FACTORY_INDEXEDDB_ISOLATED_DELETE_UI_E2E_PASS`.


## Editing requirements in the isolated IndexedDB pilot (#152)

The explicit IndexedDB-only editor can now change project requirements alongside name and brief, within a 12,000-character bound. It uses the same canonical revision ticket, byte-exact pre-edit JSON download, two operator acknowledgements and transaction-complete CAS; any edit invalidates stale pipeline stages. Deletion is blocked if requirements are unsaved. Chromium exercises the real SPA, two competing tabs, exact JSON backups, and verifies that localStorage remains untouched. **This is not the active Factory editor**: pipeline, Code Agent, GitHub push, import and cloud restore still use the legacy live path until the coordinated #139 cutover; neither cross-device nor cloud CAS is implied.


## Creazione IndexedDB: ACK di scrittura distinto dal readback (#153)

Nel pilota IDB separato, una `create` nativa confermata con `tx.oncomplete` non viene mai riportata come "non confermata" se un successivo readback o refresh dell'elenco fallisce. La UI svuota il modulo, mantiene ID/revisione e mostra un avviso IT/EN per verificare manualmente la libreria **senza creare un altro UUID**. Solo ID+revisione+JSON byte-esatto autorizzano l'esito `verificato`; i writer concorrenti non vengono automaticamente adottati. Nessun retry, localStorage fallback o switch live. Chromium simula un'interruzione del readback **dopo** il commit e controlla l'unicità del record e la recuperabilità. Ciò non completa il cutover #139 né il sync multi-device #91/#92.


## Protezione bozze del pilota IndexedDB (#154)

Il pannello CAS separato richiede conferma IT/EN per **chiudere con modifiche non salvate** a nome, descrizione o requisiti. Il refresh di una sessione pronta conserva sempre la bozza; dopo un conflitto che rende la sessione non più scrivibile, il refresh che la cancellerebbe richiede consenso esplicito. Annullando, il testo resta in memoria per copia manuale; confermando, viene abbandonata solo la bozza locale e si deve riaprire manualmente la revisione attuale. Nessuna correzione automatica del conflitto, nessun retry e nessuna mutazione del live editor localStorage. Il pilota non equivale al cutover #139 né al sync multi-device #91/#92.


## Reset selettivo dei checkpoint nel pilota IndexedDB (#155)

Il pannello di editing CAS opt-in permette di scegliere una fase (`features`, `competitors`, `technical`, `architecture`, `adversarial`, `implementation`) e **azzerare quella e tutte le successive**, mantenendo esattamente i checkpoint precedenti. Prima di ogni commit scarica il JSON **raw** pre-reset, richiede la conferma di averlo conservato e un consenso distruttivo distinto; la transazione IndexedDB compare ID/revisione/JSON, fallisce su conflitti tra schede e conferma solo a `tx.oncomplete`. Bozze config sporche e reset inutili vengono bloccati. Questa funzione non esegue la pipeline e non crea attestazioni AI, test o review: serve solo a invalidare output locali. L'editor live localStorage resta separato finché non è completo il cutover #139; #91/#92 sono indipendenti e aperte.


## Contratto asincrono per stage CAS in preparazione al cutover (#156)

A fianco del pilota IndexedDB è ora disponibile **solo come API interna**, non ancora collegata al workspace attivo, la sessione \`openCasPipelineSession(id)\`. \`begin(stage)\` salva \`running\` nel CAS nativo e restituisce un token ID/revisione/JSON **dopo** la transazione; \`complete(token, output, sources)\`, \`abort(token)\` e \`fail(token, kind)\` possono scrivere soltanto con quel token, bloccando i risultati AI tardivi dopo conflitti o un abort. Lo stato \`running\` lasciato da crash/reload non diventa automaticamente \`complete\`: è necessaria una verifica e una procedura di recupero esplicita. Nessuna attestazione di test/review viene creata da questa API. La Factory principale resta su \`localStorage\` finché anche config, Code Agent, GitHub, import/cloud, switch e cleanup non saranno convertiti insieme (#139).

## Esecuzione AI nel pannello IndexedDB opt-in (#157)

Il pannello CAS separato consente di eseguire **una fase AI alla volta** direttamente sulla copia IndexedDB selezionata, usando il modello già configurato nelle Impostazioni e le chiavi **solo in sessione**. Prima dell'avvio richiede: (1) download del backup JSON raw byte-esatto, (2) conferma del salvataggio, (3) consenso esplicito all'invio del contesto al provider AI ed eventuali query al gateway ricerca, che possono comportare costi. L'avvio della fase è confermato da una transazione IndexedDB `running` prima della chiamata HTTP; la risposta viene salvata solo con ticket CAS id/revisione/raw ancora valido. Il pulsante Annulla interrompe il provider e tenta il reset a `pending` tramite un'ulteriore transazione CAS; i fallimenti si registrano con testo sanitizzato. Se un'altra scheda scrive o la lettura post-ACK non è verificabile, **non avviene alcun retry o rebase automatico**: è necessaria verifica/riapertura manuale. La fase `running` rimasta dopo crash non è considerata completata e può essere recuperata con il reset selettivo previo backup. Il risultato AI è un checkpoint **non** una prova di test/Code Review/approvazione. Il workspace principale `App.tsx` resta legacy fino al cutover coordinato #139; #91/#92 aperte.


## Ispezione read-only dei checkpoint nel pannello IndexedDB (#158)

Il pilota CAS ora mostra **tutte e sei le fasi** della copia IndexedDB selezionata, insieme allo stato salvato e a un'anteprima **solo testo** dell'output AI. Le fonti esterne sono dati non attendibili: soltanto URL HTTPS senza credenziali sono link cliccabili (nuova scheda con `noopener noreferrer nofollow`), mentre schemi HTTP, `javascript:`, `data:` e credenziali sono resi inerti. Anteprime di output e citazioni sono limitate; per il JSON completo occorre il backup raw esatto. Uno stage `complete` senza output, o una fase `running/pending` con evidence incoerente, è segnalato come **non verificato**, mai come test passato. La UI non mostra raw error potenzialmente sensibili del provider.

Se dopo crash/refresh è presente uno stage `running`, non viene ripreso né completato automaticamente: l'operatore può usare il reset selettivo già presente nel pannello (#155), dopo il backup JSON e tre consensi, per rimettere quella fase e le successive in `pending`. La vista resta ancorata all'ID/revisione/raw aperti; una tab rivale non sostituisce silenziosamente il contenuto visualizzato. Si rilegge solo su riapertura esplicita. Questo non cambia il workspace live `localStorage`: il cutover #139 e la sincronizzazione #91/#92 restano incompleti.


## Backup JSON completo di una revisione IndexedDB selezionata (#159)

Nel pannello CAS separato ora è possibile **esportare il JSON completo byte-esatto** del progetto IndexedDB aperto senza modificare configurazione, checkpoint o stato della Factory live. Il pulsante funziona anche con una bozza di configurazione non salvata: il backup contiene **la revisione già persistita** e non la bozza, che rimane nell'editor. Prima del download chiede consenso, poi confronta più volte l'ID, la revisione e il raw direttamente su IndexedDB; una copia rimossa, una tombstone o una modifica di un'altra scheda blocca l'esportazione, senza retry/rebase. Dopo l'avvio del download chiede separatamente all'utente se il file è **davvero stato salvato**, distinguendo il semplice tentativo di download da un backup conservato. Il nome file deriva solo da ID/revisione validi; nessuna chiave API o PAT viene caricata da sessionStorage o trasferita. Il file può contenere brief, output AI, fonti e codice riservati: custodiscilo adeguatamente. Il backup è un'osservazione locale, non sincronizzazione cloud o prova di test, e non sposta l'editor principale da localStorage a IndexedDB (#139).


## Errori IndexedDB nel pilota CAS: quota, versione e storage negato (#160)

La UI del pannello CAS opt-in distingue ora **quota esaurita**, **schema IndexedDB più recente/incompatibile**, **database bloccato da un'altra scheda** e **IndexedDB disabilitato/indisponibile** dagli altri conflitti. I dettagli grezzi delle eccezioni native, i segreti e i dati provider non vengono mostrati. In caso di quota durante un salvataggio, la transazione è abortita, la sessione è bloccata e la **bozza rimane disponibile senza essere segnata salvata**; non viene effettuato alcun retry, merge o fallback a localStorage. L'operatore deve verificare permessi/spazio browser, eventuali backup JSON e riaprire esplicitamente la copia IndexedDB. Se un'altra versione dell'app ha aggiornato lo schema, non cancellare né ricreare il database per tentare di tornare alla versione precedente: utilizzare una versione compatibile dell'app e custodire i backup. Il collaudo Chromium include un guasto di quota *iniettato sulla chiamata nativa* (non esaurimento fisico del disco), un vero aumento dello schema DB in un profilo effimero e un browser con IndexedDB reso indisponibile; marker `FACTORY_INDEXEDDB_STORAGE_FAULT_E2E_PASS`. Il live editor rimane su localStorage finché tutti i percorsi non saranno migrati insieme (#139).


## Checkpoint di fase manuali nel pilota IndexedDB (#161)

Il pannello **CAS isolato** consente ora di scrivere o correggere manualmente l'output di una delle sei fasi. Non viene chiamato alcun provider AI, runner o servizio remoto. Occorre che tutte le fasi precedenti siano complete e non vi siano fasi `running`. Il testo umano, non vuoto e al massimo 60.000 caratteri, diventa un checkpoint `complete` con **`completionOrigin: "manual"`**: tutte le fasi successive tornano `pending`, senza output/fonti/errore o attestazioni obsolete. Una correzione di un checkpoint già completo è ammessa; un no-op è rifiutato. Prima dell'unica transazione CAS sono obbligatori download del JSON **byte-esatto** pre-modifica, conferma umana di file salvato e consenso finale alla sostituzione e invalidazione; un writer di un'altra scheda che vince fa fallire la scrittura, senza rebase, retry o perdita del testo non salvato. La selezione della revisione corrente cambia soltanto dopo `tx.oncomplete`. Il progetto Factory live in `localStorage` resta intatto.

Per distinguere le origini senza falsi positivi, i nuovi risultati AI salvati dal pilota sono marcati `completionOrigin: "ai"`, i checkpoint umani `"manual"`, quelli storici senza attributo **`unknown`**. La vista legge questa informazione come descrizione del percorso di scrittura locale, **mai** prova di test eseguiti, review indipendente, approvazione o billing. Il reset e le invalidazioni rimuovono le vecchie etichette. Gli eventuali receipt di GitHub e gli artefatti di sviluppo preesistenti restano storici, non prove sul nuovo testo; confrontarli esplicitamente prima di riutilizzarli. E2E Chromium a due tab `FACTORY_INDEXEDDB_MANUAL_STAGE_UI_E2E_PASS` e test unitari verificano backup, provenienza, invalidazioni, modifica rivale, riapertura e assenza di scritture legacy. Non è ancora il cutover della Factory live (#139).


## Proposta di patch Code Agent in pending nel pilota CAS IndexedDB (#162)

Il pannello **IndexedDB isolato**, separato dalla Factory live, accetta ora una descrizione di feature e un **JSON di proposta Code Agent** incollato dall'operatore. La validazione riutilizza il codice di dominio `validateProposal`/`setPending`: percorsi sorgente consentiti, 1–8 file a sostituzione completa, limiti su file e payload, conflitti con scaffold, `development.revision`, proposta `pending` già esistente e ricerca di credenziali anche nel testo della richiesta e nei metadati JSON. Nessun provider AI, Code Reviewer, runner, test, approvazione, applicazione delle modifiche, GitHub push o cloud viene chiamato. Il risultato è **esclusivamente `development.pending` non approvato**. La vista della proposta pending è in testo semplice, con sommario e conteggio file bounded; l'eventuale `lastRunnerEvidence` di altre patch resta dato storico, non prova della nuova proposta.

Dopo preflight l'operatore conferma **tre passaggi**: download del backup JSON **byte-esatto** della revisione selezionata, dichiarazione di aver conservato il file, e consenso finale a salvare il solo pending. Solo allora `CasSelectionController.commit(candidate,expected)` esegue una vera transazione IndexedDB CAS con token ID/rev/raw; un'altra scheda che modifica il raw durante il consenso impedisce il commit senza merge, retry o falsa review. La richiesta e il JSON rimangono bozze protette sui tentativi falliti; le operazioni close/discard/refresh/switch sono interbloccate dal consenso di scarto e l'aggiornamento della libreria non perde bozze se IndexedDB è indisponibile. La conferma del salvataggio locale avviene solo dopo `tx.oncomplete`, non dopo il click. Chromium E2E `FACTORY_INDEXEDDB_CODE_PROPOSAL_UI_E2E_PASS` e Vitest verificano consensi, bytes, race, reload e zero modifiche al workspace principale. Questa funzione **non** trasferisce CodeAgentPanel live da `localStorage` a IndexedDB e non risolve il cutover #139 o i protocolli provider/#91/#92.

## Scarto controllato del pending Code Agent nel pilota IndexedDB (#163)

Nel pannello CAS opt-in è possibile scartare **solo** una proposta pending non revisionata con tre consensi (download JSON raw byte-esatto, conferma file salvato, ultima conferma distruttiva con ID/revisione). Il native IndexedDB CAS rifiuta un writer concorrente, senza retry né localStorage fallback. Stage, cronologia patch applicate, ricevute runner e GitHub restano storici e intatti: nessuna review/test viene creata e la Factory live rimane sul legacy. #139/#91/#92/#109/#113 rimangono aperte.

## Anteprima sorgenti Code Agent nel pilota IndexedDB (#164 / ADR 0117)

La copia IndexedDB opt-in ora mostra una vista **read-only** dei file della proposta Code Agent pending (path, motivazione, contenuto precedente/proposto), come testo inerte e troncato a 1.600 caratteri per lato. Il confronto ricostruisce la baseline corrente di scaffold e override già applicati: se `edit.previous` non corrisponde esattamente ai sorgenti, l'anteprima viene bloccata senza correggere o sovrascrivere alcun dato. La vista resta fissata all'ID/revisione selezionata anche quando un'altra scheda scrive; nessuna nuova versione viene adottata senza riapertura esplicita. **Non** significa review, test, approvazione, apply, runner o pubblicazione. L'editor live continua su localStorage finché tutti i writer non saranno migrati insieme (#139). #91/#92 e #109/#113 restano aperte.

## ZIP nativo dei sorgenti nel pilota IndexedDB (#165 / ADR 0118)

Ora il pannello CAS opt-in può scaricare un **ZIP dei sorgenti** generati dalla copia IndexedDB selezionata senza usare il progetto live localStorage. Include scaffold deterministico e override già applicati, ma **esclude ogni Code Agent pending non revisionato**. Ricontrolla con letture native ID/revisione/raw dopo il consenso: se un'altra scheda modifica la copia, non scarica nulla e non esegue retry né merge. Il salvataggio su disco è una dichiarazione separata dell'operatore. Il file `docs/cas-idb-export-provenance.md` avverte che build, test, review indipendente e runner non sono attestati; lo storico `docs/feature-implementation.md` con affermazioni di review non verificabili viene deliberatamente escluso **solo da questo ZIP**. Limiti e controlli su override/path/secret riconoscibili non garantiscono assenza di ogni segreto: ispezionare sempre prima di condividere. Le bozze non salvate non entrano nel pacchetto e restano visibili. Vitest e Chromium con tab rivale e marker `FACTORY_INDEXEDDB_SOURCE_ZIP_E2E_PASS`. Nessun cutover live, GitHub/cloud o review automatica: #139/#91/#92/#109/#113 restano aperte.

## Duplicazione atomica della configurazione nel pilota IndexedDB (#166 / ADR 0119)

Il pannello IndexedDB isolato offre una duplicazione **solo configurazione**: conserva stack, nome-base/brief e requisiti, genera un nuovo UUID con suffisso `(copy)` e riparte con **tutti e sei gli stage pending**. Non copia output AI, patch Code Agent/override/storico, evidenze runner/review, impostazioni di pubblicazione GitHub, consenso pubblico o credenziali. Tre consensi distinti sono richiesti per backup raw JSON byte-esatto, conferma file salvato e nuovo progetto. La nuova primitiva `forkCasProjectConfiguration` verifica **sorgente revision/raw + destinazione never-seen (anche tombstone) + limite 40** nella stessa transazione readwrite IndexedDB e conferma solo con `tx.oncomplete`; writer non cooperativo sulla sorgente prima della transazione blocca l'insert senza retry. Dopo ACK la sorgente resta selezionata; il readback è soltanto osservazionale e non annulla un commit già avvenuto. Test Vitest/Chromium a due schede con marker `FACTORY_INDEXEDDB_CONFIG_FORK_E2E_PASS`. Non è restore completo, non esegue test e **non** sposta il live `App.tsx` su IDB: #139, #91/#92, #109/#113 restano aperte.

## Modalità workspace IndexedDB separata a livello root (#167 / ADR 0120)

La Factory espone la modalità **esplicita** `?workspace=cas`: prima di montare React sceglie un albero **CAS-only** con `CasIsolatedEditor` e **senza montare** `LegacyFactoryApp`, `loadProject`, writer Web Lock localStorage, CodeAgentPanel live, autosync/outbox GitHub, OAuth callback o cloud restore. Le impostazioni (lingua/profili AI) sono lette in sola lettura; non viene importato né scelto automaticamente un progetto. I progetti IDB richiedono apertura/azione manuale e continuano a usare le transazioni CAS reali.

Dalla schermata legacy è disponibile un **passaggio con ricarica completa**, solo se il progetto è salvato con raw locale esatto, writer lease valido e nessun task/bozza/conflitto/autosync attivo: (1) backup completo JSON, (2) conferma salvataggio del file, (3) consenso al cambio modalità, seguiti da un ultimo controllo del raw prima della navigazione. Il ritorno al legacy ricarica la pagina e richiede consenso (con warning bozza non salvata). La modalità diretta non effettua backup automatici o migrazione implicita. La protezione opera **solo in questa tab**: non blocca altre schede legacy o dispositivi. L'editor legacy e le sue scritture `App.tsx`/pipeline/Code Agent/GitHub/cloud non sono ancora migrate; #139 e #91/#92/#109/#113 restano aperte. Test Vitest + Chromium reale `FACTORY_INDEXEDDB_STANDALONE_ROOT_E2E_PASS`.

## Composer stack completo su CAS nativo (#168 / ADR 0121)

Il workspace `?workspace=cas` può ora modificare **più frontend, target deployment, versione .NET, database e tutti e cinque i servizi dev/prod** senza montare l'editor legacy: le modifiche di stack e di brief/requisiti vengono committate **insieme** dalla stessa transazione IndexedDB CAS che richiede backup JSON raw byte-esatto e conferma di salvataggio. Le bozze di stack sono protette durante close/switch/refresh/ritorno al legacy. La modifica invalida tutti e sei gli output di pipeline e ogni presunta origine di completamento; **rifiuta di modificare** copie che hanno già `development` Code Agent/runner o qualsiasi binding/receipt GitHub per evitare di riutilizzare sorgenti, review o test di una baseline precedente. In quel caso creare prima un fork **SOLO configurazione** (#166). Config strettamente allowlisted e senza campi extra; nessun fallback localStorage o rebase automatico. Test unitari e browser Chromium con scheda rivale, `FACTORY_INDEXEDDB_FULL_STACK_EDIT_E2E_PASS`. Il full cutover di `App.tsx`/CodeAgentPanel/GitHub/cloud resta aperto in #139; altre schede legacy e il multi-device non sono risolti.

## Applicazione umana di sorgenti Code Agent in CAS-only (#169 / ADR 0122)

Nel workspace `?workspace=cas`, una proposta Code Agent `pending` **non revisionata** può essere trasferita ai sorgenti IndexedDB soltanto con una scelta **umana esplicita**: anteprima integrale di ogni before/after (non basta un diff troncato), path allowlist e baseline generata/override esatti, assenza di storico review indipendente/runner/GitHub, backup JSON raw byte-identico, consenso sul file salvato e terzo dialogo che chiarisce **nessun test, build o reviewer eseguito**. La singola transazione CAS `ID/revision/raw` aggiorna `development.overrides` e `originals`, incrementa la revisione, cancella il pending e registra `humanApplications.status=operator-unverified`; non crea `FeatureReview`, `history:applied`, proof runner/test/GitHub. Le modifiche umane **saranno** incluse nello ZIP, corredato da disclaimer neutro sulla loro origine; pending non incluso. Writer rivale sulla stessa IDB rev blocca tutto senza retry/merge; la bozza rimane. Vitest, Chromium `FACTORY_INDEXEDDB_HUMAN_PATCH_APPLY_E2E_PASS`, ADR 0122. Non è il cutover live `App.tsx`/CodeAgentPanel o una review indipendente: #139/#109/#113/#91/#92 restano aperte.

## Undo nativo dell'ultima applicazione umana ai sorgenti CAS (#170 / ADR 0123)

Il workspace `?workspace=cas` può annullare **l'ultima** applicazione Code Agent umana `operator-unverified` (#169), senza passare dal legacy. Le nuove applicazioni registrano anche il contenuto effettivo **prima/dopo** per ciascun file in `development.humanApplications[*].files` (anteprima completa ≤1600 caratteri per lato, allowlist, nessun secret riconoscibile). L'undo rilegge il baseline generato e gli override effettivi: può rimuovere un file aggiunto oppure ripristinare la precedente versione soltanto se verificabile e non sostituita da un writer concorrente; incrementa `development.revision`, marca il record `reverted` con timestamp e invalida tutte le sei analisi, **senza inventare review, test o evidenza runner/GitHub**. Sullo storico #169 senza immagini prima/dopo è possibile **soltanto** togliere un file nuovo mai precedentemente toccato; le sostituzioni sconosciute richiedono backup JSON e recupero esplicito.

In UI IT/EN: anteprima testuale integrale dei sorgenti corrente/ripristinato, consenso al download del JSON raw esatto, conferma di averlo salvato e terzo consenso all'undo; un solo commit IndexedDB CAS ID/revision/raw, senza retry, merge o localStorage. La seconda scheda che scrive durante il consenso finale vince e blocca lo stale undo. Lo ZIP dopo undo include solo gli override rimasti, con provenance non verificata. Vitest e Chromium `FACTORY_INDEXEDDB_HUMAN_PATCH_UNDO_E2E_PASS`. Non è il full cutover dei writer live o una review indipendente: #139/#91/#92/#109/#113 restano aperte.

## Trasferimento assistito progetto legacy → workspace CAS-only (#171 / ADR 0124)

La Factory ora offre un secondo percorso dall'editor live: **Copia il progetto ATTIVO e aprilo in CAS-only**, diverso sia dalla copia anteprima IndexedDB (#141) sia dal semplice cambio modalità senza copia (#167). Serve il lease di scrittura locale attivo con snapshot per-ID byte-identico, niente task/bozze/conflitti/autosync GitHub e stage coerenti non in esecuzione. Prima dei consensi si controlla che la destinazione IDB sia **assente**; record presenti, divergenti, identici o tombstonati NON si sovrascrivono né si ripristinano implicitamente. L'operatore scarica il **JSON sorgente raw esatto** e ne conferma il salvataggio, poi autorizza il trasferimento: copia nativa insert-only con lo stesso ID, ACK/readback rev1 e confronto locale ripetuto prima/dopo. Un rivale legacy o IndexedDB può bloccare l'operazione, non causare un merge o un retry automatico.

Un trasferimento confermato ricarica la pagina nel root CAS-only con un *hint* limitato a ID, revisione e impronta SHA-256 del JSON, senza codice o credenziali nella URL e mantenendo il path GitHub Pages. Il CAS root non monta editor/lease/autosync/cloud legacy e **non apre automaticamente** neppure il progetto IDB suggerito; l'utente deve confermare un pulsante di apertura, che verifica esattamente ID/rev/raw/digest **prima e dopo** il dialogo. Se un altro tab modifica la copia, il suggerimento stale viene rifiutato e si può ricorrere alla libreria manuale. Tornare al legacy elimina l'hint senza importare la copia. Tutte le evidenze AI/Code Agent/runner/GitHub sono conservate come **storico non indipendentemente verificato**, mai come nuovo test o review. Nessun sync multi-device, pubblicazione o cutover generale dei writer legacy. Vitest, browser Chromium `FACTORY_INDEXEDDB_ASSISTED_HANDOFF_E2E_PASS`, ADR 0124; #139 e #91/#92/#109/#113 restano aperte.

## Recupero manuale di una fase AI IndexedDB rimasta running (#172)

Nel workspace IndexedDB separato, se una richiesta AI lascia un checkpoint **running** dopo un crash/chiusura/race, un pulsante dedicato rileva una singola fase running senza output. Richiede backup JSON esatto e tre consensi prima di resettare **solo questa fase e le successive** tramite CAS nativo, preservando gli stadi precedenti. Se una scheda concorrente cambia la revisione, la recovery viene bloccata senza sovrascritture. Non ferma chiamate provider in altri client, non attesta test/completion e **non** converte ancora la Factory live da localStorage a IndexedDB. Vedi [ADR 0125](adr/0125-cas-running-stage-explicit-recovery.md) e [issue #172](https://github.com/KeyserDSoze/SoftwareFactory/issues/172).

## Write fence legacy dopo trasferimento IndexedDB (#173)

Dopo backup byte-esatto e tre consensi dell'handoff #171, viene salvato e riletto un marker minimo, specifico per progetto (ID, versione schema e SHA-256, **nessun sorgente o segreto**) **prima** dell'inserimento in IndexedDB. I writer legacy cooperativi non possono più modificare quel progetto, neppure dopo reload o in altre schede: restano disponibili il backup legacy in sola lettura e l'apertura manuale del workspace CAS. Un errore di quota o readback del marker blocca la copia IDB; un ACK IDB fallito o incerto lascia il marker attivo, senza riprova automatica. Non è una transazione unica tra i due store, né protegge client vecchi, accessi diretti al browser o dispositivi diversi. Si veda [ADR 0126](adr/0126-cas-legacy-writer-retirement.md): #139/#91/#92 restano aperte.
