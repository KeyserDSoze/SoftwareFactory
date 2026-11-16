# ADR 0043 — Collaudo OIDC JWKS HTTPS in Production con CA temporanea di CI

- Data: 2026-11-16
- Stato: accettato nella Factory CI
- Sottoissue: https://github.com/KeyserDSoze/SoftwareFactory/issues/86
- Epica: https://github.com/KeyserDSoze/SoftwareFactory/issues/9
- Precedenti: ADR 0027, 0038, 0039, 0041, 0042

## Problema

La sicurezza OIDC/JWKS del backend ASP.NET Core generato era testata finora su un issuer `http://identity:8999` dentro una bridge Docker `--internal` in `Development`. Il gate di startup rifiutava correttamente issuer HTTP in Production, ma non eseguiva un happy-path end-to-end di metadata/JWKS firmati RS256 su connessione **HTTPS con verifica CA e SAN**, né verificava che un backend Production senza trust CA respingesse lo stesso token. Un test HTTP con issuer simulato non prova che la configurazione HTTPS risulti interoperabile con la trust store TLS usata realmente da .NET.

## Decisione

1. Conservare la precedente suite browser OIDC HTTP su rete interna, non modificarne il percorso PKCE/refresh/logout; aggiungere invece **una seconda fase indipendente** nel medesimo test fullstack con provider effimero HTTPS e backend ASP.NET Core in `Production`.
2. Limitare rigidamente i trasporti del provider CI a `http://identity:8999` o `https://identity-tls:9443`, solo quando `CI=true` e con segreto di controllo effimero. Il provider genera chiavi JWT RS256 all'avvio e legge il certificato TLS leaf da mount read-only a path fissi `/ci-tls/server.crt` e `/ci-tls/server.key`. Mai mettere la CA privata nei container.
3. Creare su host CI effimero una CA RSA e certificato server con SAN `DNS:identity-tls` via openssl, validare la chain, e copiare nel mount solo CA pubblica e certificato/chiave leaf con ACL private. Lo smoke è CI-only e mantiene `--network=internal`, nessuna porta pubblicata, cap drop e no-new-privileges; elimina i file e i container in `finally`.
4. Avviare in rete isolata **due API .NET** con `ASPNETCORE_ENVIRONMENT=Production`, `Auth__Mode=oidc`, `Auth__Authority=https://identity-tls:9443`, `Web__AllowedOrigins=https://app.example.test`, DB PostgreSQL già attivo. Solo l'API trusted riceve `SSL_CERT_FILE=/ci-tls/ca.crt`; sull'API untrusted lo stesso JWT deve risultare `401`. Il client Node deve fallire la verifica TLS senza CA, poi riuscire con CA (senza TLS bypass).
5. Riutilizzare lo smoke JWT JWKS rollover contro l'issuer HTTPS e la prima API, verificando chiave iniziale e nuovo kid, firma manipolata, reader/editor e ruoli invalidi. Sui fallimenti non stampare chiavi/tokens, negare il successo. Test Node per il trasporto CI che rifiuta hostname/porte/URL pubblici e ambienti non CI, sintassi runner e fullstack reali obbligatori.

## Limiti

La CA è privata, temporanea e attendibile solo per gli explicit-test processes. La prova esercita un vero handshake TLS e la validazione certificato .NET su rete privata, non una PKI pubblica, CRL/OCSP, IdP HTTPS esterno, ingress TLS/browser, cloud CDN, Cloudflare o ambienti VM rootless. Il provider è una fixture homegrown e non ha compatibilità garantita con i flussi di un IdP esterno; queste verifiche restano workstream aperto in #9. Il Docker host di GitHub Actions CI è rootful, non è attestazione di runtime isolato su VM.
