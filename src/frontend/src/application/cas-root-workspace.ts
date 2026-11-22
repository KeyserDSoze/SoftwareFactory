/**
 * #167 — root workspace selection before mounting either React subtree.
 * A query flag is a local UI route, NOT permission to migrate data. In CAS
 * mode no legacy project initializer, writer lease, outbox, Code Agent or
 * cloud/GitHub effects may be mounted by the App root.
 */
export type FactoryWorkspaceMode="legacy"|"cas";

export function factoryWorkspaceMode(search:string):FactoryWorkspaceMode {
  if(typeof search!=="string" || search.length>2048)return "legacy";
  try {
    return new URLSearchParams(search.startsWith("?")?
      search.slice(1):search).get("workspace")==="cas" ? "cas":"legacy";
  }catch{return "legacy";}
}

/** Preserve Pages base path and unrelated query params (OAuth etc.) while
 * switching only the explicit workspace selector. Navigation causes a
 * FULL PAGE reload: a React state flip cannot fence legacy effects.
 */
export function factoryWorkspaceUrl(
  href:string,mode:FactoryWorkspaceMode,
):string {
  const url=new URL(href);
  if(!["https:","http:"].includes(url.protocol))
    throw Error("Workspace URL must be HTTP(S)");
  if(mode==="cas") url.searchParams.set("workspace","cas");
  else url.searchParams.delete("workspace");
  url.hash="";
  return url.toString();
}

/** Pure pre- and post-consent guard for leaving the live legacy editor.
 * The caller reads the ACTUAL local per-ID slot at both points. No mutation.
 */
export function canNavigateLegacyToCas(input:Readonly<{
  busy:boolean;writerReady:boolean;editingOutput:boolean;
  switching:boolean;localConflict:boolean;writerContended:boolean;
  githubAutoSync:boolean;otherDraft:boolean;
  projectId:string;leaseProjectId:string|null;
  expectedRaw:string;persistedRaw:string|null;
}>):boolean {
  return Boolean(input) && !input.busy &&
    input.writerReady && !input.editingOutput &&
    !input.switching && !input.localConflict &&
    !input.writerContended && !input.githubAutoSync &&
    !input.otherDraft &&
    /^[0-9a-f-]{36}$/i.test(input.projectId) &&
    input.leaseProjectId===input.projectId &&
    typeof input.expectedRaw==="string" &&
    input.expectedRaw.length>0 &&
    input.expectedRaw.length<=1_000_000 &&
    input.persistedRaw===input.expectedRaw;
}
