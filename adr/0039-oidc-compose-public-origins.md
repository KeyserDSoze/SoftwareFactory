# ADR 0039 — Compose generato solo loopback e configurazione OIDC pubblica indipendente

- Data: 2026-11-16
- Stato: accettato nello scaffold generato
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/82
- Epica: https://github.com/KeyserDSoze/SoftwareFactory/issues/9
- Precedente: ADR 0038 (CSP e no-store)

## Contesto

Il Docker Compose dello scaffold PostgreSQL pubblicava il frontend Nginx HTTP su `3000:80` (tutte le interfacce), mentre l'API era già vincolata a loopback. Forzava `ASPNETCORE_ENVIRONMENT=Development`, rendendo possibile pubblicare inavvertitamente un backend con le eccezioni di sviluppo (legacy HMAC e issuer HTTP). Il browser era compilato con `VITE_API_URL=http://localhost:8080` senza variabile Compose; un edge pubblico HTTPS non poteva usare l'API pubblica senza modificare il file. Dopo la #81, `VITE_OIDC_AUDIENCE` derivava sempre da `AUTH_AUDIENCE`: la modalità legacy con audience API obbligatoria ma OIDC pubblico non configurato diventava una build invalida a causa del corretto gate CSP 0-o-3.

## Decisioni

1. Limitiamo la pubblicazione Nginx di default a `127.0.0.1:3000:80`, come API/database. Il template resta di sviluppo e non introduce automaticamente proxy/TLS; un accesso pubblico richiede reverse proxy con certificato e configurazione CORS/redirect URI reali.
2. Sostituiamo l'ambiente ASP.NET Core hardcoded con `APP_ENVIRONMENT`, default `Development` per il demo locale. L'operatore deve specificare `APP_ENVIRONMENT=Production` sul deployment reale: le validazioni API già presenti disabilitano Auth Mode legacy e metadata OIDC HTTP.
3. Iniettiamo nel Web build `PUBLIC_API_URL`, default `http://localhost:8080` solo loopback; la SPA e il CSP generator lo leggono dallo stesso `VITE_API_URL`. Il validatore CSP rifiuta HTTP remoto e URL con credenziali/query/fragment, eccetto CI isolata esplicitamente opt-in. `PUBLIC_API_URL` è raggiungibile **dal browser**, non è il nome del servizio Docker.
4. Introduciamo `OIDC_PUBLIC_AUDIENCE` separata da `AUTH_AUDIENCE` per consentire legacy/dev senza client OIDC pubblico; in Production le tre OIDC_PUBLIC_* vanno impostate tutte, l'audience pubblica deve coincidere col resource server dell'IdP. Il gate CSP di #81 continua a rifiutare 1-2 valori presenti.
5. Verifichiamo la configurazione prodotta con un test deterministico e `docker compose config --format json` in CI (due scenari, variabili fittizie, zero servizi avviati). Gli smoke .NET/React/Playwright della Factory restano indipendenti.

## Limiti

Questa modifica **riduce il rischio** di esporre una demo HTTP involontariamente, ma non conferisce protezione TLS/IdP su un host reale; il default `Development` esiste solo per comodità locale ed è da cambiare esplicitamente in produzione. Le variabili VITE/OIDC_PUBLIC sono visibili nel browser e non devono contenere secret. Nessuna attestazione di CORS esterno, reverse proxy, certificati o Identity Provider HTTPS effettivo è inclusa. L'epica #9 rimane aperta.
