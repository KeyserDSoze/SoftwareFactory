# ADR 0140 — Diagnosi volatile dei checkpoint pipeline CAS (#198/#139)

## Contesto
ADR 0109 e #156 introducono una sessione nativa distinta per begin/complete/abort/fail. ADR 0139 (#197) copre solo i commit espliciti dell'editor. Una completion tardiva respinta non deve lasciare il riferimento alla vecchia revisione pre-avvio né indurre a richiamare il provider.

## Decisione
La sessione pipeline costruisce il ticket canonico old/proposed prima di ciascuno dei quattro commit nativi, lo conserva in memoria con stage e operazione solo se l'errore blocca la sessione. Nessun ticket da validazione respinta, nessuna ripetizione del CAS, fallback o mutazione ulteriore. Le operazioni valide mantengono la semantica single-use del ticket running di ADR 0109. L'editor conserva la baseline già confermata con oncomplete (quella iniziale se begin fallisce, quella running se begin riesce), invalida il vecchio controller scrivibile e riusa la diagnosi read-only #197 per la proposta non confermata. Non adotta una versione rivale né attribuisce al provider una completion attestata. Eventuale readback dopo ACK resta separato. La diagnosi non invia nuove richieste AI, non scrive storage, non trasporta segreti e non persiste il ticket. Il controllo si perde dopo reload/uscita; l'operatore può usare il normale recupero esplicito di running.

## Test e limiti
Vitest: tutte le quattro transizioni bloccate, baseline e RAW esatti, tentativo tardivo respinto, validazione e successo senza ticket. Chromium due tab con provider HTTP simulato, begin nativo confermato e completion concorrente respinta: baseline r2, vincitore r3 immutato, diagnosi senza nuova chiamata provider, marker FACTORY_CAS_PIPELINE_FAILED_WRITE_DIAGNOSIS_E2E_PASS. Factory CI/Pages/Installer candidate sullo stesso SHA. Non risolve l'esecuzione su provider reali, né migrazione completa del live legacy, né CAS multi-device.
