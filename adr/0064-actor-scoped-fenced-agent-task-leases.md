# ADR 0064 — Actor-scoped task lease con fencing, senza falsi task passed

- Data: 19 novembre 2026
- Stato: accepted per #108, sottoissue #105/#89

## Contesto

Il registro handoff #107 possiede un campo `owner`, ma è semplice testo
dichiarato dall'operatore. Permettere `claim` usando solo quell'etichetta,
la chiave globale del runner o una receipt dei test aprirebbe una escalation
multi-tenant e una falsa attestazione di lavoro AI.

## Decisione

L'API introduce `RUNNER_AGENT_ACTORS_FILE` separato dagli auth provider
del runner e del worker Docker. Ogni bearer è scoped a una tripla
`tenantId,id,role` e nominato `agent.<id>.<random>`. Il file è riaperto
per ciascuna richiesta e nuovamente **dentro il lock POSIX** immediatamente
prima del commit: O_NOFOLLOW, owner, mode-0600, single link e snapshot FD
stabile. Nessun fallback da credenziali globali.

La route mutante `POST /v1/agent-task-leases` permette solo claim/renew/
release con task owner/role e tenant verificati. Ogni claim incrementa un
fencing version monotono, alloca un ticket random e scade entro 30–300 s.
Il rinnovo mantiene la versione e richiede il ticket corrente, un actor
ancora autorizzato e il lease ancora attivo. Una claim nuova dopo expiry
o release invalida il ticket precedente. Le lease consumano tentativi,
al più `maxAttempts` previsti dal manifest. Due API sul medesimo volume
sono serializzate via admission lock condiviso; non c'è lock takeover
automatico per età.

La catena degli eventi è append-only a livello **logico** (record JSON
atomically replaced) e SHA-bound: sequence, previousHash, actorId,
taskId, kind, generation, leaseId e scadenza. La lettura ricostruisce
lo stato e rifiuta eventi impossibili, hash o permessi non verificabili.
Il modello immutabile v1 preesistente resta leggibile senza eventi.

## Non obiettivi e rischio residuo

Il ticket di lease è una capacità temporanea, **non prova di esecuzione,
completamento, test riuscito o consumo token**. Non ci sono route
`complete`/attest, e task con predecessori non vengono sbloccati dalla
sola claim. L'API non chiama LLM, non fa apply/push e non tocca Docker.
Il campo `budgetUnits` rimane preventivo. Il wall clock locale regola
l'expiry; skew multi-host e compromissione owner del filesystem non
sono attestati da hash non firmati. Occorrono actor evidence firmate,
costi effettivi e credenziali prod prima del coordinamento autonomo:
#105/#89. Il collaudo VM rootless/Cloudflare live resta #2/#87.
