/** Private write-once, bounded review documents (#116).
 * Local SHA and file-owner checks are not off-host attestations.
 */
import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,mkdir,open,readdir} from "node:fs/promises";
import path from "node:path";
export const REVIEW_ARTIFACT_MODE="stored_review_document_v1";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TASK=/^[a-z][a-z0-9-]{1,31}$/;
const ACTOR=/^[a-z][a-z0-9_-]{1,31}$/;
const TENANT=/^[a-z][a-z0-9-]{2,31}$/;
const SHA=/^[a-f0-9]{64}$/;
const MAX_FILES=256,MAX_BYTES=8192;
const CREDENTIAL=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[a-zA-Z0-9_]{15,}|gh[pousr]_[a-zA-Z0-9]{20,}|Bearer\s+\S+|(?:api[_-]?key|password|secret|token)\s*[=:]\s*\S+/i;
const fault=code=>Object.assign(new Error(code),{code});
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact=(v,keys)=>v && typeof v==="object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",")===keys.slice().sort().join(",");
const root=dataDir=>path.join(dataDir,"agent-review-artifacts");
const filename=(dataDir,id)=>{
  if(!UUID.test(id)) throw fault("REVIEW_ARTIFACT_INVALID");
  return path.join(root(dataDir),id+".json");
};
function safeText(value,min,max) {
  return typeof value==="string" && value===value.trim() &&
    value.length>=min && value.length<=max &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) &&
    !CREDENTIAL.test(value) && !/\x60{3}|<script\b/i.test(value);
}
export function validateReviewDocument(doc) {
  if(!exact(doc,["version","summary","recommendation","findings"]) ||
      doc.version!==1 || !safeText(doc.summary,12,1200) ||
      !["approve","changes_requested"].includes(doc.recommendation) ||
      !Array.isArray(doc.findings) || doc.findings.length>8 ||
      !doc.findings.every(item=>exact(item,["severity","description"]) &&
        ["low","medium","high","critical"].includes(item.severity) &&
        safeText(item.description,8,500)) ||
      Buffer.byteLength(JSON.stringify(doc))>6000)
    throw fault("REVIEW_ARTIFACT_INVALID");
  return doc;
}
export function validateReviewArtifactStage(input) {
  if(!exact(input,["handoffId","taskId","leaseId","submissionId",
      "sourceFingerprint","document"]) ||
      !UUID.test(input.handoffId) || !TASK.test(input.taskId) ||
      !UUID.test(input.leaseId) || !UUID.test(input.submissionId) ||
      !SHA.test(input.sourceFingerprint))
    throw fault("REVIEW_ARTIFACT_INVALID");
  validateReviewDocument(input.document);
  return input;
}
export function makeReviewArtifactRecord({
  handoffId,taskId,submissionId,tenantId,owner,generation,
  sourceFingerprint,document,
}) {
  if(!UUID.test(handoffId) || !TASK.test(taskId) ||
      !UUID.test(submissionId) || !ACTOR.test(owner) ||
      !(tenantId===null || typeof tenantId==="string" && TENANT.test(tenantId)) ||
      !Number.isInteger(generation) || generation<1 || generation>20 ||
      !SHA.test(sourceFingerprint))
    throw fault("REVIEW_ARTIFACT_INVALID");
  validateReviewDocument(document);
  const payload={version:1,handoffId,taskId,submissionId,tenantId,
    owner,generation,sourceFingerprint,document};
  const record={...payload,digest:hash({scope:REVIEW_ARTIFACT_MODE,...payload})};
  if(Buffer.byteLength(JSON.stringify(record))>MAX_BYTES)
    throw fault("REVIEW_ARTIFACT_INVALID");
  return record;
}
async function trustedDir(dataDir,create=false) {
  if(create) await mkdir(root(dataDir),{recursive:true,mode:0o700});
  let stat;
  try {stat=await lstat(root(dataDir));}
  catch(e) {throw fault(e.code==="ENOENT"?
    "REVIEW_ARTIFACT_MISSING":"REVIEW_ARTIFACT_INTEGRITY");}
  if(!stat.isDirectory() || stat.uid!==process.geteuid?.() ||
      (stat.mode & 0o077)!==0)
    throw fault("REVIEW_ARTIFACT_INTEGRITY");
}
function safeStat(s) {
  return s.isFile() && s.uid===process.geteuid?.() &&
    s.nlink===1 && (s.mode & 0o077)===0 &&
    Number.isSafeInteger(s.size) && s.size>1 && s.size<=MAX_BYTES;
}
export async function readReviewArtifact(dataDir,id) {
  await trustedDir(dataDir);
  if(typeof constants.O_NOFOLLOW!=="number")
    throw fault("REVIEW_ARTIFACT_INTEGRITY");
  let fd;
  try {
    fd=await open(filename(dataDir,id),constants.O_RDONLY|constants.O_NOFOLLOW);
    const before=await fd.stat();
    if(!safeStat(before)) throw Error("unsafe review document");
    const buf=Buffer.alloc(before.size);
    let n=0;
    while(n<buf.length){
      const {bytesRead}=await fd.read(buf,n,buf.length-n,n);
      if(!bytesRead) throw Error("truncated review document");
      n+=bytesRead;
    }
    const after=await fd.stat();
    if(!safeStat(after) || before.dev!==after.dev || before.ino!==after.ino ||
        before.size!==after.size || before.mode!==after.mode ||
        before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs)
      throw Error("rotated review document");
    const content=buf.toString("utf8"),record=JSON.parse(content);
    if(!exact(record,["version","handoffId","taskId","submissionId",
        "tenantId","owner","generation","sourceFingerprint","document","digest"]) ||
        record.submissionId!==id)
      throw Error("invalid stored fields");
    const verified=makeReviewArtifactRecord(record);
    if(content!==JSON.stringify(verified) || verified.digest!==record.digest)
      throw Error("invalid review digest");
    return record;
  } catch(e) {
    if(e.code==="ENOENT") throw fault("REVIEW_ARTIFACT_MISSING");
    throw fault("REVIEW_ARTIFACT_INTEGRITY");
  } finally {await fd?.close().catch(()=>{});}
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/** Call ONLY under the serialized admission lock with current actor fencing.
 * Any orphan file blocks restaging for the same generation; never overwrite.
 */
export async function storeReviewArtifact(dataDir,record) {
  await trustedDir(dataDir,true);
  const entries=await readdir(root(dataDir),{withFileTypes:true});
  if(entries.length>MAX_FILES || entries.some(e=>!e.isFile() ||
      !e.name.endsWith(".json") || !UUID.test(e.name.slice(0,-5))))
    throw fault("REVIEW_ARTIFACT_INTEGRITY");
  let identical=null;
  for(const entry of entries) {
    const existing=await readReviewArtifact(dataDir,entry.name.slice(0,-5));
    if(existing.submissionId===record.submissionId) identical=existing;
    if(existing.handoffId===record.handoffId &&
        existing.taskId===record.taskId &&
        existing.generation===record.generation && !same(existing,record))
      throw fault("REVIEW_ARTIFACT_CONFLICT");
  }
  if(identical) {
    if(!same(identical,record)) throw fault("REVIEW_ARTIFACT_CONFLICT");
    return {created:false,record:identical};
  }
  if(entries.length>=MAX_FILES) throw fault("REVIEW_ARTIFACT_CAPACITY");
  if(typeof constants.O_NOFOLLOW!=="number")
    throw fault("REVIEW_ARTIFACT_INTEGRITY");
  let fd;
  try {
    fd=await open(filename(dataDir,record.submissionId),
      constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await fd.writeFile(JSON.stringify(record),"utf8");
    await fd.sync();
  } catch(e) {
    throw fault(e.code==="EEXIST"?
      "REVIEW_ARTIFACT_CONFLICT":"REVIEW_ARTIFACT_INTEGRITY");
  } finally {await fd?.close().catch(()=>{});}
  if(!same(await readReviewArtifact(dataDir,record.submissionId),record))
    throw fault("REVIEW_ARTIFACT_INTEGRITY");
  return {created:true,record};
}
export async function verifyReviewArtifactLink(dataDir,expected) {
  const a=await readReviewArtifact(dataDir,expected.submissionId);
  if(a.handoffId!==expected.handoffId || a.taskId!==expected.taskId ||
      a.tenantId!==expected.tenantId || a.owner!==expected.owner ||
      a.generation!==expected.generation ||
      a.sourceFingerprint!==expected.sourceFingerprint ||
      a.digest!==expected.digest)
    throw fault("REVIEW_ARTIFACT_INTEGRITY");
  return a;
}
