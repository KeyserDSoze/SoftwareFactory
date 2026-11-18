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
