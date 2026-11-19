# ADR 0067 — Contesto di evidenza upstream per Reviewer, read-only

- Data: 19 novembre 2026
- Stato: accepted come incremento limitato #112; #109/#105 rimangono aperte

## Decisione

Il runner proietta per ogni task `code_reviewer` un oggetto
`reviewContext` derivato dalle sole dependency dichiarate nel DAG.
Per un predecessore PM approvato mostra il digest dell'artefatto con
l'identificativo dell'approvatore; per un Tester mostra i metadata della
prova realmente verificata (`jobId/digest/head/count/step`). Le
dependency non concluse sono marcate `not_started`.

Solo quando esiste almeno una dependency e tutte hanno evidenza di
completion il runner produce un fingerprint SHA-256 canonico e
domain-separated (`agent-review-context-v1`, `handoffId`, `taskId`,
lista ordinata di prove). Altrimenti il fingerprint è `null`.
Il dato non viene serializzato nel manifesto: è ricostruito per ogni
POST/GET, dopo verifica della SHA-chain e dei journal tecnici originali.

## Sicurezza e limiti

Il fingerprint prova **solo l'identità dei metadata upstream presenti
nel registro al momento della lettura**; non è hash di una patch né
attesta autenticità del modello AI, ispezione sorgenti, costo token,
approvazione della review, firma off-host o sicurezza contro la
compromissione dell'host. La lease Reviewer resta una capability:
nessun evento `review_verified`, nessun `passed` inventato, nessuno
sblocco del DAG. Senza dependency il task può risultare claimable
secondo la policy preesistente, ma il reviewContext rimane privo di
fingerprint. Le completion Code Reviewer con prova di snapshot
e approvatore indipendente restano lavori della #109.
