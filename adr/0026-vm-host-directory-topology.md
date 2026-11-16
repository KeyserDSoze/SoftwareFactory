# ADR 0026 — Il preflight VM usa la stessa policy di path del Compose

- Data: 2026-11-16
- Stato: accettato per il runner sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/69
- Precedenti: ADR 0014, ADR 0021, ADR 0022 e ADR 0025

## Contesto

La validazione Compose non autorizza data e workspace sovrapposti; `validateHostEnvironment` verificava solo che non fossero path identici. Il preflight della VM poteva quindi riuscire quando un mount della workspace conteneva la directory delle evidenze. Inoltre `inspectHost` chiamava `lstat` solo sul path finale: un symlink in un componente parent veniva seguito dal kernel, aggirando la verifica `isSymbolicLink()` della leaf.

## Decisione

1. Usare la stessa policy di bind host del Compose per `RUNNER_DATA_DIR` e `RUNNER_HOST_WORK_DIR`: path assoluti e canonici, nessuna directory sotto /etc,/proc,/sys,/dev,/run,/tmp,/root e nessun nesting, in entrambe le direzioni. Confrontare confini di segmento; i prefissi simili non implicano contenimento.
2. Prima del probe Docker, eseguire `lstat` per ogni componente parent e leaf delle directory dati/workspace e del socket Unix dedicato, rifiutando parent symlink, segmenti mancanti e intermedi non directory. Usare lo stesso snapshot finale per verificare tipo, UID 1000 e mode privato, senza secondo lookup volontario della leaf.
3. Non stampare percorsi, dettagli FS o daemon in errori. Test Node deterministici su nesting, path traversal, directory di sistema, nomi simili, parent symlink effettivi e mancata chiamata Docker in caso di invalidità.

## Trade-off e limiti

Una serie di `lstat` non impedisce che un parent sia sostituito **dopo** la verifica, né identifica un daemon malevolo che cambia socket fra probe e operazione. Una futura evoluzione potrà usare `openat2`/traversata FD vincolata al filesystem per chiudere la race. Il test CI con mock di ownership e un filesystem temporaneo non è la prova su VM Docker rootless con Cloudflare Access reale. Sono ancora necessari deployment, audit remoto e attestazione indipendente nell'epica #2.
