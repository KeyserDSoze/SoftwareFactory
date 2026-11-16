# ADR 0012 — OpenID Connect, PKCE e JWT asimmetrici nello scaffold

- Data: 2026-11-14
- Stato: sperimentale, da convalidare completamente con provider reale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/9
- Precedente: ADR 0011

## Problema

Il JWT HS256 dello scaffold è una baseline didattica. Usare la stessa chiave simmetrica per emettere/verificare token è inappropriato quando l'identità è gestita da un servizio esterno. La SPA non disponeva di login e richiedeva all'utente di incollare token manualmente.

## Decisione

1. L'API PostgreSQL sceglie `Auth:Mode=oidc` di default: authority discovery/JWKS, audience esplicita, token RS256, issuer e lifetime verificati da ASP.NET Core. HTTPS dei metadati obbligatorio in Production. `Auth:Mode=legacy` mantiene HS256 solo in Development per fixture e test.
2. React usa la libreria pinned `oidc-client-ts@3.5.0` per Authorization Code + PKCE, state/nonce, verifica dei redirect e gestione della sessione. Il client pubblico richiede solo authority URL, client ID e audience, passati tramite configurazione Vite. La callback usa /auth/callback e Nginx history fallback.
3. La CI Factory dispone di una identity fixture temporanea Node+RSA su bridge Docker `--internal`. Essa pubblica discovery, JWKS, authorize, token, userinfo e logout e richiede PKCE S256, eseguendo test browser. La chiave RSA privata viene generata all'avvio del container e non esce dalla fixture.
4. La CI delle app generate può usare legacy HMAC con chiave random solo in un ambiente effimero Development: non deve essere abilitata in Production.
5. I permessi RBAC, owner-scoped SQL, rate limiting e audit introdotti in ADR 0011 rimangono invariati sotto JWKS.

## Rischi residui

La fixture OIDC automatizza il login soltanto per test e non è un Identity Provider utilizzabile da utenti reali. Restano aperti test con servizio OIDC esterno, gestione delle sessioni e del logout federato, revoca/refresh e key rollover JWKS, hardening XSS/CSP e scelta tra SPA con token in sessionStorage e BFF cookie HttpOnly. Nessuna credenziale OIDC o chiave di firma va nel bundle. Il frontend Vite è servito su **127.0.0.1 del container Chromium**, secure context secondo la Web Crypto API, mentre il servizio API, il provider OIDC fittizio e PostgreSQL condividono una Docker bridge **--internal**. Non si abilitano flag Chromium per rendere sicuri origini HTTP non-locali.

## Verifiche addizionali del protocollo

La Factory CI impiega due livelli indipendenti: (a) sei test Chromium che esercitano il redirect OIDC completo con code+PKCE e logout, RS256 sul backend e proprietà dei record PostgreSQL; (b) `oidc-protocol-smoke.mjs` eseguito nella rete Docker privata che verifica la firma JWK, l'assenza di materiale privato in JWKS, il rifiuto dei verifier PKCE errati, la non riutilizzabilità del codice, la rotazione monouso del refresh token, il logout e il cambio `kid` dopo il rollover della chiave temporanea.

Il rollover prova la pubblicazione della nuova chiave JWKS, **non** certifica il refresh automatico delle chiavi di un servizio ASP.NET Core/IdP reale sotto carico. I test di produzione con IdP commerciale/open-source, sicurezza sessione e revoca distribuita restano da completare prima del rilascio.

## Integrazione di sicurezza — issue #10 (15 novembre 2026)

La modalità simmetrica demo è ammessa **solo in Development**, mai in Staging/Production/ambienti personalizzati. L'identificatore di soggetto che controlla `owner_id` deve comparire una sola volta, essere non vuoto e lungo massimo 255 caratteri: le policy negano l'accesso a claim `sub` assenti, vuoti o multipli. Il controllo viene verificato con JWT RS256 firmati in CI dal provider temporaneo e PostgreSQL reale; il processo .NET generato è anche avviato intenzionalmente in ambienti vietati per provarne il rifiuto. Non equivale a certificazione IdP esterno o sicurezza di produzione.


