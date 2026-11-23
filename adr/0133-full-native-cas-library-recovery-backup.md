# ADR 0133 — Snapshot atomico e backup ZIP completo della libreria CAS (#183/#139)

## Motivazione
L'export del progetto selezionato (#159) non copre i rimanenti ID nativi. Gli strumenti per la migrazione devono permettere all'operatore di creare una copia offline coerente, senza confondere il backup con cloud sync, attestazione di review/runner o permesso di recupero.

## Decisione
Il primo passo chiama `readCasLibraryBackupSnapshot()` solo su azione manuale: un'unica transazione IndexedDB `readonly`, con cursor sullo store `projects`, valida tutte le righe, esige JSON RAW canonici per gli attivi, registra tutte le tombstone soltanto come ID/revisione. Hard cap: 40 attivi, 256 tombstone, 16.000.000 caratteri cumulativi di RAW (ogni RAW max 1M). Qualunque anomalia manda in abort e produce zero risultati. Non si accede a localStorage, sessionStorage o reti.

Il ticket in memoria è congelato, ordina gli ID e vincola l'intero inventario. Due consensi umani precedono la conferma: la libreria viene **riletta integralmente** subito dopo il consenso e ancora dopo gli SHA-256; qualsiasi new/update/delete/restore/tombstone mutata provoca fail-closed e nessun ZIP. Dopo il secondo controllo il manifest include formato/schema v1, avviso di storico in chiaro, SHA-256 per ogni file JSON RAW esatto, revisioni e tombstone solo metadata; non crea file JSON per progetti cancellati. Le SHA-256 non sono firme né atti di code review o runner. Lo ZIP è generato localmente tramite `fflate` e il download offerto solo dopo tutte le verifiche. Un consenso finale di 'file salvato' è dichiarazione umana, NON ACK di filesystem.

## Limiti e minacce
File storici e brief possono contenere segreti inseriti dall'utente: NON si afferma che lo ZIP sia privo di dati sensibili. Nessuna trasmissione automatica o crittografia; custodire offline. È uno snapshot coerente in un singolo momento **same-origin/browser profile**, non una transazione che blocca altre tab dopo il check: la libreria può cambiare più tardi. Nessun import ZIP automatico, restore multi-progetto, garbage collection tombstone, sync multi-device, migrazione dei writer legacy, nuova prova di test/runner/GitHub.

## Test e gate
Unit test per canonicalità/limiti/consenso/race dopo preflight e durante SHA-256/ticket alterati, Chromium reale 2 tab per ZIP, manifest+raw, rifiuto e conflitti, corruzione/limite e reload. Factory CI, Pages e Installer candidate `completed/success` stesso main SHA prima della chiusura.

## Compatibilità ZIP prima del download (#192)
Il limite di 16 milioni di caratteri JSON (UTF-16) NON implica che il file ZIP abbia dimensione inferiore ai **20 MB** ammessi dal restore #189: molti caratteri Unicode poco comprimibili possono espandersi a più byte UTF-8 per carattere. Dopo i due consensi e i due readback, la funzione pura `encodeCasLibraryRecoveryZip` genera lo ZIP localmente, confronta la dimensione COMPRESSA con lo stesso limite del parser e passa **il ZIP prodotto** attraverso `parseCasEmptyLibraryBackupZip` per validare v1/path/manifest/digest/RAW/revisioni/tombstone. Soltanto dopo questi gate la UI crea object URL e offre il download; su fallimento, mostra errore IT/EN e consiglia backup JSON individuali. Non riduce il limite d'import o espone i RAW nei messaggi. È un preflight di compatibilità, non una garanzia di scrittura su disco, autenticità storica, test o restore su un dispositivo realmente nuovo.
