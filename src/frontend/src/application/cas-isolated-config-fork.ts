/**
 * #166 / #139 — pure, opt-in IndexedDB configuration fork ticket.
 * This is an independent clean project, NOT a copy of historical AI outputs,
 * Code Agent workspace, tests, reviews, runner receipts or GitHub bindings.
 */
import {createProject,DEFAULT_CONFIG,SERVICE_KINDS,SERVICE_OPTIONS,STAGES}
  from "../domain/defaults";
import type {FactoryProject,ProjectConfig} from "../domain/types";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {forkCasProjectConfiguration,serializeCasProject}
  from "../infrastructure/project-cas";
import {prepareCasIsolatedExport} from "./cas-isolated-export";
import {inspectCasIsolatedStages} from "./cas-isolated-stage-inspection";
import {
  CAS_ISOLATED_NAME_MAX,CAS_ISOLATED_DESCRIPTION_MAX,
  CAS_ISOLATED_REQUIREMENTS_MAX,
} from "./cas-isolated-config";

const SECRET=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/i;
const FRONTENDS=new Set(["react","react-native","android","ios","unity"]);
const DEPLOYMENTS=new Set(["azure","aws","gcp","kubernetes","docker"]);
const DATABASES=new Set(["postgresql","sqlserver","mysql","sqlite"]);
const CONFIG_KEYS=Object.keys(DEFAULT_CONFIG).sort().join(",");

export type CasIsolatedConfigForkTicket=Readonly<{
  source:CasProjectSnapshot;
  id:string;name:string;raw:string;
}>;

export function checkedCasForkSource(expected:CasProjectSnapshot):FactoryProject {
  const canonical=prepareCasIsolatedExport(expected);
  const inspection=inspectCasIsolatedStages(expected);
  if(!inspection || inspection.some(s=>s.status==="invalid"))
    throw Error("Sorgente IndexedDB con checkpoint non coerenti.");
  const source=JSON.parse(canonical.raw) as FactoryProject;
  const c=source.config as ProjectConfig;
  if(!c || Object.keys(c).sort().join(",")!==CONFIG_KEYS ||
     typeof c.name!=="string" || !c.name.trim() ||
     c.name.length>CAS_ISOLATED_NAME_MAX ||
     typeof c.description!=="string" ||
     c.description.length>CAS_ISOLATED_DESCRIPTION_MAX ||
     typeof c.requirements!=="string" ||
     c.requirements.length>CAS_ISOLATED_REQUIREMENTS_MAX ||
     !Array.isArray(c.frontends) || !c.frontends.length ||
     c.frontends.length>FRONTENDS.size ||
     new Set(c.frontends).size!==c.frontends.length ||
     c.frontends.some(f=>!FRONTENDS.has(f)) ||
     !DEPLOYMENTS.has(c.deployment) ||
     !["11.0","10.0"].includes(c.dotnetVersion) ||
     !DATABASES.has(c.database) ||
     !c.services || Object.keys(c.services).sort().join(",")!==
       SERVICE_KINDS.slice().sort().join(",") ||
     SERVICE_KINDS.some(kind=>{
       const item=c.services[kind];
       return !item || Object.keys(item).sort().join(",")!==
         "development,production" ||
         !SERVICE_OPTIONS[kind].includes(item.development) ||
         !SERVICE_OPTIONS[kind].includes(item.production);
     }) || SECRET.test(JSON.stringify(c)))
    throw Error("Configurazione IndexedDB non sicura per una copia.");
  return source;
}

/** The only copied information is the schema-checked non-secret config. */
export function prepareCasIsolatedConfigFork(
  expected:CasProjectSnapshot,
):CasIsolatedConfigForkTicket {
  const source=checkedCasForkSource(expected);
  const name=source.config.name.slice(0,CAS_ISOLATED_NAME_MAX-7)+" (copy)";
  const fresh=createProject();
  const project:FactoryProject={
    ...fresh,
    config:{...structuredClone(source.config),name},
  };
  // Fresh createProject assigns a new identity and pending checkpoints.
  // Deliberately omit development/githubDestination/githubSync/testReceipt.
  if(project.id===source.id || project.stages.length!==STAGES.length)
    throw Error("Nuova identità IndexedDB non disponibile.");
  const raw=serializeCasProject(project);
  return Object.freeze({
    source:Object.freeze({id:expected.id,revision:expected.revision,
      raw:expected.raw}),
    id:project.id,name,raw,
  });
}

/** Guard the prepared fresh identity BEFORE calling the native atomic tx. */
export async function confirmCasIsolatedConfigFork(
  ticket:CasIsolatedConfigForkTicket,consent:boolean,
):Promise<CasProjectSnapshot> {
  if(consent!==true)
    throw Error("Consenso duplicazione IndexedDB mancante.");
  if(!ticket || typeof ticket.raw!=="string")
    throw Error("Ticket fork IndexedDB non valido.");
  const source=checkedCasForkSource(ticket.source);
  const target=JSON.parse(ticket.raw) as FactoryProject;
  const expectedName=source.config.name.slice(0,CAS_ISOLATED_NAME_MAX-7)+
    " (copy)";
  const emptyStages=STAGES.map(({id,label})=>({
    id,label,status:"pending",output:"",sources:[],
  }));
  if(!target || target.id!==ticket.id || ticket.id===source.id ||
     ticket.name!==expectedName || target.config?.name!==ticket.name ||
     target.createdAt!==target.updatedAt ||
     Object.keys(target).sort().join(",")!==
       "config,createdAt,id,stages,updatedAt" ||
     JSON.stringify(target.config)!==
       JSON.stringify({...source.config,name:expectedName}) ||
     JSON.stringify(target.stages)!==JSON.stringify(emptyStages) ||
     serializeCasProject(target)!==ticket.raw)
    throw Error("Ticket duplicazione IndexedDB alterato.");
  const result=await forkCasProjectConfiguration(ticket.source,target,true);
  if(result.id!==ticket.id || result.raw!==ticket.raw || result.revision!==1)
    throw Error("ACK fork IndexedDB incoerente: controlla la libreria.");
  return result;
}
