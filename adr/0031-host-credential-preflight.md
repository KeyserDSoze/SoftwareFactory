# ADR 0031 — Host preflight e probe remoto dei profili di credenziali

- Data: 2026-11-16
- Stato: accettato per l'operatività sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/74
- Precedenti: ADR 0021, ADR 0025, ADR 0030

## Contesto
Compose supporta key-file e tenant registry con mount API-only (#73), ma `preflight host` richiedeva una chiave globale inline, contraddicendo il deployment con file/key tenant. Il probe endpoint non può leggere l'intero registro tenant, né richiedere che risieda nella postazione dell'operatore.

## Decisione
1. Selezionare esplicitamente per host il profilo `inline`, `--runner-key-file` oppure `--tenants`; `--operator-registry` è ammesso soltanto per profilo globale. Nessuna inferenza da file disponibili o da chiave placeholder, né fallback quando il profilo richiesto non è valido. L'env host privato definisce directory sorgenti, mentre i path container sono imposti solo dagli override Compose revisionati.
2. Sul vero host (UID 1000) verificare data/work/socket già previsti e tutte le directory private dei secret: path canonico, no symlink su ogni componente, owner e mode 0700, disgiunzione reciproca e da workspace/data. Per i file secret usare `open(O_NOFOLLOW)`, `fstat` e lettura bounded su un singolo FD con metadati stabili e formati coerenti con runtime. La rotazione tramite rename è riletta da un nuovo descriptor; nessun valore/filename è restituito nella receipt.
3. `preflight endpoint` con profilo key-file o tenant deve ricevere `RUNNER_PROBE_BEARER` separato da un `--env-file` 0600; per tenant il bearer è unicamente di un tenant scelto dall'operatore. Il probe riusa GET HTTPS capabilities e OPTIONS CORS, con eventuale Cloudflare Access Service Auth, senza interrogare registry o avviare job; non ricorre a credenziali inline o container file path.
4. Test Node con file reali e rotazione atomica, casi di symlink/hardlink/permessi/schema, mismatch di profili, fallimenti senza secret output; CI mantiene il controllo dei test runner.

## Limiti
Si tratta di verifiche point-in-time, non attestazioni del daemon VM rootless, del socket dopo il controllo, di Cloudflare Access/Tunnel reali né della revoca fra request. Nessun check è eseguito sul browser. Le prove esterne richieste dall'epica #2 rimangono aperte.
