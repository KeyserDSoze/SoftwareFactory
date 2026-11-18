# ADR 0062 — Project Manager AI propone un DAG test, supervisione umana obbligatoria

- Data: 18 novembre 2026
- Stato: accepted per incremento #106 (epica #89)

## Decisione

Al piano manuale #104 aggiungiamo un ruolo Project Manager AI realmente invocabile.
L'operatore sceglie **prima** i test ammessi e autorizza separatamente l'invio
dei soli metadata al provider OpenAI-compatible selezionato tramite routing
per ruolo. Il provider suggerisce ordine e dipendenze JSON; non vede i file
sorgenti del workspace, non sceglie nuovi test e non può avviare job.

Il parser locale impone keys esatte, identificatori allowlisted e set uguale
alla selezione dell'operatore, precedenze solo verso task antecedenti,
max tre per task, no cicli/duplicati e prerequisiti transitive build→test
e Playwright dopo tutti gli step selezionati. Razionali e summary sono dati
non fidati, mostrati come testo. I ruoli per runner e i file da inviare
sono derivati deterministicamente dalla configurazione attuale
dell'operatore; non provengono dalla risposta dell'LLM.

Una proposta è effimera e legata a identità/revisione del progetto, set di
test, profilo/modello/effort. Cambiando qualsiasi componente si scarta,
si abortisce il provider dove possibile e si richiede nuova conferma.
L'eventuale POST /v1/workflows/batch richiede ancora checkbox e conferma
sullo snapshot codice; idempotenza, gate enforced e prove journal sono
esattamente quelli delle ADR 0059–0061.

## Limiti, privacy e controlli

Un provider LLM è un servizio esterno con eventuali costi e policy sulla
privacy. Anche i metadata e il testo del piano implementativo possono
essere sensibili: consenso esplicito e messaggio UI prima di inviarli.
Niente token nel payload, nel manifest o nei log, nessun esito passed
dall'LLM, nessuna approval/push/repair senza altri gate.
Questo NON è un PM che orchestra autonomamente software agents,
budget tokens, leases distribuiti o un report firmato off-host.
Gli sviluppi più ampi restano nell'epica #89.
