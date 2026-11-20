
import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash,generateKeyPairSync,randomUUID} from "node:crypto";
import {chmod,link,mkdtemp,readFile,rm,stat,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {validateRequest} from "../common.mjs";
import {makeReviewArtifactRecord,REVIEW_ARTIFACT_MODE} from "../review-artifacts.mjs";
import {executeAiReview,prepareAiReviewStage,signAiReviewStageIntent,
  verifyAiReviewStageIntent,verifyAiReviewStoredWithStageIntent,main}
  from "../ai-review-execute.mjs";
const pair=()=>generateKeyPairSync("ed25519");
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone=value=>structuredClone(value);
const doc=()=>({version:1,
  summary:"The code should reject invalid input values at the boundary.",
  recommendation:"changes_requested",
  findings:[{severity:"high",description:"Validate incoming values explicitly."}],
});
const sample=async()=>{
  const files={"src/backend/domain/X.cs":"namespace X; public class X {}"};
  const checked=validateRequest({label:"Source",files,steps:["dotnet-test"]});
  const workspace={version:1,handoffId:randomUUID(),taskId:"review",
    generation:2,sourceFingerprint:"c".repeat(64),
    sourceDigest:digest({scope:"runner-input-files-v1",files:checked.request.files}),
    fileCount:checked.fileCount,bytes:checked.bytes,files:checked.request.files};
  const observed=pair(),intentSigner=pair();
  const receipt=await executeAiReview({
    workspace,model:"review-model",privateKey:observed.privateKey,
    providerUrl:"https://review.example.com/v1/chat/completions",
    apiKey:"testing_example_key_123456789",
    consent:"send-source-to-provider",
    fetchImpl:async()=>new Response(JSON.stringify({
      choices:[{finish_reason:"stop",
        message:{role:"assistant",content:JSON.stringify(doc())}}],
      usage:{prompt_tokens:12,completion_tokens:7,total_tokens:19},
    }),{status:200}),
  });
  const ids={leaseId:randomUUID(),submissionId:randomUUID()};
  const stage=prepareAiReviewStage(workspace,receipt,observed.publicKey,ids);
  const intent=signAiReviewStageIntent(workspace,receipt,
    observed.publicKey,stage,intentSigner.privateKey);
  const owner="reviewer-one",tenantId="tenant-one";
  const record=makeReviewArtifactRecord({
    handoffId:stage.handoffId,taskId:stage.taskId,
    submissionId:stage.submissionId,tenantId,owner,
    generation:workspace.generation,sourceFingerprint:stage.sourceFingerprint,
    document:stage.document,
  });
  const stored={version:1,handoffId:stage.handoffId,taskId:stage.taskId,
    submissionId:stage.submissionId,tenantId,owner,
    generation:workspace.generation,sourceFingerprint:stage.sourceFingerprint,
    document:stage.document,artifactDigest:record.digest,
    artifactMode:REVIEW_ARTIFACT_MODE};
  return {workspace,receipt,observed,intentSigner,stage,intent,stored,
    owner,tenantId};
};
const verify=s=>verifyAiReviewStageIntent(s.workspace,s.receipt,
  s.observed.publicKey,s.stage,s.intent,s.intentSigner.publicKey);
const compare=s=>verifyAiReviewStoredWithStageIntent(s.workspace,
  s.receipt,s.observed.publicKey,s.stage,s.intent,s.intentSigner.publicKey,
  s.stored,{owner:s.owner,tenantId:s.tenantId});

test("post-receipt operator intent signs chosen UUIDs and private record linkage",async()=>{
  const s=await sample();
  assert.notEqual(s.observed.publicKey,s.intentSigner.publicKey);
  assert.equal(verify(s).verified,true);
  assert.equal(compare(s).verified,true);
  assert.equal(verify(s).leaseId,s.stage.leaseId);
  assert.equal(compare(s).submissionId,s.stage.submissionId);
  assert.equal(Object.hasOwn(compare(s),"approved"),false);
  for(const changed of [
    x=>{x.stage.leaseId=randomUUID();},
    x=>{x.stage.submissionId=randomUUID();},
    x=>{x.stage.sourceFingerprint="a".repeat(64);},
    x=>{x.stage.document.summary="Changed document";},
    x=>{x.stage.untrusted=true;},
    x=>{x.receipt.statement.document.recommendation="approve";},
    x=>{x.receipt.signerKeySha256="0".repeat(64);},
    x=>{x.intent.statement.leaseId=randomUUID();},
    x=>{x.intent.statement.stageSha256="0".repeat(64);},
    x=>{x.intent.statement.context="other";},
    x=>{x.intent.statement.extra="false-passed";},
    x=>{x.intent.signature="x".repeat(86);},
    x=>{x.intent.signerKeySha256="1".repeat(64);},
    x=>{x.workspace.sourceFingerprint="2".repeat(64);},
  ]){
    const t={...s,workspace:clone(s.workspace),receipt:clone(s.receipt),
      stage:clone(s.stage),intent:clone(s.intent)};
    changed(t);
    assert.throws(()=>verify(t),{code:"AI_REVIEW_INVALID"});
  }
  assert.throws(()=>verifyAiReviewStageIntent(s.workspace,s.receipt,
    s.observed.publicKey,s.stage,s.intent,pair().publicKey),
  {code:"AI_REVIEW_INVALID"});
  assert.throws(()=>verifyAiReviewStageIntent(s.workspace,s.receipt,
    pair().publicKey,s.stage,s.intent,s.intentSigner.publicKey),
  {code:"AI_REVIEW_INVALID"});
});

test("signed stage intent rejects stored-document substitution, tenant confusion and replay",async()=>{
  const s=await sample();
  for(const change of [
    x=>{x.stored.document.summary="Forged report";},
    x=>{x.stored.document.recommendation="approve";},
    x=>{x.stored.artifactDigest="e".repeat(64);},
    x=>{x.stored.sourceFingerprint="e".repeat(64);},
    x=>{x.stored.submissionId=randomUUID();},
    x=>{x.stored.generation++;},
    x=>{x.stored.owner="other-reviewer";},
    x=>{x.stored.tenantId="tenant-two";},
    x=>{x.stored.artifactMode="legacy_external_digest";},
    x=>{x.stored.passed=true;},
    x=>{x.owner="different-reviewer";},
    x=>{x.tenantId="tenant-two";},
  ]){
    const t={...s,stored:clone(s.stored)};
    change(t);
    assert.throws(()=>compare(t),{code:"AI_REVIEW_INVALID"});
  }
  const rootless=sample;
  assert.equal(typeof rootless,"function");
});

test("stage-intent CLI is offline with pinned keys, protected output and no overwrite",async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"sf-ai-stage-intent-"));
  const s=await sample();
  const ws=path.join(dir,"workspace.json"),receipt=path.join(dir,"receipt.json"),
    stage=path.join(dir,"stage.json"),intent=path.join(dir,"intent.json"),
    stored=path.join(dir,"stored.json"),receiptKey=path.join(dir,"receipt.pub"),
    signerKey=path.join(dir,"stage-private.pem"),stageKey=path.join(dir,"stage.pub");
  try {
    for(const [file,body,mode] of [
      [ws,JSON.stringify(s.workspace),0o600],
      [receipt,JSON.stringify(s.receipt),0o600],
      [stage,JSON.stringify(s.stage),0o600],
      [stored,JSON.stringify(s.stored),0o600],
      [receiptKey,s.observed.publicKey.export({type:"spki",format:"pem"}),0o644],
      [stageKey,s.intentSigner.publicKey.export({type:"spki",format:"pem"}),0o644],
      [signerKey,s.intentSigner.privateKey.export({type:"pkcs8",format:"pem"}),0o600],
    ])await writeFile(file,body,{mode});
    const shared=["--workspace="+ws,"--receipt="+receipt,
      "--receipt-public-key="+receiptKey,"--stage="+stage];
    const signing=["sign-stage-intent",...shared,
      "--private-key="+signerKey,"--out="+intent];
    assert.equal((await main(signing)).created,true);
    assert.equal((await stat(intent)).mode&0o077,0);
    assert.equal((await main(["verify-stage-intent",...shared,
      "--intent="+intent,"--stage-public-key="+stageKey])).verified,true);
    assert.equal((await main(["verify-stored-intent",...shared,
      "--intent="+intent,"--stage-public-key="+stageKey,
      "--stored="+stored,"--expected-owner="+s.owner,
      "--expected-tenant="+s.tenantId])).verified,true);
    assert.ok(!(await readFile(intent,"utf8")).includes(
      s.workspace.files["src/backend/domain/X.cs"]));
    await assert.rejects(main(signing),{code:"AI_REVIEW_INVALID"});
    const symlinkPath=path.join(dir,"intent-link.json");
    await symlink(intent,symlinkPath);
    await assert.rejects(main(signing.map(f=>f.startsWith("--out=")?
      "--out="+symlinkPath:f)),{code:"AI_REVIEW_INVALID"});
    const hardlinkPath=path.join(dir,"receipt-hard.json");
    await link(receipt,hardlinkPath);
    await assert.rejects(main(signing.map(f=>f.startsWith("--receipt=")?
      "--receipt="+hardlinkPath:f)),{code:"ATTESTATION_INVALID"});
    await chmod(signerKey,0o644);
    await assert.rejects(main(signing.map(f=>f.startsWith("--out=")?
      "--out="+path.join(dir,"no-write.json"):f)),{code:"ATTESTATION_INVALID"});
  }finally{await rm(dir,{recursive:true,force:true});}
});
