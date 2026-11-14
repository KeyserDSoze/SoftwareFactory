# Infra della factory

SoftwareFactory è una SPA statica, pubblicabile con GitHub Pages (vedi `.github/workflows/pages.yml`) oppure Docker/nginx. Nessun backend richiesto per l'interfaccia locale.

La cartella `infra/` **all'interno di ogni applicazione generata** contiene il bootstrap Terraform per Azure, AWS, GCP o indicazioni per on-prem/Kubernetes. Non eseguire `terraform apply` in produzione senza completare i moduli infrastrutturali e approvarne il piano.
