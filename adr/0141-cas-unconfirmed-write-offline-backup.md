# ADR 0141 — Copia locale volontaria di un tentativo CAS non confermato (#199)

- Data: 24 novembre 2026
- Stato: accepted per l'incremento limitato #199; epica #139 aperta

## Contesto
Le diagnosi #197/#198 mantengono solo in memoria il ticket old/proposed
quando una transazione nativa non riceve conferma. Un reload elimina il
candidato, soprattutto se contiene una risposta AI non committata. Leggere
lo store e riprovare a scrivere può sovrascrivere un writer concorrente.

## Decisione
Offrire una funzione *pura* e fall-closed per il ticket diagnostico canonico:
record JSON locale v1 con baseline old, proposta proposed, operation/stage,
warning plaintext e marker \`unconfirmed:true\`, \`authoritative:false\`,
\`automaticRestore:false\`. Limiti 1 M caratteri per ogni RAW canonicale
e 6 MB per il file. L'UI mostra il comando soltanto con ticket attivo
e snapshot selezionata esatta; prima del download chiede consenso esplicito.
Nessuna lettura post-failure, transazione IndexedDB, fallback localStorage,
rete/provider, mutazione del ticket, avvio AI o tentativo di riparazione.

Un download offerto non dà un ACK del file salvato. Il file in chiaro può
contenere dati sensibili: può essere usato solo per ispezione offline
volontaria, non come backup autorevole/import automatico.

## Verifiche e limiti
Test Vitest per byte-exactness, metadati contraddittori, ticket non canonici,
e zero I/O. Chromium a due schede con HTTP provider simulato: rifiuto e
accettazione consenso, candidato \`complete\` non confermato conservato
nel file, revisione rivale immutata, nessun secondo invio AI; marker
\`FACTORY_CAS_FAILED_WRITE_BACKUP_E2E_PASS\`. Non prova provider reali,
CAS multi-device, salvataggio file garantito né migrazione del live editor.
