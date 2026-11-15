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