## Addendum — invalidazione della sessione locale (#11, 15 novembre 2026)

Decisione: ogni HTTP 401 su operazioni dati PostgreSQL invalida e rimuove la credenziale in memoria/sessionStorage e i dati visibili, senza lanciare automaticamente un redirect al provider. Si attende un nuovo login esplicito. Il 403 indica autorizzazione insufficiente, ma non invalida la sessione. Una risposta tardiva deve essere legata al token utilizzato per quella richiesta, così non può cancellare un login più recente. `removeUser()` è una pulizia **locale**, non una revoca federata: resta aperta issue #9 per CSP, BFF, IdP reale, key rollover, refresh e logout distribuito.


## Addendum — rinnovo JWKS sul processo .NET vivo (#12, 15 novembre 2026)

Alla verifica protocollare della pubblicazione di un nuovo `kid` si affianca una prova sulla **stessa API ASP.NET Core già avviata** durante Chromium/PostgreSQL: un token firmato dalla chiave originale viene validato, la fixture RSA ruota, e l'API deve accettare in un tempo massimo la nuova firma attraverso il refresh metadata/JWKS configurato con `RefreshOnIssuerKeyNotFound`. Nel frattempo 401 transitori sono accettabili, non un falso successo. Sono obbligatorie una prova 401 per firma alterata e un 403 per reader sulla POST. Per evitare leakage la prova non logga né token né segreti. Il cambiamento del JWKS non implica revoca istantanea dei token precedenti, né dimostra disponibilità con un IdP reale, sotto carico o tramite HTTPS: queste verifiche restano nella #9.


## Addendum — rinnovo e logout browser verificati (#13, 15 novembre 2026)

Si mantiene `oidc-client-ts` con sessione in `sessionStorage` e refresh-token grant. La CI fullstack prova ora l'intero ciclo nel browser reale dopo PKCE: `signinSilent()` usa il refresh token monouso e ottiene nuove credenziali, un replay del vecchio token è respinto dal provider, una chiamata a PostgreSQL con il nuovo JWT è autorizzata e un reload mantiene la sessione. Il logout effettua il redirect al provider e la callback browser rimuove l'identità locale. Nessun JWT o segreto è riportato nei log. I contatori della fixture sono osservati prima del test Node indipendente, quindi provano la sequenza browser. La fixture non dimostra revoca dei JWT già emessi, logout globale e politiche di sicurezza del provider reale, né protegge la SPA da XSS; la scelta di BFF e CSP resta aperta in #9.


## Addendum — stabilità `auth_time` della sessione CI (#14, 15 novembre 2026)

Una prima prova di refresh dal vero browser ha rilevato un bug della fixture OIDC: il token di rinnovo conteneva un `auth_time` diverso da quello del login originale e il client `oidc-client-ts` lo ha giustamente respinto. La fixture ora associa il timestamp di autenticazione ai record refresh rotanti e lo riusa per ogni ID token successivo, mantenendo indipendente il proprio `iat`. Il test protocollare esegue due rinnovi e verifica sia la continuità temporale sia il diniego del replay. Restano indispensabili le prove Chromium reali e, in seguito, con IdP HTTPS esterno.


## Addendum — rinnovo fallito: terminale vs transitorio (#15, 15 novembre 2026)

Il rinnovo di un refresh token rifiutato definitivamente (`invalid_grant`, `login_required`, `invalid_token`) richiede la pulizia dello user store locale e la richiesta di login esplicito; non comporta redirect federati automatici né revoca dei JWT già rilasciati. Errori di rete temporanei non devono distruggere una sessione con access token ancora valido. Il modulo OIDC espone `renewOidcSession` con controllo della sessione corrente e il componente React riceve i segnali di rifiuto del rinnovo automatico ed elimina dati e UI autenticata allo scarico della credenziale. Due prove Chromium verificano rispettivamente `invalid_grant` dal vero provider temporaneo (refresh token consumato) e token endpoint irraggiungibile; il test mantiene il controllo del reale backend .NET/PostgreSQL, con 12 scenari browser complessivi. La #9 rimane aperta per integrazione con IdP HTTPS reali, revoca distribuita, CSP, cookie e BFF.


