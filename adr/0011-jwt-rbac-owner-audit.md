# ADR 0011 — JWT fail-closed, RBAC, proprietà e audit transazionale

- Data: 2026-11-14
- Stato: accettata per baseline dimostrativa, non production-ready
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/8
- Precedenti: ADR 0009 e 0010

## Contesto

Il CRUD PostgreSQL #7 consentiva accesso anonimo ai record. Doveva diventare possibile verificare separatamente l'accesso non autenticato, i permessi dei ruoli e i tentativi di un utente di accedere ai record di un altro. Nessuna signing key o token poteva essere introdotto nei sorgenti esportati.

## Decisione

1. Aggiungere Microsoft.AspNetCore.Authentication.JwtBearer coerente al target .NET (11.0.0 o 10.0.15), con chiave HS256 random esterna di almeno 48 byte. Validare issuer, audience, signature, scadenza, algoritmo e claim sub/role; non avviare l'API se mancano le impostazioni.
2. Policy items.read per reader/editor e items.write soltanto per editor. Proteggere tutte le route dati con RequireAuthorization. Il subject JWT viene passato al repository e usato in WHERE owner_id, non accettato dal body/client. Record altrui si comportano come inesistenti (404).
3. Migrazione 0002 per owner_id e work_item_audit. Quarantena dei dati legacy sotto owner legacy-unassigned, audit create/update/delete inserito nella stessa transazione PostgreSQL della modifica.
4. Applicare body size max 8 KiB, rate limiting per soggetto, errore server JSON generico, CORS prima dell'autorizzazione, health pubblico e readiness DB accessibile solo ad autenticati.
5. CI effimera: generare signing key e tre JWT durata dieci minuti per reader/editor di due utenti, verificare black-box 401/403, ownership e CRUD browser. Contare anche gli audit nel PostgreSQL reale. Nessuna chiave committata o inserita in asset SPA.
6. La UI dimostrativa riceve il token già emesso tramite inserimento manuale, lo conserva solo in sessionStorage e lo trasmette nell'header Authorization; lo script che emette JWT di prova rimane disponibile solo a chi possiede la chiave di firma.

## Limiti e workstream successivi

Non esiste ancora un identity provider OIDC/JWKS, login Authorization Code + PKCE, token refresh/revoca, rotazione chiavi, threat assessment completo o audit immutabile. L'HMAC condiviso sul server è una scelta temporanea per lo scaffold di demo. sessionStorage è vulnerabile a XSS. Il runner remoto e i container su host di produzione richiedono isolamento aggiuntivo; una CI Docker rootful effimera non certifica sicurezza multitenant né readiness pubblica.
