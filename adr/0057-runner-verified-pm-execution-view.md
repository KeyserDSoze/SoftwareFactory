# ADR 0057 — Piano PM dal journal verificato del runner

- Data: 18 novembre 2026
- Stato: accettato per incremento #99 (sottoissue #89)

## Contesto

La Factory ha un board PM read-only (#98), mentre il runner remoto conserva
job tramite report e catena SHA-256 append-only con verifica inode-bound.
Un dispatch o receipt non equivale a prova che un test sia stato eseguito.

## Decisione

Il GET autenticato `/v1/jobs/:id/plan` riusa `verifyJobEvidenceForRead` e
i gate di autorizzazione tenant del GET job. Il proiettore puro applica policy
fail-closed: step definiti da allowlist, risultati con ordine e step journal
validi, passed con exitCode 0, durata non negativa e nessun timeout. Il piano
fornisce solamente identificatori allowlisted, dipendenze, stato ed exitCode.
Se il job è running, il prossimo step non è dichiarato running finché il
journal non ne documenta l'avanzamento; chiusura anticipata blocca i residui.

Il client richiede id/digest/stato/count/head coincidenti con il report live.
Se la catena cambia fra richieste, non mostra un piano non correlato.
Il runner non scrive task separati, non avvia altri job, non applica patch
e non esegue AI: mantiene inalterati i gate repair e i limiti Docker.

## Limitazioni e minacce residue

Hash-chain locale non firmata né attestazione remota. Il piano dura soltanto
finché i dati persistono e viene sottoposto a retention del runner. Non
è un orchestratore generale di ruoli, budget, code multi-job o scheduler
resiliente al crash con fencing: l'epica #89 rimane aperta.
