# ADR 0068 — Snapshot sorgenti da input runner, non da dichiarazioni di Reviewer

**Data:** 2026-11-19  
**Issue:** #114 (parte di #113, #109, #105)  
**Stato:** accepted per descriptor locale read-only, NON per completion/review attestata

## Contesto

La #112 lega il reviewer ai digest delle prove upstream. Il digest di job di #111 include anche label e step: non identifica, da solo, il file set effettivamente passato al worker. Non possiamo permettere che l'agent fornisca un hash di sorgente o un verdetto come prova.

## Decisione

Su ogni read di un handoff con `test_verified`, riaprire `jobs/ID/input.json` con le guardie già disponibili (`O_NOFOLLOW`, owner UID, file singolo, stable fd), ricalcolare `validateRequest` e confrontare i dati canonici, il digest completo, il numero di file, i byte e gli step contro il report con journal hash-chain. Errori di lettura, rimozione o mismatch sono errori di prova, non un test passato. Non inserire i sorgenti né nuove copie della snapshot nel manifesto.

Per il solo Code Reviewer, usare i Tester **direttamente dipendenti**: un source digest SHA-256 separato e domain-separated sul mapping sorted files, poi un fingerprint che lega source digest a handoff ID, task ID e `reviewContext.fingerprint`. Un reviewer senza Tester diretto non ha una snapshot testata; dipendenze incomplete non producono fingerprint; test con file diversi non producono una singola snapshot e bloccano la claim. Un checksum descrive soltanto i file inclusi nel job, non l'intera repository.

## Conseguenze e confini

Le letture richiedono la conservazione di `input.json` oltre al journal/report; retention o manomissione sospendono l'uso dell'evidenza. L'API non restituisce file, token o lease private. Lo SHA locale non resiste alla compromissione dell'host e non attesta che un reviewer umano/LLM abbia visto la patch: nessuna route di review submit/approve viene introdotta qui. Richiedere approval indipendente e provenienza dell'atto di review in #113; costi provider e firma off-host in #109/#105.
