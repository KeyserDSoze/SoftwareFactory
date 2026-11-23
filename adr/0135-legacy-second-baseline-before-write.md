# ADR 0135 — secondo fence della baseline prima del commit locale legacy (#186 / #92 / #139)

## Contesto
Il legacy `persistProjectIfUnchanged(project,expected)` verifica subito `localProjectSnapshot(project.id)===expected`, poi richiama `persistProject()`. Questa serializza il progetto, scansiona fino a 40 slot per applicare capacity e ricontrolla il retirement marker, prima di scrivere nel per-ID authoritative slot. Mentre queste letture avvengono, uno script vecchio o un'altra tab non cooperativa può aggiornare/creare direttamente la stessa chiave: il preflight iniziale non basta.

## Decisione
La versione checked invoca un helper privato `persistProjectInternal(project,{expected})` che conserva `expected` **senza aggiornarla** durante enumerazione. Immediatamente prima di `localStorage.setItem(slot,raw)`, dopo la validazione e il secondo guard retirement, legge di nuovo `localProjectSnapshot(id)` e impone ancora uguaglianza con la baseline iniziale. Se diverso, fallisce **senza nessuna scrittura propria** (slot/caches/session). Il percorso diretto `persistProject(project)` mantiene API e comportamento esistenti, incluso il retirement marker, e non può fingere un CAS con baseline implicita. I caller correnti dell'editor legacy passano tutti da `persistProjectIfUnchanged`.

## Sicurezza e limiti
Questo fence chiude una finestra di validazione, **non** rende la coppia get+set atomica; un writer vecchio/profilo separato può ancora interleavare dopo l'ultimo get. Web Locks coordinano solo i writer consenzienti; non è IndexedDB nativo, transazione, rollback, autoconvergenza né sync multi-device. Eventuali scritture fallite rimangono rifiutate e richiedono il percorso di recupero con backup; non ritentare automaticamente l'insert `expected=null`. La chiusura di #139/#92 richiede ancora conversione dei live writer, test crash e provider/dispositivi reali.

## Verifica
Vitest: iniezione deterministica di modifica update dopo primo get durante `listLocalProjects`, creazione concorrente di ID inizialmente assente durante scansione di altro record, successo senza race, scrittura diretta compatibile. Chromium reale due tab: codice locale `Storage.prototype.getItem` simula precisamente la mutazione non cooperativa nello scanning, la seconda tab verifica bytes rivali e metadati invariati, reload. Marker `FACTORY_LEGACY_SECOND_BASELINE_E2E_PASS`. Factory CI/Pages/Installer candidate success stesso SHA prima di chiudere #186.
