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
