import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash, generateKeyPairSync, randomUUID} from "node:crypto";
import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {validateRequest} from "../common.mjs";
import {makeReviewArtifactRecord, REVIEW_ARTIFACT_MODE} from "../review-artifacts.mjs";
import {reviewInspectionStatement, signReviewInspectionBundle,
  verifySignedReviewInspection} from "../review-attest.mjs";

const execFile=promisify(execFileCallback);
const command=fileURLToPath(new URL("../review-attest.mjs",import.meta.url));
const keys=()=>generateKeyPairSync("ed25519");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

function bundle() {
  const handoffId=randomUUID(),submissionId=randomUUID();
  const sourceFingerprint="a".repeat(64);
  const document={version:1,
    summary:"Independent inspection report for the exact tested source snapshot.",
    recommendation:"approve",findings:[
      {severity:"low",description:"No blocking issues identified in the scoped source."},
    ]};
  const record=makeReviewArtifactRecord({
    handoffId,taskId:"review",submissionId,tenantId:"alpha",
    owner:"reviewer-one",generation:2,sourceFingerprint,document,
  });
  const files={
    "src/backend/domain/X.cs":"namespace X; public class X {}",
    "src/frontend/web/src/App.tsx":"export default function App() { return null; }",
  };
  const checked=validateRequest({label:"actual Tester input",files,
    steps:["dotnet-test","web-build"]});
  return {version:1,artifact:{
    version:1,handoffId,taskId:"review",submissionId,tenantId:"alpha",
    owner:"reviewer-one",generation:2,artifactDigest:record.digest,
    sourceFingerprint,artifactMode:REVIEW_ARTIFACT_MODE,document,
  },sources:{
    version:1,handoffId,taskId:"review",submissionId,sourceFingerprint,
    sourceDigest:hash({scope:"runner-input-files-v1",
      files:checked.request.files}),fileCount:checked.fileCount,
    bytes:checked.bytes,files:checked.request.files,
  }};
}
const mutation=(original,fn)=>{
  const result=structuredClone(original);fn(result);return result;
};
test("offline inspection receipt pins actual document, every source byte and independent public key",()=>{
  const pkg=bundle(),{privateKey,publicKey}=keys();
  const statement=reviewInspectionStatement(pkg);
  assert.equal(statement.tenantId,"alpha");
  assert.equal(statement.owner,"reviewer-one");
  assert.equal(statement.generation,2);
  assert.equal(statement.artifactDigest,pkg.artifact.artifactDigest);
  assert.equal(statement.sourceDigest,pkg.sources.sourceDigest);
  assert.equal(statement.bytes,pkg.sources.bytes);
  assert.equal(statement.fileCount,2);
  const signed=signReviewInspectionBundle(pkg,privateKey);
  const verified=verifySignedReviewInspection(pkg,signed,publicKey);
  assert.equal(verified.verified,true);
  assert.equal(verified.recommendation,"approve");
  assert.equal(verified.sourceDigest,pkg.sources.sourceDigest);
  assert.equal(JSON.stringify(signed).includes("namespace X"),false);
  assert.equal(JSON.stringify(signed).includes("No blocking issues"),false);
  assert.equal(JSON.stringify(signed).includes("private"),false);
  assert.throws(()=>verifySignedReviewInspection(pkg,signed,keys().publicKey),
    {code:"REVIEW_INSPECTION_INVALID"});
  assert.throws(()=>signReviewInspectionBundle(pkg,
    generateKeyPairSync("rsa",{modulusLength:2048}).privateKey),
    {code:"REVIEW_INSPECTION_INVALID"});
});

test("offline inspection fails closed on tampered code, document, identity, replay and counts",()=>{
  const pkg=bundle(),{privateKey,publicKey}=keys();
  const receipt=signReviewInspectionBundle(pkg,privateKey);
  const bad=[
    mutation(pkg,b=>{b.artifact.document.summary="Revised description that was never examined.";}),
    mutation(pkg,b=>{b.artifact.document.recommendation="changes_requested";}),
    mutation(pkg,b=>{b.artifact.owner="someone-else";}),
    mutation(pkg,b=>{b.artifact.tenantId="bravo";}),
    mutation(pkg,b=>{b.artifact.generation=3;}),
    mutation(pkg,b=>{b.sources.handoffId=randomUUID();}),
    mutation(pkg,b=>{b.sources.submissionId=randomUUID();}),
    mutation(pkg,b=>{b.sources.sourceFingerprint="b".repeat(64);}),
    mutation(pkg,b=>{b.sources.files["src/backend/domain/X.cs"]="namespace X; public class FORGED {}";}),
    mutation(pkg,b=>{b.sources.fileCount=3;}),
    mutation(pkg,b=>{b.sources.bytes=0;}),
    mutation(pkg,b=>{b.sources.extra="forged";}),
    mutation(pkg,b=>{b.artifact.document.findings[0].description="Bearer aaa.bbb";}),
    mutation(pkg,b=>{b.artifact.artifactDigest="c".repeat(64);}),
    mutation(pkg,b=>{b.sources.sourceDigest="d".repeat(64);}),
  ];
  // A hostile server may recompute local hashes on new content; a signature
  // from the independent private key remains bound to the original package.
  bad.push(mutation(pkg,b=>{
    b.sources.files["src/backend/domain/X.cs"]="namespace X; public class FORGED {}";
    b.sources.bytes=validateRequest({label:"any",files:b.sources.files,
      steps:["web-build"]}).bytes;
    b.sources.sourceDigest=hash({scope:"runner-input-files-v1",
      files:b.sources.files});
  }));
  bad.push(mutation(pkg,b=>{
    b.artifact.document.summary="Independently fabricated and rehashed report.";
    const a=b.artifact;
    a.artifactDigest=makeReviewArtifactRecord({
      handoffId:a.handoffId,taskId:a.taskId,
      submissionId:a.submissionId,tenantId:a.tenantId,owner:a.owner,
      generation:a.generation,sourceFingerprint:a.sourceFingerprint,
      document:a.document,
    }).digest;
  }));
  for(const changed of bad)
    assert.throws(()=>verifySignedReviewInspection(changed,receipt,publicKey),
      {code:"REVIEW_INSPECTION_INVALID"});
  for(const forged of [
    {...receipt,signature:"X".repeat(86)},
    {...receipt,signerKeySha256:"0".repeat(64)},
    {...receipt,algorithm:"RSA"},
    {...receipt,statement:{...receipt.statement,submissionId:randomUUID()}},
    {...receipt,adminKey:"injected"},
  ])
    assert.throws(()=>verifySignedReviewInspection(pkg,forged,publicKey),
      {code:"REVIEW_INSPECTION_INVALID"});
});

