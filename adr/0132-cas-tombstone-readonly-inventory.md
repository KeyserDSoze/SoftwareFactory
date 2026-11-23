# ADR 0132 — Inventario delle tombstone native in sola lettura (#181/#139)

## Contesto
La primitiva `readCasProjectSlot(id)` (#142) ispeziona una tombstone solo quando l'operatore già conosce l'ID. Il restore da file (#179) richiede backup e tombstone, ma la libreria mostra solo i record attivi.

## Decisione
`listCasTombstones()` usa il database CAS v1 esistente e un'unica transazione IndexedDB `readonly` con cursor. Convalida ogni riga, anche quelle attive, mediante `checkId` e `readRow`; corruzione, più di 40 righe attive, più di 256 tombstone o abort danno **errore totale**, mai una lista parziale. Espone esclusivamente `{id, revision}` senza raw, nomi, evidenze o credenziali. L'utente avvia la scansione manualmente dal root `?workspace=cas`: nessuna enumerazione automatica in mount, nessuna scrittura, auto-select, restore, cancellazione o lettura di `localStorage`. Bozze e selezione restano intatte. L'inventario viene invalidato dopo refresh, delete o restore.

## Sicurezza e limiti
Le tombstone sono osservazioni puntuali, non ticket e non consensi. Una tab rivale può cambiare un record dopo lo scan. Il restore resta condizionato a backup JSON completo, due conferme e confronto atomico della revisione nativa nella transazione di #179. Non c'è recovery senza backup, garbage collection automatica, migrazione dei writer legacy o CAS multi-device.

## Prove
Unit test per IndexedDB non disponibile e errore sanitizzato, Chromium reale due tab con elenco dopo delete, stale snapshot, ripristino, reload, corruzione rifiutata, nessuna mutazione legacy. Gate Factory CI, Pages e Installer candidate sul medesimo commit prima della chiusura.
