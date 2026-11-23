# ADR 0131 — ripristino delle tombstone dalla root CAS-only (#179/#139)

## Decisione

Il percorso root \`?workspace=cas\` può ripristinare una copia **già eliminata** senza riaprire il writer legacy. Il file scelto manualmente, fino a 1,5 MB, è raw project JSON oppure envelope di recupero v1. La preparazione usa il parser storico e una lettura nativa di tombstone per ID/revisione, senza scritture, rete o localStorage.

Dopo due conferme distinte che mostrano ID e generazione, il protocollo nativo rileggge la tombstone e usa **una sola transazione IndexedDB readwrite** con confronto atomico revision+ID e limite 40. Nessun ID missing o progetto present viene mai sovrascritto. Il successo è attestato solo da tx.oncomplete; post-ACK readback/elenco sono osservazionali, e una race/ACK incerto vieta retry automatici o silent rebase. Non vi è apertura automatica della copia ripristinata.

## Limitazioni

Il backup riporta anche storico AI/Code Agent/test/review/runner/GitHub, che NON diventa nuova evidenza o autorizzazione di pubblicazione. La UI IT/EN chiarisce questa distinzione sia prima del consenso sia dopo l'ACK. Restano fuori scope writer live legacy, CAS cross-device, PAT/Drive/OneDrive reali, rootless VM (#139/#91/#92/#90).

## Gate

Unit test \`cas-isolated-tombstone-restore.test.ts\`, test Chromium reale a due schede \`FACTORY_CAS_ROOT_TOMBSTONE_RESTORE_E2E_PASS\`, Factory CI/Pages/Installer candidate completed/success sul medesimo SHA prima della chiusura.

Il test E2E browser aggiunto su main include il marker `FACTORY_CAS_ROOT_TOMBSTONE_RESTORE_E2E_PASS` e verifica che il contenuto di backup storico rimane storico e non diventa attestazione fresh.
