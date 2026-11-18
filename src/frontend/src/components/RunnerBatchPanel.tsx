import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Play, RefreshCw, ShieldAlert } from "lucide-react";
import type { FactoryProject, FactorySettings } from "../domain/types";
import { t, normalizeLocale } from "../i18n";
import { planRunnerBatch, runnerBatchSignature } from "../application/runner-batch";
import { fetchRunnerWorkflow, runnerEndpoint, runnerPollDecision,
  submitRunnerWorkflowBatch, type RunnerStep, type RunnerWorkflowResult } from "../infrastructure/runner";
import { readSecret } from "../infrastructure/store";
import "./runner-batch.css";

type Props = {
  project: FactoryProject;
  settings: FactorySettings;
  selectedSteps: RunnerStep[];
  busy: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};
type Saved = {
  endpoint: string;
  workflowId?: string;
  snapshotTag?: string;
  pending?: { signature: string; key: string };
};
const STORAGE_PREFIX = "softwarefactory.runner.batch.v1.";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const terminal = new Set(["passed", "failed", "incomplete", "out_of_order"]);
const stamp = (project: FactoryProject) =>
  project.id + ":" + project.updatedAt + ":" + (project.development?.revision ?? 0);

export default function RunnerBatchPanel({
  project, settings, selectedSteps, busy, onNotice, onError,
}: Props) {
  const locale = normalizeLocale(settings.language);
  const endpoint = settings.runnerEndpoint || "";
  const secret = readSecret("runner.key");
  const [consented, setConsented] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [workflowId, setWorkflowId] = useState("");
  const [workflow, setWorkflow] = useState<RunnerWorkflowResult | null>(null);
  const [snapshotTag, setSnapshotTag] = useState("");
  const [notice, setNotice] = useState("");
  const [pollRestart, setPollRestart] = useState(0);
  const pendingRetry = useRef<Saved["pending"]>(undefined);
  const currentProject = useRef(project);
  currentProject.current = project;
  const storageKey = STORAGE_PREFIX + project.id;
  const planned = useMemo(() => {
    try { return planRunnerBatch(project, selectedSteps); }
    catch { return null; }
  }, [project, selectedSteps]);

  // A session contains only a UUID, digests, endpoint, and project revision:
  // no token and no uploaded source code are persisted in the browser.
  useEffect(() => {
    setConsented(false); setWorkflow(null); setWorkflowId("");
    setSnapshotTag(""); setNotice("");
    pendingRetry.current = undefined;
    if (!endpoint) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null") as Saved | null;
      if (!saved || saved.endpoint !== runnerEndpoint(endpoint)) return;
      if (typeof saved.workflowId === "string" && UUID.test(saved.workflowId))
        setWorkflowId(saved.workflowId);
      if (typeof saved.snapshotTag === "string" && saved.snapshotTag.length < 120)
        setSnapshotTag(saved.snapshotTag);
      if (saved.pending && UUID.test(saved.pending.key) &&
          typeof saved.pending.signature === "string" &&
          saved.pending.signature.length < 1500)
        pendingRetry.current = saved.pending;
    } catch { /* browser storage inaccessible or invalid */ }
  }, [storageKey, endpoint]);

  const save = (entry: Saved) => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(entry)); }
    catch { /* missing storage never authorizes duplicate or automatic submit */ }
  };

  useEffect(() => {
    setWorkflow(null);
    if (!workflowId || !endpoint || !secret) return;
    const controller = new AbortController();
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const result = await fetchRunnerWorkflow(endpoint, secret, workflowId, controller.signal);
        if (disposed || controller.signal.aborted) return;
        failures = 0;
        setNotice(""); setWorkflow(result);
        if (!terminal.has(result.status)) timer = setTimeout(() => void tick(), 3000);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setWorkflow(null); // no stale success after integrity or auth denial
        const retry = runnerPollDecision(error, failures);
        if (retry.retry) {
          failures = retry.attempt;
          setNotice(t(locale, "batchRetrying") + " " + retry.attempt + "/5");
          timer = setTimeout(() => void tick(), retry.delayMs);
        } else setNotice(t(locale, "batchNotVerified"));
      }
    };
    void tick();
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [workflowId, endpoint, secret, pollRestart, locale]);

  const submit = async () => {
    if (!planned || !consented || busy || requesting || !endpoint || !secret ||
        project.development?.pending) return;
    const location = runnerEndpoint(endpoint);
    const count = Object.keys(planned.tasks[0].request.files).length;
    const preview = planned.tasks.map((task,i) =>
      (i + 1) + ". " + task.id + " (" + task.role + ")").join("\n");
    if (!window.confirm(t(locale, "batchConfirm") + "\n" +
        location + "\n" + count + " " + t(locale, "batchFiles") + "\n" + preview))
      return;
    setRequesting(true); setNotice("");
    const projectTag = stamp(project);
    try {
      const signature = await runnerBatchSignature(endpoint, project, planned);
      if (stamp(currentProject.current) !== projectTag)
        throw new Error(t(locale, "batchHistorical"));
      const previous = pendingRetry.current;
      const key = previous?.signature === signature ? previous.key : crypto.randomUUID();
      pendingRetry.current = { signature, key };
      save({ endpoint: location, workflowId: workflowId || undefined,
        snapshotTag: snapshotTag || undefined, pending: { signature, key } });
      const result = await submitRunnerWorkflowBatch(endpoint, secret, planned, undefined, key);
      if (stamp(currentProject.current) !== projectTag)
        throw new Error(t(locale, "batchHistorical"));
      pendingRetry.current = undefined;
      setWorkflowId(result.id); setWorkflow(result); setSnapshotTag(projectTag);
      setConsented(false);
      save({ endpoint: location, workflowId: result.id, snapshotTag: projectTag });
      onNotice(t(locale, result.created === false ? "batchReplayed" : "batchCreated") +
        " " + result.id + ". " + t(locale, "batchNoApproval"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message); onError(message);
    } finally { setRequesting(false); }
  };

  const historical = Boolean(workflowId && snapshotTag && snapshotTag !== stamp(project));
  return <details className="runner-batch">
    <summary><Activity size={16}/>
      <strong>{t(locale, "batchTitle")}</strong>
      <span>{t(locale, "batchAdvanced")}</span>
    </summary>
    <p className="helper">{t(locale, "batchExplain")}</p>
    {!endpoint || !secret ? <p className="code-agent-warning"><ShieldAlert size={15}/>
      {t(locale, "batchNoRunner")}</p> : null}
    {project.development?.pending ? <p className="code-agent-warning"><ShieldAlert size={15}/>
      {t(locale, "batchPendingPatch")}</p> : null}
    {!planned && !project.development?.pending &&
      <p className="helper">{t(locale, "batchNeedTwo")}</p>}
    {planned && <div className="runner-batch-preview">
      <strong>{t(locale, "batchPreview")}</strong>
      <small>{t(locale, "batchFiles")}: {Object.keys(planned.tasks[0].request.files).length}</small>
      <ol>{planned.tasks.map((task,i)=><li key={task.id}>
        <span><strong>{task.id}</strong> · {task.role}</span>
        <small>{i === 0 ? t(locale, "batchFirst") :
          t(locale, "batchAfter") + ": " + task.dependsOn.join(", ")}</small>
      </li>)}</ol>
    </div>}
    <label className="checkline runner-batch-consent">
      <input type="checkbox" checked={consented} disabled={busy || requesting || !planned ||
        !endpoint || !secret || Boolean(project.development?.pending)}
        onChange={e => setConsented(e.target.checked)}/>
      {t(locale, "batchConsent")}
    </label>
    <div className="runner-batch-actions">
      <button type="button" className="secondary"
        disabled={!consented || !planned || !endpoint || !secret || busy ||
          requesting || Boolean(project.development?.pending)}
        onClick={() => void submit()}>
        {requesting ? <RefreshCw size={15} className="spinning"/> : <Play size={15}/>}
        {t(locale, requesting ? "batchSending" : "batchSubmit")}
      </button>
      {workflowId && <button type="button" className="secondary"
        disabled={requesting || busy || !endpoint || !secret}
        onClick={() => setPollRestart(n => n + 1)}>
        <RefreshCw size={15}/>{t(locale, "batchRefresh")}
      </button>}
    </div>
    <p className="helper">{t(locale, "batchNoApproval")}</p>
    {notice && <p className="runner-batch-notice" role="status">{notice}</p>}
    {pendingRetry.current && !requesting &&
      <p className="helper">{t(locale, "batchRetryHint")}</p>}
    {workflowId && <div className="runner-batch-result" aria-live="polite">
      <strong>{t(locale, "batchReport")} · <code>{workflowId.slice(0,8)}…</code></strong>
      {historical && <p className="code-agent-warning"><ShieldAlert size={15}/>
        {t(locale, "batchHistorical")}</p>}
      {workflow ? <>
        <p>{t(locale, "batchStatus")}: <strong>{workflow.status}</strong></p>
        <ol>{workflow.tasks.map(task => <li key={task.id}>
          <span><strong>{task.id}</strong> · {task.status}</span>
          <small>{task.role} · {task.jobId.slice(0,8)}… · {task.evidence.count} journal</small>
          <small>{task.dependsOn.length ? t(locale, "batchAfter") + ": " +
            task.dependsOn.join(", ") : t(locale, "batchFirst")}</small>
        </li>)}</ol>
      </> : <p className="helper">{t(locale, "batchNotVerified")}</p>}
    </div>}
  </details>;
}
