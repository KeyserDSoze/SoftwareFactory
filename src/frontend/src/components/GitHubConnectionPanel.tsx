import { useEffect, useRef, useState } from "react";
import { Cloud, DownloadCloud, Eye, EyeOff, Github, LockKeyhole,
  RefreshCw, Search, ShieldAlert, Trash2 } from "lucide-react";
import type { FactorySettings, GitConfig } from "../domain/types";
import { readSecret, saveSecret } from "../infrastructure/store";
import { assertGithubPat, deviceHasGithubPat, forgetGithubPatOnDevice,
  saveGithubPatOnDevice, unlockGithubPatOnDevice, forgetGithubPatInSession } from "../infrastructure/github-pat-device";
import { saveGithubPatToCloud, restoreGithubPatFromCloud } from "../infrastructure/github-pat-cloud";
import { findGithubRepositories, inspectGithubRepository,
  type GithubRepositoryChoice } from "../infrastructure/github-discovery";
import { normalizeLocale, t } from "../i18n";

type Props = { settings: FactorySettings; busy: boolean;
  onGitChange: (edit: (config: GitConfig) => void) => void;
  onAutoSyncChange: (enabled: boolean) => void;
  onNotice: (notice: string) => void; onError: (message: string) => void;
  hasPublishedCheckpoint: boolean;
};
export default function GitHubConnectionPanel({
  settings, busy, onGitChange, onAutoSyncChange,
  onNotice, onError, hasPublishedCheckpoint,
}: Props) {
  const locale = normalizeLocale(settings.language);
  const en = locale === "en";
  const [patDraft, setPatDraft] = useState("");
  const [hasStored, setHasStored] = useState(false);
  const [hasSession, setHasSession] = useState(() => Boolean(readSecret("github.pat")));
  const [reveal, setReveal] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [working, setWorking] = useState(false);
  const [choices, setChoices] = useState<GithubRepositoryChoice[] | null>(null);
  const [info, setInfo] = useState<GithubRepositoryChoice | null>(null);
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    void deviceHasGithubPat().then(v => { if (mounted.current) setHasStored(v); })
      .catch(() => { if (mounted.current) setHasStored(false); });
    return () => { mounted.current = false; generation.current++; };
  }, []);
  const report = (error: unknown) => onError(error instanceof Error ? error.message : String(error));
  async function work(job: (current: () => boolean) => Promise<void>) {
    if (working || busy) return;
    const id = ++generation.current, current = () => mounted.current && generation.current === id;
    setWorking(true); setStatus("");
    try { await job(current); } catch (e) { if (current()) report(e); }
    finally { if (current()) { setWorking(false); setPassphrase(""); } }
  }
  const store = () => void work(async current => {
    const normalized = assertGithubPat(patDraft);
    await saveGithubPatOnDevice(normalized);
    if (!current()) return;
    setPatDraft(""); setHasStored(true); setHasSession(true); setReveal(false);
    onNotice(en ? "PAT encrypted with your non-extractable device key and unlocked in this session." :
      "PAT cifrato con la chiave non estraibile del dispositivo e disponibile in sessione.");
  });
  const session = () => void work(async current => {
    saveSecret("github.pat", assertGithubPat(patDraft));
    if (!current()) return;
    setPatDraft(""); setHasSession(true); setReveal(false);
    onNotice(en ? "PAT ready for this browser session only." : "PAT attivo soltanto per questa sessione.");
  });
  const unlock = () => void work(async current => {
    if (!await unlockGithubPatOnDevice()) throw Error("Nessun PAT cifrato sul dispositivo.");
    if (current()) { setHasSession(true); onNotice(en ? "PAT unlocked." : "PAT locale sbloccato."); }
  });
  const forget = () => void work(async current => {
    if (!window.confirm(en ? "Delete the local encrypted PAT and clear this session? GitHub won't revoke the token." :
      "Eliminare il PAT cifrato da questo dispositivo e dalla sessione? Il token NON viene revocato su GitHub.")) return;
    await forgetGithubPatOnDevice();
    if (current()) { setHasStored(false); setHasSession(false); setReveal(false);
      setChoices(null); onNotice(en ? "Local PAT erased. Revoke it separately in GitHub Settings." :
        "PAT locale cancellato. Revocalo separatamente nelle impostazioni GitHub."); }
  });
  const cloud = (mode: "save" | "load") => void work(async current => {
    if (passphrase.length < 12) throw Error("Passphrase di almeno 12 caratteri obbligatoria.");
    if (!readSecret("cloud." + settings.cloud.provider)) throw Error("Connetti prima il cloud.");
    if (!window.confirm(mode === "save" ?
      (en ? "Encrypt and save the PAT to your private cloud app folder? The existing vault may be replaced." :
        "Cifrare e salvare il PAT nella cartella privata cloud? Il vault esistente può essere sostituito.") :
      (en ? "Import the encrypted PAT to this device? This replaces your local PAT." :
        "Importare il PAT cifrato sul dispositivo? Verrà sostituito il PAT locale."))) return;
    if (mode === "save") {
      const pat = readSecret("github.pat");
      if (!pat) throw Error("Sblocca prima il PAT in questa sessione.");
      await saveGithubPatToCloud(settings.cloud, pat, passphrase);
      if (current()) onNotice(en ? "Encrypted PAT stored in cloud app folder; keep the passphrase safe." :
        "PAT cifrato salvato nella cartella app cloud. Conserva la passphrase.");
    } else {
      const retrieved = await restoreGithubPatFromCloud(settings.cloud, passphrase);
      if (!current()) return;
      await saveGithubPatOnDevice(retrieved);
      if (!current()) return;
      setHasStored(true); setHasSession(true); setReveal(false);
      onNotice(en ? "Cloud PAT decrypted and saved encrypted on this device." :
        "PAT cloud decifrato e salvato cifrato su questo dispositivo.");
    }
  });
  const discover = () => void work(async current => {
    const pat = readSecret("github.pat");
    if (!pat) throw Error("Sblocca prima il PAT.");
    const found = await findGithubRepositories(pat);
    if (!current()) return;
    setChoices(found); setInfo(null);
    setStatus(found.length ? (en ? "Choose a repository below; nothing is published by this choice." :
      "Seleziona una repository: questa operazione non pubblica nulla.") :
      (en ? "No repositories visible with this PAT. You can enter owner/repo manually." :
        "Nessuna repository visibile con questo PAT. Puoi usare la configurazione manuale."));
  });
  const verify = () => void work(async current => {
    const result = await inspectGithubRepository(settings.git, readSecret("github.pat"));
    if (!current()) return;
    setInfo(result);
    setStatus(result.canPush ? (en ? "Account can push; the PAT scope and branch rules still need a real write." :
      "Account con permesso push: scope del PAT e regole branch da verificare con una scrittura reale.") :
      (en ? "Read-only or archived repository." : "Repository in sola lettura o archiviata."));
  });
  function choose(repo: GithubRepositoryChoice) {
    if (!repo.privateRepo && !window.confirm(en ? "This repository is PUBLIC. Source code and project notes may be visible to everyone. Select it?" :
      "Questa repository è PUBBLICA: codice e note del progetto saranno visibili a tutti. Selezionarla?")) return;
    onGitChange(g => { g.owner = repo.owner; g.repo = repo.repo; g.branch = repo.branch; g.privateRepo = repo.privateRepo; });
    setChoices(null); setInfo(repo);
    setStatus(en ? "Repository selected, no push performed." : "Repository selezionata, nessun push eseguito.");
  }
  return <div className="github-guided">
    <div className="panel-subtitle"><LockKeyhole size={16}/> {t(locale, "githubPatTitle")}</div>
    {settings.git.authMode === "pat" ? <>
      <p className="helper">{en ? "Save locally with a non-extractable AES-256 key in IndexedDB, or use session-only mode. Never copied to the application or plain cloud backup." :
        "Salva cifrato con chiave AES-256 non estraibile in IndexedDB oppure usa solo la sessione. Mai nel codice generato né nel backup cloud in chiaro."}</p>
      <div className="form-grid"><label>{en ? "Enter or replace PAT" : "Inserisci o sostituisci PAT"}
        <input type="password" autoComplete="off" value={patDraft} onChange={e => setPatDraft(e.target.value)}
          placeholder="github_pat_..." disabled={busy || working}/>
      </label></div>
      <div className="button-group">
        <button className="secondary" disabled={busy || working || patDraft.trim().length < 20} onClick={store}>
          <LockKeyhole size={15}/>{t(locale, "githubPatSave")}</button>
        <button className="secondary" disabled={busy || working || patDraft.trim().length < 20} onClick={session}>
          {t(locale, "githubPatSession")}</button>
        <button className="secondary" disabled={busy || working || !hasStored} onClick={unlock}>
          <RefreshCw size={15}/>{t(locale, "githubPatUnlock")}</button>
        <button className="subtle" disabled={busy || working || !hasStored} onClick={forget}>
          <Trash2 size={15}/>{t(locale, "githubPatRemove")}</button>
      </div>
      <p className="helper" role="status">{hasSession ?
        t(locale, "githubPatActive") :
        t(locale, "githubPatInactive")} · {hasStored ?
          t(locale, "githubPatRemembered") :
          t(locale, "githubPatNotRemembered")}</p>
      {hasSession && <div className="button-group">
        <button className="subtle" onClick={() => setReveal(v => !v)} disabled={working}>
          {reveal ? <EyeOff size={14}/> : <Eye size={14}/>}
          {reveal ? (en ? "Hide PAT" : "Nascondi PAT") : (en ? "Show PAT" : "Mostra PAT")}</button>
        <button className="subtle" onClick={() => {
          forgetGithubPatInSession(); setHasSession(false); setReveal(false);
        }}>{en ? "Lock this session" : "Blocca questa sessione"}</button>
        {reveal && <input aria-label="PAT visualizzato" readOnly type="text" autoComplete="off"
          value={readSecret("github.pat")}/>}
      </div>}
      <details className="github-cloud-vault">
        <summary><Cloud size={15}/> {t(locale, "githubPatCloud")}</summary>
        <p className="helper">{en ? "End-to-end encrypted with a distinct passphrase (min 12 chars). OneDrive uses ETag conditional writes. Google Drive uses best-effort version checks: concurrent writes are not fully atomic." :
          "Cifratura end-to-end con passphrase distinta (minimo 12 caratteri). OneDrive usa ETag condizionali; Google Drive solo controlli versione best-effort, non CAS atomico garantito."}</p>
        <label>{en ? "Vault passphrase" : "Passphrase del vault"}
          <input type="password" autoComplete="off" value={passphrase}
            onChange={e => setPassphrase(e.target.value)} disabled={busy || working}/></label>
        <div className="button-group">
          <button type="button" className="secondary" disabled={busy || working || !hasSession || passphrase.length < 12 ||
            !readSecret("cloud." + settings.cloud.provider)}
            onClick={() => cloud("save")}>{t(locale, "githubPatCloudSave")}</button>
          <button type="button" className="secondary" disabled={busy || working || passphrase.length < 12 ||
            !readSecret("cloud." + settings.cloud.provider)}
            onClick={() => cloud("load")}><DownloadCloud size={15}/>{t(locale, "githubPatCloudImport")}</button>
        </div>
      </details>
    </> : <p className="helper"><ShieldAlert size={15}/> {en ?
      "GitHub App mode requires an external trusted HTTPS token gateway; it is not available in a browser-only app without that server." :
      "La modalità GitHub App richiede un gateway HTTPS sicuro esterno: non funziona senza quel server nella sola SPA."}</p>}
    <div className="panel-subtitle"><Github size={16}/> {t(locale, "githubRepoLabel")}</div>
    {settings.git.authMode === "pat" && <div className="button-group">
      <button className="secondary" disabled={busy || working || !hasSession} onClick={discover}>
        <Search size={15}/>{t(locale, "githubRepoFind")}</button>
      <button className="secondary" disabled={busy || working || !hasSession || !settings.git.owner || !settings.git.repo} onClick={verify}>
        <RefreshCw size={15}/>{t(locale, "githubRepoInspect")}</button>
    </div>}
    {choices && <div className="github-repositories" aria-label={en ? "GitHub repositories" : "Repository GitHub"} role="list">
      {choices.slice(0,100).map(repo => <div className="github-repo-row" role="listitem" key={repo.fullName}>
        <div><strong>{repo.fullName}</strong><small>{repo.privateRepo ? (en ? "Private" : "Privata") :
          (en ? "PUBLIC" : "PUBBLICA")} · {repo.branch} · {repo.canPush ? "push" : "read-only"}</small></div>
        <button type="button" className="secondary" disabled={busy || working || repo.archived || repo.disabled}
          onClick={() => choose(repo)}>{t(locale, "githubRepoSelect")}</button>
      </div>)}
      {choices.length > 100 && <p className="helper">{choices.length - 100} altre repository: usa i campi avanzati manuali.</p>}
    </div>}
    <details className="github-advanced">
      <summary>{t(locale, "githubRepoAdvanced")}</summary>
      <div className="form-grid">
        <label>Owner<input value={settings.git.owner} placeholder="Username o organizzazione"
          onChange={e => onGitChange(g => { g.owner = e.target.value; })} /></label>
        <label>Repository<input value={settings.git.repo} placeholder="my-application"
          onChange={e => onGitChange(g => { g.repo = e.target.value; })} /></label>
        <label>Branch<input value={settings.git.branch} placeholder="main"
          onChange={e => onGitChange(g => { g.branch = e.target.value; })} /></label>
        <label>{en ? "Connection type" : "Tipo connessione"}
          <select value={settings.git.authMode} onChange={e => onGitChange(g => { g.authMode = e.target.value as "pat" | "app"; })}>
            <option value="pat">PAT fine-grained</option><option value="app">GitHub App · trusted HTTPS gateway</option>
          </select></label>
        {settings.git.authMode === "app" && <label>GitHub App gateway URL
          <input value={settings.git.appGateway} onChange={e => onGitChange(g => { g.appGateway = e.target.value; })}/></label>}
      </div>
    </details>
    <label className="checkline"><input type="checkbox" checked={settings.git.privateRepo}
      onChange={e => onGitChange(g => { g.privateRepo = e.target.checked; })}/>
      {en ? "Create a private repo if it does not exist (requires GitHub permissions)" :
        "Crea una repository privata se manca (richiede permessi GitHub)"}</label>
    {info && <p className="helper">{info.fullName} · {info.privateRepo ? "private" : "PUBLIC"} ·
      {info.canPush ? " account push" : " read-only"} · default {info.branch}</p>}
    {status && <p className="helper" role="status">{status}</p>}
    {settings.githubAutoSync !== undefined && <label className="checkline">
      <input type="checkbox" checked={settings.githubAutoSync ?? false}
        disabled={busy || working || !hasPublishedCheckpoint}
        onChange={e => onAutoSyncChange(e.target.checked)}/>
      {t(locale, "githubRepoAuto")}
    </label>}
  </div>;
}
