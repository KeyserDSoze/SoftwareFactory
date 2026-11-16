# ADR 0037 — Finalizzazione operator-only dei container orfani e audit del runner

- Data: 2026-11-16
- Stato: accettato per il runner sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/80
- Precedenti: ADR 0019, 0020, 0021, 0034, 0036

## Contesto

Le issue #61 e #79 proteggono i journal hash-chain quando un worker crasha o una Docker CLI va in timeout senza cleanup verificata. L'operatore può intervenire manualmente con `orphans.mjs --apply`, ma l'evento non viene annotato nel journal: l'assenza di prova finale blocca indefinitamente la retention oppure incentiva la cancellazione manuale delle evidenze. Inoltre un nuovo evento successivo al legacy `recovered` non deve nascondere la storia di esecuzione interrotta al coordinatore repair.

## Decisione

1. Aggiungere `--finalize` come opt-in solo alla CLI operatore `orphans.mjs --job=<UUID> --apply --confirm-job=<UUID>`. Il normale dry-run e apply mantengono comportamento e sicurezza esistenti. Ogni apply acquisisce un `mkdir .claim` esclusivo, senza TTL override, prima di Docker cleanup; il worker/la retention non possono agire nel frattempo sul medesimo job POSIX. Re-check delle evidenze verificate prima dell'operazione.
2. La cleanup continua a ispezionare per nome e ID Docker completo, confrontando labels/nome/step/ID, e a rieseguire il probe rootless prima di ogni comando. In `--finalize`, dopo tutti i `rm`, un nuovo `docker ps -a` filtrato per label job deve fornire **zero** container residui: output non valido, errore, id residuo, claim o journal variato bloccano l'evento.
3. Permettere la transizione terminale `finished|recovered → reconciled` nel journal fsync, una sola volta. L'evento registra solo un oggetto `reconciliation` minimo (versione, istante, numero rimozioni, `noRemaining:true`). Non cambia digest/tenant, verdict, `finishedAt` o test; il verificatore di export controlla la transizione e vieta nuovi eventi. Il nuovo campo non abilita `passed` né repair AI. La storia `recovered` va controllata su **tutte le voci**, mai solo l'ultima.
4. La retention mantiene protezione per timeout/recovery finché `reconciled` non è l'ultimo evento verificato; allora si applica il TTL tradizionale basato sul `finishedAt` originale, con ulteriore verifica sotto lock `.admission`. L'operatore deve esportare il bundle prima della prossima retention, se necessario per conservazione indipendente.
5. Test deterministici su concorrenza tra operatori, finale con zero/multipli container, failure Docker e residui, append immutabile, legacy `recovered=failed`, retention; smoke Docker reale eseguito sullo stesso flusso in CI.

## Limiti e trade-off

La claim locale vale solo su filesystem POSIX condiviso, non fornisce fencing cross-host; il docker ps finale è un'istantanea e può essere aggirato da un host compromesso o container senza label. La ricevuta è in una chain SHA-256 locale, **non** una firma off-host o garanzia anti-manomissione contro l'operatore host. Consentire la normale retention dopo la finalizzazione elimina nel tempo anche la voce audit locale: esportarla prima se richiesta come prova persistente. CI esegue Docker rootful e non certifica una VM dedicata rootless o Cloudflare Access/Tunnel reali; epica #2 rimane aperta.
