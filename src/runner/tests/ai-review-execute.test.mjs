import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash, generateKeyPairSync, randomUUID} from "node:crypto";
import {chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {validateRequest} from "../common.mjs";
import {makeReviewArtifactRecord} from "../review-artifacts.mjs";
import {buildReviewRequest, executeAiReview, main,
  validateAiProviderEndpoint, validateReviewWorkspace,
  verifyAiReviewReceipt} from "../ai-review-execute.mjs";

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
})=>({choices:[{message:{content:JSON.stringify(doc)}}],
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
