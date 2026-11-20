# ADR 0073 — Sorgenti testati consultabili dal Reviewer prima della submission

**Data:** 2026-11-20  
**Issue:** #120 (sottoissue #113 / correzione flusso #119)  
**Stato:** accepted come consegna controllata di codice; non come attestation AI.

## Contesto

La #119 autorizza la GET dei file testati solo dopo una review già presentata. Questo permette l'ispezione all'approvatore, ma non offre al Reviewer i bytes che dovrebbe valutare *prima* di scrivere e presentare il rapporto. La piattaforma non deve incoraggiare review basate sul solo digest o su una precedente vista non verificata.

## Decisione

Introdurre `GET /v1/agent-review-workspaces/:handoffId/:taskId` per `code_reviewer` owner esatto e stessa tenant, con task claim già attiva, non scaduta e non ancora submitted/rejected/approved. L'accesso è serializzato da `withAdmissionLock` rispetto a release/reclaim e usa `reauthorizeAgentActor` sia prima sia dopo la lettura dei file; quindi una credenziale ruotata prima del lock o durante il read è fail closed. Il callback rilegge il manifest SHA-chained, la prova di test e `input.json` originale con FD owner/nlink/O_NOFOLLOW/stable. Confronta digest job e file-only, source fingerprint e tutti i Tester diretti; il file set discordante non produce alcuna vista.

La risposta limitata alle quote del runner restituisce solo file map canonica, source digest/fingerprint, numero/dimensione file, task/handoff e generazione (mai leaseId, job report, token o prompt). Dopo la submission, il Reviewer/approvatore possono leggere i sorgenti mediante la route separata #119. La nuova GET non modifica stati del DAG, non crea nuove prove di review, non lancia LLM, e non contabilizza consumi.

## Sicurezza e limiti

La vista trasporta codice potenzialmente proprietario: HTTPS in deployment esposti, no-store, credenziali actor distinte e registri HTTP senza body sono obbligatori. La sicurezza di `input.json` è quella della sorgente locale POSIX, non un ancoraggio esterno; la lettura HTTP non prova che un essere umano o AI abbia effettivamente compreso il contenuto. Non copiare automaticamente in prompt di modelli terzi senza consenso esplicito. Attestazioni AI provider, token billing e live VM rootless rimangono #113/#109/#105/#87.
