import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowRight, BrainCircuit, Check, CheckCircle2, ChevronDown, Circle, Cloud,
  Code2, Download, ExternalLink, FileText, GitBranch, GitCommit, Layers3, Menu, Pause,
  Play, Plus, RefreshCw, Search, Settings2, ShieldAlert, Sparkles, Terminal, Trash2, X,
} from "lucide-react";
import { zipSync, strToU8 } from "fflate";
import CodeAgentPanel from "./components/CodeAgentPanel";
import RunnerConnectorSetup from "./components/RunnerConnectorSetup";
import AgentRoleRouter from "./components/AgentRoleRouter";
import BackgroundTaskToast, { type RunnerTaskActivity } from "./components/BackgroundTaskToast";
import { fetchRunnerJob } from "./infrastructure/runner";
import RunnerTelemetry from "./components/RunnerTelemetry";
import { t, normalizeLocale } from "./i18n";
import "./components/code-agent.css";
import { workspaceFiles } from "./domain/development";
import { createProject, DEFAULT_SETTINGS, SERVICE_KINDS, SERVICE_LABELS, SERVICE_OPTIONS, STAGES, updateConfig } from "./domain/defaults";
import type { AiProfile, FactoryProject, FactorySettings, FrontendKind, ProjectConfig, StageId } from "./domain/types";
import { commitStage, invalidateStages, runStage, stageReady } from "./application/pipeline";
import { generateFiles } from "./application/scaffold";
import { backupCloud, finishCloudLogin, restoreCloud, startCloudLogin,
  saveEncryptedRunnerVault, restoreEncryptedRunnerVault } from "./infrastructure/cloud";
import { discoverAiModels } from "./infrastructure/ai";
import { resolveGithubToken } from "./infrastructure/github";
import GitHubConnectionPanel from "./components/GitHubConnectionPanel";
import { publishGithubWorkspace, importGithubWorkspace } from "./infrastructure/github-publication";
import { githubProjectDirty, githubBindingMatches, inspectGithubWorkspace } from "./infrastructure/github-workspace";
import { compareGithubWorkspaces, type GithubWorkspaceComparison } from "./infrastructure/github-diff";
import { loadProject, loadLocalProject, listLocalProjects, loadSettings, localProjectSnapshot, persistProjectIfUnchanged, persistSettings, readSecret, saveSecret } from "./infrastructure/store";
import { acquireProjectWriterLease, type ProjectWriterLease } from "./infrastructure/project-writer-lease";

