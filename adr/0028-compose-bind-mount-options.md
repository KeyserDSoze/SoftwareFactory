# ADR 0028 — Bind mount con opzioni revisionate e directory credenziali disgiunte

- Data: 2026-11-16
- Stato: accettato come policy statica sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/71
- Precedenti: ADR 0022, 0024, 0026 e 0027

## Contesto

Il controllo Compose precedente verificava i percorsi e la tipologia bind, ma ignorava opzioni avanzate di mount: un override con `bind.propagation: rshared`, relabel SELinux o `consistency` poteva lasciare invariati source/target ed essere dichiarato `passed`. Inoltre la directory degli operatori repair era trattata come API-only se `registry.source !== apiData.source`, senza verificare che non fosse annidata nel workspace host del worker. La directory parent montata dal worker rendeva raggiungibili le credenziali API.

## Decisione

1. Il JSON Docker Compose v2 risolto deve contenere per ogni bind di API e worker soltanto `type`, `source`, `target`, `read_only` (booleano) e `bind`. `bind` può essere assente/vuoto o contenere esclusivamente `create_host_path` booleano, emesso normalmente dal serializzatore per la sintassi short-form; qualsiasi altra opzione o tipo non previsto fallisce. Mantenere i vincoli RW su data/work/socket e RO su operator registry.
2. La sorgente host del registro degli operatori può essere montata solo in API, read-only, e deve essere separata sia dal persistent data dir sia dal worker workspace (né coincidente né parent/child). Il controllo considera i segmenti path e non i prefissi lessicali (`/data` e `/database` restano distinti).
3. Errori statici senza esposizione di path o segreti; test Node parametrizzati per ogni bind, compatibilità con `bind.create_host_path` di Compose v2, casi di directory disgiunta e sovrapposta. Conservare preflight del Compose reale nella Factory CI, con override operatori.

## Limiti

L'allowlist statico non prova il comportamento effettivo del filesystem o gli inode al momento in cui Docker monta le directory: per i percorsi host serve ancora `preflight host`, e gli intervalli TOCTOU vanno mitigati in un host controllato. Le immagini e il daemon rootless VM, Cloudflare Tunnel/Access, fencing e attestazione off-host restano aperti in #2.
