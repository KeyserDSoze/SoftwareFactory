/** Offline independent inspection receipt for the exact report + source bundle.
 * The signer must run on another trusted host with a private key not installed
 * in the runner. Signing is an operator action, not proof of human reading,
 * executed AI, original runner honesty or provider billing.
 */
import {KeyObject, createHash, createPrivateKey, createPublicKey, sign, verify} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {canonical, publicKeyFingerprint, readAttestationFile,
  readBoundedJson} from "./attest.mjs";
import {validateRequest} from "./common.mjs";
import {makeReviewArtifactRecord, REVIEW_ARTIFACT_MODE} from "./review-artifacts.mjs";

const SHA = /^[a-f0-9]{64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TASK = /^[a-z][a-z0-9-]{1,31}$/;
const exact = (v,keys) => v && typeof v==="object" &&
  !Array.isArray(v) && Object.keys(v).sort().join(",")===
    [...keys].sort().join(",");
const fail = () => Object.assign(new Error("Offline review inspection verification failed"),
  {code:"REVIEW_INSPECTION_INVALID"});
const hash = text => createHash("sha256").update(text).digest("hex");
function ed25519Public(value) {
  const key=value instanceof KeyObject && value.type==="public" ?
    value : createPublicKey(value);
  if(key.type!=="public" || key.asymmetricKeyType!=="ed25519")throw fail();
  return key;
}
/** The artifact digest is recomputed using exactly the stored #116 schema;
 * files digest is recomputed using exactly the Tester #114 domain separation.
 * Neither a client-supplied verdict nor a supplied hash is taken as proof.
 */
export function reviewInspectionStatement(bundle) {
  try {
    if(!exact(bundle,["version","artifact","sources"]) || bundle.version!==1 ||
        Buffer.byteLength(JSON.stringify(bundle))>4_000_000) throw fail();
    const a=bundle.artifact,s=bundle.sources;
    if(!exact(a,["version","handoffId","taskId","submissionId",
        "tenantId","owner","generation","artifactDigest",
        "sourceFingerprint","artifactMode","document"]) ||
        !exact(s,["version","handoffId","taskId","submissionId",
        "sourceFingerprint","sourceDigest","fileCount","bytes","files"]) ||
        a.version!==1 || s.version!==1 || a.artifactMode!==REVIEW_ARTIFACT_MODE ||
        !UUID.test(a.handoffId) || !UUID.test(a.submissionId) ||
        !TASK.test(a.taskId) || !SHA.test(a.artifactDigest) ||
        !SHA.test(a.sourceFingerprint) || !SHA.test(s.sourceDigest) ||
        s.handoffId!==a.handoffId || s.taskId!==a.taskId ||
        s.submissionId!==a.submissionId ||
        s.sourceFingerprint!==a.sourceFingerprint)
      throw fail();
    const computed=makeReviewArtifactRecord({
      handoffId:a.handoffId,taskId:a.taskId,
      submissionId:a.submissionId,tenantId:a.tenantId,
      owner:a.owner,generation:a.generation,
      sourceFingerprint:a.sourceFingerprint,document:a.document,
    });
    if(computed.digest!==a.artifactDigest) throw fail();
    const checked=validateRequest({label:"Offline review inspection",
      files:s.files,steps:["web-build"]});
    if(checked.fileCount!==s.fileCount || checked.bytes!==s.bytes ||
        JSON.stringify(checked.request.files)!==JSON.stringify(s.files))
      throw fail();
    const sourceDigest=hash(JSON.stringify({
      scope:"runner-input-files-v1",files:checked.request.files,
    }));
    if(sourceDigest!==s.sourceDigest) throw fail();
    return {version:1,context:"softwarefactory.review.inspection.v1",
      handoffId:a.handoffId,taskId:a.taskId,submissionId:a.submissionId,
      tenantId:a.tenantId,owner:a.owner,generation:a.generation,
      sourceFingerprint:a.sourceFingerprint,sourceDigest,
      artifactDigest:a.artifactDigest,recommendation:a.document.recommendation,
      fileCount:checked.fileCount,bytes:checked.bytes,
      bundleSha256:hash(canonical(bundle))};
  }catch {throw fail();}
}
export function signReviewInspectionBundle(bundle,privateKeySource) {
  try {
    const statement=reviewInspectionStatement(bundle);
    const secret=privateKeySource instanceof KeyObject &&
      privateKeySource.type==="private" ?
      privateKeySource : createPrivateKey(privateKeySource);
    if(secret.type!=="private" || secret.asymmetricKeyType!=="ed25519")
      throw fail();
    const pub=ed25519Public(secret);
    return {version:1,algorithm:"Ed25519",statement,
      signerKeySha256:publicKeyFingerprint(pub),
      signature:sign(null,Buffer.from(canonical(statement)),secret)
        .toString("base64url")};
  }catch {throw fail();}
}
export function verifySignedReviewInspection(bundle,receipt,trustedPublicKeySource) {
  try {
    if(!exact(receipt,["version","algorithm","statement",
        "signerKeySha256","signature"]) ||
        receipt.version!==1 || receipt.algorithm!=="Ed25519" ||
        typeof receipt.signerKeySha256!=="string" ||
        !SHA.test(receipt.signerKeySha256) ||
        typeof receipt.signature!=="string" || !SIG.test(receipt.signature))
      throw fail();
    const statement=reviewInspectionStatement(bundle);
    if(canonical(receipt.statement)!==canonical(statement)) throw fail();
    const trusted=ed25519Public(trustedPublicKeySource);
    if(receipt.signerKeySha256!==publicKeyFingerprint(trusted))
      throw fail();
    const signature=Buffer.from(receipt.signature,"base64url");
    if(signature.length!==64 ||
        !verify(null,Buffer.from(canonical(statement)),trusted,signature))
      throw fail();
    return {verified:true,context:statement.context,
      handoffId:statement.handoffId,taskId:statement.taskId,
      submissionId:statement.submissionId,
      artifactDigest:statement.artifactDigest,
      sourceFingerprint:statement.sourceFingerprint,
      sourceDigest:statement.sourceDigest,
      recommendation:statement.recommendation,
      signerKeySha256:receipt.signerKeySha256};
  }catch {throw fail();}
}
/** The operator prepares the bundle from two authenticated GET responses.
 * This CLI does not contact the runner or trust network-fetched signing keys.
 * Key paths and bundle contents are never echoed in stdout/stderr.
 */
export async function main(argv=process.argv.slice(2)) {
  const [mode,...options]=argv;
  const names=mode==="sign" ? ["bundle","private-key","out"] :
    mode==="verify" ? ["bundle","receipt","public-key"] : null;
  if(!names || options.length!==3) throw fail();
  const flags=Object.create(null);
  for(const item of options) {
    const m=/^--([a-z-]+)=(.+)$/.exec(item);
    if(!m || !names.includes(m[1]) || flags[m[1]]) throw fail();
    flags[m[1]]=m[2];
  }
  if(names.some(n=>!flags[n])) throw fail();
  const bundle=await readBoundedJson(flags.bundle,"evidence");
  if(mode==="sign") {
    const secret=await readAttestationFile(flags["private-key"],"private-key");
    const receipt=signReviewInspectionBundle(bundle,secret);
    await writeFile(flags.out,JSON.stringify(receipt,null,2)+"\n",{
      flag:"wx",mode:0o600,
    });
    process.stdout.write("REVIEW_INSPECTION_SIGNED\n");
    return receipt;
  }
  const receipt=await readBoundedJson(flags.receipt,"receipt");
  const pub=(await readAttestationFile(flags["public-key"],"public-key"))
    .toString("utf8");
  const result=verifySignedReviewInspection(bundle,receipt,pub);
  process.stdout.write("REVIEW_INSPECTION_VERIFIED\n");
  return result;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(()=>{
    console.error("REVIEW_INSPECTION_FAILED");
    process.exitCode=1;
  });
