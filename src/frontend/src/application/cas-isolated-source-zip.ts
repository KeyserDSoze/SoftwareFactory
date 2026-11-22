/**
 * Native IndexedDB-only scaffold source export (#165/#139).
 * This pure projection does not approve code, attach credentials, access
 * storage, run tests, or include any unreviewed Code Agent pending edits.
 */
import type {FactoryProject} from "../domain/types";
import {allowedCodePath,developmentOf,workspaceFiles} from "../domain/development";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {prepareCasIsolatedExport} from "./cas-isolated-export";
import {inspectCasIsolatedStages} from "./cas-isolated-stage-inspection";

const SECRET=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/i;
const MAX_OVERRIDE_CHARS=32_000;
const MAX_SOURCE_CHARS=1_000_000;
const MAX_TOTAL_CHARS=8_000_000;
const MAX_FILES=500;
const SOURCE_PROVENANCE_PATH="docs/cas-idb-export-provenance.md";
const SOURCE_PROVENANCE=[
  "# IndexedDB project source export",
  "",
  "This archive was generated from an explicitly selected local IndexedDB",
  "project snapshot. It is NOT a proof of successful compilation, tests,",
  "independent Code Review, approved changes, runner execution or GitHub sync.",
  "Unreviewed Code Agent pending edits were NOT included in these sources.",
  "Human operator-applied source edits MAY be included in this ZIP. These",
  "are explicitly UNVERIFIED: no independent review, runner, tests, build",
  "or GitHub publication is demonstrated by the local application action.",
  "Local historical Code Agent records are not independently attested here.",
  "A historical feature-implementation log was omitted to avoid treating",
  "operator-supplied or restored review claims as verified evidence.",
  "Validate source contents and secrets yourself before sharing or deploying.",
  "",
].join("\n");

export type CasIsolatedSourceZipTicket=Readonly<{
  id:string;revision:number;raw:string;fileName:string;
  files:Readonly<Record<string,string>>;
}>;

function prepareFiles(project:FactoryProject):Readonly<Record<string,string>> {
  const dev=developmentOf(project);
  if(!dev || !Number.isSafeInteger(dev.revision) || dev.revision<0 ||
     !dev.overrides || Array.isArray(dev.overrides) ||
     typeof dev.overrides!=="object" ||
     !dev.originals || Array.isArray(dev.originals) ||
     typeof dev.originals!=="object" ||
     !Array.isArray(dev.history) || dev.history.length>50)
    throw Error("Invalid development state");
  const paths=Object.keys(dev.overrides);
  const originals=Object.keys(dev.originals);
  if(paths.length!==originals.length ||
     originals.some(path=>!Object.prototype.hasOwnProperty.call(
       dev.overrides,path)))
    throw Error("Inconsistent applied source records");
  for(const path of paths){
    const text=dev.overrides[path],original=dev.originals[path];
    if(!allowedCodePath(path) || typeof text!=="string" ||
       !text.trim() || text.length>MAX_OVERRIDE_CHARS ||
       (original!==null && typeof original!=="string") ||
       (typeof original==="string" && original.length>MAX_SOURCE_CHARS))
      throw Error("Untrusted applied source");
  }
  // workspaceFiles does not incorporate development.pending; it expands
  // only the current scaffold and already-applied overrides. Conflicts with
  // an old generator baseline fail closed here.
  const source=workspaceFiles(project);
  const files:Record<string,string>=Object.create(null);
  let chars=0;
  for(const [name,value] of Object.entries(source)){
    // A historical log is constructed from unverified project data. Never
    // preserve its claim "independently reviewed" in the CAS-only archive.
    if(name==="docs/feature-implementation.md")continue;
    if(name===SOURCE_PROVENANCE_PATH ||
       !name || name.startsWith("/") ||
       name.includes("\\") || name.includes("//") ||
       name.split("/").some(part=>!part || part==="." || part==="..") ||
       typeof value!=="string" || value.length>MAX_SOURCE_CHARS ||
       SECRET.test(value))
      throw Error("Untrusted output in source bundle");
    chars+=value.length;
    if(chars>MAX_TOTAL_CHARS || Object.keys(files).length>=MAX_FILES)
      throw Error("Source bundle too large");
    files[name]=value;
  }
  if(!Object.keys(files).length)
    throw Error("Empty source bundle");
  files[SOURCE_PROVENANCE_PATH]=SOURCE_PROVENANCE;
  return Object.freeze(files);
}

/** Fail-closed pure preparation, no IndexedDB/network/localStorage or ZIP I/O. */
export function prepareCasIsolatedSourceZip(
  snapshot:CasProjectSnapshot,
):CasIsolatedSourceZipTicket {
  try{
    const ticket=prepareCasIsolatedExport(snapshot);
    if(inspectCasIsolatedStages(snapshot)===null)
      throw Error("Invalid stage layout");
    const project=JSON.parse(ticket.raw) as FactoryProject;
    const files=prepareFiles(project);
    return Object.freeze({
      id:ticket.id,revision:ticket.revision,raw:ticket.raw,
      fileName:"softwarefactory-idb-sources-"+ticket.id+
        "-r"+ticket.revision+".zip",
      files,
    });
  }catch{
    // Avoid propagating untrusted generator/config/override fields to UI.
    throw Error("Sorgenti IndexedDB non esportabili: verifica progetto e backup JSON.");
  }
}
