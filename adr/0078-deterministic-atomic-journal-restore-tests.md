# ADR 0078 — Test deterministicamente fail-closed del journal durante rename del report

**Data:** 2026-11-20  
**Issue:** #124  
**Stato:** accepted come correzione di test, non come cambio alla semantica delle prove.

## Problema

La Factory CI #44702451226 ha mostrato un singolo test Node flakey: \`runner.test.mjs\` riceve HTTP 409 invece di 200, perché una fixture inietta una finestra di 15ms di discordanza fra report e journal e riscrive \`report.json\` direttamente tramite \`writeFile\` durante la GET. Il writer di produzione invece esegue append/fsync del journal e poi \`atomicWrite\` del report, con rename atomica. Il test dipendeva quindi dal tempo di scheduling del runner GitHub e simulava una modalità di scrittura diversa dalla produzione.

## Decisione

Separare le due proprietà da testare:
1. \`retryEvidenceRead\` continua a essere testato direttamente tramite callback controllata: al primo \`EVIDENCE_INVALID\` ritenta, sull'evidenza permanentemente corrotta fallisce definitivamente dopo il budget bounded, su \`ENOENT\` non ritenta.
2. Per entrambe le API HTTP, impostare il report *stale* in modo atomico, verificare **409** finché il report non coincide col journal, ripristinare la versione esatta con \`atomicWrite\`, poi verificare **200** e il contenuto del report/prova. Non dipendere da \`setTimeout(15)\`, non riscrivere il file in-place in concorrenza.

Non cambiare \`verifyJobEvidenceForRead\` o \`verifyJobEvidence\`, né allungare artificialmente il numero/durata dei retry o accettare risultati parziali. Il test non considera 409 un successo per un job completato: soltanto 409 durante discordanza e 200 con evidenza ricostituita.

## Limiti

È una verifica deterministica delle proprietà fail-closed ed eventual recovery dei lettori, non una simulazione esaustiva di tutti gli interleaving a livello filesystem su host di produzione. Il monitoraggio CI rimane necessario; se compare di nuovo lo stesso 409 senza una discordanza persistente verificata, si apre una nuova investigazione con log concreti.
