# ADR 0066 — Completion Tester dal journal runner verificato, mai dal verdetto AI

- Data: 19 novembre 2026
- Stato: accepted per #111; epiche #109/#105/#89 ancora aperte

## Decisione

Un task \`tester\` può passare dalla lease attiva a
\`runner_verified_test\` soltanto quando il runner conferma un job
Docker terminale \`passed\` tramite lettura inode-bound e
\`verifyJobEvidenceForRead\` + \`projectVerifiedJobPlan\`.
L'attore fornisce riferimenti, **non il verdetto**: UUIDv4 di handoff,
task, lease, idempotency e job, digest della richiesta, head/count
dell'evidence chain e nome step effettivamente di test.

Il job deve avere stesso tenant, accettazione **strettamente successiva**
alla claim fencing del task, esecuzione e fine cronologicamente valide,
evento finale \`finished\` e tutti i test realmente passati senza skip.
Il contratto chiuso non ammette \`passed\` o campi iniettati.
La API è autenticata solo con \`RUNNER_AGENT_ACTORS_FILE\`, non root/tenant.

La transizione \`test_verified\` è append-only a livello logico nel
manifesto con SHA-chain e generation/leaseId correnti. Il lock POSIX
condiviso fra API serializza l'operazione e un controllo esaustivo
di tutti i manifest già presenti impedisce riuso dello stesso job.
Un retry con stessa submission e stesso job restituisce risposta senza
doppia transizione. \`GET\` mostra solo metadata di proof e mai la lease.

A ogni lettura del registro (e dunque nelle decisioni di claim dei
downstream) si riconvalidano **i file originali del job**. Se la
retention elimina il job o il journal è manomesso, il sistema
fallisce closed: non inventa un successo storico non attestato.

## Limiti e alternativa rifiutata

Una receipt \`state:passed\` non verificata o un flag inviato dall'AI
non è accettabile. Nemmeno un checksum JSON isolato prova la
correttezza dei passi: è obbligatorio il journal coerente.

Questa completion significa solo che **una specifica snapshot
del job** ha superato test runner; non prova che il Tester AI
abbia eseguito codice, né che abbia revisionato la patch o che
l'app corrente corrisponda a quel digest. Non costituisce firma
off-host né garanzia di filesystem contro power loss. Il job
deve rimanere retained; una futura attestation durevole off-host
richiederà un'architettura separata. Code Reviewer non diventa
\`completed\` usando una test suite; provider billing resta
non verificato e \`approvedReportedUnits\` rimane self-report
umano (#109). Nessuna esecuzione LLM, apply/push o deployment
avviata da questa route.
