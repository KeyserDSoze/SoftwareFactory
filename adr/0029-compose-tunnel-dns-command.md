# ADR 0029 — DNS del tunnel e comando cloudflared fissati nel preflight Compose

- Data: 2026-11-16
- Stato: accettato come policy statica del deployment sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/72
- Precedenti: ADR 0024, 0025, 0027, 0028

## Contesto

Il gate di rete #70 accetta una sola rete Compose `default`, ma l'opzione `extra_hosts` può alterare il mapping di `runner-api` in `/etc/hosts` di cloudflared e deviare il tunnel senza introdurre una rete aggiuntiva. `dns`, `links` e altri override del nome host/identity non erano verificati. Anche `cloudflared.command` era liberamente sostituibile, benché fosse fissata l'immagine.

## Decisione

1. Per API, worker e tunnel, rifiutare `extra_hosts`, `links`, `dns`, `dns_search` e `dns_opt` non vuoti e ogni `hostname`, `domainname`, `container_name`, `mac_address`, `network_interface_name`. Un array vuoto è neutro e può essere emesso da Compose v2.
2. Il Compose base imposta `user: "1000:1000"` e `read_only: true` anche sul tunnel. Il preflight ammette l'immagine approvata solo con comando normalizzato in array di 5 argomenti `["tunnel", "--no-autoupdate", "run", "--token", token]`: token ASCII stampabile 16–4096 caratteri, non inizia con trattino e non contiene spazi o caratteri di controllo. Nessun environment custom o hook/entrypoint è consentito.
3. Le verifiche restituiscono solo messaggi statici, senza stampare token, indirizzi o config Compose. Test Node coprono le mutazioni dei tre servizi e varianti avverse del comando; nella CI la CLI di preflight legge il JSON reale Docker Compose v2 includendo il profilo tunnel e l'override operator registry opzionale.

## Limiti

Il token non viene autenticato dal controllo sintattico; gli endpoint effettivi, il DNS a runtime, il tag `latest` mutabile, Cloudflare Access, la VM Docker rootless, fencing e attestazione off-host richiedono verifiche indipendenti (#2).
