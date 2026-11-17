import { DEFAULT_SETTINGS, createProject } from "../domain/defaults";
import type { FactoryProject, FactorySettings } from "../domain/types";

const PROJECT_KEY = "softwarefactory.project.v1";
const SETTINGS_KEY = "softwarefactory.settings.v1";
const PROJECT_LIBRARY_PREFIX = "softwarefactory.project.library.v1.";
const PROJECT_INDEX = "softwarefactory.project.index.v1";
const SECRET_PREFIX = "softwarefactory.secret.";

export function loadProject(): FactoryProject {
  try {
    const value = localStorage.getItem(PROJECT_KEY);
    if (value) {
      const project = JSON.parse(value) as FactoryProject;
      if (project && project.id && project.config && Array.isArray(project.stages)) {
        return { ...project, stages: project.stages.map(s => s.status === "running" ? { ...s, status: "pending" as const } : s) };
      }
    }
  } catch { /* invalid local state */ }
  return createProject();
}
export type LocalProjectChoice = { id: string; name: string; updatedAt: string; repository: string };
function index(): LocalProjectChoice[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(PROJECT_INDEX) || "[]");
    if (!Array.isArray(list)) return [];
    return list.filter((x: unknown): x is LocalProjectChoice =>
      Boolean(x) && typeof x === "object" && typeof (x as LocalProjectChoice).id === "string" &&
      /^[0-9a-f-]{36}$/i.test((x as LocalProjectChoice).id) &&
      typeof (x as LocalProjectChoice).name === "string" &&
      typeof (x as LocalProjectChoice).updatedAt === "string" &&
      typeof (x as LocalProjectChoice).repository === "string").slice(0, 40);
  } catch { return []; }
}
export function listLocalProjects(): LocalProjectChoice[] {
  return index().sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function loadLocalProject(id: string): FactoryProject {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error("ID progetto locale non valido.");
  const data = localStorage.getItem(PROJECT_LIBRARY_PREFIX + id);
  if (!data || data.length > 1_000_000) throw Error("Progetto non trovato o troppo grande.");
  let project: FactoryProject;
  try { project = JSON.parse(data) as FactoryProject; }
  catch { throw Error("Progetto locale non valido."); }
  if (!project || project.id !== id || !project.config ||
      !Array.isArray(project.stages) || typeof project.config.name !== "string")
    throw Error("Progetto locale corrotto.");
  return { ...project, stages: project.stages.map(s => s.status === "running" ?
    { ...s, status: "pending" as const } : s) };
}
export function persistProject(project: FactoryProject): void {
  const raw = JSON.stringify(project);
  localStorage.setItem(PROJECT_KEY, raw);
  // Retain up to 40 nonsecret local projects, never PAT/API credentials.
  try {
    localStorage.setItem(PROJECT_LIBRARY_PREFIX + project.id, raw);
    const all = index();
    const current = { id: project.id, name: project.config.name,
      updatedAt: project.updatedAt,
      repository: project.githubDestination?.owner && project.githubDestination.repo ?
        project.githubDestination.owner + "/" + project.githubDestination.repo : "" };
    const selected = [current, ...all.filter(x => x.id !== project.id)].slice(0, 40);
    localStorage.setItem(PROJECT_INDEX, JSON.stringify(selected));
  } catch {
    // The current project remains saved. A full localStorage quota means
    // the library isn't guaranteed; manual ZIP/Cloud backup is still necessary.
  }
}
export function loadSettings(): FactorySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<FactorySettings>;
      return {
        ...DEFAULT_SETTINGS, ...s,
        profiles: Array.isArray(s.profiles) ? s.profiles : DEFAULT_SETTINGS.profiles,
        assignments: { ...DEFAULT_SETTINGS.assignments, ...(s.assignments || {}) },
        git: { ...DEFAULT_SETTINGS.git, ...(s.git || {}) },
        cloud: { ...DEFAULT_SETTINGS.cloud, ...(s.cloud || {}) },
      };
    }
  } catch { /* invalid settings */ }
  return structuredClone(DEFAULT_SETTINGS);
}
export function persistSettings(settings: FactorySettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
// Secrets are session-scoped and never included in project exports or remote commits.
export function readSecret(key: string): string {
  return sessionStorage.getItem(SECRET_PREFIX + key) || "";
}
export function saveSecret(key: string, value: string): void {
  if (value) sessionStorage.setItem(SECRET_PREFIX + key, value);
  else sessionStorage.removeItem(SECRET_PREFIX + key);
}
