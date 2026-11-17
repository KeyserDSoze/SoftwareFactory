import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Server, ShieldAlert, Terminal } from "lucide-react";
import { probeRunnerConnector, runnerEndpoint, type RunnerConnectorProbe } from "../infrastructure/runner";
import { readSecret } from "../infrastructure/store";

type Host = "local" | "server";

/**
 * Guided, non-destructive install/link flow. The browser never runs shell,
 * uses SSH or downloads the runner host's secrets.
 */
export default function RunnerConnectorSetup({ endpoint, authRevision }: { endpoint: string; authRevision: number }) {
  const [host, setHost] = useState<Host>("local");
  const [status, setStatus] = useState<RunnerConnectorProbe | null>(null);
  const [checking, setChecking] = useState(false);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    active.current?.abort();
    setStatus(null);
    setChecking(false);
    return () => { active.current?.abort(); };
  }, [endpoint, authRevision]);

  const checkConnection = async () => {
    active.current?.abort();
    setStatus(null);
    try { runnerEndpoint(endpoint); }
    catch {
      setStatus({ state: "api-unavailable",
        detail: "Inserisci un URL HTTPS valido oppure http://localhost:8787, senza path, parametri o password." });
      return;
    }
    const key = readSecret("runner.key");
    if (key.length < 32) {
      setStatus({ state: "auth-failed", detail: "Inserisci prima la chiave del runner (almeno 32 caratteri)." });
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setChecking(true);
    try {
      const result = await probeRunnerConnector(endpoint, key, controller.signal);
      if (!controller.signal.aborted) setStatus(result);
    } catch {
      if (!controller.signal.aborted) setStatus({
        state: "api-unavailable", detail: "Verifica interrotta o impossibile. Nessun job è stato creato.",
      });
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  };

  const commands = `# Prima: installa Docker Engine ROOTLESS, Docker Compose e Node.js
# Accedi come utente dedicato Linux UID 1000 (non root).
git clone https://github.com/KeyserDSoze/SoftwareFactory.git
cd SoftwareFactory
node src/runner/scripts/host-setup.mjs setup --origin=${location.origin}
# Crea .env privato (0600), key random e directory private (0700).
# La chiave si legge soltanto sul server e si inserisce in Settings → Runner API key.
node src/runner/scripts/host-setup.mjs start
# Esegue preflight host+Compose; se OK avvia API + worker.
# Per connessioni remote, configura separatamente Tunnel/HTTPS.`;

  return <div className="runner-connector-setup">
    <div className="panel-subtitle"><Server size={15} /> Installa o collega il tuo connector Linux</div>
    <p className="helper">
      Il servizio API e il worker sono già disponibili nel repository. Il browser può mostrare
      i passaggi di installazione e verificarne l'accessibilità, ma non installa software via SSH
      e non esegue comandi sul dispositivo.
    </p>
    <label>Macchina che eseguirà i test
      <select value={host} onChange={e => setHost(e.target.value as Host)}>
        <option value="local">Questo PC Linux (Docker rootless locale)</option>
        <option value="server">Server / VM Linux dedicata</option>
      </select>
    </label>
    <p className="helper">{host === "local"
      ? "Sul PC Linux con Docker rootless e Node.js, usa http://localhost:8787 soltanto quando il browser gira sullo stesso PC. In caso contrario configura un accesso HTTPS."
      : "Sulla VM dedicata usa Docker rootless, directory private e firewall. L'API Compose ascolta solo su 127.0.0.1; per raggiungerla da remoto configura separatamente HTTPS/Tunnel e Access."}</p>
    <p className="helper">
      Dopo aver installato Docker rootless, Docker Compose e Node.js, esegui questi comandi
      <strong> sul PC/server scelto</strong> con un utente dedicato Linux UID 1000.
      Lo script crea chiave e file .env 0600 senza stamparli o inviarli al browser.
      Controlla manualmente la configurazione prima di avviare servizi non fidati.
    </p>
    <pre className="runner-setup-code">{commands}</pre>
    <p className="helper">Il preflight deve essere superato prima dell'avvio.
      Per prerequisiti, permessi, creazione directory e configurazione del tunnel consulta{" "}
      <a href="https://github.com/KeyserDSoze/SoftwareFactory/blob/main/docs/runner.md"
        target="_blank" rel="noopener noreferrer">la guida runner</a>.
      Non installare su host con workload o segreti sensibili. Per usarlo da qualsiasi dispositivo,
      pubblica l'API tramite HTTPS (reverse proxy o Cloudflare Tunnel con Access),
      configura CORS sull'origin della SPA e inserisci il dominio pubblico in Runner API URL.
      Il servizio non è scoperto automaticamente da GitHub Pages.</p>
    <div className="panel-footer">
      <span>Diagnostica in sola lettura: nessun codice inviato, nessun container avviato.</span>
      <button className="secondary" type="button" disabled={checking || !endpoint.trim()}
        onClick={() => void checkConnection()}>
        <Terminal size={15} /> {checking ? "Controllo..." : "Verifica connector"}
      </button>
    </div>
    {status && <div role="status" className={status.state === "ready"
      ? "runner-verification ok" : "code-agent-warning"}>
      {status.state === "ready" ? <CheckCircle2 size={17}/> : <ShieldAlert size={17}/>}
      <span>{status.detail}
        {status.steps && <small> Step dichiarati: {status.steps.join(", ")}.</small>}
      </span>
    </div>}
  </div>;
}
