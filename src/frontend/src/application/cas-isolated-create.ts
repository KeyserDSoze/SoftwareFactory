/**
 * Separate, explicit native IndexedDB-only new-project creation (#150/#139).
 * No localStorage editor bootstrap, legacy copy, tombstone revival, GitHub
 * destination, inherited AI evidence or remote secrets are involved.
 */
import {createProject, DEFAULT_CONFIG, STAGES} from "../domain/defaults";
import type {FactoryProject} from "../domain/types";
import {
  compareAndSwapCasProject,serializeCasProject,
} from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {
  CAS_ISOLATED_NAME_MAX,CAS_ISOLATED_DESCRIPTION_MAX,
} from "./cas-isolated-config";

export type CasIsolatedCreateTicket = Readonly<{
  id:string;
  name:string;
  description:string;
  raw:string;
}>;

function validateFields(name:string,description:string):void {
  if(typeof name!=="string" || !name.trim() ||
     name.length>CAS_ISOLATED_NAME_MAX ||
     typeof description!=="string" ||
     description.length>CAS_ISOLATED_DESCRIPTION_MAX)
    throw Error("Nome o descrizione del nuovo progetto IndexedDB non validi.");
}

export function prepareCasIsolatedNewProject(
  name:string,description:string,
):CasIsolatedCreateTicket {
  validateFields(name,description);
  const fresh=createProject();
  const project:FactoryProject={
    ...fresh,
    config:{...fresh.config,name:name.trim(),description},
  };
  const raw=serializeCasProject(project);
  return Object.freeze({
    id:project.id,name:project.config.name,description,raw,
  });
}

/** Verify a prepared ticket before writing, even if supplied by a caller. */
function parseTicket(ticket:CasIsolatedCreateTicket):FactoryProject {
  if(!ticket || typeof ticket.raw!=="string" ||
     ticket.raw.length===0 || ticket.raw.length>1_000_000)
    throw Error("Ticket nuovo progetto IndexedDB non valido.");
  let project:FactoryProject;
  try {
    project=JSON.parse(ticket.raw) as FactoryProject;
    validateFields(ticket.name,ticket.description);
    const projectKeys=Object.keys(project).sort().join(",");
    if(projectKeys!=="config,createdAt,id,stages,updatedAt" ||
      ticket.id!==project.id || ticket.name!==project.config.name ||
      ticket.description!==project.config.description ||
      project.createdAt!==project.updatedAt ||
      JSON.stringify(project.config)!==JSON.stringify({
        ...DEFAULT_CONFIG,name:ticket.name,description:ticket.description,
      }) ||
      project.stages.length!==STAGES.length ||
      project.stages.some((s,index)=>
        s.id!==STAGES[index].id || s.label!==STAGES[index].label ||
        s.status!=="pending" || s.output!=="" ||
        s.sources.length!==0 || s.error!==undefined ||
        s.updatedAt!==undefined) ||
      serializeCasProject(project)!==ticket.raw)
      throw Error("Invalid");
  } catch {
    throw Error("Ticket nuovo progetto IndexedDB modificato o non canonico.");
  }
  return project;
}

/**
 * One explicit consent, one never-seen native CAS insert. The caller must
 * never silently retry after an ambiguous acknowledgement, even under a new
 * UUID, because the first transaction may already have committed.
 */
export async function confirmCasIsolatedNewProject(
  ticket:CasIsolatedCreateTicket,consent:boolean,
):Promise<CasProjectSnapshot> {
  if(consent!==true)
    throw Error("Conferma esplicita del nuovo progetto IndexedDB obbligatoria.");
  const project=parseTicket(ticket);
  const result=await compareAndSwapCasProject(project,null);
  if(result.id!==ticket.id || result.revision!==1 ||
     result.raw!==ticket.raw)
    throw Error("ACK nuovo progetto IndexedDB incoerente: verifica la libreria.");
  return Object.freeze({id:result.id,revision:result.revision,raw:result.raw});
}
