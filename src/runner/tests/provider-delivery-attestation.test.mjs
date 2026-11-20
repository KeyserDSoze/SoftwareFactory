import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash,generateKeyPairSync,randomUUID,sign} from "node:crypto";
import {chmod,link,mkdtemp,readFile,rm,stat,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {canonical,publicKeyFingerprint} from "../attest.mjs";
import {validateRequest} from "../common.mjs";
import {executeAiReview} from "../ai-review-execute.mjs";
import {main,verifyProviderDeliveryEvidence} from "../provider-delivery-attestation.mjs";

const pair=()=>generateKeyPairSync("ed25519");
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const clone=x=>structuredClone(x);
const providerId="verified-review-vendor";
const providerHost="review.example.com";
const assurance="provider_key_signed_delivery_claim_not_execution_or_billing";
const sample=async()=>{
  const checked=validateRequest({label:"Tested source",
    files:{"src/backend/domain/X.cs":"namespace X; public class X {}"},
    steps:["dotnet-test"]});
  const workspace={version:1,handoffId:randomUUID(),taskId:"review",
    generation:2,sourceFingerprint:"f".repeat(64),
    sourceDigest:sha({scope:"runner-input-files-v1",files:checked.request.files}),
    fileCount:checked.fileCount,bytes:checked.bytes,files:checked.request.files};
  const operator=pair(),provider=pair();
  const operatorReceipt=await executeAiReview({
    workspace,model:"review-model-1",providerUrl:"https://"+providerHost+
      "/v1/chat/completions",
    apiKey:"test_api_key_012345678901234567",
    privateKey:operator.privateKey,consent:"send-source-to-provider",
    fetchImpl:async()=>new Response(JSON.stringify({
      choices:[{finish_reason:"stop",message:{role:"assistant",
        content:JSON.stringify({version:1,
          summary:"Validate the request before accepting untrusted user data.",
          recommendation:"changes_requested",findings:[{severity:"medium",
            description:"Add input validation at the service boundary."}]})}}],
      usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150},
    }),{status:200}),
  });
  const s=operatorReceipt.statement;
  const statement={version:1,context:"softwarefactory.ai-review.provider-delivery.v1",
    assurance,providerId,providerHost,
    providerEndpointSha256:s.providerEndpointSha256,
    requestedModel:s.requestedModel,requestSha256:s.requestSha256,
    responseSha256:s.responseSha256,usage:s.usage,
    issuedAt:new Date().toISOString()};
  // This signer exists only in the test fixture. There is deliberately no
  // vendor-attestation creation path in the SoftwareFactory CLI.
  const evidence={version:1,algorithm:"Ed25519",statement,
    signerKeySha256:publicKeyFingerprint(provider.publicKey),
    signature:sign(null,Buffer.from(canonical(statement)),provider.privateKey)
      .toString("base64url")};
  return {workspace,operatorReceipt,operator,provider,evidence};
};
const params=x=>({workspace:x.workspace,operatorReceipt:x.operatorReceipt,
  operatorPublicKey:x.operator.publicKey,
  evidence:x.evidence,providerPublicKey:x.provider.publicKey,
  expectedProviderId:providerId,expectedProviderHost:providerHost,
  expectedProviderKeySha256:publicKeyFingerprint(x.provider.publicKey)});
