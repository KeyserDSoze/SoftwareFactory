# ADR 0088 — Libreria locale: indice ricostruibile e progetto selezionato per scheda

**Data:** 2026-11-20  
**Issue:** #134 (milestone di #92 e #91)  
**Stato:** accepted come hardening local-first; non è un CAS multi-device.

## Problema

Web Locks (#92, ADR 0049) consentono a due schede di modificare **progetti diversi** contemporaneamente. Le copie `softwarefactory.project.library.v1.<id>` sono indipendenti, ma `softwarefactory.project.index.v1` è un array globale salvato con read-modify-write; una scrittura concorrente dell'indice può perdere una voce. Il puntatore attivo globale `softwarefactory.project.v1` può inoltre essere aggiornato dall'altra scheda, causando l'apertura di un progetto non desiderato dopo reload.

## Decisione

- La fonte autorevole della libreria locale è l'insieme delle copie **per ID progetto**. Nei browser Storage standard con `key(i)` e `length`, `listLocalProjects` enumera in sola lettura le chiavi `softwarefactory.project.library.v1.<id>`, valida ID, dimensione (1MB), schema del progetto e `updatedAt`, poi restituisce fino a 40 elementi ordinati. Il vecchio indice condiviso è una cache leggibile soltanto se non è disponibile l'enumerazione; una cache persa, incoerente o con voci ghost non nasconde copie persistenti valide nel browser reale. Anche il cap dei nuovi progetti considera gli slot invece dell'indice.
- Dopo il salvataggio confermato di slot+legacy pointer+index, ogni scheda salva in `sessionStorage` **solo** l'ID del progetto attivo; `loadProject()` usa quell'ID per rileggere lo snapshot autorevole, così un'altra scheda che salva un progetto diverso non cambia il progetto mostrato al reload. Se il puntatore della scheda è valido ma la copia manca, non si apre silenziosamente il progetto attivato dall'altra scheda; si usa un nuovo progetto e si conserva la libreria esistente per recupero manuale. Per progetti legacy privi di puntatore per-tab, resta la lettura del valore globale originario.
- `persistProjectIfUnchanged` e l'exclusive Web Lock per ID restano necessari e non vengono sostituiti. La ricostruzione non scrive o ripara automaticamente snapshot, non fa merge e non trasferisce prove di test/review.

## Limiti e prove

Le `localStorage.setItem` di slot/index/puntatore **non** costituiscono una transazione e non garantiscono serializzabilità contro client obsoleti non cooperativi, profili indipendenti o dispositivi diversi. Il salvataggio può fallire per quota e il recupero richiede backup umano. Le API Storage enumerate servono a recuperare copie già presenti, non a garantire l'esito di scritture concorrenti. Per il vero CAS multi-dispositivo servono protocolli transazionali o revisioni remote con compare-and-swap (vedere #92/#91). Test unitari simulano due sessionStorage isolati con uno Storage condiviso, perdita forzata dell'indice, cap a 40, record corrotti e fallback legacy. CI browser Chromium esistente continua a proteggere l'editor per singolo ID.
