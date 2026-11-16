# ADR 0038 — No-store HTTP e fail-closed delle variabili pubbliche OIDC

- Data: 2026-11-16
- Stato: accettato nello scaffold PostgreSQL sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/81
- Epica: https://github.com/KeyserDSoze/SoftwareFactory/issues/9

## Contesto

La SPA generata con PostgreSQL usa OpenID Connect Authorization Code + PKCE, sessionStorage e un Nginx compilato con CSP dinamica, script inline disabilitati e Referrer-Policy no-referrer. Ma le risposte HTTP del server statico, incluso il fallback `/auth/callback`, non disponevano di una politica `Cache-Control` esplicita. Inoltre il generatore della configurazione CSP considerava completo l'OIDC se mancava la sola audience, ma consentiva `VITE_OIDC_AUDIENCE` configurata senza authority/client ID, un asset incoerente che la SPA interpretava come OIDC disabilitato.

## Decisione

1. Inserire `add_header Cache-Control "no-store" always;` a livello **server** sia nel modello statico `nginx.conf` sia nella configurazione emessa da `scripts/build-nginx.mjs` alla build. La CSP, X-Content-Type-Options, Referrer-Policy, X-Frame-Options e Permissions-Policy restano applicate su home, callback e fallback SPA; non duplicare header in location che ne interrompono l'ereditarietà.
2. Richiedere zero o tre valori OIDC pubblici: authority, client ID e audience. Una configurazione parziale o con client/audience solo whitespace interrompe la build senza generare config Nginx; l'authority continua a usare validazione URL clean HTTPS, HTTP solo loopback o fixture CI private. Non scrivere segreti nel file.
3. Test Vitest esegue il **build script generato** in una directory temporanea isolata senza rete e verifica gli header effettivi, il path di successo HTTPS e i casi negativi di variabili parziali, whitespace e authority malformate. La suite Playwright fullstack interroga Nginx realmente containerizzato e verifica `Cache-Control: no-store` sia su `/` sia su `/auth/callback`, oltre alla CSP invariata.
4. Documentare che `no-store` HTTP non rende i token browser automaticamente non accessibili via XSS, non cancella sessionStorage né history, e non impedisce cache applicate a monte da un CDN/proxy che ignori gli header.

## Trade-off e limiti

Usare no-store a livello server impedisce il caching HTTP **anche degli asset statici versionati**, con maggiore utilizzo della rete; si privilegia una policy semplice e verificabile durante lo sviluppo OIDC. Una successiva ottimizzazione potrà dedicare location statiche con replica completa e testata dei security header. La CI con provider fittizio nella rete Docker privata non equivale a validazione con un IdP HTTPS esterno, né attesta TLS, cookie e CDN di produzione, token revocation/failover e BFF contro XSS. L'epica #9 rimane aperta.
