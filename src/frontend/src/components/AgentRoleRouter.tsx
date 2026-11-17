import type { FactorySettings } from "../domain/types";
import { AGENT_ROLES, EXECUTED_ROLES, roleFallbackStage,
  type AgentRoleId, type AgentRoleRoute, type ThinkingChoice } from "../domain/agent-roles";

type Props = { settings: FactorySettings; onChange: (next: FactorySettings) => void };
const choices: ThinkingChoice[] = ["automatic", "low", "medium", "high", "xhigh"];

/** UI catalog: only the six stage roles and code/review/repair are executed today. */
export default function AgentRoleRouter({ settings, onChange }: Props) {
  const groups = [...new Set(AGENT_ROLES.map(role => role.group))];
  function change(role: AgentRoleId, key: "profileId" | "modelId" | "thinking", value: string) {
    const next = structuredClone(settings);
    const routes = { ...(next.agentRoutes ?? {}) };
    const edited: AgentRoleRoute = { ...(routes[role] ?? {}) };
    if (key === "thinking") {
      if (value) edited.thinking = value as ThinkingChoice;
      else delete edited.thinking;
    } else if (key === "modelId") {
      if (value) edited.modelId = value;
      else delete edited.modelId;
    } else {
      if (value) edited.profileId = value;
      else delete edited.profileId;
    }
    if (Object.keys(edited).length) routes[role] = edited;
    else delete routes[role];
    next.agentRoutes = routes;
    onChange(next);
  }
  return <section className="agent-roles-panel">
    <p className="helper">Come in BookWriter puoi scegliere endpoint, modello e thinking per attività.
      Le sei fasi AI Factory e le operazioni Code Agent (developer, reviewer e fix) usano già
      queste scelte; gli altri ruoli sono predisposti per l'orchestratore futuro,
      <strong> non ancora agent autonomi attivi</strong>.</p>
    {groups.map(group => <details key={group} className="agent-roles-group">
      <summary>{group} · {AGENT_ROLES.filter(role => role.group === group).length} ruoli</summary>
      {AGENT_ROLES.filter(role => role.group === group).map(role => {
        const assignment = settings.agentRoutes?.[role.id];
        const fallback = roleFallbackStage(role.id);
        const inherited = settings.profiles.find(p => p.id === settings.assignments[fallback]);
        return <div className="agent-role-row" key={role.id}>
          <div className="agent-role-heading"><strong>{role.name}</strong>
            <span>{EXECUTED_ROLES.includes(role.id) ? "Collegato a task reali" : "Predisposto, non eseguito"}</span></div>
          <p className="helper">{role.duty}</p>
          <div className="agent-role-fields">
            <label>Endpoint
              <select value={assignment?.profileId ?? ""}
                onChange={e => change(role.id, "profileId", e.target.value)}>
                <option value="">Eredita da {fallback} ({inherited?.label ?? "da configurare"})</option>
                {settings.profiles.map(p => <option key={p.id} value={p.id}>
                  {p.label}{p.enabled ? "" : " (disabilitato)"}</option>)}
              </select>
            </label>
            <label>Modello per ruolo
              <input value={assignment?.modelId ?? ""} placeholder="Eredita dal profilo"
                onChange={e => change(role.id, "modelId", e.target.value)} />
            </label>
            <label>Thinking / reasoning
              <select value={assignment?.thinking ?? ""}
                onChange={e => change(role.id, "thinking", e.target.value)}>
                <option value="">Eredita dal profilo</option>
                {choices.map(choice => <option key={choice} value={choice}>
                  {choice === "automatic" ? "Automatico — ometti parametro" : choice}
                </option>)}
              </select>
            </label>
          </div>
        </div>;
      })}
    </details>)}
  </section>;
}
