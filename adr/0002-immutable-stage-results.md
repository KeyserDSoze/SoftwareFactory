# ADR 0002 — Pipeline a checkpoint e revisioni

- Stato: accettato per MVP
- Data: 2026-11-14

Ogni fase AI è distinta e produce un output persistito solo dopo una risposta completa, non-vuota. La revisione di un output invalida gli step successivi. Modifiche al brief o allo stack invalidano tutte le fasi, perché le decisioni non sono più attendibili. La cancellazione via AbortController scarta il risultato incompleto. In futuro si aggiungeranno revisioni immutabili, budget, auditing e lease tra dispositivi.
