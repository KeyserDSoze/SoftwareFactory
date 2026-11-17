# ADR 0053 — Regressione browser OIDC duplicate callback durante POST PostgreSQL

Data: 17 novembre 2026 · Stato: implementato, verifica Factory CI da completare · Issue [#93](https://github.com/KeyserDSoze/SoftwareFactory/issues/93) e [#9](https://github.com/KeyserDSoze/SoftwareFactory/issues/9). Completa [ADR 0050](0050-oidc-session-idempotence-and-postgres-e2e.md).

## Contesto

La issue #93 ha rilevato un fallimento intermittente: la POST creava potenzialmente un record ma la UI non lo mostrava. La correzione rende idempotente `switchSession(nextToken)` su notifiche duplicate del medesimo token. La sola verifica statica e una CI verde non riproducono però la competizione tra notifica di sessione e risposta HTTP.

## Decisione

- Aggiungere un test **nella suite Playwright generata** eseguito dalla Factory full-stack con vero provider OIDC di prova, API ASP.NET Core e PostgreSQL nella rete Docker interna.
- Dopo login PKCE reale, Playwright intercetta esclusivamente POST `/api/items`: `route.fetch()` invia la richiesta reale e riceve una risposta effettiva, senza creare risultati sintetici. La risposta è trattenuta *prima* di `route.fulfill({ response })`.
- Durante l'attesa, la pagina importa `/src/oidc.ts` nel contesto Vite reale, ottiene l'utente corrente tramite `getUser()` e chiama `manager.events.load(user, true)` due volte. Sono notifiche client equivalenti, non token fittizi: devono lasciare intatti titolo e session epoch; il componente deve poi mostrare il record quando la risposta si sblocca.
- Verificare POST `ok`, riga UI, vero `GET /api/items` autorizzato e cleanup `DELETE`; fail-closed su eventi/response non attesi, nessun `test.retry` e nessun secret stampato.
- Eseguire la regressione **solo** in modalità OIDC/PostgreSQL reale: nei test mock e negli scaffold non OIDC resta `skip` esplicito. Il gate Factory fullstack rifiuta test saltati.

## Limiti

Le notifiche sono provocate in modo deterministico nel browser e non dimostrano che la causa esatta del precedente flake sia stata individuata. La prova usa un IdP effimero, non un provider esterno. Un token diverso, un logout o un 401 devono continuare a invalidare richieste e dati obsoleti; gli altri test già esistenti coprono questi casi. Resta aperta #93 per eventuali esecuzioni ripetute e diagnosi di failure reali.
