import type { FactoryProject, FactorySettings, ProjectConfig, ServiceKind, Stage, StageId } from "./types";

export const STAGES: { id: StageId; label: string; detail: string }[] = [
  { id: "features", label: "Piano feature", detail: "Requisiti, backlog e priorità" },
  { id: "competitors", label: "Analisi competitor", detail: "Alternative e differenziazione" },
  { id: "technical", label: "Ricerca tecnica", detail: "Documentazione, standard e vincoli normativi" },
  { id: "architecture", label: "Architettura", detail: "DDD, provider e ADR" },
  { id: "adversarial", label: "Adversarial review", detail: "Rischi, lacune e contraddizioni" },
  { id: "implementation", label: "Piano implementativo", detail: "Task, test e criteri di accettazione" },
];
export const SERVICE_OPTIONS: Record<ServiceKind, string[]> = {
  database: ["postgresql", "azure-postgresql", "aws-rds", "cloud-sql", "sqlserver", "mysql", "sqlite"],
  cache: ["none", "redis", "azure-managed-redis", "aws-elasticache", "gcp-memorystore"],
  queue: ["none", "rabbitmq", "azure-service-bus", "aws-sqs", "gcp-pubsub"],
  telemetry: ["opentelemetry-jaeger", "grafana-prometheus", "azure-application-insights", "aws-cloudwatch", "gcp-cloud-monitoring"],
  storage: ["local", "minio", "azure-blob", "aws-s3", "gcp-cloud-storage"],
};
export const SERVICE_LABELS: Record<ServiceKind, string> = {
  database: "Database", cache: "Cache", queue: "Messaggistica", telemetry: "Osservabilità", storage: "Object storage",
};
export const SERVICE_KINDS = Object.keys(SERVICE_LABELS) as ServiceKind[];
export const DEFAULT_CONFIG: ProjectConfig = {
  name: "Nuova applicazione",
  description: "",
  frontends: ["react"],
  deployment: "docker",
  dotnetVersion: "11.0",
  database: "postgresql",
  requirements: "",
  services: {
    database: { development: "postgresql", production: "postgresql" },
    cache: { development: "none", production: "none" },
    queue: { development: "none", production: "none" },
    telemetry: { development: "opentelemetry-jaeger", production: "opentelemetry-jaeger" },
    storage: { development: "local", production: "local" },
  },
};
export const DEFAULT_SETTINGS: FactorySettings = {
  language: "it",
  profiles: [{ id: "default", label: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", model: "", enabled: true }],
  assignments: { features: "default", competitors: "default", technical: "default", architecture: "default", adversarial: "default", implementation: "default" },
  searchEndpoint: "",
  runnerEndpoint: "",
  git: { owner: "", repo: "", branch: "main", authMode: "pat", appGateway: "", privateRepo: true },
  cloud: { provider: "google", clientId: "" },
};
export function createProject(): FactoryProject {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), config: structuredClone(DEFAULT_CONFIG),
    stages: STAGES.map(({ id, label }): Stage => ({ id, label, status: "pending", output: "", sources: [] })),
    createdAt: now, updatedAt: now,
  };
}
export function updateConfig(project: FactoryProject, config: ProjectConfig): FactoryProject {
  const stages = project.stages.map(s => s.status === "running" ? { ...s, status: "pending" as const } : s);
  return { ...project, config, stages, updatedAt: new Date().toISOString() };
}
