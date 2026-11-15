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
