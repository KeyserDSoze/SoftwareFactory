# ADR 0059 — Enforced DAG gates alla claim dei job queued

- Data: 18 novembre 2026
- Stato: accettato, incremento #102 sotto epica #89

## Motivazione

Il registro multi-job #100 sa riconoscere violazioni storiche di ordine, ma non
ferma il worker prima dell'esecuzione. Attivare retroattivamente un gate su
tutti i manifest sarebbe una breaking change e potrebbe sorprendere operatori
che hanno già un workflow osservativo in corso.

## Decisione

Un manifest v2 contiene l'opzione esplicita `enforced:true` con consenso
operatore. Sotto lo stesso lock POSIX delle nuove claim, l'API registra
solo job già ammessi, nel medesimo tenant, tutti queued e senza claim. I job
non possono comparire in due manifest enforced. Il v1 rimane osservativo.

Ogni scan worker legge tutti i manifest sicuri e filtra i job dipendenti;
in più `executeJob` prende il lock, ricontrolla snapshot dei predecessori
tramite journal verificato, e solo allora crea la claim. Non viene eseguito
alcun Docker step quando una dipendenza non è passed; la relativa queue rimane
intatta. Un manifest corrotto o una dipendenza non verificabile impediscono
la claim anziché degradare al comportamento permissivo. Per evitare timestamp
ambigui, lo start può verificarsi solo dopo l'istante di finish del predecessor.

## Cosa non è incluso

Non è un PM autonomo né un dispatcher multi-host: i job sono già ammessi
separatamente dall'operatore, e il worker non invoca AI o applica patch. La
registrazione enforced va eseguita prima del loro avvio: nei sistemi sempre
attivi l'operatore ferma l'worker durante onboarding, oppure in una tranche
futura si aggiungerà API di batch admission atomica. I manifest dipendono
dalla retention dei journal; host non attendibile può riscrivere anche hash
locali. Identità forte, firma, lease distribuite, budgeting e proof off-host
restano #89/#2/#87.
