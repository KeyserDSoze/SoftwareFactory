# ADR 0022 — Il preflight Compose deve verificare l'intero stack risolto

- Data: 2026-11-16
- Stato: accettato per il runner sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/65
- Collegamenti: ADR 0014 (gate rootless), ADR 0021 (preflight env)

## Contesto

Il preflight di Docker Compose considerava solo due servizi noti e l'eventuale tunnel, senza validare la cardinalità o i nomi degli altri servizi nel JSON risolto. Un override poteva aggiungere `debug` con `privileged`, mount Docker socket e porta pubblica, e mantenere un risultato `status:passed`. I bind mount di `cloudflared`, anche verso directory host con segreti, passavano purché non sembrassero socket.

## Decisione

1. Definire una allowlist esatta dei servizi `runner-api`, `runner-worker`, `cloudflared` opzionale. Un servizio nuovo richiede proposta, review, test e ADR, non viene ignorato automaticamente.
2. Vietare in `cloudflared` mount di qualsiasi tipo, volumi ereditati, tmpfs, dispositivi, namespace condivisi, cap extra e pubblicazione host. Il tunnel mantiene soltanto traffico di rete necessario verso l'API.
3. Canonicalizzare il controllo degli host bind mount: no path relativi/noncanonici, no mount di `/` o directory di sistema, no data/work sovrapposti. Unica eccezione: `/run/user/1000/docker.sock` montato come `/run/docker.sock` **solo** nel worker, previa verifica host rootless.
4. Test Node positivi sui Compose noti e negativi su sidecar rootful, tunnel mount/namespace e percorsi problematici. Nessun segreto o JSON Compose va stampato in caso di rifiuto.

## Limiti

Le regole si applicano al JSON Compose risolto e non analizzano symlink o inode host. Una VM compromessa può mutare l'host dopo il preflight. Servono ancora `preflight host/endpoint` su VM e Cloudflare Access reali, fencing e attestazione indipendente, tutti nell'epica #2.
