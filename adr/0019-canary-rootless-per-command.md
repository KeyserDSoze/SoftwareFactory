# ADR 0019 — Il canary richiede prova rootless fresca prima di ogni operazione Docker

- Data: 2026-11-16
- Stato: accettato per runner sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/62
- Precedenti: ADR 0005, 0014, 0015, 0016; #57, #59

## Contesto

La CLI `rootless-canary.mjs` avvia un container Node per verificare l'isolamento locale (UID non-root, rete disabilitata, filesystem read-only, no effective capabilities, limiti). Il probe rootless avveniva **una sola volta**, prima del `create`, e autorizzava implicitamente tutti i successivi inspect/start/rm. Un daemon sostituito o degradato lungo la sequenza poteva essere contattato senza la prova di isolamento rootless corrente, compresa un'operazione distruttiva di cleanup.

## Decisione

1. Spostare il controllo `probeRootlessDocker({host}) === true` direttamente nell'unico wrapper `command` che esegue ogni chiamata Docker del canary. Non mantenere alcun valore cached tra le operazioni. Se rootless non è dimostrato, fermare prima di invocare `runDocker`.
2. Fare lo stesso controllo anche su ogni inspect e su `rm -f <full container ID>`, non solo sull'avvio. Le regole di identità, label e sicurezza del container rimangono invarianti.
3. Conservare l'errore generico del canary senza includere diagnostiche o segreti del daemon. Se la CLI ha già creato un container ma il cleanup non è verificabile, non dichiarare successo e richiedere la riconciliazione manuale dell'operatore. Non esporre callback di probe a HTTP/API o payload job.
4. Testare in Node, con probe stateful fidato, i cambi rootless→rootful prima di inspect, start e rm, la riabilitazione successiva e throw contenenti secret. Il rootful Docker smoke della CI usa un callback interno **esclusivamente** nel file `rootless-canary-ci-smoke.mjs` con guardia CI/GITHUB_ACTIONS/UID non-root, per validare il ciclo di vita Docker senza fingere una VM rootless.

## Trade-off e limiti

I probe per ogni comando aumentano il tempo di esecuzione del canary. La verifica è just-in-time ma non è un legame atomico fra `docker info` e comando successivo: la sostituzione del socket nell'intervallo rimane fuori dal modello, come gli attacchi da amministratore host compromesso. Per completare l'epica #2 occorrono un test operativo su VM Docker rootless dedicata, Cloudflare Access/IAM, fencing e attestazione indipendente.