type Tab = "workspace" | "pipeline" | "code" | "stack" | "connections";
const NAV: { id: Tab; title: string; detail: string; icon: typeof Layers3 }[] = [
  { id: "workspace", title: "Workspace", detail: "Panoramica e brief", icon: Layers3 },
  { id: "pipeline", title: "AI Factory", detail: "Generazione e review", icon: BrainCircuit },
  { id: "code", title: "Code Agent", detail: "Implementazione feature", icon: Terminal },
  { id: "stack", title: "Architecture", detail: "Stack e artefatti", icon: Code2 },
  { id: "connections", title: "Settings", detail: "AI, Git e cloud", icon: Settings2 },
];
const FRONTENDS: { id: FrontendKind; title: string; detail: string }[] = [
  { id: "react", title: "React + TS", detail: "Web, scaffold compilabile" },
  { id: "react-native", title: "React Native", detail: "Mobile, placeholder" },
  { id: "android", title: "Android nativo", detail: "Kotlin, placeholder" },
  { id: "ios", title: "iOS nativo", detail: "Swift, placeholder" },
  { id: "unity", title: "Unity", detail: "3D / game, placeholder" },
];
const formatDate = (stamp?: string) => stamp ? new Date(stamp).toLocaleString("it-IT") : "—";
function safeLocalSnapshot(id: string): string | null {
  try { return localProjectSnapshot(id); } catch { return null; }
}
function IconStatus({ status }: { status: string }) {
  if (status === "complete") return <CheckCircle2 size={18} className="ok" />;
  if (status === "running") return <RefreshCw size={18} className="spinning accent" />;
  if (status === "failed") return <ShieldAlert size={18} className="danger" />;
  return <Circle size={18} className="muted" />;
}
function SecretInput({ secretKey, placeholder = "Token (solo sessione)", onSecretChange }: { secretKey: string; placeholder?: string; onSecretChange?: () => void }) {
  const [value, setValue] = useState(() => readSecret(secretKey));
  useEffect(() => { setValue(readSecret(secretKey)); }, [secretKey]);
  return <input aria-label={placeholder} type="password" autoComplete="off" value={value} placeholder={placeholder}
    onChange={e => { setValue(e.target.value); saveSecret(secretKey, e.target.value); onSecretChange?.(); }} />;
}
function SectionHead({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <header className="section-head"><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{text}</p></header>;
}
export default function App() {
  const [project, setProject] = useState<FactoryProject>(loadProject);
  const [projectIndexRevision, setProjectIndexRevision] = useState(0);
  const [settings, setSettings] = useState<FactorySettings>(loadSettings);
  const [tab, setTab] = useState<Tab>("workspace");
  const [selectedStage, setSelectedStage] = useState<StageId>("features");
  const [selectedFile, setSelectedFile] = useState("README.md");
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [editingOutput, setEditingOutput] = useState(false);
  const [draftOutput, setDraftOutput] = useState("");
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [lastPush, setLastPush] = useState("");
  const [githubPreview, setGithubPreview] = useState<GithubWorkspaceComparison | null>(null);
  const [localConflict, setLocalConflict] = useState("");
  const [writerLeaseReady, setWriterLeaseReady] = useState(false);
  const [runnerSecretRevision, setRunnerSecretRevision] = useState(0);
  const [runnerVaultPassphrase, setRunnerVaultPassphrase] = useState("");
  const [runnerTaskActivity, setRunnerTaskActivity] = useState<RunnerTaskActivity | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const projectRef = useRef(project);
  const writerLeaseRef = useRef<ProjectWriterLease | null>(null);
  const projectSwitchRef = useRef(false);
  const localBaselineRef = useRef<Map<string,string|null>>(
    new Map([[project.id, safeLocalSnapshot(project.id)]]));
  const settingsRef = useRef(settings);
  const oauthChecked = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    let cancelled = false;
    // Delay acquisition one microtask to survive React StrictMode's synthetic
    // mount/cleanup cycle without confusing the second setup with a rival tab.
    queueMicrotask(() => {
      if (cancelled) return;
      void acquireProjectWriterLease(project.id).then(lease => {
        if (cancelled) { lease.release(); return; }
        writerLeaseRef.current = lease;
        const persisted = localBaselineRef.current.get(project.id) ?? null;
        try {
          // The per-project library is authoritative when opening a second tab.
          // Never rewrite a newer copy with a stale active-project pointer.
          const raw = JSON.stringify(projectRef.current);
          if (persisted && persisted !== raw &&
              JSON.stringify(loadLocalProject(project.id)) !== raw)
            throw Error("Il progetto attivo differisce dalla copia della libreria: verifica il conflitto locale prima di salvare.");
          if (persisted !== raw) {
            const confirmed = persistProjectIfUnchanged(projectRef.current, persisted);
            localBaselineRef.current.set(project.id, confirmed);
          }
          setWriterLeaseReady(true);
          setProjectIndexRevision(v => v + 1);
        } catch (error) {
          setLocalConflict(error instanceof Error ? error.message : String(error));
        }
      }).catch(error => {
        if (!cancelled)
          setLocalConflict(error instanceof Error ? error.message : String(error));
      });
    });
    return () => {
      cancelled = true;
      writerLeaseRef.current?.release();
      writerLeaseRef.current = null;
    };
  }, []);
  useEffect(() => {
    const storageChanged = (event: StorageEvent) => {
      const id = projectRef.current.id;
      if (event.storageArea === localStorage &&
          event.key === "softwarefactory.project.library.v1." + id &&
          event.newValue !== localBaselineRef.current.get(id)) {
        setLocalConflict("Un'altra scheda ha modificato il progetto aperto. " +
          "Questa scheda non deve sovrascrivere la versione aggiornata.");
        setPublishConfirmed(false);
      }
    };
    window.addEventListener("storage", storageChanged);
    return () => window.removeEventListener("storage", storageChanged);
  }, []);
  useEffect(() => { settingsRef.current = settings; persistSettings(settings); }, [settings]);
  // GitHub auto-save runs only while this browser tab is open and ONLY after
  // an explicitly approved first push + an opt-in. A durable, non-secret outbox
  // remembers retries and a remote conflict stops all unattended attempts.
  useEffect(() => {
    if (!settings.githubAutoSync) return;
    let disposed = false, inFlight = false;
    const tick = async () => {
      const current = projectRef.current, config = settingsRef.current;
      const git = config.git;
      if (disposed || inFlight || busyRef.current || Boolean(localConflict) || !config.githubAutoSync ||
          document.visibilityState === "hidden" || !githubBindingMatches(current, git) ||
          !githubProjectDirty(current, git) || !readSecret("github.pat")) return;
      const key = "softwarefactory.github.outbox." + current.id;
      const due = Date.parse(current.githubSync?.syncedAt || "");
      if (!Number.isFinite(due) || Date.now() - due < 120000) return;
      let record: { status: "pending" | "blocked"; attempts: number; retryAt: number;
        updatedAt: string } = { status: "pending", attempts: 0, retryAt: 0, updatedAt: current.updatedAt };
      try {
        const saved = localStorage.getItem(key);
        if (saved) {
          const v = JSON.parse(saved) as typeof record;
          if (v && Number.isInteger(v.attempts) && v.attempts >= 0 && v.attempts <= 20 &&
              Number.isFinite(v.retryAt) && ["pending", "blocked"].includes(v.status)) record = v;
        }
      } catch { /* ignore corrupted metadata, never ignore remote HEAD checks */ }
      if (record.status === "blocked" || Date.now() < record.retryAt) return;
      if (!navigator.locks?.request) {
        localStorage.setItem(key, JSON.stringify({ ...record, status: "blocked" }));
        setError("Autosync GitHub bloccato: Web Locks non disponibili, sincronizza manualmente.");
        return;
      }
      inFlight = true;
      try {
        await navigator.locks.request("softwarefactory:github:" + git.owner + "/" + git.repo +
          "@" + git.branch, { ifAvailable: true }, async lock => {
          if (!lock || disposed) return;
          const snapshot = projectRef.current;
          if (snapshot.id !== current.id || snapshot.updatedAt !== current.updatedAt ||
              !githubBindingMatches(snapshot, git) || !githubProjectDirty(snapshot, git)) return;
          // A second tab on this origin may have changed persisted data. No
          // local last-writer-wins overwrite: ask the user to reconcile.
          if (JSON.stringify(loadProject()) !== JSON.stringify(snapshot))
            throw Error("Workspace locale modificato da un'altra scheda: autosync bloccato.");
          const token = await resolveGithubToken(git, readSecret("github.pat"));
          const result = await publishGithubWorkspace(snapshot, git, token);
          if (disposed) return;
          const latest = projectRef.current;
          if (latest.id !== snapshot.id) return;
          // A new local task may have completed during the remote write. Only
          // confirm the SNAPSHOT revision, not later edits.
          const binding = { ...result.project.githubSync!,
            syncedLocalUpdatedAt: snapshot.updatedAt };
          if (!changeProject({ ...latest, githubSync: binding }))
            throw Error("Ack GitHub non salvato: conflitto locale. Il commit remoto può essere riuscito.");
          localStorage.removeItem(key);
          setLastPush(result.url);
          setNotice("GitHub autosync: confermato " + result.sha.slice(0,12) +
            (latest.updatedAt !== snapshot.updatedAt ? " · altre modifiche locali ancora in coda." : "."));
        });
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        const blocked = /[Cc]onflitto|branch remoto|altra scheda|[Rr]epository|[Cc]heckpoint|[Cc]ambiato/.test(message);
        const attempts = Math.min(20, record.attempts + 1);
        localStorage.setItem(key, JSON.stringify({ status: blocked ? "blocked" : "pending",
          attempts, retryAt: blocked ? 0 : Date.now() + Math.min(300000, attempts * 30000),
          updatedAt: projectRef.current.updatedAt }));
        setError("GitHub autosync: " + message + (blocked ?
          " Salvataggio automatico sospeso: verifica HEAD e risolvi manualmente." :
          " Nuovo tentativo solo mentre la pagina è aperta."));
      } finally { inFlight = false; }
    };
    const timer = setInterval(() => { void tick(); }, 15000);
    return () => { disposed = true; clearInterval(timer); };
  }, [settings.githubAutoSync, localConflict]);
  useEffect(() => {
    if (oauthChecked.current) return;
    oauthChecked.current = true;
    void finishCloudLogin(settingsRef.current.cloud).then(ok => {
      if (ok) { setTab("connections"); setNotice("Account cloud collegato per la sessione corrente."); }
    }).catch(e => { setTab("connections"); setError(String(e instanceof Error ? e.message : e)); });
  }, []);
  // Keep the BookWriter-style activity card accurate even when Code Agent
  // is not the active tab. Reading job state never starts a job or executes code.
  const watchedRunnerId = project.development?.lastRunnerEvidence?.id ||
    project.development?.lastRunnerJobId || "";
  useEffect(() => {
    const url = settings.runnerEndpoint || "";
    const key = readSecret("runner.key");
    const evidenceEndpoint = projectRef.current.development?.lastRunnerEvidence?.endpoint;
    if (!watchedRunnerId || !url || key.length < 32 ||
        (evidenceEndpoint && evidenceEndpoint !== url)) {
      setRunnerTaskActivity(null); return;
    }
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const check = async () => {
      try {
        const report = await fetchRunnerJob(url, key, watchedRunnerId, controller.signal);
        if (cancelled) return;
        if (report.state === "running" || report.state === "queued") {
          setRunnerTaskActivity({ id: report.id, state: report.state, label: report.label });
          timeout = setTimeout(() => void check(), document.visibilityState === "hidden" ? 15000 : 5000);
        } else setRunnerTaskActivity(null);
      } catch {
        if (!cancelled) setRunnerTaskActivity(null); // no invented running state
      }
    };
    void check();
    return () => { cancelled = true; controller.abort(); if (timeout) clearTimeout(timeout); };
  }, [watchedRunnerId, settings.runnerEndpoint, runnerSecretRevision]);
  const completed = project.stages.filter(s => s.status === "complete").length;
  const current = project.stages.find(s => s.id === selectedStage)!;
  const next = project.stages.find(s => s.status !== "complete");
  const files = useMemo(() => {
    try { return workspaceFiles(project); } catch { return {} as Record<string, string>; }
  }, [project]);
  const paths = Object.keys(files).sort();
  const localProjects = useMemo(() => listLocalProjects(), [projectIndexRevision]);
  function changeProject(nextProject: FactoryProject): boolean {
    if (!writerLeaseRef.current || writerLeaseRef.current.projectId !== nextProject.id) {
      setError("Scrittura rifiutata: il progetto non ha il lock esclusivo della scheda. " +
        "Chiudi eventuali schede concorrenti e riprova.");
      return false;
    }
    if (localConflict) {
      setError("Conflitto locale aperto: salva prima un backup e scegli la versione corretta.");
      return false;
    }
    try {
      const previous = localBaselineRef.current.has(nextProject.id) ?
        localBaselineRef.current.get(nextProject.id)! : localProjectSnapshot(nextProject.id);
      const stored = persistProjectIfUnchanged(nextProject, previous);
      localBaselineRef.current.set(nextProject.id, stored);
      projectRef.current = nextProject;
      setProject(nextProject);
      setProjectIndexRevision(v => v + 1);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalConflict(message);
      setError("Scrittura locale sospesa: " + message);
      setPublishConfirmed(false);
      return false;
    }
  }
  async function changeProjectWithLease(nextProject: FactoryProject): Promise<boolean> {
    if (projectSwitchRef.current)
      throw Error("Cambio progetto già in corso: la nuova operazione è stata annullata.");
    projectSwitchRef.current = true;
    const old = writerLeaseRef.current;
    try {
      if (old?.projectId === nextProject.id) return changeProject(nextProject);
      setWriterLeaseReady(false);
      const lease = await acquireProjectWriterLease(nextProject.id);
      writerLeaseRef.current = lease;
      if (!changeProject(nextProject)) {
        writerLeaseRef.current = old;
        lease.release();
        return false;
      }
      old?.release();
      return true;
    } finally {
      projectSwitchRef.current = false;
      setWriterLeaseReady(Boolean(writerLeaseRef.current));
    }
  }
  function editConfig(change: (config: ProjectConfig) => void) {
    if (busy || localConflict || !writerLeaseReady || projectSwitchRef.current) return;
    const config = structuredClone(projectRef.current.config);
    change(config);
    if (!changeProject(invalidateStages(updateConfig(projectRef.current, config)))) return;
    setNotice("Configurazione aggiornata. Le analisi precedenti sono state invalidate per coerenza.");
    setPublishConfirmed(false);
  }
  function editSettings(change: (settings: FactorySettings) => void) {
    const copy = structuredClone(settingsRef.current);
    change(copy); settingsRef.current = copy; setSettings(copy);
  }
  async function readProviderModels(profile: AiProfile) {
    const captured = settingsRef.current.profiles.find(p => p.id === profile.id);
    if (!captured) return;
    const key = readSecret("ai." + profile.id);
    try {
      const models = await discoverAiModels(captured, key);
      if (settingsRef.current.profiles.find(p => p.id === profile.id) !== captured ||
          readSecret("ai." + profile.id) !== key)
        throw new Error("Endpoint o credenziali cambiati durante /models: risultato scartato.");
      editSettings(s => {
        const target = s.profiles.find(p => p.id === profile.id);
        if (target) target.models = models;
      });
      setNotice("Catalogo /models letto: " + models.length + " identificatori. Nessun modello scelto automaticamente.");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  function clearMessages() { setError(""); setNotice(""); }
  async function execute(from: StageId, runAll: boolean) {
    if (busy || localConflict || !writerLeaseReady || projectSwitchRef.current) return;
    clearMessages();
    if (!projectRef.current.config.name.trim() || !projectRef.current.config.description.trim()) {
      setError("Inserisci nome e descrizione prima di avviare il workflow."); setTab("workspace"); return;
    }
    if (!stageReady(projectRef.current, from)) {
      setError("Completa prima le fasi precedenti."); return;
    }
    const controller = new AbortController(); abortRef.current = controller; setBusy(true); setTab("pipeline");
    const startIndex = STAGES.findIndex(s => s.id === from);
    let activeStage: StageId = from;
    try {
      for (let i = startIndex; i < (runAll ? STAGES.length : startIndex + 1); i++) {
        if (controller.signal.aborted) break;
        const id = STAGES[i].id;
        activeStage = id; setSelectedStage(id);
        let working = { ...projectRef.current, stages: projectRef.current.stages.map(s =>
          s.id === id ? { ...s, status: "running" as const, error: undefined } : s) };
        if (!changeProject(working)) throw Error("Workspace locale in conflitto: stage AI non avviato.");
        setOperation(STAGES[i].label);
        setRunLog(log => [formatDate(new Date().toISOString()) + " · Avvio: " + STAGES[i].label, ...log].slice(0, 30));
        const result = await runStage(working, settingsRef.current, id, controller.signal, sources => {
          // Sources are shown only once the stage completes; we do not publish intermediate unsourced claims.
          void sources;
        });
        if (controller.signal.aborted) break;
        working = commitStage(working, id, result.output, result.sources);
        if (!changeProject(working)) throw Error("Il checkpoint AI non è stato salvato: progetto modificato da un\u0027altra scheda.");
        setRunLog(log => [formatDate(new Date().toISOString()) + " · Completato: " + STAGES[i].label, ...log].slice(0, 30));
      }
      if (controller.signal.aborted) setNotice("Pipeline in pausa. Nessuna risposta interrotta è stata salvata.");
      else setNotice(runAll ? "Pipeline completata. Controlla le review prima di pubblicare." : "Task completato.");
    } catch (e) {
      if (controller.signal.aborted) setNotice("Pipeline interrotta. Puoi riprendere dal checkpoint.");
      else {
        const message = e instanceof Error ? e.message : String(e);
        const failed = { ...projectRef.current, stages: projectRef.current.stages.map(s =>
          s.id === activeStage ? { ...s, status: "failed" as const, error: message } : s) };
        if (!localConflict) changeProject(failed); setError(message);
        setRunLog(log => [formatDate(new Date().toISOString()) + " · Errore: " + activeStage + " — " + message, ...log].slice(0, 30));
      }
    } finally {
      if (controller.signal.aborted) {
        if (!localConflict) changeProject({ ...projectRef.current, stages: projectRef.current.stages.map(s =>
          s.status === "running" ? { ...s, status: "pending" as const } : s) });
      }
      setBusy(false); setOperation(""); abortRef.current = null;
    }
  }
  function pause() { abortRef.current?.abort(); }
  async function newProject() {
    if (busy || localConflict || !writerLeaseReady || !confirm("Creare un nuovo progetto? Quello corrente resta nella libreria locale, " +
      "ma esporta un backup ZIP/cloud per proteggerlo da cancellazione browser.")) return;
    try {
      if (!await changeProjectWithLease(createProject())) return;
      editSettings(s => { s.git = { ...DEFAULT_SETTINGS.git }; s.githubAutoSync = false; });
      setTab("workspace"); clearMessages(); setRunLog([]); setLastPush("");
    } catch(error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  async function switchProject(id: string) {
    if (busy || localConflict || !writerLeaseReady || projectSwitchRef.current ||
        id === projectRef.current.id) return;
    projectSwitchRef.current = true;
    setWriterLeaseReady(false);
    try {
      const selected = loadLocalProject(id);
      if (!confirm("Passare a «" + selected.config.name + "»? " +
        "Le modifiche attuali restano nella libreria locale. Nessun push automatico in questa operazione.")) return;
      // Acquire the destination's exclusive writer lease before trusting or
      // persisting the selected snapshot (another tab may have changed it).
      const selectedOnRequest = localProjectSnapshot(id);
      const lease = await acquireProjectWriterLease(id);
      const previousLease = writerLeaseRef.current;
      try {
        const selectedNow = localProjectSnapshot(id);
        if (selectedNow !== selectedOnRequest)
          throw Error("Il progetto è cambiato durante il cambio scheda: rileggi la libreria.");
        localBaselineRef.current.set(id, selectedNow);
        writerLeaseRef.current = lease;
        if (!changeProject(selected)) {
          // A failed guarded write must not strand the app on the old project
          // while accidentally holding the destination lease as its active lock.
          writerLeaseRef.current = previousLease;
          return;
        }
        previousLease?.release();
      } catch (error) {
        writerLeaseRef.current = previousLease;
        throw error;
      } finally {
        if (writerLeaseRef.current !== lease) lease.release();
      }
      editSettings(s => {
        s.git = selected.githubDestination ? { ...selected.githubDestination } :
          selected.githubSync ? { ...s.git, owner: selected.githubSync.owner,
            repo: selected.githubSync.repo, branch: selected.githubSync.branch } :
            { ...DEFAULT_SETTINGS.git };
        s.githubAutoSync = false;
      });
      setTab("workspace"); clearMessages(); setRunLog([]); setLastPush("");
      setNotice("Progetto locale aperto. Verifica destinazione GitHub e sblocca il PAT prima di pubblicare.");
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally {
      projectSwitchRef.current = false;
      setWriterLeaseReady(Boolean(writerLeaseRef.current));
    }
  }
  function downloadZip() {
    clearMessages();
    if (!paths.length) { setError("Inserisci nome e descrizione per generare lo scaffold."); return; }
    const archive: Record<string, Uint8Array> = {};
    for (const [path, text] of Object.entries(files)) archive[path] = strToU8(text);
    const zip = zipSync(archive, { level: 6 });
    const bytes = new Uint8Array(zip.length); bytes.set(zip);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const a = document.createElement("a"); a.href = url;
    a.download = (project.config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "application") + "-scaffold.zip";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setNotice("ZIP creato. Include solo configurazione e artefatti, mai i token.");
  }
  async function publish() {
    clearMessages();
    if (localConflict || !writerLeaseReady || writerLeaseRef.current?.projectId !== projectRef.current.id) {
      setError("Progetto non protetto dal lock locale: non pubblicare finché il controllo di scrittura non è pronto."); return;
    }
    if (!publishConfirmed) { setError("Conferma il contenuto da pubblicare sul repository."); return; }
    if (!paths.length) { setError("Inserisci nome e descrizione per generare lo scaffold."); return; }
    setBusy(true); setOperation("GitHub sync");
    const start = projectRef.current;
    try {
      const git = settingsRef.current.git;
      const token = await resolveGithubToken(git, readSecret("github.pat"));
      const publicConsent = !git.privateRepo && window.confirm(
        "La destinazione GitHub è impostata come PUBBLICA: codice, brief, checkpoint AI " +
        "e proposte in corso possono essere visibili a chiunque. Autorizzi espressamente il push?");
      if (!git.privateRepo && !publicConsent) return;
      let result;
      try {
        result = await publishGithubWorkspace(start, git, token, publicConsent);
      } catch (reason) {
        // GitHub's *actual* visibility can differ from the "create private"
        // preference. This error is thrown BEFORE source commit creation.
        if (!(reason instanceof Error) || !reason.message.includes("PUBBLICA") ||
            publicConsent) throw reason;
        if (!window.confirm("GitHub ha rilevato una repository realmente PUBBLICA, " +
            "anche se nelle preferenze è selezionata la creazione privata. " +
            "Autorizzi espressamente a rendere visibili sorgenti, checkpoint e bozze AI?"))
          return;
        result = await publishGithubWorkspace(start, git, token, true);
      }
      setLastPush(result.url);
      localStorage.removeItem("softwarefactory.github.outbox." + start.id);
      if (projectRef.current.id === start.id && projectRef.current.updatedAt === start.updatedAt) {
        if (!changeProject({ ...result.project, githubDestination: { ...git } }))
          throw Error("Commit remoto riuscito ma ack locale bloccato da un'altra scheda. Verifica HEAD GitHub prima di riprovare.");
        setNotice("Commit " + result.sha.slice(0,12) + " verificato sul branch " + result.branch +
          " con checkpoint ripristinabile. Nessun force push.");
      } else {
        // The remote write may have succeeded, but local edits appeared meanwhile.
        // We must not mark an unconfirmed later snapshot as saved.
        setError("Commit remoto riuscito ma workspace locale cambiato durante il push. Prima di ripubblicare, verifica la HEAD GitHub.");
      }
      setPublishConfirmed(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); setOperation(""); }
  }
  async function recoverLocalConflict() {
    if (!localConflict || busy) return;
    try {
      if (!window.confirm("Esportare il progetto di questa scheda come backup JSON prima di caricare " +
          "lo stato scritto dall'altra scheda? Non verrà fatto alcun push GitHub.")) return;
      downloadRecoveryProject(projectRef.current);
      if (!window.confirm("Confermi di aver SALVATO il file di recupero? Il progetto della " +
          "scheda corrente sarà sostituito con la versione più recente della libreria locale.")) return;
      const id = projectRef.current.id;
      if (!writerLeaseRef.current || writerLeaseRef.current.projectId !== id)
        writerLeaseRef.current = await acquireProjectWriterLease(id);
      const remote = localProjectSnapshot(id);
      if (!remote) throw Error("Nessun progetto aggiornato trovato nella libreria locale.");
      const fresh = loadLocalProject(id);
      localBaselineRef.current.set(id, remote);
      projectRef.current = fresh;
      setProject(fresh);
      setProjectIndexRevision(v => v + 1);
      setLocalConflict("");
      setWriterLeaseReady(true);
      editSettings(s => { s.githubAutoSync = false; });
      setNotice("Versione della libreria locale caricata. Autosync disabilitato per sicurezza.");
    } catch(error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  function downloadRecoveryProject(project: FactoryProject): void {
    // Explicit single-project recovery file; no PAT, AI API or cloud credentials
    // are included (they are stored in the browser's session/device vault).
    const backup = JSON.stringify({
      kind: "softwarefactory-local-recovery", schemaVersion: 1,
      exportedAt: new Date().toISOString(), project,
    }, null, 2);
    if (backup.length > 1_500_000)
      throw Error("Progetto troppo grande per il backup di sicurezza in browser.");
    const url = URL.createObjectURL(new Blob([backup], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "softwarefactory-recovery-" + project.id + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function importFromGithub(mode: "status" | "import") {
    if (busy || localConflict || !writerLeaseReady) return;
    clearMessages(); setBusy(true); setOperation("GitHub import");
    try {
      const git = settingsRef.current.git;
      const token = await resolveGithubToken(git, readSecret("github.pat"));
      if (mode === "status") {
        const remote = await inspectGithubWorkspace(git, token);
        const local = projectRef.current;
        const comparison = remote.project ?
          compareGithubWorkspaces(local, remote.project, git, remote.headSha) : null;
        setGithubPreview(comparison);
        setNotice(comparison ?
          "GitHub " + comparison.headSha.slice(0,12) + " · " +
          (comparison.remoteAdvanced ? "HEAD diversa" : "HEAD già confermata") +
          " · " + (comparison.onlyLocal.length + comparison.onlyRemote.length +
            comparison.changed.length) + " file di differenza (anteprima sotto)." :
          "La repository esiste ma non contiene ancora un checkpoint SoftwareFactory.");
        return;
      }
      const initial = projectRef.current;
      const imported = await importGithubWorkspace(initial, git, token);
      const compared = compareGithubWorkspaces(initial, imported.project, git, imported.sha);
      setGithubPreview(compared);
      const replacing = initial.id !== imported.project.id ||
        githubProjectDirty(initial, git) || compared.changed.length > 0 ||
        compared.onlyLocal.length > 0 || compared.onlyRemote.length > 0;
      if (replacing) {
        if (!window.confirm("ATTENZIONE: importazione GitHub " +
          (compared.sameProject ? "dello stesso progetto" : "di un progetto diverso") +
          ". File differenti: " + (compared.onlyLocal.length + compared.onlyRemote.length +
          compared.changed.length) +
          ". Prima di sostituire lo stato locale viene scaricato un backup di recupero JSON. " +
          "Se il browser lo blocca, annulla l'operazione. Procedere al download?")) return;
        downloadRecoveryProject(initial);
        if (!window.confirm("Hai effettivamente SALVATO il backup JSON sul tuo dispositivo? " +
          "Procedendo verrà sostituito il progetto aperto senza merge automatico. " +
          "Un vecchio report di test o una vecchia review NON saranno considerati validi.")) return;
      }
      if (initial.id !== projectRef.current.id || initial.updatedAt !== projectRef.current.updatedAt)
        throw Error("Il progetto locale è cambiato durante l'importazione: operazione annullata.");
      if (!await changeProjectWithLease({ ...imported.project, githubDestination: { ...git } }))
        throw Error("Importazione non applicata: copia locale modificata durante l'operazione.");
      editSettings(s => { s.githubAutoSync = false; });
      setPublishConfirmed(false);
      setGithubPreview(null);
      setNotice("Checkpoint GitHub " + imported.sha.slice(0,12) +
        " ripristinato. Autosync disattivato su questo dispositivo fino a nuovo consenso.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); setOperation(""); }
  }
  function toggleGithubAutoSync(enabled: boolean) {
    if (enabled && (!writerLeaseReady || writerLeaseRef.current?.projectId !== projectRef.current.id)) {
      setError("Autosync non abilitabile senza lock esclusivo della scheda."); return;
    }
    if (enabled && (!githubBindingMatches(projectRef.current, settingsRef.current.git) ||
        !projectRef.current.githubSync?.lastCommit)) {
      setError("Prima pubblica il primo checkpoint GitHub e attendi la conferma del commit."); return;
    }
    if (enabled && !navigator.locks?.request) {
      setError("Web Locks non disponibili: autosync disabilitato per evitare scritture concorrenti."); return;
    }
    if (enabled && !readSecret("github.pat")) {
      setError("Sblocca il PAT sul dispositivo prima di abilitare autosync."); return;
    }
    if (enabled && !window.confirm("Abilitare salvataggi automatici dei checkpoint su GitHub " +
      "(inclusi output AI, bozze e proposte non approvate) quando la pagina rimane aperta? " +
      "La repository deve essere privata o esplicitamente autorizzata alla pubblicazione."))
      return;
    if (enabled && !settingsRef.current.git.privateRepo) {
      if (!window.confirm("Repository impostata come PUBBLICA: autorizzi anche ogni successivo autosync " +
        "del checkpoint AI, inclusi task in bozza?")) return;
      const active = projectRef.current;
      if (active.githubSync)
        changeProject({ ...active, githubSync: { ...active.githubSync, publicConsent: true } });
    }
    editSettings(s => { s.githubAutoSync = enabled; });
    setNotice(enabled ? "Autosync GitHub attivato (solo pagina aperta, massimo ogni 2 minuti)." :
      "Autosync GitHub disattivato. Le modifiche locali restano disponibili.");
  }
  async function cloudAction(kind: "save" | "load") {
    clearMessages(); setBusy(true); setOperation("Cloud " + kind);
    try {
      if (kind === "save") { await backupCloud(projectRef.current, settingsRef.current); setNotice("Backup cloud completato, senza credenziali."); }
      else {
        if (!confirm("Ripristinare il progetto dal cloud e sostituire quello locale corrente?")) return;
        const recovered = await restoreCloud(settingsRef.current);
        if (!await changeProjectWithLease({ ...recovered.project, stages: recovered.project.stages.map(s => s.status === "running" ? { ...s, status: "pending" as const } : s) }))
          throw Error("Ripristino cloud non applicato: conflitto locale.");
        if (recovered.settings) editSettings(s => {
          s.profiles = recovered.settings!.profiles;
          s.assignments = recovered.settings!.assignments;
          s.agentRoutes = recovered.settings!.agentRoutes;
          s.runnerEndpoint = recovered.settings!.runnerEndpoint || "";
          s.searchEndpoint = recovered.settings!.searchEndpoint;
          s.git = recovered.settings!.git;
          s.cloud = recovered.settings!.cloud;
        });
        setNotice("Progetto e impostazioni non segrete ripristinati dal cloud.");
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); setOperation(""); }
  }
  async function runRunnerVaultAction(kind: "save" | "load") {
    if (busy) return;
    if (runnerVaultPassphrase.length < 12) {
      setError("Imposta una passphrase per il vault di almeno 12 caratteri."); return;
    }
    if (!readSecret("cloud." + settings.cloud.provider)) {
      setError("Collega prima Google Drive o OneDrive."); return;
    }
    if (!confirm(kind === "save"
      ? "Cifrare la API key runner nel browser e sovrascrivere il vault cloud precedente? La passphrase non è recuperabile e non viene salvata."
      : "Sostituire URL e API key runner di questa sessione con quelli letti dal vault cifrato?")) return;
    clearMessages(); setBusy(true); setOperation("Vault runner cloud");
    try {
      if (kind === "save") {
        await saveEncryptedRunnerVault(settingsRef.current, runnerVaultPassphrase);
        setNotice("Credenziale runner salvata nel vault cloud cifrato. Conserva la passphrase separatamente.");
      } else {
        const recovered = await restoreEncryptedRunnerVault(settingsRef.current, runnerVaultPassphrase);
        editSettings(s => { s.runnerEndpoint = recovered.endpoint; });
        saveSecret("runner.key", recovered.apiKey);
        setRunnerSecretRevision(v => v + 1);
        setNotice("Runner collegato da vault cloud: URL ripristinato e API key caricata soltanto per questa sessione.");
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally {
      setRunnerVaultPassphrase(""); setBusy(false); setOperation("");
    }
  }
  const progress = Math.round(completed / STAGES.length * 100);
  return <div className="shell">
    <aside className={"sidebar " + (mobileNav ? "open" : "")}>
      <div className="brand"><div className="brand-mark"><Layers3 size={24} /></div><div><strong>SOFTWARE<span>FACTORY</span></strong><small>AI APP STUDIO · v0.1</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Navigazione principale">{NAV.map(item => {
        const Icon = item.icon;
        return <button key={item.id} className={"nav-button " + (tab === item.id ? "active" : "")} onClick={() => { setTab(item.id); setMobileNav(false); clearMessages(); }}>
          <Icon size={19} /><span><strong>{item.title}</strong><small>{item.detail}</small></span>{tab === item.id && <span className="nav-indicator" />}
        </button>;
      })}</nav>
      <div className="sidebar-bottom"><div className="project-mini"><div className="mini-head"><span className="status-dot" /> PROGETTO ATTIVO</div><strong title={project.config.name}>{project.config.name || "Senza nome"}</strong>
        <div className="mini-progress"><span style={{ width: progress + "%" }} /></div><small>{completed} / {STAGES.length} fasi completate · {progress}%</small></div>
        <button className="subtle full" disabled={!writerLeaseReady || Boolean(localConflict)} onClick={() => void newProject()}><Plus size={16} /> Nuovo progetto</button>
        <div className="sidebar-credit">Local-first · dati nel browser</div>
      </div>
    </aside>
    {mobileNav && <div className="nav-backdrop" onClick={() => setMobileNav(false)} />}
    <main className="main">
      <div className="topbar"><button className="mobile-menu subtle" onClick={() => setMobileNav(true)} aria-label="Apri navigazione"><Menu size={22} /></button>
        <div className="breadcrumb">Workspace <span>/</span> {NAV.find(n => n.id === tab)?.title}</div>
        <div className="top-right"><label className="language-select" aria-label={t(normalizeLocale(settings.language), "language")}>
          <select aria-label={t(normalizeLocale(settings.language), "language")}
            value={normalizeLocale(settings.language)}
            onChange={event => editSettings(s => { s.language = event.target.value === "en" ? "en" : "it"; })}>
            <option value="it">Italiano</option><option value="en">English</option>
          </select></label><span className="top-status"><span className={"status-dot " + (busy ? "pulse" : "")} /> {busy ? operation : "Sistema pronto"}</span><button className="icon-button" onClick={() => setTab("connections")} title="Impostazioni"><Settings2 size={18} /></button></div>
      </div>
      <div className="page">
        {error && <div className="alert error" role="alert"><ShieldAlert size={18} /><span>{error}</span><button onClick={() => setError("")} aria-label="Chiudi"><X size={17} /></button></div>}
        {notice && <div className="alert success" role="status"><CheckCircle2 size={18} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Chiudi"><X size={17} /></button></div>}
        {tab === "workspace" && <>
          {localConflict && <section className="panel local-project-conflict" role="alert">
            <h3>Conflitto locale tra schede</h3>
            <p>{localConflict}</p>
            <p>Questa scheda non sovrascriverà la versione salvata dall'altra.
              Esporta prima il JSON di recupero e scegli esplicitamente se caricare la versione aggiornata.</p>
            <button className="secondary" disabled={busy} onClick={() => void recoverLocalConflict()}>
              <Download size={15}/> Salva backup e carica versione aggiornata
            </button>
          </section>}
          <section className="panel local-project-library">
            <div className="panel-title"><div><span className="eyebrow">LOCAL / PROJECTS</span>
              <h3>{t(normalizeLocale(settings.language), "githubProjectsTitle")}</h3></div>
              <Layers3 size={18}/></div>
            <label>{t(normalizeLocale(settings.language), "githubProjectsOpen")}
              <select value={project.id} disabled={busy} onChange={e => void switchProject(e.target.value)}>
                {localProjects.some(x => x.id === project.id) ? null :
                  <option value={project.id}>{project.config.name} · corrente</option>}
                {localProjects.map(x => <option value={x.id} key={x.id}>
                  {x.name} {x.repository ? "· " + x.repository : ""}
                </option>)}
              </select>
            </label>
            <p className="helper">I progetti sono separati sul dispositivo. Il PAT cifrato è condiviso;
              ogni progetto può selezionare una repository diversa. La libreria locale non sostituisce un backup cloud.</p>
          </section>
          <section className="hero"><div className="hero-copy"><div className="hero-pill"><Sparkles size={14} /> THE AUTONOMOUS SOFTWARE STUDIO</div>
            <h1>Da un'idea a un'<em>applicazione.</em></h1>
            <p>Descrivi il prodotto, scegli lo stack e lascia che gli agenti pianifichino feature, ricerca, architettura e adversarial review. Esamina ogni decisione, poi genera uno scaffold versionabile.</p>
            <div className="hero-actions"><button className="primary" disabled={busy} onClick={() => void execute("features", true)}><Play size={17} fill="currentColor" /> Avvia la factory <ArrowRight size={18} /></button>
              <button className="outline light" onClick={() => setTab("pipeline")}><Activity size={17} /> Esplora pipeline</button></div>
          </div><div className="hero-graphic"><div className="orbit-ring a" /><div className="orbit-ring b" /><div className="hero-core"><BrainCircuit size={48} /><span>AI ENGINE</span></div><div className="orbit-point one"><Code2 size={17} /></div><div className="orbit-point two"><GitBranch size={17} /></div><div className="orbit-point three"><ShieldAlert size={17} /></div></div></section>
          <div className="stats">
            <div className="stat"><span className="stat-icon violet"><Layers3 size={21} /></span><div><strong>{STAGES.length}</strong><span>Agenti / fasi</span></div></div>
            <div className="stat"><span className="stat-icon teal"><CheckCircle2 size={21} /></span><div><strong>{completed}</strong><span>Fasi completate</span></div></div>
            <div className="stat"><span className="stat-icon blue"><Terminal size={21} /></span><div><strong>{paths.length || "—"}</strong><span>File generabili</span></div></div>
            <div className="stat"><span className="stat-icon amber"><GitBranch size={21} /></span><div><strong>{settings.git.branch || "main"}</strong><span>Branch GitHub</span></div></div>
          </div>
          <div className="two-col">
            <section className="panel"><div className="panel-title"><div><span className="eyebrow">01 / PRODUCT BRIEF</span><h3>La tua prossima applicazione</h3></div><FileText size={20} className="muted" /></div>
              <label>Nome progetto<input value={project.config.name} disabled={busy} placeholder="Es. Legal Research Platform" onChange={e => editConfig(c => { c.name = e.target.value; })} /></label>
              <label>Descrizione dell'idea<textarea rows={6} value={project.config.description} disabled={busy} placeholder="Descrivi cosa deve fare l'app, per chi, quali problemi risolve..." onChange={e => editConfig(c => { c.description = e.target.value; })} /></label>
              <label>Vincoli e requisiti opzionali<textarea rows={3} value={project.config.requirements} disabled={busy} placeholder="Sicurezza, GDPR, mercati, budget, integrazioni..." onChange={e => editConfig(c => { c.requirements = e.target.value; })} /></label>
              <div className="panel-footer"><span>Ogni modifica invalida le analisi precedenti.</span><button className="secondary" onClick={() => setTab("stack")}>Configura stack <ArrowRight size={16} /></button></div>
            </section>
            <section className="panel"><div className="panel-title"><div><span className="eyebrow">02 / EXECUTION ENGINE</span><h3>Pipeline intelligente</h3></div><span className="count-pill">{progress}%</span></div>
              <div className="pipeline-mini">{STAGES.map((s, i) => {
                const stage = project.stages[i];
                return <button className="pipeline-row" key={s.id} onClick={() => { setSelectedStage(s.id); setTab("pipeline"); }}>
                  <span className={"step-index " + (stage.status === "complete" ? "done" : "")}>{stage.status === "complete" ? <Check size={15} /> : String(i + 1).padStart(2, "0")}</span>
                  <span className="pipeline-row-text"><strong>{s.label}</strong><small>{s.detail}</small></span><IconStatus status={stage.status} />
                </button>;
              })}</div>
              <div className="panel-footer"><span>Prossimo: {next?.label || "Review finale"}</span><button className="secondary" disabled={!next || busy} onClick={() => { if (next) void execute(next.id, true); }}>Riprendi <ArrowRight size={16} /></button></div>
            </section>
          </div>
        </>}
        {tab === "pipeline" && <>
          <SectionHead eyebrow="FACTORY / ORCHESTRATION" title="Pipeline di generazione" text="Ogni agente ha un compito, un output versionabile e uno stato. I risultati sono salvati nel browser al completamento di ogni fase." />
          <div className="toolbar"><div className="toolbar-info"><span className="status-dot" /> {busy ? "Elaborazione in corso: " + operation : completed + " su " + STAGES.length + " step terminati"}</div>
            <div className="button-group">{busy ? <button className="danger-button" onClick={pause}><Pause size={16} /> Interrompi</button> :
              <button className="primary" disabled={!next} onClick={() => { if (next) void execute(next.id, true); }}><Play size={16} /> {completed ? "Continua" : "Avvia workflow"}</button>}</div></div>
          <div className="stage-layout"><div className="stage-list">{STAGES.map((s, i) => <button key={s.id} className={"stage-item " + (selectedStage === s.id ? "selected" : "")} onClick={() => { setSelectedStage(s.id); setEditingOutput(false); }}>
            <span className="stage-num">{String(i + 1).padStart(2, "0")}</span><div><strong>{s.label}</strong><small>{s.detail}</small></div><IconStatus status={project.stages[i].status} /></button>)}</div>
            <section className="panel stage-detail"><div className="panel-title"><div><span className="eyebrow">AGENT OUTPUT / {selectedStage.toUpperCase()}</span><h3>{STAGES.find(s => s.id === selectedStage)?.label}</h3></div><IconStatus status={current.status} /></div>
              <p className="stage-description">{STAGES.find(s => s.id === selectedStage)?.detail}. Il contenuto generato non sostituisce una validazione umana.</p>
              {current.status === "failed" && <div className="alert error">{current.error}</div>}
              {editingOutput ? <>
                <textarea className="output-editor" value={draftOutput} onChange={e => setDraftOutput(e.target.value)} rows={16} />
                <div className="button-group"><button className="secondary" onClick={() => setEditingOutput(false)}>Annulla</button><button className="primary" disabled={!draftOutput.trim() || busy} onClick={() => {
                  changeProject(commitStage(projectRef.current, selectedStage, draftOutput, current.sources));
                  setEditingOutput(false); setNotice("Output corretto manualmente; gli step successivi sono stati invalidati.");
                }}>Salva revisione</button></div>
              </> : <div className="output-box">{current.output ? <pre>{current.output}</pre> :
                <div className="output-empty"><BrainCircuit size={34} /><strong>Nessun output per questo task</strong><span>Configura il provider AI, completa le fasi precedenti e avvia l'agente.</span></div>}</div>}
              {current.sources.length > 0 && <div className="source-list"><strong><Search size={15} /> Fonti recuperate ({current.sources.length})</strong>{current.sources.map((s, i) => <a href={s.url} target="_blank" rel="noopener noreferrer" key={i}>{s.title} <ExternalLink size={13} /></a>)}</div>}
              <div className="panel-footer"><span>Ultimo salvataggio: {formatDate(current.updatedAt)}</span><div className="button-group">
                {current.output && !editingOutput && <button className="subtle" disabled={busy} onClick={() => { setDraftOutput(current.output); setEditingOutput(true); }}>Modifica</button>}
                <button className="secondary" disabled={busy || !stageReady(project, selectedStage)} onClick={() => void execute(selectedStage, false)}><RefreshCw size={15} /> {current.output ? "Rigenera" : "Esegui task"}</button></div></div>
            </section></div>
          <section className="panel activity-panel"><div className="panel-title"><div><span className="eyebrow">OPERATION LOG</span><h3>Attività della sessione</h3></div><Activity size={20} /></div>
            {runLog.length ? runLog.map((item, i) => <div key={i} className="log-line"><span className="status-dot" /> {item}</div>) : <p className="dimmed">Le attività appariranno qui dopo il primo task. I checkpoint sono salvati nel progetto.</p>}</section>
        </>}
        {tab === "code" && <CodeAgentPanel project={project} settings={settings} busy={busy || !writerLeaseReady || Boolean(localConflict)}
          onBusy={(active, label) => { setBusy(active); setOperation(active ? label || "Code Agent" : ""); }}
          onProjectChange={next => {
            if (!changeProject(next)) throw Error("Modifica Code Agent non persistita: lock locale o conflitto.");
          }} onNotice={setNotice} onError={setError} />}
        {tab === "stack" && <>
          <SectionHead eyebrow="FACTORY / BLUEPRINT" title="Architettura componibile" text="Puoi modificare frontend, hosting e servizi in qualsiasi momento. I piani AI dipendenti dalla configurazione vengono invalidati." />
          <section className="panel"><div className="panel-title"><div><span className="eyebrow">TARGET APPLICATIONS</span><h3>Frontend multipli</h3></div><Code2 size={20} /></div>
            <div className="frontend-grid">{FRONTENDS.map(f => <button key={f.id} disabled={busy} className={"choice-card " + (project.config.frontends.includes(f.id) ? "chosen" : "")} onClick={() => editConfig(c => {
              c.frontends = c.frontends.includes(f.id) ? c.frontends.filter(x => x !== f.id) : [...c.frontends, f.id];
            })}><span className="choice-check">{project.config.frontends.includes(f.id) ? <Check size={14} /> : <Plus size={14} />}</span><strong>{f.title}</strong><small>{f.detail}</small></button>)}</div>
            <p className="helper">Il web React è compilabile. Gli altri target generano per ora solo i placeholder dichiarati, non un'app nativa fittizia.</p>
          </section>
          <section className="panel"><div className="panel-title"><div><span className="eyebrow">DEPLOYMENT & BACKEND</span><h3>Stack e hosting</h3></div><Cloud size={20} /></div>
            <div className="form-grid"><label>Provider di deploy<select disabled={busy} value={project.config.deployment} onChange={e => editConfig(c => { c.deployment = e.target.value as ProjectConfig["deployment"]; })}>
              <option value="docker">On-prem · Docker</option><option value="kubernetes">On-prem · Kubernetes</option><option value="azure">Microsoft Azure</option><option value="aws">Amazon Web Services</option><option value="gcp">Google Cloud</option>
            </select></label><label>Backend .NET<select disabled={busy} value={project.config.dotnetVersion} onChange={e => editConfig(c => { c.dotnetVersion = e.target.value as ProjectConfig["dotnetVersion"]; })}><option value="11.0">.NET 11 · ultima stable</option><option value="10.0">.NET 10 · LTS</option></select></label>
            <label>Database predefinito<select disabled={busy} value={project.config.database} onChange={e => editConfig(c => {
              const prev = c.database; c.database = e.target.value as ProjectConfig["database"];
              for (const env of ["development", "production"] as const) if (c.services.database[env] === prev) c.services.database[env] = c.database;
            })}><option value="postgresql">PostgreSQL</option><option value="sqlserver">SQL Server</option><option value="mysql">MySQL</option><option value="sqlite">SQLite</option></select></label></div>
          </section>
          <section className="panel"><div className="panel-title"><div><span className="eyebrow">SERVICE ROUTING</span><h3>Servizi per ambiente</h3></div><Layers3 size={20} /></div>
            <p className="helper">La selezione descrive le dipendenze desiderate per sviluppo e produzione. Gli adapter runtime verso i cloud sono ancora da implementare.</p>
            <div className="service-table"><div className="service-row header"><strong>Servizio</strong><strong>Development</strong><strong>Production</strong></div>
              {SERVICE_KINDS.map(kind => <div className="service-row" key={kind}><strong>{SERVICE_LABELS[kind]}</strong>
                {(["development", "production"] as const).map(env => <select key={env} aria-label={SERVICE_LABELS[kind] + " " + env} disabled={busy} value={project.config.services[kind][env]} onChange={e => editConfig(c => { c.services[kind][env] = e.target.value; })}>
                  {SERVICE_OPTIONS[kind].map(opt => <option key={opt} value={opt}>{opt}</option>)}</select>)}
              </div>)}</div>
          </section>
          <section className="panel"><div className="panel-title"><div><span className="eyebrow">CODE OUTPUT</span><h3>Artefatti di progetto</h3></div><button className="primary" disabled={!paths.length} onClick={downloadZip}><Download size={16} /> Esporta ZIP</button></div>
            {!paths.length ? <p className="dimmed">Inserisci nome e descrizione nel Workspace per generare i file.</p> :
            <div className="files-layout"><div className="file-list">{paths.map(path => <button key={path} className={selectedFile === path ? "active" : ""} onClick={() => setSelectedFile(path)}><FileText size={14} /> <span>{path}</span></button>)}</div>
              <div className="code-preview"><div className="code-title"><Code2 size={14} /> {files[selectedFile] ? selectedFile : paths[0]}</div><pre>{files[selectedFile] || files[paths[0]]}</pre></div></div>}
          </section>
        </>}
        {tab === "connections" && <>
          <SectionHead eyebrow="FACTORY / CONNECTIONS" title="Integrazioni e modelli AI" text="Le credenziali sono usate solo nella sessione del browser: non finiscono nel repository, nel progetto esportato o nei backup cloud." />
          <section className="panel"><div className="panel-title"><div><span className="eyebrow">MODEL ROUTER</span><h3>Endpoint AI</h3></div><button className="secondary" onClick={() => editSettings(s => { s.profiles.push({ id: crypto.randomUUID(), label: "Nuovo endpoint", baseUrl: "https://api.openai.com/v1", model: "", enabled: true }); })}><Plus size={16} /> Aggiungi</button></div>
            {settings.profiles.map((profile, index) => <div className="endpoint" key={profile.id}><div className="endpoint-heading"><strong>Endpoint {index + 1}</strong><button className="icon-button" disabled={settings.profiles.length < 2} aria-label="Elimina endpoint" onClick={() => editSettings(s => {
              s.profiles = s.profiles.filter(p => p.id !== profile.id); for (const st of STAGES) if (s.assignments[st.id] === profile.id) s.assignments[st.id] = s.profiles[0]?.id || "";
            })}><Trash2 size={16} /></button></div>
              <div className="form-grid"><label>Etichetta<input value={profile.label} onChange={e => editSettings(s => { s.profiles.find(p => p.id === profile.id)!.label = e.target.value; })} /></label>
                <label>Modello<input list={"ai-models-" + profile.id} value={profile.model} placeholder="es. gpt-4.1 / modello locale" onChange={e => editSettings(s => { s.profiles.find(p => p.id === profile.id)!.model = e.target.value; })} />
                  <datalist id={"ai-models-" + profile.id}>{(profile.models || []).map(model => <option key={model} value={model}/>)}</datalist>
                </label>
                <label>Base URL OpenAI-compatible<input value={profile.baseUrl} placeholder="https://api.../v1" onChange={e => editSettings(s => { s.profiles.find(p => p.id === profile.id)!.baseUrl = e.target.value; })} /></label>
                <label>API key (temporanea)<SecretInput secretKey={"ai." + profile.id} placeholder="API key · mai esportata" /></label>
                <label>Thinking predefinito endpoint<select value={profile.reasoningEffort ?? ""} onChange={e => editSettings(s => {
                  const p = s.profiles.find(p => p.id === profile.id)!;
                  if (e.target.value) p.reasoningEffort = e.target.value as "automatic" | "low" | "medium" | "high" | "xhigh";
                  else delete p.reasoningEffort;
                })}>
                  <option value="">Non specificato</option><option value="automatic">Automatico — ometti parametro</option>
                  <option value="low">Low</option><option value="medium">Medium</option>
                  <option value="high">High</option><option value="xhigh">Extra high</option>
                </select></label></div>
              <div className="button-group"><button className="secondary" type="button" onClick={() => void readProviderModels(profile)}>
                <RefreshCw size={14} /> Leggi /models</button>
                <span className="helper">{profile.models?.length || 0} modelli disponibili. Modifica esplicita, nessuna selezione automatica.</span>
              </div>
              <label className="checkline"><input type="checkbox" checked={profile.enabled} onChange={e => editSettings(s => { s.profiles.find(p => p.id === profile.id)!.enabled = e.target.checked; })} /> Endpoint abilitato</label>
            </div>)}
            <div className="panel-subtitle">Modello per task</div><div className="routing-grid">{STAGES.map(stage => <label key={stage.id}>{stage.label}<select value={settings.assignments[stage.id]} onChange={e => editSettings(s => { s.assignments[stage.id] = e.target.value; })}>
              {settings.profiles.map(p => <option key={p.id} value={p.id}>{p.label} — {p.model || "modello da configurare"}</option>)}</select></label>)}</div>
            <AgentRoleRouter settings={settings} onChange={set => editSettings(s => { s.agentRoutes = set.agentRoutes; })} />
          </section>
          <section className="panel"><div className="panel-title"><div><span className="eyebrow">RESEARCH ENGINE</span><h3>Ricerca online</h3></div><Search size={20} /></div>
            <p className="helper">Per competitor e documentazione usa un gateway di ricerca web compatibile CORS che risponde a <code>GET ?q=...</code> con <code>{"{results:[{title,url,snippet}]}"}</code>. Senza gateway usa il fallback Wikipedia, che non è sufficiente per verifiche normative o competitive.</p>
            <label>Search gateway URL (opzionale)<input value={settings.searchEndpoint} placeholder="https://gateway.example.com/search" onChange={e => editSettings(s => { s.searchEndpoint = e.target.value; })} /></label>
          </section>
          <section className="panel"><div className="panel-title"><div><span className="eyebrow">REMOTE EXECUTION</span><h3>Runner Docker remoto</h3></div><Terminal size={20} /></div>
            <p className="helper">Connetti una API su HTTPS esposta tramite Cloudflare Tunnel e protetta da API key. Il worker Docker deve essere isolato su una macchina dedicata; non inserire credenziali cloud nel runner.</p>
            <div className="form-grid"><label>Runner API URL<input value={settings.runnerEndpoint || ""} placeholder="https://runner.example.com" onChange={e => editSettings(s => { s.runnerEndpoint = e.target.value; })}/></label>
              <label>Runner API key (solo sessione)<SecretInput secretKey="runner.key" placeholder="API key per job build/test" onSecretChange={() => setRunnerSecretRevision(value => value + 1)}/></label>
              <label>Operatore repair (solo sessione)<SecretInput secretKey="runner.operator.key" placeholder="Chiave personale con ruoli repair"/></label></div>
            <p className="helper">I checkpoint richiedono una credenziale operatore separata dalla chiave dei job. Ruoli: propose per creare patch/re-test, review per dichiarare review, approve per registrare approvazione. Il client può richiedere di cambiare chiave prima della review o approvazione; non è una prova di identità umana o una firma. Se il runner non configura operatori, l'API repair resta disabilitata.</p>
            <RunnerConnectorSetup endpoint={settings.runnerEndpoint || ""} authRevision={runnerSecretRevision} locale={normalizeLocale(settings.language)} />
            <RunnerTelemetry endpoint={settings.runnerEndpoint || ""} authRevision={runnerSecretRevision} active={busy} />
            <p className="helper">Vai su Code Agent per scegliere .NET build/test, React build/test e Playwright. L’agent restituisce exit code e log; senza dipendenze Node già disponibili offline alcuni step possono fallire o essere saltati.</p>
          </section>
          <section className="panel"><div className="panel-title"><div><span className="eyebrow">SOURCE CONTROL</span><h3>GitHub</h3></div><GitBranch size={20} /></div>
            <GitHubConnectionPanel settings={settings} busy={busy}
              onGitChange={change => {
                editSettings(s => { change(s.git); s.githubAutoSync = false; });
                const active = projectRef.current;
                const newDest = { ...settingsRef.current.git };
                changeProject({ ...active, githubDestination: newDest });
                setPublishConfirmed(false);
              }}
              onAutoSyncChange={toggleGithubAutoSync}
              hasPublishedCheckpoint={githubBindingMatches(project, settings.git)}
              onNotice={setNotice} onError={setError}/>
            <p className="helper">Checkpoint GitHub: {githubBindingMatches(project, settings.git) ?
              project.githubSync!.lastCommit.slice(0,12) + " · " +
              (githubProjectDirty(project, settings.git) ? "modifiche locali non salvate" : "sincronizzato") :
              "nessun primo commit confermato per questa destinazione"}.</p>
            <div className="button-group">
              <button className="secondary" type="button" disabled={busy || !settings.git.owner || !settings.git.repo}
                onClick={() => void importFromGithub("status")}><RefreshCw size={15}/> {t(normalizeLocale(settings.language), "githubRemoteHead")}</button>
              <button className="secondary" type="button" disabled={busy || !settings.git.owner || !settings.git.repo}
                onClick={() => void importFromGithub("import")}><Download size={15}/> {t(normalizeLocale(settings.language), "githubRemoteImport")}</button>
            </div>
            {githubPreview && githubPreview.repository.toLowerCase() ===
              (settings.git.owner + "/" + settings.git.repo).toLowerCase() &&
              githubPreview.branch === settings.git.branch && <div className="github-diff-preview">
                <strong>Confronto in sola lettura · {githubPreview.headSha.slice(0,12)}</strong>
                <p className="helper">Remoto: {githubPreview.projectName} ·
                  {githubPreview.sameProject ? " stesso progetto" : " PROGETTO DIFFERENTE"} ·
                  {githubPreview.remoteAdvanced ? " branch remoto avanzato/non associato" : " HEAD già nota"}.
                  Modifiche locali: {githubPreview.localDirty ? "presenti" : "nessuna"}.
                  Non vengono risolti automaticamente i conflitti.</p>
                <p className="helper">Solo in locale: {githubPreview.onlyLocal.length} ·
                  Solo in GitHub: {githubPreview.onlyRemote.length} ·
                  File con contenuto diverso: {githubPreview.changed.length}.
                  {githubPreview.truncated ? " Elenco abbreviato." : ""}</p>
                {(["onlyLocal","onlyRemote","changed"] as const).map(group =>
                  githubPreview[group].length ? <details key={group}>
                    <summary>{group === "onlyLocal" ? "File presenti solo in locale" :
                      group === "onlyRemote" ? "File presenti solo su GitHub" :
                      "File modificati"} ({githubPreview[group].length})</summary>
                    <ul>{githubPreview[group].map(path => <li key={path}><code>{path}</code></li>)}</ul>
                  </details> : null)}
                <p className="helper">Il controllo mostra nomi e differenze di file generati,
                  non applica patch. Per importare un progetto diverso o con divergenze
                  bisogna scaricare prima il backup locale.</p>
              </div>}
            <p className="helper">Push atomico con Git Data API e fast-forward, senza force push. Per GitHub App serve un broker sicuro: non mettere una chiave privata App nella SPA. Il merge dei branch resta una decisione esplicita su GitHub.</p>
            <label className="checkline"><input type="checkbox" checked={publishConfirmed} onChange={e => setPublishConfirmed(e.target.checked)} /> Ho verificato file e visibilità della repository; autorizzo creazione e commit.</label>
            <div className="button-group align-right"><button className="secondary" onClick={() => setTab("stack")}><FileText size={15} /> Anteprima file</button>
              <button className="primary" disabled={busy || !writerLeaseReady || Boolean(localConflict) || !publishConfirmed || !paths.length} onClick={() => void publish()}><GitCommit size={17} /> Pubblica su GitHub</button></div>
            {lastPush && <a className="link-result" href={lastPush} target="_blank" rel="noopener noreferrer">Apri ultimo commit <ExternalLink size={14} /></a>}
          </section>
          <section className="panel"><div className="panel-title"><div><span className="eyebrow">BACKUP & RESTORE</span><h3>Google Drive / OneDrive</h3></div><Cloud size={20} /></div>
            <div className="form-grid"><label>Provider<select value={settings.cloud.provider} onChange={e => editSettings(s => { s.cloud.provider = e.target.value as "google" | "microsoft"; })}><option value="google">Google Drive · appDataFolder</option><option value="microsoft">Microsoft OneDrive · app folder</option></select></label>
              <label>OAuth SPA client ID<input value={settings.cloud.clientId} placeholder="Client ID registrato sul provider" onChange={e => editSettings(s => { s.cloud.clientId = e.target.value; })} /></label></div>
            <p className="helper">Registra un'app OAuth pubblica con redirect URI <code>{location.origin + location.pathname}</code>. Google richiede scope drive.appdata; Microsoft Files.ReadWrite.AppFolder. Il token rimane in sessionStorage, senza refresh token persistente. Il backup sovrascrive lo snapshot cloud precedente.</p>
            <p className="helper">Backup: settings non segreti (endpoint, ruoli, thinking e URL runner) trasferibili su altri dispositivi. Le API key restano nella sessione: per trasferirle servirà un vault cifrato come BookWriter. Il backup attuale è manuale, sovrascrive lo snapshot precedente e non risolve i conflitti multi-device.</p>

            <div className="runner-vault-control">
              <strong>Vault cifrato del connector runner (BookWriter-style)</strong>
              <p className="helper">URL HTTPS + API key del runner vengono cifrati nel browser con PBKDF2/AES-GCM
                e salvati in un file separato e privato della cartella app cloud. La passphrase non è salvata:
                serve su ogni nuovo dispositivo. Il token Cloudflare resta sul server, mai nel vault.
                Sincronizzazione manuale con conferma, ancora senza protezione CAS da modifiche contemporanee.</p>
              <label>Passphrase vault (minimo 12 caratteri)
                <input type="password" autoComplete="off" value={runnerVaultPassphrase}
                  onChange={e => setRunnerVaultPassphrase(e.target.value)} placeholder="Solo in memoria durante l'operazione" />
              </label>
              <div className="button-group">
                <button type="button" className="secondary" disabled={busy || runnerVaultPassphrase.length < 12 ||
                  !readSecret("cloud." + settings.cloud.provider) || !settings.runnerEndpoint || !readSecret("runner.key")}
                  onClick={() => void runRunnerVaultAction("save")}>Cifra e salva connector</button>
                <button type="button" className="secondary" disabled={busy || runnerVaultPassphrase.length < 12 ||
                  !readSecret("cloud." + settings.cloud.provider)}
                  onClick={() => void runRunnerVaultAction("load")}>Apri vault su questo dispositivo</button>
              </div>
            </div>
            <div className="button-group"><button className="secondary" disabled={busy} onClick={() => void startCloudLogin(settings.cloud).catch(e => setError(e instanceof Error ? e.message : String(e)))}><Cloud size={16} /> {readSecret("cloud." + settings.cloud.provider) ? "Ricollega" : "Connetti"} {settings.cloud.provider === "google" ? "Drive" : "OneDrive"}</button>
              <button className="secondary" disabled={busy || !readSecret("cloud." + settings.cloud.provider)} onClick={() => void cloudAction("save")}><Download size={16} /> Backup</button>
              <button className="subtle" disabled={busy || !readSecret("cloud." + settings.cloud.provider)} onClick={() => void cloudAction("load")}><RefreshCw size={16} /> Ripristina</button></div>
          </section>
          <div className="settings-note"><ShieldAlert size={18} /><span>Una SPA non può proteggere le chiavi da JavaScript malevolo eseguito nella stessa origin. Usa PAT minimali, OAuth PKCE, repository private e un backend broker per GitHub App e segreti di produzione.</span></div>
        </>}
        <footer className="footer"><span>© 2026 SoftwareFactory · Autonomous by design, reviewed by humans.</span><span>React + TypeScript <ChevronDown size={12} /> .NET 11 <ChevronDown size={12} /> Cloud agnostic</span></footer>
      </div>
    </main>
    <BackgroundTaskToast busy={busy} operation={operation} selectedStage={selectedStage}
      projectName={project.config.name} completed={completed} total={STAGES.length}
      latestLog={runLog[0]} runner={runnerTaskActivity}
      onOpen={section => setTab(section)} />
  </div>;
}
