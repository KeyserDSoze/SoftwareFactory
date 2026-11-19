# ADR 0065 — Checkpoint umano del digest PM, separato dalle prove tecniche

- Data: 19 novembre 2026
- Stato: accepted per sottoissue #110 della #109/#105

## Contesto

Il runner mantiene già manifest immutabili di handoff #107 e lease attore
fenced #108. Una lease NON è una completion e non autorizza a dichiarare
che test Docker o lavori AI hanno avuto successo. Occorre sbloccare un
handoff di revisione dopo che **una persona autorizzata** ha approvato
il documento di pianificazione del Project Manager, senza equiparare
un digest controllato a una prova di esecuzione.

## Decisione

Aggiungiamo al file di actor capability privato/0600 il ruolo separato
\`checkpoint_approver\` (tenant-bound). Il PM producer con lease valida
presenta \`submit\` e un digest SHA-256 con UUIDv4 di submission riusabile
nel retry e unità di lavoro autodichiarate, bounded da estimatedUnits.
La submit non cambia lo stato in completed/passed e non permette claim dei
task downstream. Il reviewer umano ricalcola il digest del documento
*fuori* dal runner e approva \`submissionId+artifactDigest\` usando
la **sua** key diversa dal PM, con stesso tenant e differente actor ID.
Il server ricontrolla key e scope sotto il lock POSIX prima del commit.
Né root API key né bearer tenant può approvare un checkpoint PM.

Le transizioni \`submit/approve\` sono eventi aggiunti alla catena SHA-256
già usata per \`claim/renew/release\`: lease e fencing devono essere
correnti, checkpoint solo per ruolo \`project_manager\`, campi whitelist,
digest immutable, hash previous e ordinal validati a ogni read. Retry
identici sono idempotenti e non duplicano un evento/una voce di budget.
Un release, nuova claim o scadenza impedisce l'approval tardivo.

La proiezione dello stato distingue \`awaiting_human_approval\` (evidence
\`not_started\`) da \`human_approved_checkpoint\` (evidence
\`human_approved_digest\`). Una revisione dipendente da PM si sblocca solo
se l'approval indipendente esiste nel journal. Non esistono transizioni
di completion per \`tester\`, \`code_reviewer\` né interpretazioni di
un booleano \`passed\`. \`executions:0\` conserva la distinzione.

Il limite \`approvedReportedUnits\` somma i consumi *autodichiarati*
da PM e approvati da un actor distinto, con cap per task e manifest.
**Non misura consumo effettivo di token, billing o costi cloud**.

## Limitazioni e conseguenze

Il server non conserva né vede il documento. La presenza di un digest
e un actor bearer certifica solo che quella capability ha espresso
un'approvazione del digest; non prova la qualità o esistenza del
documento, una verifica crittografica dell'identità legale del reviewer
o una firma off-host. Un host compromesso può rigenerare hash-chain
locale. Le prove tecniche da runner journal, l'attestazione off-host,
budget provider verificabile e orchestrazione/PM autonomi restano
aperti in #109/#105/#89. VM rootless/Cloudflare reali in #87/#2.
