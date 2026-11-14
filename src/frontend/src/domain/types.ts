import type { DevelopmentWorkspace } from "./development";

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
  enabled: boolean;
}
export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  output: string;
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
  profiles: AiProfile[];
  assignments: Record<StageId, string>;
  searchEndpoint: string;
  git: GitConfig;
  cloud: CloudConfig;
}
export interface FactoryProject {
  id: string;
  config: ProjectConfig;
  stages: Stage[];
  createdAt: string;
  updatedAt: string;
  development?: DevelopmentWorkspace;
}
export interface Activity {
  id: string;
  stage: StageId;
  startedAt: string;
  finishedAt: string;
  status: "success" | "failed";
  message: string;
}