## Addendum — CSP enforced e origin pubblici OIDC (#16, 15 novembre 2026)

L'app PostgreSQL generata incorpora una CSP nell'immagine web tramite builder Node eseguito nel Dockerfile. La policy abilita script solo dallo stesso origin, esclude script inline e eval, vieta frame ancestors/object/base e limita le connessioni agli origin autorizzati della API e dell'Identity Provider. URI issuer con path (es. realm Keycloak) sono ammessi e normalizzati all'origin, mentre input non validi, credenziali, query, fragment e HTTP remoto sono rifiutati (fixture privata CI esplicitamente autorizzata). Un vero Nginx e Chromium nella Factory CI verificano risposta sulla callback e blocco inline senza mock. Gli stili inline restano consentiti per React; la CSP non trasforma sessionStorage in storage sicuro da XSS e non evita necessità di BFF/HttpOnly o valutazione CSRF. Lo stato della #9 resta sperimentale.


## Addendum — invalidazione locale cross-tab senza condivisione delle credenziali (#17, 15 novembre 2026)

Decisione: mantenere `sessionStorage` distinto per scheda e sincronizzare solo l'evento `logout` tramite `BroadcastChannel` same-origin. Il canale non trasmette token, refresh token, claims o profili e non persiste contenuti in localStorage. Logout utente, risposta 401 da ASP.NET Core e rifiuto definitivo del refresh token inviano l'evento; il ricevente pulisce `UserManager`, dati e form, senza reindirizzamento automatico e senza ritrasmissione (evita echo-loop). La Factory CI usa browser Chromium reale con due schede entrambe autenticate tramite code+PKCE e richieste contro PostgreSQL per verificare disconnessione e reload pulito; il numero di prove sale a 15. Rischi residui: schede sospese possono non ricevere subito il segnale, il canale non attraversa dispositivi e non revoca JWT lato server. BFF/cookie HttpOnly e IdP HTTPS reale restano in #9.


Nota di validazione #17: la prima implementazione usava un canale temporaneo per la pubblicazione e uno diverso per l'ascolto nella stessa pagina; Chromium ha verificato che la pagina mittente riceveva anche il proprio evento, sovrascrivendo l'errore locale 401. La decisione correttiva è **un solo oggetto BroadcastChannel per documento**, condiviso e gestito con conteggio delle subscription; questo preserva il messaggio di errore 401 originario e la sincronizzazione degli altri tab senza token nel payload.


## Addendum — fence per risposte CRUD dopo cambio sessione (#42, 16 novembre 2026)

L'originaria protezione della GET dei WorkItems confrontava soltanto il token corrente prima di aggiornare la UI; le risposte POST/PUT/DELETE invece aggiornavano `items`, editing e errori anche dopo un logout BroadcastChannel, invalida 401 o rinnovo che cambia il token. In un browser con più tab, un'operazione già autorizzata dal server prima del logout può concludersi tardi, ripopolando la schermata anonima o del successivo account.

Decisione: usare un contatore `sessionEpoch` locale monotono per ogni transizione di sessione e una referenza sincrona al token attivo. Ogni fetch CRUD cattura (token,epoch) prima della rete, ricontrolla la coppia dopo gli await e nei catch/finally, e scarta risposte obsolete senza toccare lo stato React. Un 401 della sessione A non può rimuovere credenziali della B. Lo switch libera subito `busy` e le schermate protette vengono pulite dall'invalidation già implementata. Una prova Chromium fullstack con IdP fittizio, due schede e PostgreSQL vero ritarda la consegna al browser del risultato di un POST già eseguito, verifica il logout broadcast e controlla che il risultato vecchio non riappaia.

Il meccanismo non annulla una scrittura PostgreSQL già autorizzata dal server né impedisce l'uso del vecchio JWT sul lato rete finché resta valido; nessuna revoca federata o cross-device è stata introdotta. Per una protezione complessiva rimangono necessari BFF HttpOnly, CSRF/XSS e IdP HTTPS in #9.
