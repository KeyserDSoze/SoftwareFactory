# ADR 0063 — Registry multi-ruolo dichiarativo persistente, non esecutivo

- Data: 18 novembre 2026
- Stato: accettato per primo incremento #107 di #105/#89

## Contesto

Il DAG dei job test Docker (#103/#104) è verificato, ma non rappresenta
l'ownership di task AI separati. Dichiarare una stessa receipt come PM o
Tester AI in esecuzione costituirebbe un falso esito. Occorre un registro
con identificatori e dependences immutabili prima di progettare lease
fencing, actor auth e budget contabilizzati.

## Decisione

Introdurre `POST /v1/agent-handoffs` (consenso obbligatorio, uuid v4
idempotente) e `GET /v1/agent-handoffs/:uuid` (read-only), senza endpoint
claim/renew/complete. Sono ammessi solo ruoli catalogati, owner come
etichetta non autorizzativa, task 2-8 topologicamente ordinati, costo
preventivo bounded per task, numero massimo tentativi e budgetUnits
dichiarato coerente con la somma delle stime.

Il record atomico sotto `agent-handoffs` privato è hash-bound, con
lettura tramite FD O_NOFOLLOW, uid/mode/nlink e controllo inode prima/dopo
il read. Prima di inserire nuovi record, l'API valida tutte le entrate
sotto lo stesso admission lock POSIX dei job runner. Idempotency-key
fingerprinted con scope v1 e segregata per tenant. Recheck credenziali
file-backed sotto lock; un tenant non legge il manifest di un altro.

La proiezione di stato indica solo `declared` e task `ready` o `blocked`
per la topologia, `evidence: not_started`, `executions:0`. Nessun
`passed` senza journaling e nessun `running` senza lease attendibile.

## Non obiettivi, limiti e conseguenze

Nessun codice/sorgente/prompt/token salvato; il budget è previsto e non
consumi reali. Il campo `owner` non è un'autorizzazione per un worker,
e il registro non rende PM/Tester autonomi. Le lease e le key actor-scoped
richiederanno un protocollo nuovo, revoca, fencing monotono e journal
append-only separato, prima di permettere task state mutabili (#105).
Il checksum locale non è prova off-host e POSIX locale non garantisce
distributed consistency su volumi NFS. Mancano collaudi VM reali
rootless/Cloudflare, tracciati in #87/#2.
