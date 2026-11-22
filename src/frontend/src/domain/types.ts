import type { DevelopmentWorkspace } from "./development";
import type { AgentRoleRoutes, ThinkingChoice } from "./agent-roles";

export type StageId = "features" | "competitors" | "technical" | "architecture" | "adversarial" | "implementation";
export type StageStatus = "pending" | "running" | "complete" | "failed";
export type FrontendKind = "react" | "react-native" | "android" | "ios" | "unity";
export type DeploymentTarget = "azure" | "aws" | "gcp" | "kubernetes" | "docker";
export type ServiceKind = "database" | "cache" | "queue" | "telemetry" | "storage";
export type EnvironmentName = "development" | "production";

export interface AiProfile {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  /** Inventory from a user-triggered GET /models, not automatic discovery. */
  models?: string[];
  enabled: boolean;
  /** BookWriter-style endpoint fallback. Automatic omits reasoning_effort. */
  reasoningEffort?: ThinkingChoice;
}
export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  output: string;
  /** Optional origin assertion of the local authoring path, NOT test/review evidence.
   * Older backups without this field have unknown provenance. */
  completionOrigin?: "manual" | "ai";
  error?: string;
  sources: ResearchSource[];
  updatedAt?: string;
}
export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
  query: string;
  fetchedAt: string;
}
export interface ServiceBinding {
  development: string;
  production: string;
}
export interface ProjectConfig {
  name: string;
  description: string;
  frontends: FrontendKind[];
  deployment: DeploymentTarget;
  dotnetVersion: "11.0" | "10.0";
  database: "postgresql" | "sqlserver" | "mysql" | "sqlite";
  services: Record<ServiceKind, ServiceBinding>;
  requirements: string;
}
export interface GitConfig {
  owner: string;
  repo: string;
  branch: string;
  authMode: "pat" | "app";
  appGateway: string;
  privateRepo: boolean;
}
export interface CloudConfig {
  provider: "google" | "microsoft";
  clientId: string;
}
export interface FactorySettings {
  language?: "it" | "en";
  profiles: AiProfile[];
  assignments: Record<StageId, string>;
  /** Per-role model/endpoint/effort override, saved in cloud configuration. */
  agentRoutes?: AgentRoleRoutes;
  searchEndpoint: string;
  runnerEndpoint?: string;
  git: GitConfig;
  /** Opt-in, browser-open sync after a confirmed first push. */
  githubAutoSync?: boolean;
  cloud: CloudConfig;
}
export interface FactoryProject {
  id: string;
  config: ProjectConfig;
  stages: Stage[];
  createdAt: string;
  updatedAt: string;
  development?: DevelopmentWorkspace;
  /** Per-project repository destination; PAT is shared in session/device vault. */
  githubDestination?: GitConfig;
  /** Last remotely confirmed Git commit; no secrets or PAT. */
  githubSync?: {
    owner: string; repo: string; branch: string; lastCommit: string;
    syncedLocalUpdatedAt: string; syncedAt: string;
    /** Explicit consent for public repository publication; never inferred from config. */
    publicConsent?: boolean;
  };
  /** Non-secret GitHub Actions dispatch binding; PAT stays in sessionStorage. */
  githubTestReceipt?: {
    requestId: string; repository: string; branch: string; commitSha: string;
    createdAt: string; selected: ("dotnet-build"|"dotnet-test"|"web-build"|"web-test"|"playwright")[];
    runId?: number;
  };
}
export interface Activity {
  id: string;
  stage: StageId;
  startedAt: string;
  finishedAt: string;
  status: "success" | "failed";
  message: string;
}
