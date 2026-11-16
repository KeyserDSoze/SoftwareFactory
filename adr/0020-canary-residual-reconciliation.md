# ADR 0020 — Riconciliazione manuale dei container canary rootless residui

- Data: 2026-11-16
- Stato: accettato per il runner sperimentale su singolo daemon rootless
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/63
- Precedenti: ADR 0014, 0015, 0016 e 0019; #21, #59, #62

## Contesto

La guardia #62 interrompe ogni comando del canary se il daemon non è più rootless. Se questo succede appena dopo `create`, il canary non può verificare che l'oggetto creato sia sicuro da eliminare e lascia un residuo. La CLI esistente `orphans.mjs` gestisce job con ledger SHA e label `softwarefactory.runner=job`, non il canary `softwarefactory.canary`. Senza il suo UUID di esecuzione l'operatore fatica a trovare il residuo senza indagini generiche.

## Decisione

1. Emettere sullo stderr un `ROOTLESS_CANARY_ID=<UUID>` casuale e **non segreto** prima del comando Docker `create`.
2. Implementare un'interfaccia di riconciliazione separata da API e worker che accetti un solo UUID completo. Il default è dry-run; solo `--apply` unito a `--confirm-canary=<UUID identico>` consente rimozione. Vietare `prune` e target per nome.
3. Prima di ogni `ps`, `inspect` e `rm`, richiedere un probe fresco `probeRootlessDocker({host}) === true`, socket Unix allowlisted, timeout/output limitati ed ambiente Docker senza credenziali. Validare nome, ID pieno, label esatta, profilo non privilegiato del canary e stato fermo `created/exited`; ri-ispezionare per ID subito prima della cancellazione.
4. Non eliminare container attivi o la cui configurazione/identità non sia stabile. Verificare anche l'acknowledgment del comando `rm`. Qualunque incertezza rimane un errore operatore generico senza log del daemon, non un successo. Il conteggio delle risorse residue è quindi una responsabilità manuale.
5. Test Node deterministici su dry-run, conferma, label e nome contraffatti, cambio ID/stato, perdita rootless, errori Docker sanitizzati, CLI non-root e nessun contatto remoto. GitHub CI rootful non certifica una VM rootless.

## Limiti

Una `docker info` appena prima della rimozione non blocca l'eventuale sostituzione del socket fra i processi. Il comando non è fencing multi-host, non conclude automaticamente una recovery e non rimpiazza il collaudo su VM dedicata, Cloudflare Access/IAM e attestazione off-host ancora nell'epica #2.