test("signer CLI enforces private keys off-host, safe file FD and write-once receipts",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"sf-review-inspect-"));
  const pkg=bundle(),{privateKey,publicKey}=keys();
  const bundleFile=path.join(root,"bundle.json"),
    privateFile=path.join(root,"independent.pem"),
    publicFile=path.join(root,"trusted.pem"),
    receiptFile=path.join(root,"receipt.json");
  const invoke=args=>execFile(process.execPath,[command,...args],{
    timeout:8000,maxBuffer:20000,
  });
  const signArgs=["sign","--bundle="+bundleFile,
    "--private-key="+privateFile,"--out="+receiptFile];
  const verifyArgs=["verify","--bundle="+bundleFile,
    "--receipt="+receiptFile,"--public-key="+publicFile];
  try {
    await writeFile(bundleFile,JSON.stringify(pkg),{mode:0o600});
    await writeFile(privateFile,privateKey.export({type:"pkcs8",format:"pem"}),
      {mode:0o600});
    await writeFile(publicFile,publicKey.export({type:"spki",format:"pem"}),
      {mode:0o644});
    const signed=await invoke(signArgs);
    assert.match(signed.stdout,/REVIEW_INSPECTION_SIGNED/);
    assert.equal((await stat(receiptFile)).mode & 0o077,0);
    const verified=await invoke(verifyArgs);
    assert.match(verified.stdout,/REVIEW_INSPECTION_VERIFIED/);
    assert.equal(verified.stdout.includes(pkg.sources.files["src/backend/domain/X.cs"]),false);
    await assert.rejects(invoke(signArgs),/REVIEW_INSPECTION_FAILED/);
    const pubLink=path.join(root,"public-link.pem");
    await symlink(publicFile,pubLink);
    await assert.rejects(invoke(verifyArgs.map(a=>a.startsWith("--public-key=")?
      "--public-key="+pubLink:a)),/REVIEW_INSPECTION_FAILED/);
    const bundleLink=path.join(root,"bundle-link.json");
    await symlink(bundleFile,bundleLink);
    await assert.rejects(invoke(verifyArgs.map(a=>a.startsWith("--bundle=")?
      "--bundle="+bundleLink:a)),/REVIEW_INSPECTION_FAILED/);
    const privateLink=path.join(root,"private-link.pem");
    await symlink(privateFile,privateLink);
    await assert.rejects(invoke(signArgs.map(a=>a.startsWith("--private-key=")?
      "--private-key="+privateLink:a)),/REVIEW_INSPECTION_FAILED/);
    const hard=path.join(root,"private-hard.pem");
    await link(privateFile,hard);
    await assert.rejects(invoke(signArgs),/REVIEW_INSPECTION_FAILED/);
    await rm(hard);
    await chmod(privateFile,0o644);
    await assert.rejects(invoke(signArgs),/REVIEW_INSPECTION_FAILED/);
    await chmod(privateFile,0o600);
    await chmod(publicFile,0o666);
    await assert.rejects(invoke(verifyArgs),/REVIEW_INSPECTION_FAILED/);
    await chmod(publicFile,0o644);
    await writeFile(bundleFile,"{incomplete", {mode:0o600});
    await assert.rejects(invoke(verifyArgs),/REVIEW_INSPECTION_FAILED/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("realistic archive uses only manual review report and Tester source metadata",()=>{
  const pkg=bundle();
  const cloned=JSON.parse(JSON.stringify(pkg));
  assert.deepEqual(Object.keys(cloned).sort(),["artifact","sources","version"]);
  assert.equal(Object.keys(cloned.sources.files).length,2);
  assert.equal(typeof cloned.artifact.document.summary,"string");
  assert.equal(reviewInspectionStatement(cloned).sourceDigest,
    pkg.sources.sourceDigest);
  assert.throws(()=>reviewInspectionStatement({...pkg,runnerKey:"a".repeat(64)}),
    {code:"REVIEW_INSPECTION_INVALID"});
});
