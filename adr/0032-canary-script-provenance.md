# ADR 0032 — Verifica dello script canary e delle opzioni namespace in Docker inspect

- Data: 2026-11-16
- Stato: accettato come gate del runner sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/75
- Precedenti: ADR 0019, 0020, 0024, 0029 e 0031

## Contesto

Il canary crea un container usando `node -e <sentinel>` e si aspetta il marker `SF_ROOTLESS_CANARY_OK`, ma il validatore `safeConfig` controllava solo l'entrypoint Node, l'output e parte dei campi HostConfig. Uno script sostitutivo che stampa il marker potrebbe superare l'inspect senza aver controllato UID, CapEff, interfacce di rete e /tmp. `HostConfig.SecurityOpt.some(no-new-privileges)` inoltre consentiva ulteriori elementi come `seccomp=unconfined`; i namespace PID/IPC/UTS/userns/cgroupns host non erano ispezionati.

## Decisione

1. `safeConfig` verifica che `Config.Cmd` contenga esattamente `["-e", sentinel]`, usando lo stesso sorgente immutabile di `buildRootlessCanaryArgs`; lo stdout rimane condizione necessaria ma non sufficiente. Il check prima/dopo lo start e la cleanup per identità restano obbligatori.
2. `HostConfig.SecurityOpt` può contenere un solo `no-new-privileges` (anche con suffix `:true` emesso dal serializer) e non può includere altri profili. I namespace devono essere assenti/vuoti/`private`, mai host/container; negare DNS/hosts/links, device requests, group additions, sysctls, parent cgroup e tmpfs supplementari. L'assenza di mount e privilegio rimane vincolante.
3. La riconciliazione con ID preciso del container riusa `safeConfig` e non cancella un oggetto non conforme; è accettata una richiesta di indagine manuale dei residui di canary legacy. Test Node parametrizzati e smoke Docker reale su GitHub Actions verificano le regole compatibili col serializer effettivo.

## Limiti

Il daemon può mentire in inspect ed è un confine di trust: nessun checksum locale prova esecuzione avvenuta contro amministratore host compromesso. Il canary rootful dello smoke GitHub usa un override di test interno e non sostituisce un collaudo VM rootless, Cloudflare Access/Tunnel reali, fencing o una attestazione off-host indipendente (#2).
