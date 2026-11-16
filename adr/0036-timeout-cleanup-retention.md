# ADR 0036 — Preservare evidenza dei timeout Docker senza cleanup verificata

- Data: 2026-11-16
- Stato: accettato per il runner sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/79
- Precedenti: ADR 0019, 0020, 0021, 0030, 0031, 0034, 0035

## Contesto

La CLI Docker viene terminata dopo il timeout, ma il suo container può essere rimasto attivo. La sottoissue #58 ha introdotto cleanup mirata con verifica di rootless e identità Docker due volte; il risultato del cleanup però veniva atteso e scartato, lasciando sul report soltanto `timedOut`. Il job finiva `incomplete` e la retention ordinaria eliminava dopo 24h il journal di un timeout non verificato. La protezione #61 copriva solo i job recuperati dopo crash con ultimo evento `recovered`, non i timeout ordinari.

## Decisione

1. `runDockerStep` deve attendere la cleanup anche quando `SIGKILL` provoca un evento close sincrono; esportare `cleanupVerified` soltanto per timeout, booleano `true` esclusivamente su ritorno esattamente `true` dal cleanup d'identità. Errori, output ignoto o assenza del container => `false`. Nessun `passed`/exit code reale è dedotto da uno step scaduto.
2. `executeJob` conserva il flag nei risultati redatti di `step` e `npm-prepare`, che entrano nella chain di evidenza. Timeout sono problemi di esecuzione non verificati: job `incomplete`, niente AI repair. Il summary dichiara la necessità del manual reconciliation se il cleanup è incerto.
3. La retention del worker deve preservare i job terminali con un timeout non sicuramente ripulito in `results` o `preparation`, **anche se vecchi o legacy privi del flag**. Lo scanner verifica il journal e ricontrolla la stessa condizione sotto `.admission`, prima di `rm`. Se cleanup è verificata, resta possibile la retention standard.
4. L'operatore usa `orphans.mjs` su UUID esatto, dry-run e consenso per la rimozione per full-ID; stop dei worker prima di intervenire. Il journal non viene eliminato automaticamente a posteriori.

## Conseguenze e limiti

La retention può conservare indefinitamente dati e occupare quota finché non interviene l'operatore: scelta fail-closed deliberata contro cancellazione delle prove di possibili orfani. `cleanupVerified:false` indica incertezza, non dimostra un container attivo. La firma del journal resta locale; daemon o host compromessi possono mentire. CI Docker rootful, VM rootless dedicata e Cloudflare Access/Tunnel live restano distinti (#2).