test("strict vendor-key-pinned signature links HTTP request/response and declared usage",async()=>{
  const x=await sample(),result=verifyProviderDeliveryEvidence(params(x));
  assert.equal(result.verified,true);
  assert.equal(result.assurance,assurance);
  assert.equal(result.requestSha256,x.operatorReceipt.statement.requestSha256);
  assert.equal(result.responseSha256,x.operatorReceipt.statement.responseSha256);
  assert.equal(result.signerKeySha256,publicKeyFingerprint(x.provider.publicKey));
  assert.equal(Object.hasOwn(result,"actualCost"),false);
  assert.equal(Object.hasOwn(result,"modelExecuted"),false);
  const serialized=JSON.stringify(result);
  assert.equal(serialized.includes("namespace X"),false);
  assert.equal(serialized.includes("test_api_key"),false);
  assert.equal(serialized.includes("120"),false);
});
test("fail closed on wrong independent pin, keys, identity and replayed evidence",async()=>{
  const x=await sample();
  const wrongKey=pair();
  for(const override of [
    {providerPublicKey:wrongKey.publicKey},
    {operatorPublicKey:wrongKey.publicKey},
    {expectedProviderKeySha256:"0".repeat(64)},
    {expectedProviderId:"other-vendor"},
    {expectedProviderHost:"other.example.org"},
    {providerPublicKey:x.operator.publicKey,
      expectedProviderKeySha256:publicKeyFingerprint(x.operator.publicKey)},
    {workspace:{...x.workspace,sourceFingerprint:"e".repeat(64)}},
  ])assert.throws(()=>verifyProviderDeliveryEvidence({...params(x),...override}),
    {code:"PROVIDER_DELIVERY_INVALID"});
  const other=await sample();
  for(const override of [{operatorReceipt:other.operatorReceipt},
    {workspace:other.workspace}]){
    assert.throws(()=>verifyProviderDeliveryEvidence({...params(x),...override}),
      {code:"PROVIDER_DELIVERY_INVALID"});
  }
});
test("strict schema rejects changed hashes, usage, times, signature and injected fields",async()=>{
  const x=await sample();
  for(const change of [
    o=>{o.statement.requestSha256="a".repeat(64);},
    o=>{o.statement.responseSha256="a".repeat(64);},
    o=>{o.statement.providerEndpointSha256="a".repeat(64);},
    o=>{o.statement.providerId="different-vendor";},
    o=>{o.statement.providerHost="different.example.com";},
    o=>{o.statement.requestedModel="other-model";},
    o=>{o.statement.usage.promptTokens=999;},
    o=>{o.statement.usage.assurance="verified_invoice";},
    o=>{o.statement.usage=null;},
    o=>{o.statement.issuedAt="2026-11-20";},
    o=>{o.statement.issuedAt="2026-13-20T15:00:00.000Z";},
    o=>{o.statement.issuedAt="2026-11-20T15:00:00Z";},
    o=>{o.statement.context="invoice";},
    o=>{o.statement.assurance="provider_verified_execution";},
    o=>{o.statement.extra="passed";},
    o=>{o.signature="a".repeat(86);},
    o=>{o.signerKeySha256="b".repeat(64);},
    o=>{o.algorithm="RSA";},
    o=>{o.unverified=true;},
    o=>{o.statement=null;},
    o=>{o.statement=[];},
  ]){
    const bad=clone(x.evidence);
    change(bad);
    assert.throws(()=>verifyProviderDeliveryEvidence({...params(x),evidence:bad}),
      {code:"PROVIDER_DELIVERY_INVALID"});
  }
  const provider=pair();
  const signedWrong=clone(x.evidence);
  signedWrong.statement.responseSha256="a".repeat(64);
  signedWrong.signerKeySha256=publicKeyFingerprint(provider.publicKey);
  signedWrong.signature=sign(null,Buffer.from(canonical(signedWrong.statement)),
    provider.privateKey).toString("base64url");
  assert.throws(()=>verifyProviderDeliveryEvidence({...params(x),
    evidence:signedWrong,providerPublicKey:provider.publicKey,
    expectedProviderKeySha256:publicKeyFingerprint(provider.publicKey)}),
    {code:"PROVIDER_DELIVERY_INVALID"});
});
test("CLI verifies only with pinned public key files, no remote calls, and rejects unsafe file links",async()=>{
  const x=await sample(),dir=await mkdtemp(
    path.join(tmpdir(),"sf-provider-delivery-"));
  const fs={};
  try {
    for(const [name,content,mode] of [
      ["workspace",JSON.stringify(x.workspace),0o600],
      ["operator-receipt",JSON.stringify(x.operatorReceipt),0o600],
      ["delivery-evidence",JSON.stringify(x.evidence),0o600],
      ["operator-public-key",x.operator.publicKey.export({type:"spki",format:"pem"}),0o644],
      ["provider-public-key",x.provider.publicKey.export({type:"spki",format:"pem"}),0o644],
    ]){
      fs[name]=path.join(dir,name+".json");
      await writeFile(fs[name],content,{mode});
    }
    const args=["verify",...Object.entries(fs).map(([k,v])=>"--"+k+"="+v),
      "--expected-provider-id="+providerId,
      "--expected-provider-host="+providerHost,
      "--expected-provider-key-sha256="+publicKeyFingerprint(x.provider.publicKey)];
    assert.equal((await main(args)).verified,true);
    const linked=path.join(dir,"linked-public.pem");
    await symlink(fs["provider-public-key"],linked);
    await assert.rejects(main(args.map(a=>a.startsWith("--provider-public-key=")?
      "--provider-public-key="+linked:a)),{code:"ATTESTATION_INVALID"});
    const hard=path.join(dir,"hardlink.json");
    await link(fs["delivery-evidence"],hard);
    await assert.rejects(main(args.map(a=>a.startsWith("--delivery-evidence=")?
      "--delivery-evidence="+hard:a)),{code:"ATTESTATION_INVALID"});
    await chmod(fs["provider-public-key"],0o666);
    await assert.rejects(main(args),{code:"ATTESTATION_INVALID"});
    await chmod(fs["provider-public-key"],0o644);
    await assert.rejects(main(args.map(a=>a.startsWith("--expected-provider-id=")?
      "--expected-provider-id=wrong":a)),{code:"PROVIDER_DELIVERY_INVALID"});
    assert.equal((await stat(fs["provider-public-key"])).isFile(),true);
    assert.ok((await readFile(fs["delivery-evidence"],"utf8")).length>100);
  }finally{await rm(dir,{recursive:true,force:true});}
});
