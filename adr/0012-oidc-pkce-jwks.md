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

La fixture OIDC automatizza il login soltanto per test e non è un Identity Provider utilizzabile da utenti reali. Restano aperti test con servizio OIDC esterno, gestione delle sessioni e del logout federato, revoca/refresh e key rollover JWKS, hardening XSS/CSP e scelta tra SPA con token in sessionStorage e BFF cookie HttpOnly. Nessuna credenziale OIDC o chiave di firma va nel bundle. HTTP OIDC con flag Chromium che tratta un origin come sicuro è permesso soltanto in CI isolata, mai per traffico utente.
