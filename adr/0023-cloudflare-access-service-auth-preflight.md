# ADR 0023 — Preflight HTTP con credenziali Cloudflare Access solo fuori browser

- Data: 2026-11-16
- Stato: accettato per runner sperimentale; prove su provider reale non eseguite
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/66
- Precedenti: ADR 0014, 0021, 0022

## Contesto

Il preflight remoto già verifica liveness, Bearer API, capabilities e CORS via HTTPS ma non sa attraversare una policy Cloudflare Access Service Auth. Per collaudare un endpoint protetto non si deve disattivare Access né esportare service token nel JavaScript/browser. I token Cloudflare sono un client ID e un secret trasmessi nei due header dedicati, in aggiunta alla `RUNNER_API_KEY` del nostro servizio.

## Decisione

1. Consentire esclusivamente alla CLI operator-only `preflight.mjs endpoint` di caricare la coppia `CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET` dal file `--env-file` owner-only 0600/O_NOFOLLOW o dal processo dell'operatore. Coppie parziali, CR/LF, whitespace, token troppo corti/lunghi falliscono prima di ogni chiamata HTTP. Nessun percorso API o SPA espone i token; supportare secret 64-hex legacy e `cfast_` recenti.
2. Quando Access è configurato, prima effettuare `GET /healthz` senza token; deve negare la lettura con status 302 (login)/401/403 e non deve seguire il redirect. Non considerare altro stato un gate valido.
3. Poi eseguire gli attuali quattro probe HTTP protetti, includendo **entrambi** gli header Access in tutte le chiamate GET/OPTIONS: health 200, capabilities 401 senza Bearer, capabilities 200 con Bearer API, preflight CORS OPTIONS 204 con origin/metodi/header espliciti. Nessun POST, nessun redirect credentialed, timeout 8 secondi.
4. Output e errori solo categoria/boolean, mai API key, Cloudflare token, Location, cookie o response body. Nessun token nel job, nel container o nel codice pubblicato.
5. Test Node deterministici di sequenza e header, token partial/malformato, endpoint pubblico senza Access, scadenza/redirect, errore fetch con secret, CORS e wiring CLI con .env temporaneo 0600, mantenendo la precedente modalità senza Access.

## Conseguenze e limiti

Cinque richieste HTTP contro le quattro senza token; i service token sono per traffico *machine-to-machine*, non per SPA/browser. La negazione unauth non identifica in modo crittografico il provider; le policy vere Cloudflare, il CORS con cookie `CF-Authorization`/preflight browser e il login umano richiedono collaudo separato su account e dominio reali. Non è una certificazione rootless VM, multi-host fencing o attestazione indipendente. Il relativo lavoro rimane aperto in #2.
