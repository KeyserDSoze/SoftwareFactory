# ADR 0134 — riallineamento esplicito della selezione CAS dopo un writer rivale (#185/#139)

## Contesto
L'editor opt-in CAS-only seleziona un token nativo revisione/RAW e il controller è fenced in scrittura. Un'altra tab può avanzarlo: il pulsante ricarica libreria osserva altri progetti, ma NON aggiorna intenzionalmente la selezione per evitare la perdita di bozze. Manca un percorso manuale e sicuro che riapra la nuova revisione.

## Decisione
Su **azione esplicita** nel root `?workspace=cas` il modulo `cas-selected-revision-reconcile.ts` legge lo slot nativo `readonly`, valida ID, revisione monotona e JSON RAW canonico. Distingue `unchanged`, `advanced`, `tombstone`, `missing`; stesso rev/raw divergente, rollback e dati corrotti bloccano. La ricognizione non è autorizzazione a scrivere o rebase. Se il progetto è tombstoned/missing, si sospende il controller scrivibile conservando la revisione vecchia e le bozze in vista per il recupero manuale. Bozze non salvate non vengono scartate o fuse automaticamente: in caso di `advanced` si mostra un avviso e non si può adottare la nuova rev.

Con selezione stabile pulita, l'operatore conferma: (1) download esatto del RAW della VECCHIA revisione storica, (2) conferma di aver salvato il file, (3) consenso finale a passare alla revisione IDB rivale osservata. Dopo il consenso il modulo rilegge ID/rev/RAW esatti; l'UI apre un *nuovo* controller nativo e verifica ancora prima di aggiornare il React state. Un'ulteriore modifica in qualunque intervallo ferma senza merge, retry o overwrite. Nessun legacy writer viene montato nella root CAS. Il file di backup può contenere dati sensibili e prove non riverificate.

## Limiti
Il check resta puntuale: altra tab può committare subito dopo; le future scritture rimangono comunque protette da CAS transaction. Non realizza migrazione completa del live editor, sync cross-device, cloud/PAT, attestazioni runner/review. Il vecchio controller può restare attivo durante un check con bozza ma il CAS nativo respinge qualsiasi scrittura stale. Senza backup confermato nessun rebase.

## Gate
Vitest per compare/consent/revision monotonicity/tombstone/race; Chromium reale 2 tab per unchanged/advanced, sporco, backup e consensi, rival durante dialogo, tombstone, no legacy/reload. Factory CI, Pages e Installer candidate completed/success sul medesimo SHA prima della chiusura.
