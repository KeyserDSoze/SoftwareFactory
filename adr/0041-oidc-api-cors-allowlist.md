# ADR 0041 — CORS dell'app generata: allowlist browser HTTPS fail-closed

- Data: 2026-11-16
- Stato: accettato per lo scaffold PostgreSQL
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/84
- Epic: https://github.com/KeyserDSoze/SoftwareFactory/issues/9
- Precedenti: ADR 0038, 0039, 0040

## Contesto

Le issue #81 e #82 hanno imposto CSP severa, caching HTTP no-store e configurazione esplicita degli origin pubblici browser/API nel Docker Compose generato. Ma `Program.cs` PostgreSQL dell'app generata manteneva in tutti gli ambienti `AddCors(WithOrigins("http://localhost:3000", ...))`, con quattro origin locali hardcoded. Una SPA pubblica HTTPS non poteva comunicare con l'API protetta, salvo editing manuale della policy CORS senza provenance né test. Accettare tutte le origini indiscriminatamente oppure consentire credenziali cookie nel browser sarebbe una regressione di sicurezza.

## Decisioni

1. Generare un file dedicato `BrowserCorsStartup.cs` per PostgreSQL che registra `web` CORS tramite `builder.AddBrowserCors()` e un `WithOrigins(origins)` costruito da configurazione **validata alla startup**, dopo `AddWorkItemSecurity()` e prima di `builder.Build()` e delle migrazioni SQL. Lasciare gli altri database a livello scaffold non-auth non dichiarandoli coperti dall'hardening OIDC.
2. `Web:AllowedOrigins` è obbligatorio in tutti gli ambienti non-Development. Accettare da 1 a 8 origin HTTPS canonici, massimo 256 caratteri ciascuno e 1024 complessivi, separati da virgole senza spazi; rifiutare `null`, duplicati, wildcard, path, userinfo, frammenti, query, schemi diversi da HTTPS, whitespace e header injection. Non riflettere la Origin richiesta, non usare `AllowAnyOrigin` o `AllowCredentials`. CORS non autentica un client non-browser: JWT, RBAC e isolamento owner rimangono la difesa reale.
3. Senza `Web:AllowedOrigins` in Development, conservare la allowlist locale Vite/Compose/CI già utilizzata. Se l'operatore imposta valori espliciti in Development, HTTP è permesso solo con host loopback o il nome di servizio CI `web`. Nessun HTTP arbitrario su WAN.
4. Mappare `WEB_ALLOWED_ORIGINS` dal file privato `docker/.env` a `Web__AllowedOrigins`; indicare in README che questo valore identifica le origini del **frontend**, diverse da `PUBLIC_API_URL` (origin API pubblica). In Production serve reverse proxy con TLS, CORS e redirect URI coerenti con IdP esterno.
5. Testare la generazione in Vitest, l'avvio **effettivo dell'API ASP.NET Core compilata** con configurazioni non sicure in QA/Staging/Production/Development e una preflight OPTIONS reale su PostgreSQL/OIDC/ASP.NET Core in Playwright. Tutte le verifiche devono risultare verdi sul medesimo SHA prima di chiudere la sottoissue.

## Limiti e trade-off

AllowAnyHeader/AllowAnyMethod resta intenzionale solo per origin esplicitamente ammesse; non esistono cookie di autenticazione o `AllowCredentials` in questo modello bearer-token. Un origin HTTPS configurato ma controllato da un attaccante avrebbe accesso al browser CORS; gli operatori devono autorizzare solo domini sotto il proprio controllo. Il CORS del server non vincola script non-browser né mitiga XSS. Il test IdP nel CI è simulato/HTTP dentro rete Docker privata; non prova reverse proxy TLS/CORS production, federazione reale o BFF. L'epica #9 resta aperta.
