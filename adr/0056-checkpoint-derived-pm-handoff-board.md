# ADR 0056 — Piano PM/handoff derivato dai checkpoint, senza esecuzione implicita

- Data: 18 novembre 2026
- Stato: accettato per tranche incrementale
- Feature: #98 (sottoissue #89)

## Contesto

Il catalogo dei ruoli della #89 consente routing reale per sei fasi AI Factory e Code Agent
(developer/reviewer/fix), ma non esiste ancora un coordinatore persistente dei task. Mostrare
tutti i ruoli come agent in esecuzione o segnare i test come superati perché un job è stato
inviato produrrebbe una falsa prova.

## Decisione

- Proiettare dal solo \`FactoryProject\` un DAG **read-only** di 10 nodi:
  sei stage sequenziali, proposta code, review, verifica test, approvazione umana.
- Ogni fase conclusa deve avere sia lo stato \`complete\` sia output non vuoto e tutti i
  predecessori conclusi. Checkpoint incoerenti sono bloccati e non sbloccano dipendenti.
- Il Code Agent rimane l'unico percorso di generazione, verifica della review, interrogazione
  live del runner e approvazione patch. La proposta deve appartenere alla revisione corrente.
- \`lastRunnerEvidence\` è una **ricevuta di invio** e non il report verificato: indica soltanto
  che occorre una verifica live. Il piano **non** assegna mai il test \`completed\`.
- Dopo repair è sempre richiesta una nuova verifica runtime sulla patch corrente, perciò
  l'approvazione del piano resta \`verification_required\` anche con review \`pass\`.
- L'approvazione di una patch mai riparata è visualizzata come disponibile dopo review, in
  accordo al gate già implementato in \`approvePending\`: non modifica tale policy.
- Il piano non viene persistito separatamente: si rigenera con il progetto selezionato, senza
  scritture concorrenti, timer, dispatch, prompt supplementari o credenziali.

## Limiti

Questo è un **proiettore PM per il browser**, non un vero PM autonomous agent, non una coda
durabile e non una prova server-side di esecuzione. I ruoli di Tester e supervisore sono
responsabilità e handoff UI, non worker nuovi. Non conserva receipt verificata del risultato
dopo reload né sostituisce il journal runner: runtime isolation, orchestrazione persistente,
budget, job DAG scheduling, multi-tenant fencing e verifica dei provider reali restano #89/#2/#87.
