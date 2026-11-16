# ADR 0017 — File operatori repair letto da snapshot stabile del descriptor

- Data: 2026-11-16
- Stato: accettato per MVP sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/60
- Contesto: #31, #32 e confronto con `runner-auth.mjs` / `tenants.mjs`

## Problema

La registry operatori repair hot-reload si basa su un file riservato all'utente API, aperto con `O_NOFOLLOW`. Si verificavano UID/mode/link prima della lettura ma non si confrontavano byte effettivamente letti e metadati dopo. Una modifica in-place poteva produrre una registry JSON valida ma composta da dati che non erano quelli del file approvato al momento del controllo.

## Decisione

1. Un singolo file descriptor `O_RDONLY | O_NOFOLLOW` è l'autorità per tutti i controlli, prima e dopo la lettura.
2. Confrontare i metadati pre/post: file regolare, UID API, permessi solo owner, nlink=1, size positiva <= 10KiB, dev/ino/uid/gid/nlink/mode/size/mtimeMs/ctimeMs invariati.
3. Leggere esattamente `size` byte, senza accettare EOF anticipato o byte eccedenti. Solo dopo i controlli invocare il parser delle capability; fallire con `REPAIR_AUTH_UNAVAILABLE` senza diagnostica e senza fallback al file precedente.
4. Conservare hot-rotation per rename atomico di un file completo, evitando scritture in-place. Lo snapshot di un lettore già aperto non è retroattivamente invalidato dal cambio di pathname; la reauthorization sotto lock verifica le credenziali correnti prima di una nuova mutazione.
5. Coprire la decisione con test Node deterministici di scrittura concorrente same-size, append, truncate, chmod/link, letture EOF, e le suite di API a due istanze e revoca esistenti.

## Limiti

Il filesystem locale non è un identity provider e il doppio stat non protegge da un amministratore privilegiato che controlla l'host o modifica i timestamp arbitrariamente. IAM federato, MFA, enforcement two-person reale, attestazione off-host e VM rootless collaudata sono ancora nelle epiche #2 e #9.
