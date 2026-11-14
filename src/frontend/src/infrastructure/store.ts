import { DEFAULT_SETTINGS, createProject } from "../domain/defaults";
import type { FactoryProject, FactorySettings } from "../domain/types";

const PROJECT_KEY = "softwarefactory.project.v1";
const SETTINGS_KEY = "softwarefactory.settings.v1";
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
export function persistProject(project: FactoryProject): void {
  localStorage.setItem(PROJECT_KEY, JSON.stringify(project));
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
