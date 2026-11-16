# ADR 0018 — Job recovery non è un fallimento del codice, e i suoi journal non scadono automaticamente

- Data: 2026-11-16
- Stato: accettato per il runner sperimentale su volume POSIX condiviso
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/61
- Precedenti: ADR 0005 e 0015; issue #18, #21, #54, #55

## Contesto

La scansione di un job `running` senza `.claim` indica un worker morto o una claim rimossa manualmente. Non prova né che un test codice sia fallito, né che il container Docker sia cessato. La recovery storica scriveva `failed` e il worker poteva eliminare il report scaduto per retention; senza journal, la CLI operator-only non può più riconciliare in sicurezza quel container potenzialmente ancora vivo.

## Decisione

1. Solo dopo claim e riverifica della hash-chain, la recovery trasforma un running in terminale `incomplete` con evento `recovered`. I risultati verificati precedenti rimangono intatti e nessun nuovo step Docker viene avviato.
2. Il coordinatore AI nega `beginRepairSession` per **qualsiasi** report la cui ultima voce verificata è `recovered`, anche per gli storici `failed`: la finalizzazione non è stata completata e un exit code parziale non basta a decidere una riparazione automatica. Gli eventi storici vengono consultati senza migrazione o rewriting del ledger.
3. La retention non cancella automaticamente un job con ultimo evento `recovered`; il worker verifica il marker durante lo scan e lo ricontrolla sotto lock di admission prima del `rm`. I terminali normali scaduti seguono la retention già esistente.
4. Il recupero dei container resta **manuale**: l'operatore ferma API/worker, usa `orphans.mjs` (dry-run, conferma esplicita per `--apply`) e verifica che non restino container/claim; soltanto dopo può archiviare ricevute e rimuovere in modo esplicito la directory del singolo job. Nessun automatismo distruttivo né API di purge.
5. Copertura Node deterministica con evidence SHA e accesso API, ripetizione recovery idempotente, claim, partial pass/fail, vecchia combinazione `recovered+failed` bloccata per AI repair, retention di job recuperati e cancellazione dei terminali scaduti ordinari.

## Conseguenze e limiti

La garanzia è fail-closed: le prove e i conteggi `maxRetained` dei job recuperati possono accumularsi, richiedendo manutenzione e supervisione prima di accettare nuovi job. I report storici conservano il loro stato originario ma il coordinatore li tratta come non repairable. Non si attesta che Docker abbia davvero arrestato i container, non si implementa high-availability fencing cross-host, recovery unattended, VM rootless collaudata o firma off-host; questi restano nell'epica #2.
