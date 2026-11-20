import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash, generateKeyPairSync, randomUUID} from "node:crypto";
import {chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {validateRequest} from "../common.mjs";
import {makeReviewArtifactRecord, REVIEW_ARTIFACT_MODE} from "../review-artifacts.mjs";
import {buildReviewRequest, executeAiReview, main,
  prepareAiReviewStage, validateAiProviderEndpoint, validateReviewWorkspace,
  verifyAiReviewReceipt,verifyAiReviewStage,
  verifyAiReviewStoredArtifact} from "../ai-review-execute.mjs";

const endpoint="https://reviews.example.com/v1/chat/completions";
const model="review-model-1";
const apiKey="sk_example_key_for_test_only_123456789";
const pair=()=>generateKeyPairSync("ed25519");
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const document=()=>({version:1,
  summary:"The tested code contains a potential validation issue needing attention.",
  recommendation:"changes_requested",
  findings:[{severity:"high",
    description:"Validate the API boundary before accepting user-provided values."}],
});
const sourceCode="namespace X; public class X {}";
const workspace=()=>{
  const files={"src/backend/domain/X.cs":sourceCode};
  const checked=validateRequest({label:"real Tester snapshot",
    files,steps:["dotnet-test"]});
  return {version:1,handoffId:randomUUID(),taskId:"review",
    generation:2,sourceFingerprint:"c".repeat(64),
    sourceDigest:sha({scope:"runner-input-files-v1",files:checked.request.files}),
    fileCount:checked.fileCount,bytes:checked.bytes,
    files:checked.request.files};
};
const responsePayload=(doc=document(),usage={
  prompt_tokens:123,completion_tokens:45,total_tokens:168,
})=>({choices:[{finish_reason:"stop",
    message:{role:"assistant",content:JSON.stringify(doc)}}],
  usage,model:"provider-self-reported-model"});
const mockFetch=(payload=responsePayload(),status=200,tracker={})=>
  async (url,options)=>{
    tracker.calls=(tracker.calls||0)+1;
    tracker.url=url;tracker.options=options;
    return new Response(JSON.stringify(payload),{status});
  };
const mutate=(src,fn)=>{const copy=structuredClone(src);fn(copy);return copy;};
const execute=(ws=workspace(),options={})=>
  executeAiReview({workspace:ws,model,providerUrl:endpoint,apiKey,
    privateKey:pair().privateKey,consent:"send-source-to-provider",
    fetchImpl:mockFetch(),...options});

test("operator sends tested files only after explicit consent and signs observed HTTP response",async()=>{
  const ws=workspace(),{privateKey,publicKey}=pair(),tracker={};
  const receipt=await execute(ws,{privateKey,
    fetchImpl:mockFetch(responsePayload(),200,tracker)});
  assert.equal(tracker.calls,1);
  assert.equal(tracker.url,endpoint);
  assert.equal(tracker.options.method,"POST");
  assert.equal(tracker.options.redirect,"manual");
  assert.equal(tracker.options.headers.Authorization,"Bearer "+apiKey);
  assert.ok(tracker.options.signal instanceof AbortSignal);
  const sent=JSON.parse(tracker.options.body);
  assert.equal(sent.model,model);
  assert.equal(sent.stream,false);
  assert.equal(sent.messages[0].role,"system");
  assert.equal(JSON.parse(sent.messages[1].content).files[
    "src/backend/domain/X.cs"],sourceCode);
  assert.equal(receipt.statement.sourceDigest,ws.sourceDigest);
  assert.equal(receipt.statement.generation,ws.generation);
  assert.equal(receipt.statement.assurance,
    "operator_observed_http_response_unverified");
  assert.equal(receipt.statement.document.recommendation,"changes_requested");
  assert.deepEqual(receipt.statement.usage,{
    assurance:"provider_reported_unverified",
    promptTokens:123,completionTokens:45,totalTokens:168,
  });
  assert.equal(verifyAiReviewReceipt(ws,receipt,publicKey).verified,true);
  assert.equal(verifyAiReviewReceipt(ws,receipt,publicKey).recommendation,
    "changes_requested");
  const serialized=JSON.stringify(receipt);
  for(const sensitive of [sourceCode,apiKey,"Bearer ",endpoint,
      "provider-self-reported-model"])
    assert.equal(serialized.includes(sensitive),false);
  // The resulting DOCUMENT is compatible with existing #116 staging, but
  // neither signature nor recommendation is an approval or bill.
  const staged=makeReviewArtifactRecord({
    handoffId:ws.handoffId,taskId:ws.taskId,submissionId:randomUUID(),
    tenantId:null,owner:"reviewer-one",generation:ws.generation,
    sourceFingerprint:ws.sourceFingerprint,document:receipt.statement.document,
  });
  assert.equal(staged.document.recommendation,"changes_requested");
});

test("no consent, modified Tester snapshot, unsafe URL, key or model never trigger network",async()=>{
  const good=workspace(),{privateKey}=pair();
  let calls=0;
  const fetchImpl=async()=>{calls++;throw Error("unexpected network");};
  for(const ws of [
    mutate(good,w=>{w.files["src/backend/domain/X.cs"]="namespace X; public class Forged {}";}),
    mutate(good,w=>{w.fileCount=3;}),
    mutate(good,w=>{w.bytes=0;}),
    mutate(good,w=>{w.generation=0;}),
    mutate(good,w=>{w.sourceDigest="a".repeat(64);}),
    mutate(good,w=>{w.sourceFingerprint="bad";}),
    mutate(good,w=>{w.files["../evil"]="secret";}),
    mutate(good,w=>{w.passed=true;}),
  ]){
    assert.throws(()=>validateReviewWorkspace(ws),{code:"AI_REVIEW_INVALID"});
    await assert.rejects(execute(ws,{workspace:ws,privateKey,fetchImpl}),
      {code:"AI_REVIEW_INVALID"});
  }
  for(const consent of [undefined,"true","approve","no"]){
    await assert.rejects(execute(good,{consent,privateKey,fetchImpl}),
      {code:"AI_REVIEW_INVALID"});
  }
  for(const invalid of [
    "http://reviews.example.com/v1/chat/completions",
    "https://127.0.0.1/v1/chat/completions",
    "https://localhost/v1/chat/completions",
    "https://reviews.local/v1/chat/completions",
    "https://reviews.example.com:8443/v1/chat/completions",
    "https://username:password@reviews.example.com/v1/chat/completions",
    "https://reviews.example.com/v1/chat/completions?key=secret",
    "https://reviews.example.com/v1/chat/completions#fragment",
    "https://reviews.example.com/v1/not-review",
    "file:///etc/passwd",
  ]){
    assert.throws(()=>validateAiProviderEndpoint(invalid),
      {code:"AI_REVIEW_INVALID"});
    await assert.rejects(execute(good,{providerUrl:invalid,privateKey,fetchImpl}),
      {code:"AI_REVIEW_INVALID"});
  }
  for(const options of [{model:"--bad"},{apiKey:"short"},
      {privateKey:pair().publicKey}]){
    await assert.rejects(execute(good,{...options,fetchImpl}),
      {code:"AI_REVIEW_INVALID"});
  }
  assert.equal(calls,0);
});

test("HTTP failures, redirect, timeout, oversized response and invalid model content are fatal",async()=>{
  const ws=workspace();
  for(const [status,body] of [
    [429,responsePayload()],[503,responsePayload()],[302,responsePayload()],
  ])await assert.rejects(execute(ws,{fetchImpl:mockFetch(body,status)}),
    {code:"AI_REVIEW_INVALID"});
  for(const fetchImpl of [
    async()=>{throw Error("provider timeout with secret");},
    async()=>new Response("z".repeat(65_537),{status:200}),
    async()=>new Response("x".repeat(65_535),{status:200,
      headers:{"content-length":"70000"}}),
    async()=>new Response("not json",{status:200}),
    mockFetch({choices:[]}),
    mockFetch({choices:[{message:{content:""}}]}),
    mockFetch({choices:[{message:{content:JSON.stringify({
      ...document(),passed:true,
    })}}]}),
    mockFetch({choices:[{message:{content:JSON.stringify({
      ...document(),summary:"Bearer secret123456789",
    })}}]}),
  ])await assert.rejects(execute(ws,{fetchImpl}),
    {code:"AI_REVIEW_INVALID"});
});

test("only a single normally finished assistant answer can be signed",async()=>{
  const ws=workspace(),{privateKey,publicKey}=pair(),good=responsePayload();
  const receipt=await execute(ws,{privateKey,fetchImpl:mockFetch(good)});
  assert.equal(verifyAiReviewReceipt(ws,receipt,publicKey).verified,true);
  // A document can be syntactically complete even when the remote server
  // declares it was cut off or filtered. Never sign it as a completed review.
  for(const alter of [
    x=>{x.choices[0].finish_reason="length";},
    x=>{x.choices[0].finish_reason="content_filter";},
    x=>{x.choices[0].finish_reason="tool_calls";},
    x=>{x.choices[0].finish_reason=null;},
    x=>{delete x.choices[0].finish_reason;},
    x=>{x.choices[0].finish_reason="function_call";},
    x=>{x.choices[0].message.role="tool";},
    x=>{x.choices[0].message.role="user";},
    x=>{delete x.choices[0].message.role;},
    x=>{x.choices[0].message.refusal="I cannot review this code";},
    x=>{x.choices[0].message.tool_calls=[{id:"call_1"}];},
    x=>{x.choices[0].message.function_call={name:"review"};},
    x=>{x.choices.push(structuredClone(x.choices[0]));},
    x=>{x.choices=[];},
    x=>{delete x.choices;},
    x=>{x.choices[0].message.content=[{type:"text",text:"forged"}];},
    x=>{x.choices[0].message.content=null;},
  ]){
    let calls=0;
    const payload=mutate(good,alter);
    const mock=mockFetch(payload,200,{});
    await assert.rejects(execute(ws,{privateKey,fetchImpl:async (...args)=>{
      calls++;
      return mock(...args);
    }}),{code:"AI_REVIEW_INVALID"});
    assert.equal(calls,1,"do not retry a possibly paid completion");
  }
  // Some OpenAI-compatible backends include null (not active) tool fields.
  const withNulls=mutate(good,p=>{
    p.choices[0].message.refusal=null;
    p.choices[0].message.tool_calls=null;
    p.choices[0].message.function_call=null;
  });
  const valid=await execute(ws,{privateKey,fetchImpl:mockFetch(withNulls)});
  assert.equal(verifyAiReviewReceipt(ws,valid,publicKey).verified,true);
});

test("missing, inconsistent, false or extreme usage is never estimated as cost",async()=>{
  const ws=workspace(),{privateKey,publicKey}=pair();
  for(const badUsage of [undefined,null,{},
    {prompt_tokens:2,completion_tokens:3,total_tokens:6},
    {prompt_tokens:-1,completion_tokens:3,total_tokens:2},
    {prompt_tokens:"1",completion_tokens:3,total_tokens:4},
    {prompt_tokens:Number.MAX_SAFE_INTEGER,completion_tokens:1,
      total_tokens:Number.MAX_SAFE_INTEGER},
  ]){
    const payload=responsePayload();
    if(badUsage===undefined)delete payload.usage;
    else payload.usage=badUsage;
    const receipt=await execute(ws,{privateKey,fetchImpl:mockFetch(payload)});
    assert.equal(receipt.statement.usage,null);
    assert.equal(verifyAiReviewReceipt(ws,receipt,publicKey).verified,true);
    assert.equal(JSON.stringify(receipt).includes("cost"),false);
  }
  const zero=await execute(ws,{fetchImpl:mockFetch(responsePayload(document(),{
    prompt_tokens:0,completion_tokens:0,total_tokens:0,
  }))});
  assert.equal(zero.statement.usage.totalTokens,0);
});

test("signed operator observation cannot be replayed with wrong key, source, verdict or counts",async()=>{
  const ws=workspace(),{privateKey,publicKey}=pair();
  const receipt=await execute(ws,{privateKey});
  assert.throws(()=>verifyAiReviewReceipt(ws,receipt,pair().publicKey),
    {code:"AI_REVIEW_INVALID"});
  for(const altered of [
    mutate(receipt,r=>{r.statement.document.recommendation="approve";}),
    mutate(receipt,r=>{r.statement.document.summary="Fabricated independent approval.";}),
    mutate(receipt,r=>{r.statement.usage.totalTokens=200;}),
    mutate(receipt,r=>{r.statement.sourceFingerprint="b".repeat(64);}),
    mutate(receipt,r=>{r.statement.generation=3;}),
    mutate(receipt,r=>{r.statement.providerHost="other.example.org";}),
    mutate(receipt,r=>{r.statement.requestedModel="fake-model";}),
    mutate(receipt,r=>{r.statement.responseSha256="a".repeat(64);}),
    mutate(receipt,r=>{r.signature="X".repeat(86);}),
    mutate(receipt,r=>{r.signerKeySha256="0".repeat(64);}),
    mutate(receipt,r=>{r.statement.passed=true;}),
  ])assert.throws(()=>verifyAiReviewReceipt(ws,altered,publicKey),
    {code:"AI_REVIEW_INVALID"});
  assert.throws(()=>verifyAiReviewReceipt(mutate(ws,w=>{
    w.sourceFingerprint="a".repeat(64);
  }),receipt,publicKey),{code:"AI_REVIEW_INVALID"});
  assert.throws(()=>verifyAiReviewReceipt(workspace(),receipt,publicKey),
    {code:"AI_REVIEW_INVALID"});
});

test("CLI read-only verification honors protected file descriptors and no overwrite",async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"sf-ai-review-"));
  const ws=workspace(),{privateKey,publicKey}=pair();
  const wsFile=path.join(dir,"workspace.json"),pubFile=path.join(dir,"trusted.pem"),
    privFile=path.join(dir,"private.pem"),keyFile=path.join(dir,"provider.key"),
    receiptFile=path.join(dir,"receipt.json");
  try{
    await writeFile(wsFile,JSON.stringify(ws),{mode:0o600});
    await writeFile(pubFile,publicKey.export({type:"spki",format:"pem"}),{mode:0o644});
    await writeFile(privFile,privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});
    await writeFile(keyFile,apiKey+"\n",{mode:0o600});
    await writeFile(receiptFile,JSON.stringify(await execute(ws,{privateKey})),{mode:0o600});
    const args=["verify","--workspace="+wsFile,
      "--receipt="+receiptFile,"--public-key="+pubFile];
    assert.equal((await main(args)).verified,true);
    const linkFile=path.join(dir,"linked.pem");
    await symlink(pubFile,linkFile);
    await assert.rejects(main(args.map(x=>x.startsWith("--public-key=")?
      "--public-key="+linkFile:x)),{code:"ATTESTATION_INVALID"});
    const hard=path.join(dir,"ws-hardlink.json");
    await link(wsFile,hard);
    await assert.rejects(main(args),{code:"ATTESTATION_INVALID"});
    await rm(hard);
    await chmod(pubFile,0o666);
    await assert.rejects(main(args),{code:"ATTESTATION_INVALID"});
    await chmod(pubFile,0o644);
    const execArgs=["execute","--workspace="+wsFile,
      "--provider-url="+endpoint,"--model="+model,
      "--api-key-file="+keyFile,"--private-key="+privFile,
      "--out="+receiptFile,"--consent=send-source-to-provider"];
    // Destination collision is detected before any potentially billable call.
    await assert.rejects(main(execArgs),{code:"AI_REVIEW_INVALID"});
    await assert.rejects(main(execArgs.map(x=>x.startsWith("--consent=")?
      "--consent=false":x)),{code:"AI_REVIEW_INVALID"});
    await chmod(keyFile,0o644);
    await assert.rejects(main(execArgs),{code:"ATTESTATION_INVALID"});
    await chmod(keyFile,0o600);
    await chmod(privFile,0o644);
    await assert.rejects(main(execArgs),{code:"ATTESTATION_INVALID"});
    assert.equal((await stat(receiptFile)).mode & 0o077,0);
    assert.equal((await readFile(receiptFile,"utf8")).includes(apiKey),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test("signed operator receipt creates exact actor-scoped staged document and matches stored readback",async()=>{
  const ws=workspace(),{privateKey,publicKey}=pair();
  const receipt=await execute(ws,{privateKey});
  const leaseId=randomUUID(),submissionId=randomUUID();
  const stage=prepareAiReviewStage(ws,receipt,publicKey,{leaseId,submissionId});
  assert.deepEqual(Object.keys(stage).sort(),[
    "handoffId","taskId","leaseId","submissionId","sourceFingerprint",
    "document"].sort());
  assert.equal(stage.document,receipt.statement.document);
  assert.equal(stage.submissionId,submissionId);
  assert.ok(Buffer.byteLength(JSON.stringify(stage))+1<=8192);
  assert.equal(verifyAiReviewStage(ws,receipt,publicKey,stage,{
    leaseId,submissionId,
  }).verified,true);
  const owner="reviewer-one",tenantId="tenant-one";
  const record=makeReviewArtifactRecord({
    handoffId:ws.handoffId,taskId:ws.taskId,submissionId,tenantId,owner,
    generation:ws.generation,sourceFingerprint:ws.sourceFingerprint,
    document:stage.document,
  });
  const stored={version:1,handoffId:ws.handoffId,taskId:ws.taskId,
    submissionId,tenantId,owner,generation:ws.generation,
    sourceFingerprint:ws.sourceFingerprint,
    artifactDigest:record.digest,artifactMode:REVIEW_ARTIFACT_MODE,
    document:record.document};
  const opts={owner,tenantId,leaseId,submissionId};
  const verified=verifyAiReviewStoredArtifact(ws,receipt,publicKey,stage,stored,opts);
  assert.equal(verified.verified,true);
  assert.equal(verified.artifactDigest,record.digest);
  assert.equal(Object.hasOwn(verified,"passed"),false);
  assert.equal(Object.hasOwn(verified,"cost"),false);
  assert.throws(()=>prepareAiReviewStage(ws,receipt,pair().publicKey,
    {leaseId,submissionId}),{code:"AI_REVIEW_INVALID"});
  assert.throws(()=>prepareAiReviewStage(ws,receipt,publicKey,
    {leaseId:"bad",submissionId}),{code:"AI_REVIEW_INVALID"});
  assert.throws(()=>prepareAiReviewStage(ws,receipt,publicKey,
    {leaseId,submissionId:"bad"}),{code:"AI_REVIEW_INVALID"});
  assert.throws(()=>prepareAiReviewStage(workspace(),receipt,publicKey,
    {leaseId,submissionId}),{code:"AI_REVIEW_INVALID"});
  const badReceipt=mutate(receipt,r=>{
    r.statement.document.recommendation="approve";
  });
  assert.throws(()=>prepareAiReviewStage(ws,badReceipt,publicKey,
    {leaseId,submissionId}),{code:"AI_REVIEW_INVALID"});
  for(const altered of [
    mutate(stage,x=>{x.document.recommendation="approve";}),
    mutate(stage,x=>{x.document.summary="Tampered summary";}),
    mutate(stage,x=>{x.sourceFingerprint="e".repeat(64);}),
    mutate(stage,x=>{x.submissionId=randomUUID();}),
    mutate(stage,x=>{x.taskId="different-review";}),
    mutate(stage,x=>{x.leaseId=randomUUID();}),
    mutate(stage,x=>{x.extra="passed";}),
  ])assert.throws(()=>verifyAiReviewStage(
    ws,receipt,publicKey,altered,{leaseId,submissionId}),
  {code:"AI_REVIEW_INVALID"});
  // A receipt cannot itself fix an ID chosen after signing. The separate
  // expected pair makes substitutions detectable by an operator.
  assert.throws(()=>verifyAiReviewStage(ws,receipt,publicKey,stage,{
    leaseId:randomUUID(),submissionId,
  }),{code:"AI_REVIEW_INVALID"});
  assert.throws(()=>verifyAiReviewStage(ws,receipt,publicKey,stage,{
    leaseId,submissionId:randomUUID(),
  }),{code:"AI_REVIEW_INVALID"});
  for(const altered of [
    mutate(stored,x=>{x.document.summary="Swapped document";}),
    mutate(stored,x=>{x.document.recommendation="approve";}),
    mutate(stored,x=>{x.artifactDigest="a".repeat(64);}),
    mutate(stored,x=>{x.submissionId=randomUUID();}),
    mutate(stored,x=>{x.generation++;}),
    mutate(stored,x=>{x.sourceFingerprint="b".repeat(64);}),
    mutate(stored,x=>{x.artifactMode="legacy_external_digest";}),
    mutate(stored,x=>{x.owner="other-reviewer";}),
    mutate(stored,x=>{x.tenantId="different-tenant";}),
    mutate(stored,x=>{x.passed=true;}),
  ])assert.throws(()=>verifyAiReviewStoredArtifact(
    ws,receipt,publicKey,stage,altered,opts),{code:"AI_REVIEW_INVALID"});
  assert.throws(()=>verifyAiReviewStoredArtifact(
    ws,receipt,publicKey,stage,stored,{...opts,owner:"other"}),
  {code:"AI_REVIEW_INVALID"});
  assert.throws(()=>verifyAiReviewStoredArtifact(
    ws,receipt,publicKey,stage,stored,{...opts,tenantId:"wrong-tenant"}),
  {code:"AI_REVIEW_INVALID"});
  assert.throws(()=>verifyAiReviewStoredArtifact(
    ws,receipt,pair().publicKey,stage,stored,opts),
  {code:"AI_REVIEW_INVALID"});
  const noTenantRecord=makeReviewArtifactRecord({...record,tenantId:null});
  const unscoped={...stored,tenantId:null,artifactDigest:noTenantRecord.digest};
  assert.equal(verifyAiReviewStoredArtifact(ws,receipt,publicKey,
    stage,unscoped,{...opts,tenantId:null}).verified,true);
});

test("offline stage CLI is write-once, side-effect free and verifies server readback",async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"sf-ai-review-stage-"));
  const ws=workspace(),{privateKey,publicKey}=pair();
  const receipt=await execute(ws,{privateKey});
  const workspacePath=path.join(dir,"workspace.json");
  const receiptPath=path.join(dir,"receipt.json");
  const keyPath=path.join(dir,"trusted.pem");
  const stagePath=path.join(dir,"stage.json");
  const storedPath=path.join(dir,"stored.json");
  const leaseId=randomUUID(),submissionId=randomUUID();
  try {
    await writeFile(workspacePath,JSON.stringify(ws),{mode:0o600});
    await writeFile(receiptPath,JSON.stringify(receipt),{mode:0o600});
    await writeFile(keyPath,publicKey.export({type:"spki",format:"pem"}),
      {mode:0o644});
    const shared=["--workspace="+workspacePath,
      "--receipt="+receiptPath,"--public-key="+keyPath];
    const createArgs=["prepare-stage",...shared,
      "--lease-id="+leaseId,"--submission-id="+submissionId,
      "--out="+stagePath];
    const created=await main(createArgs);
    assert.equal(created.submissionId,submissionId);
    assert.equal((await stat(stagePath)).mode&0o077,0);
    const contents=await readFile(stagePath,"utf8");
    assert.equal(contents.includes(sourceCode),false);
    assert.equal(contents.includes(apiKey),false);
    assert.ok(Buffer.byteLength(contents)<=8192);
    const boundIds=["--lease-id="+leaseId,"--submission-id="+submissionId];
    assert.equal((await main(["verify-stage",...shared,
      "--stage="+stagePath,...boundIds])).verified,true);
    await assert.rejects(main(createArgs),{code:"AI_REVIEW_INVALID"});
    const markerPath=path.join(dir,"marker.json");
    await symlink(stagePath,markerPath);
    await assert.rejects(main(createArgs.map(x=>x.startsWith("--out=")?
      "--out="+markerPath:x)),{code:"AI_REVIEW_INVALID"});
    const owner="reviewer-one";
    const tenantId="tenant-one";
    const stage=JSON.parse(contents);
    const storedRecord=makeReviewArtifactRecord({
      handoffId:ws.handoffId,taskId:ws.taskId,submissionId,tenantId,owner,
      generation:ws.generation,sourceFingerprint:ws.sourceFingerprint,
      document:stage.document,
    });
    const stored={version:1,handoffId:ws.handoffId,taskId:ws.taskId,
      submissionId,tenantId,owner,generation:ws.generation,
      sourceFingerprint:ws.sourceFingerprint,artifactMode:REVIEW_ARTIFACT_MODE,
      artifactDigest:storedRecord.digest,document:stage.document};
    await writeFile(storedPath,JSON.stringify(stored),{mode:0o600});
    const checkArgs=["verify-stored",...shared,"--stage="+stagePath,
      "--stored="+storedPath,...boundIds,"--expected-owner="+owner,
      "--expected-tenant="+tenantId];
    assert.equal((await main(checkArgs)).verified,true);
    await assert.rejects(main(checkArgs.map(x=>x.startsWith("--lease-id=")?
      "--lease-id="+randomUUID():x)),{code:"AI_REVIEW_INVALID"});
    await assert.rejects(main(checkArgs.map(x=>x.startsWith("--submission-id=")?
      "--submission-id="+randomUUID():x)),{code:"AI_REVIEW_INVALID"});
    await writeFile(storedPath,JSON.stringify({...stored,
      document:{...stored.document,recommendation:"approve"}}),{mode:0o600});
    await assert.rejects(main(checkArgs),{code:"AI_REVIEW_INVALID"});
  }finally {await rm(dir,{recursive:true,force:true});}
});
