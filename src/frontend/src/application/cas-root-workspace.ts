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
  // A handoff is a ONE-WAY, untrusted hint only. Never let a stale CAS
  // project ID follow the operator back into the legacy workspace.
  url.searchParams.delete("casHandoff");
  url.searchParams.delete("casRevision");
  url.searchParams.delete("casDigest");
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

/**
 * #171: URL hint after an explicitly backed-up, native insert-only copy.
 * A hint is NEVER a storage authority. Even an authentic SHA-256 digest
 * only binds the browser's explicit-open choice to that exact JSON version.
 * No raw project contents or credentials go in the URL.
 */
export type CasHandoffHint=Readonly<{
  id:string;revision:number;digest:string;
}>;
const HANDOFF_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDOFF_HASH=/^[0-9a-f]{64}$/;

export function factoryCasHandoffUrl(
  href:string,hint:CasHandoffHint,
):string {
  if(!hint || !HANDOFF_ID.test(hint.id) ||
     !Number.isSafeInteger(hint.revision) || hint.revision<1 ||
     hint.revision>Number.MAX_SAFE_INTEGER-1 ||
     typeof hint.digest!=="string" || !HANDOFF_HASH.test(hint.digest))
    throw Error("Malformed CAS handoff hint");
  const url=new URL(factoryWorkspaceUrl(href,"cas"));
  url.searchParams.set("casHandoff",hint.id);
  url.searchParams.set("casRevision",String(hint.revision));
  url.searchParams.set("casDigest",hint.digest);
  return url.toString();
}

export function factoryCasHandoffHint(search:string):CasHandoffHint|null {
  if(factoryWorkspaceMode(search)!=="cas")return null;
  try{
    const qs=new URLSearchParams(search.startsWith("?")?
      search.slice(1):search);
    if(["casHandoff","casRevision","casDigest"].some(k=>
      qs.getAll(k).length!==1))return null;
    const id=qs.get("casHandoff")!;
    const revText=qs.get("casRevision")!;
    const digest=qs.get("casDigest")!;
    const revision=Number(revText);
    if(!HANDOFF_ID.test(id) || !/^[1-9][0-9]*$/.test(revText) ||
       !Number.isSafeInteger(revision) ||
       revision>Number.MAX_SAFE_INTEGER-1 ||
       !HANDOFF_HASH.test(digest))return null;
    return Object.freeze({id,revision,digest});
  }catch{return null;}
}

export async function casHandoffRawDigest(raw:string):Promise<string> {
  if(typeof raw!=="string" || !raw || raw.length>1_000_000)
    throw Error("Invalid CAS handoff input");
  const hash=await globalThis.crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(hash),
    b=>b.toString(16).padStart(2,"0")).join("");
}

export async function matchesCasHandoffHint(
  hint:CasHandoffHint,snapshot:Readonly<{
    id:string;revision:number;raw:string;
  }>,
):Promise<boolean> {
  if(!hint || !snapshot || hint.id!==snapshot.id ||
     hint.revision!==snapshot.revision ||
     !HANDOFF_HASH.test(hint.digest))return false;
  try{return await casHandoffRawDigest(snapshot.raw)===hint.digest;}
  catch{return false;}
}
