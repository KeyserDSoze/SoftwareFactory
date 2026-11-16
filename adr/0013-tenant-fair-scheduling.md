# ADR 0013 — Fair scheduling verificabile sul volume del runner multi-tenant

- Data: 2026-11-16
- Stato: accettato per runner sperimentale su singolo volume POSIX
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/56
- Precedente: ADR 0005

## Contesto

Dopo la #52, i tenant hanno quote separate ma i job rimangono in una coda condivisa, consumata in ordine `acceptedAt`. Una lunga sequenza del tenant A può far attendere un job B anche quando B non ha mai avuto un turno. Non è disponibile un database transazionale distribuito, e lo scheduling non deve accettare un tenantId da una richiesta client come fonte autorevole.

## Decisione

1. Solo i report e journal di job conservati e verificati tramite `verifyJobEvidence` contribuiscono allo scheduling. Non si introduce stato per-tenant in memoria persistente, header di rete, nuovi file o autorizzazioni.
2. Per ogni tenant si prende il più vecchio job `queued` senza claim; i job legacy senza tenantId sono un gruppo distinto. `acceptedAt` e UUID stabiliscono l'ordine deterministico interno.
3. Tra i candidati scegliere prima un tenant mai avviato nei report conservati, poi quello che ha il `startedAt` più vecchio tra i suoi avvii validi. I `running` claimed e job terminali avviati contano, mentre i preflight rifiutati senza `startedAt` non contano. Lo start più recente per tenant è ricostruito a ogni scan.
4. Il worker conserva claim atomiche, controllo journal/digest e i gate di esecuzione. Con soli job legacy la priorità rimane FIFO globale.
5. Test Node deterministici e veri file di job verificati provano alternanza A-B-A-B-A, claimed, compatibilità legacy e assenza di retry terminale.

## Trade-off e limiti

La fairness è best-effort: la retention elimina lo storico più vecchio, gli orologi possono avere skew, e più host con filesystem non condiviso non hanno turni sincronizzati. Un tenant con un solo job non ottiene una latenza garantita; risorse dei container e Docker daemon restano condivisi. Non sostituisce IAM, policy di isolamento per tenant, attestazione off-host, fencing HA, Cloudflare Access e test rootless reali, ancora nella #2.
