# ADR 0072 — Ispezione actor-scoped dei sorgenti effettivamente testati

**Data:** 2026-11-20  
**Issue:** #119 (sottoissue #113)  
**Stato:** accepted come lettura verificabile del file set; non come attestazione di ispezione/esecuzione AI

## Problema

La #114 lega il Code Reviewer a un digest file-only di prove del Tester e la #116 custodisce il rapporto di review, con decisione indipendente #115/#118. Ma l'approvatore può leggere solo il rapporto: mancano i **sorgenti effettivamente testati**. Non si può presentare la decisione come verifica della versione di codice senza offrire un percorso con provenienza controllata.

## Decisione

Aggiungere `GET /v1/agent-review-sources/:submissionId` con lo stesso controllo actor-only di `GET /v1/agent-review-artifacts/:submissionId`. Consentire al Reviewer owner o al `review_approver` indipendente della stessa tenant di recuperare i file esclusivamente **dopo** `review_submit` artifact-backed. Root/tenant Bearer, altri owner e tenant sono rifiutati; i recheck della key file-backed sono eseguiti prima e immediatamente prima della risposta.

Ogni GET apre e valida di nuovo il manifesto e la catena del journal Tester, controlla i digest delle dependency dirette e rilegge con `readRunnerInput` il job input originale (FD `O_NOFOLLOW`, owner/nlink/mtime/ctime stabili), imponendo equivalenza byte-per-byte con `validateRequest`, digest job completo e source-only. Se i test diretti usano sorgenti discordanti non esiste una singola source snapshot verificata. Nessuna copia aggiuntiva nel manifest o report, nessun job ID/leaseId/chiave nell'output. JSON bounded alle quote `MAX_FILES/MAX_TOTAL_BYTES`, `no-store` e `nosniff`.

## Threat model e limiti

La route **espone il codice sorgente** già consegnato al runner: proteggerla come un endpoint riservato, limitare chi riceve credenziali `review_approver`, usare TLS per un tunnel esposto e non inoltrare a un terzo provider senza consenso. La scannerizzazione dei secret marker del runner è best-effort, non una garanzia che il file set non contenga IP/PII. Una GET riuscita attesta soltanto che l'API ha consegnato i bytes; non prova lettura, revisione umana, esecuzione AI, firma off-host, né provider billing. Continuano #113/#109/#105 e collaudo ambiente rootless reale.
