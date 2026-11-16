# ADR 0021 — Input privato di preflight letto da FD immutabile durante l'operazione

- Data: 2026-11-16
- Stato: accettato per il runner sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/64
- Precedenti: ADR 0017 (file operatori repair), ADR 0014 (gate rootless)

## Contesto

Il preflight legge una configurazione privata `--env-file` con token di accesso e API key. La precedente implementazione validava `lstat(path)` e apriva separatamente `readFile(path)`. Una sostituzione del pathname fra le operazioni poteva bypassare i controlli di sicurezza sul file letto. Mancavano owner UID, link count e un limite di dimensione, rendendo una verifica di deployment vulnerabile ad input alterati o consumo di memoria.

## Decisione

1. Aprire un solo FD `O_RDONLY|O_NOFOLLOW`; non seguire symlink e negare le piattaforme senza il flag. Esigere uid dell'effective user, file regolare, un solo hard link, permessi esatti `0600` e size 1..32768 byte.
2. Usare lettura bounded dall'offset zero fino a **esattamente** il `size` iniziale, rifiutando EOF prematuro o conteggi impossibili; confrontare un secondo `fstat` dello stesso FD per dev/ino/UID/GID/nlink/mode/size/mtimeMs/ctimeMs, poi e solo poi interpretare la sintassi esistente del file.
3. Restituire errori statici e senza contenuti per tutti i fallimenti di apertura/lettura/snapshot; chiudere sempre il FD. Non ereditare credenziali non verificate né riutilizzare una configurazione precedente. Consentire rotazione del file completo con rename atomico fra invocazioni.
4. Coprire con test Node deterministici owner/mode/size/symlink/hardlink, append/truncate/chmod, riscrittura same-length, EOF corto e snapshot di inode alterato. L'eventuale `openFile` iniettato è solo codice dei test, mai API o input job.

## Limiti

La verifica di stabilità del file non protegge da un amministratore ostile con controllo del filesystem, né fornisce il legame atomico tra host e daemon Docker. Il collaudo in una VM Docker rootless e un endpoint HTTPS Cloudflare Access veri, con attestazione off-host e fencing, resta aperto in #2.
