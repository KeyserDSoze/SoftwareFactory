import type { AiProfile, FactorySettings, StageId } from "./types";

/** These are selectable responsibilities, not currently 22 independently running agents. */
export const AGENT_ROLES = [
  { id: "product_owner", name: "Product Owner", group: "Product & analisi", duty: "Vision, valore e priorità del prodotto." },
  { id: "business_analyst", name: "Analista funzionale", group: "Product & analisi", duty: "Requisiti, user story, criteri di accettazione e vincoli di business." },
  { id: "business_developer", name: "Business Developer", group: "Product & analisi", duty: "Mercato, competitor, opportunità e sostenibilità commerciale." },
  { id: "research_analyst", name: "Analista tecnico", group: "Product & analisi", duty: "Documentazione, fonti, licenze e verifiche fattuali." },
  { id: "project_manager", name: "Project Manager", group: "Coordinamento", duty: "Piano, milestone, dipendenze, scadenze e blocchi." },
  { id: "scrum_master", name: "Scrum Master", group: "Coordinamento", duty: "Flusso del lavoro, impedimenti e retrospettive." },
  { id: "software_architect", name: "Software Architect", group: "Architettura", duty: "Domini, API, DDD, tradeoff e decision record." },
  { id: "cloud_architect", name: "Cloud Architect", group: "Architettura", duty: "Infrastruttura cloud, costi, compliance e scaling." },
  { id: "onprem_architect", name: "On-Prem Architect", group: "Architettura", duty: "Server, reti private, storage, Docker e resilienza locale." },
  { id: "security_engineer", name: "Security Engineer", group: "Architettura", duty: "Threat model, identità, segreti e security gate indipendenti." },
  { id: "backend_developer", name: "Backend Developer", group: "Sviluppo", duty: "API, servizi, domini e test backend." },
  { id: "frontend_developer", name: "Frontend Developer", group: "Sviluppo", duty: "UI React, accessibilità e test frontend." },
  { id: "mobile_developer", name: "Mobile Developer", group: "Sviluppo", duty: "Client Android/iOS e test nativi." },
  { id: "database_engineer", name: "Database Engineer", group: "Sviluppo", duty: "Schema, migrazioni e performance dati." },
  { id: "devops_engineer", name: "DevOps / SRE", group: "Sviluppo", duty: "CI/CD, osservabilità, infrastruttura e release safety." },
  { id: "code_reviewer", name: "Code Reviewer", group: "Qualità & rilascio", duty: "Review indipendente delle patch, sicurezza, correttezza e regressioni." },
  { id: "test_architect", name: "Test Architect", group: "Qualità & rilascio", duty: "Strategia di test, coverage e quality gate." },
  { id: "tester", name: "Tester / QA", group: "Qualità & rilascio", duty: "Esegue test reali sul runner e registra problemi verificati." },
  { id: "bug_triager", name: "Bug Triager", group: "Qualità & rilascio", duty: "Classifica i fallimenti reali e instrada i bug ai fix." },
  { id: "fix_developer", name: "Fix Developer", group: "Qualità & rilascio", duty: "Corregge bug circoscritti, richiede review e re-test." },
  { id: "release_manager", name: "Release Manager", group: "Qualità & rilascio", duty: "Gestisce checklist, gate di produzione e rollout supervisionato." },
  { id: "technical_writer", name: "Technical Writer", group: "Qualità & rilascio", duty: "Documentazione, runbook e changelog." },
] as const;

export type AgentRoleId = (typeof AGENT_ROLES)[number]["id"];
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";
export type ThinkingChoice = "automatic" | ReasoningLevel;
export type AgentRoleRoute = { profileId?: string; modelId?: string; thinking?: ThinkingChoice };
export type AgentRoleRoutes = Partial<Record<AgentRoleId, AgentRoleRoute>>;

const roleIds = new Set<string>(AGENT_ROLES.map(r => r.id));
const levels = new Set<string>(["automatic", "low", "medium", "high", "xhigh"]);
const STAGE_ROLE: Record<StageId, AgentRoleId> = {
  features: "business_analyst", competitors: "business_developer",
  technical: "research_analyst", architecture: "software_architect",
  adversarial: "security_engineer", implementation: "project_manager",
};
export const stageAgentRole = (stage: StageId) => STAGE_ROLE[stage];

export function validateAgentRoutes(value: unknown): asserts value is AgentRoleRoutes {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Router ruoli non valido.");
  for (const [role, raw] of Object.entries(value)) {
    if (!roleIds.has(role) || !raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Ruolo software house non riconosciuto.");
    const route = raw as Record<string, unknown>;
    if (Object.keys(route).some(k => !["profileId", "modelId", "thinking"].includes(k)) ||
        (route.profileId !== undefined && (typeof route.profileId !== "string" || route.profileId.length > 100)) ||
        (route.modelId !== undefined && (typeof route.modelId !== "string" || route.modelId.length > 200)) ||
        (route.thinking !== undefined && (typeof route.thinking !== "string" || !levels.has(route.thinking))))
      throw new Error("Configurazione non valida per " + role + ".");
  }
}

export function resolveAgentRoute(settings: FactorySettings, role: AgentRoleId, fallbackStage: StageId): {
  profile: AiProfile; model: string; thinking: ThinkingChoice | undefined;
} {
  validateAgentRoutes(settings.agentRoutes);
  const route = settings.agentRoutes?.[role];
  const profileId = route?.profileId || settings.assignments[fallbackStage];
  const profile = settings.profiles.find(p => p.id === profileId && p.enabled);
  if (!profile) throw new Error("Endpoint AI non disponibile per il ruolo " + role + ". Configura il router.");
  const model = (route?.modelId || profile.model).trim();
  if (!model) throw new Error("Modello AI mancante per il ruolo " + role + ".");
  const thinking = route?.thinking ?? profile.reasoningEffort;
  if (thinking !== undefined && !levels.has(thinking))
    throw new Error("Thinking non valido per il ruolo " + role + ".");
  return { profile, model, thinking };
}

export function roleSystemInstruction(role: AgentRoleId): string {
  const agent = AGENT_ROLES.find(r => r.id === role);
  if (!agent) throw new Error("Ruolo non riconosciuto.");
  return "\n\nRESPONSABILITÀ DEL RUOLO " + agent.name + ": " + agent.duty +
    " Non dichiarare test, deploy, approvazioni o verifiche non realmente eseguiti.";
}
