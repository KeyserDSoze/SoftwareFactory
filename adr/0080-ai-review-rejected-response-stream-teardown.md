# ADR 0080 — Tear-down HTTPS fail-closed del Code Reviewer sulle risposte rifiutate

**Data:** 2026-11-20  
**Issue:** #126 (segue #125 e #113)  
**Stato:** accepted.

## Problema

Il trasporto off-host `provider-egress.mjs` già rifiutava HTTP non-2xx, header `Content-Length` invalidi o oversized, overflow e mismatch tra header e byte ricevuti. La verifica dello **status e dell'header precedeva però il blocco `catch` che chiamava `response.destroy()`**. Su un endpoint ostile, la promise si rigettava e il timer end-to-end veniva cancellato, ma un IncomingMessage mai consumato e la sua socket potevano restare aperti e tenere vivo il processo. Il controllo di dimensione/status logico non bastava a chiudere il canale fisico.

## Decisione

Portare controlli di **status, header, stream, byte count e costruzione del body** dentro una sola `try` e usare una `catch` unica che chiude esplicitamente `IncomingMessage.destroy()`, ove disponibile, prima di generare un errore pubblico generico `AI_REVIEW_INVALID`. Il fail-closed vale anche per rifiuti precoci, prima di leggere il body. Non ripetere richieste potenzialmente fatturate. Non modificare payload, receipt Ed25519, URL, DNS A pinned, SNI, policy TLS, timeout 30s, limite 64KiB o approvazioni indipendenti del Reviewer.

## Prove e limiti

Regressioni Node con `Readable` senza EOF riproducono 302/401/503, header troppo grande/malformato, body overflow e body troncato; verificano `destroyed`, invocazione del teardown e un solo POST mockato. I test non contattano provider, non verificano che l'LLM abbia eseguito la review né attestano il billing. Un `200` valido mantiene il percorso già coperto dalle prove #125. La #126 è un hardening delle risorse locali, non una attestazione dell'identità del provider. #113/#109/#105 restano aperte.
