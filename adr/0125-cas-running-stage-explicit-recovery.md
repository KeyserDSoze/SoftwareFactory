# ADR 0125 — Recupero esplicito di una fase AI running in IndexedDB (#172)

**Stato:** accepted (23 novembre 2026), limitato al workspace CAS separato, non cutover live.

## Contesto

Il coordinatore CAS registra lo stage **running** in IndexedDB prima di chiamare il provider. Se la scheda si chiude dopo il commit di avvio ma prima della risposta/ACK, il checkpoint resta running al reload, impedendo altre esecuzioni. Il reset manuale generico esiste (#155), ma richiede di scegliere una fase e può cancellare più risultati del necessario.

## Decisione

Esporre un recupero manuale dedicato solo quando vi è **esattamente una** fase running priva di output/fonti/completionOrigin. Gli stadi precedenti devono essere complete e quelli successivi pending senza evidenze. La funzione pura verifica ID/revision/raw canonici, conserva invariati i precedenti e costruisce soltanto il reset della fase interrotta e delle successive. Non avvia AI, build/test, review o pubblicazioni.

Prima del commit: (1) conferma download JSON raw byte-esatto della revisione scelta, (2) attestazione manuale del file salvato, (3) consenso alla modifica. Bozze locali, richieste AI in corso nella stessa scheda, controller non ready e snapshot stale bloccano l'azione. Il commit è native IndexedDB readwrite con confronto ID/revision/raw e ACK solo dopo transaction oncomplete. Se una scheda non cooperativa scrive durante i dialoghi, il recupero perde senza rebase, retry o fallback localStorage.

## Limiti

Non è possibile dedurre se altri browser, schede, richieste al provider o client abbiano smesso di eseguire o addebitare costi. Dopo recovery confermata, l'eventuale risultato AI tardivo con la vecchia revisione non può essere persistito dal coordinatore CAS. Non è fencing multi-device, cancellazione remota, completion attestata né migrazione dei writer live. Le issue #139, #91 e #92 restano aperte.

## Test

Vitest su purezza/snapshot/invalidazione; Chromium reale con due schede, backup byte-esatto, consensi, writer rivale nella conferma finale e persistenza dopo reload, senza JWT/token nei log.
