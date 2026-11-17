import { useEffect, useState } from "react";
import { Activity, Cpu, HardDrive, Thermometer, WifiOff } from "lucide-react";
import { fetchRunnerHostMetrics, type RunnerHostMetrics } from "../infrastructure/runner";
import { readSecret } from "../infrastructure/store";

type Props = { endpoint: string; authRevision?: number; active?: boolean };
const percent = (used: number, total: number) => Math.round(used / total * 100);
const bytes = (n: number) => (n / (1024 ** 3)).toFixed(1) + " GiB";
function Bar({ value }: { value: number | null }) {
  return <div className="runner-resource-bar" role="progressbar" aria-valuemin={0}
    aria-valuemax={100} aria-valuenow={value ?? undefined} aria-label="Utilizzo">
    <span style={{ width: (value ?? 0) + "%" }}/>
  </div>;
}
/** Only visible when the user has configured a connector. No polling of an unknown URL. */
export default function RunnerTelemetry({ endpoint, authRevision = 0, active = false }: Props) {
  const [sample, setSample] = useState<RunnerHostMetrics | null>(null);
  const [state, setState] = useState<"loading"|"online"|"offline">("loading");
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    let stopped = false;
    let current: AbortController | null = null;
    setSample(null); setState("loading");
    const read = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      const key = readSecret("runner.key");
      if (!endpoint || key.length < 32) {
        setState("offline"); setSample(null); return;
      }
      current?.abort();
      current = new AbortController();
      try {
        const data = await fetchRunnerHostMetrics(endpoint, key, current.signal);
        if (!stopped && !current.signal.aborted) {
          setSample(data); setState("online");
        }
      } catch {
        if (!stopped && !current.signal.aborted) {
          setState("offline"); setSample(null);
        }
      }
    };
    void read();
    // Poll gently while the page is visible. A running job gets the same rate;
    // lower frequency when idle avoids wasting the connector's resources.
    const timer = setInterval(() => { void read(); }, active ? 5000 : 12000);
    const visibility = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { stopped = true; current?.abort(); clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility); };
  }, [endpoint, authRevision, active]);

  if (!endpoint) return null;
  const memory = sample ? percent(sample.memoryUsedBytes, sample.memoryTotalBytes) : null;
  const disk = sample?.diskTotalBytes && sample.diskUsedBytes !== null
    ? percent(sample.diskUsedBytes, sample.diskTotalBytes) : null;
  const age = sample ? Date.now() - Date.parse(sample.measuredAt) : null;
  const fresh = state === "online" && age !== null && age < 60000;
  return <section className="runner-resource-panel" aria-label="Risorse server runner">
    <div className="runner-resource-heading">
      <strong><Activity size={16}/> Risorse server Docker</strong>
      <span className={fresh ? "resource-status-online" : "resource-status-offline"}>
        {fresh ? "Telemetria attiva" : state === "loading" ? "Connessione..." : "Offline / dato non disponibile"}
      </span>
      <button type="button" className="subtle" onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}>{expanded ? "Riduci" : "Espandi"}</button>
    </div>
    {expanded && (fresh && sample ? <>
      <div className="runner-resource-grid">
        <div><strong><Cpu size={15}/> CPU</strong>
          <span>{sample.cpuPercent === null ? "In acquisizione" : sample.cpuPercent.toFixed(1) + "%"}</span>
          <Bar value={sample.cpuPercent}/></div>
        <div><strong><Activity size={15}/> RAM</strong>
          <span>{bytes(sample.memoryUsedBytes)} / {bytes(sample.memoryTotalBytes)} · {memory}%</span>
          <Bar value={memory}/></div>
        <div><strong><Thermometer size={15}/> Temperatura CPU</strong>
          <span>{sample.cpuTemperatureC === null ? "Sensore non disponibile" : sample.cpuTemperatureC.toFixed(1) + " °C"}</span>
          <span className="resource-note">Sensore host visibile al worker, se disponibile</span></div>
        <div><strong><HardDrive size={15}/> Disco workspace</strong>
          <span>{disk === null ? "Non disponibile" :
            bytes(sample.diskUsedBytes! ) + " / " + bytes(sample.diskTotalBytes!) + " · " + disk + "%"}</span>
          <Bar value={disk}/></div>
      </div>
      <p className="helper">Rilevazione {new Date(sample.measuredAt).toLocaleTimeString("it-IT")} ·
        uptime host {sample.uptimeSeconds === null ? "non disponibile" : Math.round(sample.uptimeSeconds / 3600) + " ore"}.
        Consumi risorse aggregati, non per singolo test e non consumo elettrico/kWh.</p>
    </> : <p className="helper"><WifiOff size={14}/> Metriche non disponibili o obsolete.
      Verifica connector, API key, worker, versione runner e connessione HTTPS/Tunnel.</p>)}
  </section>;
}
