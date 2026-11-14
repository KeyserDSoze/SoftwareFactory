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
