import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { validateRequest } from "../common.mjs";
import { admitRunnerJob, withAdmissionLock } from "../admission.mjs";
import { executeJob } from "../worker.mjs";
import { verifyAgentTestTask, mutateAgentTaskReview } from "../agent-handoffs.mjs";
import { verifyJobEvidenceForRead } from "../evidence.mjs";

const rootKey="journal-test-root-key-abcdefghijklmnopqrstuvwxyz";
const actorKey="agent.tester-one."+"T".repeat(48);
const reviewerKey="agent.reviewer-one."+"R".repeat(48);
const wrongRoleKey="agent.tester-one."+"W".repeat(48);
const foreignKey="agent.tester-one."+"F".repeat(48);
const reviewApproverKey="agent.human-review."+"H".repeat(48);
const reviewSelfKey="agent.reviewer-one."+"I".repeat(48);
const tenantReviewKey="agent.reviewer-one."+"X".repeat(48);
const tenantApproverKey="agent.human-review."+"Z".repeat(48);
const releaseKey="agent.release-one."+"L".repeat(48);
const reviewDigest="a".repeat(64);
const origin="http://localhost:5173";
const draft=()=>({
  consent:true,label:"Journal verified tester handoff",
  budgetUnits:4,tasks:[
    {id:"test",role:"tester",owner:"tester-one",
      dependsOn:[],estimatedUnits:2,maxAttempts:2},
    {id:"review",role:"code_reviewer",owner:"reviewer-one",
      dependsOn:["test"],estimatedUnits:2,maxAttempts:1},
  ],
});
const request=(steps,sourceCode="namespace X; public class X {}")=>validateRequest({
  label:"Actual worker journal proof",
  files:{"src/backend/domain/X.cs":sourceCode},
  steps,
});
async function fixture({multiTenant=false}={}) {
  const base=await mkdtemp(path.join(tmpdir(),"sf-journal-link-"));
  const dataDir=path.join(base,"data"),workDir=path.join(base,"workspace");
  const actorFile=path.join(base,"actors.json"),tenantFile=path.join(base,"tenants.json");
  const tenantKey="alpha."+"a".repeat(40),bravo="bravo."+"b".repeat(40);
  await writeFile(actorFile,JSON.stringify({version:1,actors:[
    {id:"tester-one",role:"tester",tenantId:null,key:actorKey},
    {id:"reviewer-one",role:"code_reviewer",tenantId:null,key:reviewerKey},
    {id:"tester-one",role:"code_reviewer",tenantId:null,key:wrongRoleKey},
    {id:"tester-one",role:"tester",tenantId:"alpha",key:foreignKey},
    {id:"reviewer-one",role:"code_reviewer",tenantId:"alpha",key:tenantReviewKey},
    {id:"human-review",role:"review_approver",tenantId:null,key:reviewApproverKey},
    {id:"reviewer-one",role:"review_approver",tenantId:null,key:reviewSelfKey},
    {id:"human-review",role:"review_approver",tenantId:"alpha",key:tenantApproverKey},
    {id:"release-one",role:"release_manager",tenantId:null,key:releaseKey},
  ]}),{mode:0o600});
  if(multiTenant)await writeFile(tenantFile,JSON.stringify({version:1,tenants:[
    {id:"alpha",key:tenantKey,maxQueued:4,maxRetained:15,maxAcceptedPerMinute:0},
    {id:"bravo",key:bravo,maxQueued:4,maxRetained:15,maxAcceptedPerMinute:0},
  ]}),{mode:0o600});
  const servers=[0,1].map(()=>createRunnerServer({
    apiKey:multiTenant?"":rootKey,
    tenantsFile:multiTenant?tenantFile:"",
    dataDir,allowedOrigins:[origin],agentActorsFile:actorFile,
  }));
  for(const s of servers){s.listen(0,"127.0.0.1");await once(s,"listening");}
  const url=servers.map(s=>"http://127.0.0.1:"+s.address().port);
  const call=async(i,method,endpoint,body,token=multiTenant?tenantKey:rootKey)=>{
    const res=await fetch(url[i]+endpoint,{method,headers:{
      Origin:origin,Authorization:"Bearer "+token,
      ...(body===undefined?{}:{"Content-Type":"application/json"}),
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:res.status,body:await res.json()};
  };
  const board=async()=> {
    const r=await call(0,"POST","/v1/agent-handoffs",draft());
    // Hand-off registration needs an explicit idempotency key.
    return r;
  };
  const create=async(body=draft())=> {
    const r=await fetch(url[0]+"/v1/agent-handoffs",{
      method:"POST",headers:{Origin:origin,
        Authorization:"Bearer "+(multiTenant?tenantKey:rootKey),
        "Content-Type":"application/json","Idempotency-Key":randomUUID()},
      body:JSON.stringify(body),
    });
    const data=await r.json();
    assert.equal(r.status,201,JSON.stringify(data));
    return data.id;
  };
  const claim=(i,id,taskId="test",token=multiTenant?foreignKey:actorKey)=>
    call(i,"POST","/v1/agent-task-leases",
      {action:"claim",handoffId:id,taskId,ttlSeconds:90},token);
  const verify=(i,id,lease,job,overrides={},token=multiTenant?foreignKey:actorKey)=>
    call(i,"POST","/v1/agent-task-verifications",{
      handoffId:id,taskId:"test",leaseId:lease,
      submissionId:randomUUID(),jobId:job.report.id,jobDigest:job.report.digest,
      jobHead:job.head,jobCount:job.entries.length,step:"dotnet-test",
      ...overrides,
    },token);
  const view=(i,id,token=multiTenant?tenantKey:rootKey)=>
    call(i,"GET","/v1/agent-handoffs/"+id,undefined,token);
  const run=async({steps=["dotnet-test"],state="passed",
    tenantId=multiTenant?"alpha":null,sourceCode}={})=>{
    const checked=request(steps,sourceCode);
    const admit=await admitRunnerJob({
      dataDir,checked,tenant:tenantId?{
        id:tenantId,maxQueued:4,maxRetained:15,maxAcceptedPerMinute:0,
      }:null,
    });
    if(state==="queued")return verifyJobEvidenceForRead(dataDir,admit.id);
    const report=await executeJob(admit.id,{
      dataDir,workspaceRoot:workDir,
      createStepPlan:step=>({step}),
      executeStep:async(_plan,_id,step)=>({
        step,state,exitCode:state==="passed"?0:state==="failed"?1:undefined,
        durationMs:3,timedOut:false,
        ...(state==="skipped"?{reason:"dependency setup not available"}:{}),
      }),
    });
    assert.equal(report.state,state==="skipped"?"incomplete":state);
    return verifyJobEvidenceForRead(dataDir,admit.id);
  };
  const close=async()=>{
    await Promise.all(servers.map(s=>s.listening ?
      new Promise(ok=>s.close(ok)) : Promise.resolve()));
    await rm(base,{recursive:true,force:true});
  };
  return {base,dataDir,actorFile,tenantFile,tenantKey,bravo,servers,call,create,
    claim,verify,view,run,close};
}
test("real worker journal binding: tester completes only a passed code-test and reviewer becomes claimable",async()=>{
  const f=await fixture();
  try{
    const id=await f.create();
    const lease=await f.claim(0,id);
    assert.equal(lease.status,200,JSON.stringify(lease.body));
    assert.equal((await f.claim(1,id,"review",reviewerKey)).status,409);
    await sleep(16); // job acceptedAt must be after the task's lease claim
    const job=await f.run();
    const submissionId=randomUUID();
    const [a,b]=await Promise.all([
      f.verify(0,id,lease.body.leaseId,job,{submissionId}),
      f.verify(1,id,lease.body.leaseId,job,{submissionId}),
    ]);
    assert.deepEqual([a.status,b.status].sort(),[200,201],JSON.stringify({a,b}));
    assert.equal(a.body.state,"runner_verified_test");
    assert.equal(a.body.jobId,job.report.id);
    assert.equal(a.body.evidence.head,job.head);
    const current=await f.view(1,id);
    assert.equal(current.status,200,JSON.stringify(current.body));
    assert.equal(current.body.verifiedTestJobs,1);
    assert.equal(current.body.executions,0);
    assert.equal(current.body.approvedReportedUnits,0);
    assert.deepEqual(current.body.tasks.map(t=>t.state),["runner_verified_test","ready"]);
    assert.equal(current.body.tasks[0].evidence,"verified_runner_journal");
    assert.equal(current.body.tasks[0].testEvidence.step,"dotnet-test");
    const context=current.body.tasks[1].reviewContext;
    assert.equal(context.status,"inputs_recorded");
    assert.match(context.fingerprint,/^[a-f0-9]{64}$/);
    const expectedSourceDigest=createHash("sha256").update(JSON.stringify({
      scope:"runner-input-files-v1",files:request(["dotnet-test"]).request.files,
    })).digest("hex");
    const expectedReviewFingerprint=createHash("sha256").update(JSON.stringify({
      scope:"agent-review-source-v1",handoffId:id,taskId:"review",
      reviewContext:context.fingerprint,digest:expectedSourceDigest,
    })).digest("hex");
    assert.deepEqual(current.body.tasks[1].reviewSource,{
      status:"runner_input_recorded",digest:expectedSourceDigest,
      fingerprint:expectedReviewFingerprint,
    });
    assert.deepEqual(context.dependencies,[{
      taskId:"test",evidence:"verified_runner_journal",
      jobId:job.report.id,digest:job.report.digest,
      head:job.head,count:job.entries.length,step:"dotnet-test",
    }]);
    assert.equal(JSON.stringify(current.body).includes(lease.body.leaseId),false);
    assert.equal(JSON.stringify(current.body).includes('"passed"'),false);
    assert.equal((await f.claim(1,id,"review",reviewerKey)).status,200);
    assert.deepEqual((await f.view(0,id)).body.tasks[1].reviewContext,context);
    assert.deepEqual((await f.view(0,id)).body.tasks[1].reviewSource,
      current.body.tasks[1].reviewSource);
    assert.equal((await f.claim(0,id,"test")).status,409);
    const raw=await readFile(path.join(f.dataDir,"agent-handoffs",id+".json"),"utf8");
    assert.equal(raw.includes(actorKey),false);
    assert.equal(raw.includes(rootKey),false);
  }finally{await f.close();}
});
test("missing, queued, failed and skipped worker jobs never verify a Tester task",async()=>{
  const f=await fixture();
  try{
    const id=await f.create(),lease=await f.claim(0,id);
    assert.equal(lease.status,200);
    await sleep(14);
    for(const state of ["queued","failed","skipped"]){
      const job=await f.run({state});
      const res=await f.verify(0,id,lease.body.leaseId,job);
      assert.equal(res.status,409,JSON.stringify(res));
      assert.equal(res.body.error,"test_evidence_invalid");
    }
    const invalid=await f.verify(0,id,lease.body.leaseId,
      {report:{id:randomUUID(),digest:"a".repeat(64)},
        head:"b".repeat(64),entries:[{}]});
    assert.equal(invalid.status,409);
    const current=await f.view(1,id);
    assert.equal(current.body.tasks[0].state,"leased");
    assert.equal(current.body.tasks[1].state,"blocked");
    assert.equal(current.body.verifiedTestJobs,0);
  }finally{await f.close();}
});
test("forged report digest, journal head, count, step and unauthorized roles fail closed",async()=>{
  const f=await fixture();
  try {
    const id=await f.create(),lease=await f.claim(0,id);
    await sleep(16);
    const job=await f.run();
    const overrides=[
      {jobDigest:"a".repeat(64)}, {jobHead:"f".repeat(64)},
      {jobCount:99},{step:"web-test"},
      {step:"dotnet-build"},
      {passed:true},{apiKey:"secret"},
    ];
    for(const change of overrides){
      const r=await f.verify(0,id,lease.body.leaseId,job,change);
      assert.ok([409,422].includes(r.status),JSON.stringify(r));
    }
    assert.equal((await f.verify(0,id,lease.body.leaseId,job,{},rootKey)).status,401);
    assert.equal((await f.verify(0,id,lease.body.leaseId,job,{},reviewerKey)).status,403);
    assert.equal((await f.verify(0,id,lease.body.leaseId,job,{},wrongRoleKey)).status,403);
  }finally{await f.close();}
});
test("old job predating claim, stale lease and no reused proof between handoffs",async()=>{
  const f=await fixture();
  try{
    const old=await f.run();
    await sleep(16);
    const id=await f.create(),lease=await f.claim(0,id);
    assert.equal((await f.verify(0,id,lease.body.leaseId,old)).status,409);
    const otherId=await f.create(),second=await f.claim(1,otherId);
    await sleep(16);
    const passed=await f.run();
    assert.equal((await f.verify(0,id,lease.body.leaseId,passed)).status,201);
    assert.equal((await f.verify(1,otherId,second.body.leaseId,passed)).status,409);
    const reply=await f.call(0,"POST","/v1/agent-task-leases",{
      action:"release",handoffId:otherId,taskId:"test",leaseId:second.body.leaseId,
    },actorKey);
    assert.equal(reply.status,200);
    assert.equal((await f.verify(1,otherId,second.body.leaseId,passed)).status,409);
  }finally{await f.close();}
});
test("tenant-bound verification refuses a different tenant's passed job or root actor",async()=>{
  const f=await fixture({multiTenant:true});
  try{
    const id=await f.create();
    const lease=await f.claim(0,id);
    assert.equal(lease.status,200);
    await sleep(16);
    const foreign=await f.run({tenantId:"bravo"});
    const r=await f.verify(0,id,lease.body.leaseId,foreign);
    assert.equal(r.status,409);
    assert.equal((await f.verify(0,id,lease.body.leaseId,foreign,{},actorKey)).status,404);
    assert.equal((await f.verify(0,id,lease.body.leaseId,foreign,{},f.tenantKey)).status,401);
    const valid=await f.run({tenantId:"alpha"});
    assert.equal((await f.verify(0,id,lease.body.leaseId,valid)).status,201);
    assert.equal((await f.view(1,id,f.bravo)).status,404);
    assert.equal((await f.view(1,id,f.tenantKey)).body.verifiedTestJobs,1);
  }finally{await f.close();}
});
test("journal corruption and retention invalidate handoff reads after completion",async()=>{
  const f=await fixture();
  try{
    const id=await f.create(),lease=await f.claim(0,id);
    await sleep(16);
    const job=await f.run();
    assert.equal((await f.verify(0,id,lease.body.leaseId,job)).status,201);
    const file=path.join(f.dataDir,"jobs",job.report.id,"evidence.jsonl");
    await writeFile(file,"tampered\n",{mode:0o600});
    const read=await f.view(0,id);
    assert.notEqual(read.status,200);
    assert.equal((await f.claim(1,id,"review",reviewerKey)).status,404);
    // An operator may eventually remove the retained evidence; this also
    // removes ability to claim technical proof while preservation is absent.
    await rm(path.join(f.dataDir,"jobs",job.report.id),{recursive:true,force:true});
    assert.notEqual((await f.view(0,id)).status,200);
  }finally{await f.close();}
});
test("revoked actor during lock, local job fake verdict and byte-limited request cannot certify",async()=>{
  const f=await fixture();
  try{
    const id=await f.create(),lease=await f.claim(0,id);
    await sleep(16);
    const job=await f.run();
    let release,started;
    const blocked=new Promise(resolve=>release=resolve),
      entered=new Promise(resolve=>started=resolve);
    const lock=withAdmissionLock(f.dataDir,async()=>{started();await blocked;});
    await entered;
    const pending=f.verify(0,id,lease.body.leaseId,job);
    await sleep(80);
    const old=JSON.parse(await readFile(f.actorFile,"utf8"));
    const newFile=f.actorFile+".new";
    await writeFile(newFile,JSON.stringify({
      ...old,actors:old.actors.filter(a=>a.key!==actorKey),
    }),{mode:0o600,flag:"wx"});
    await rename(newFile,f.actorFile);
    release();await lock;
    assert.equal((await pending).status,401);
    assert.equal((await f.view(0,id)).body.verifiedTestJobs,0);
    const huge=await f.verify(0,id,lease.body.leaseId,job,{fake:"x".repeat(1400)});
    assert.equal(huge.status,401); // now revoked, cannot inspect data
  }finally{await f.close();}
});


test("late verification scan cannot commit an expired fencing lease",async()=>{
  const f=await fixture();
  try {
    const id=await f.create(),claim=await f.claim(0,id);
    assert.equal(claim.status,200);
    await sleep(16);
    const job=await f.run();
    const now=Date.now(),actor={id:"tester-one",tenantId:null,role:"tester"};
    let calls=0;
    await assert.rejects(verifyAgentTestTask({
      dataDir:f.dataDir,actor,request:{
        handoffId:id,taskId:"test",leaseId:claim.body.leaseId,
        submissionId:randomUUID(),jobId:job.report.id,
        jobDigest:job.report.digest,jobHead:job.head,
        jobCount:job.entries.length,step:"dotnet-test",
      },
      nowMs:()=>++calls===1?now:now+120000,
    }),{code:"HANDOFF_LEASE_STALE"});
    const status=await f.view(1,id);
    assert.equal(status.status,200);
    assert.equal(status.body.tasks[0].state,"leased");
    assert.equal(status.body.verifiedTestJobs,0);
  } finally { await f.close(); }
});

test("retained runner input changes or disappearance invalidate Tester proof on GET",async()=>{
  const f=await fixture();
  try {
    const id=await f.create(),lease=await f.claim(0,id);
    assert.equal(lease.status,200);
    await sleep(16);
    const job=await f.run();
    assert.equal((await f.verify(0,id,lease.body.leaseId,job)).status,201);
    assert.equal((await f.view(1,id)).status,200);
    const inputPath=path.join(f.dataDir,"jobs",job.report.id,"input.json");
    const input=JSON.parse(await readFile(inputPath,"utf8"));
    input.files["src/backend/domain/X.cs"]="namespace X; public class Changed {}";
    await writeFile(inputPath,JSON.stringify(input),{mode:0o600});
    const rejected=await f.view(0,id);
    assert.equal(rejected.status,409,JSON.stringify(rejected.body));
    assert.equal(rejected.body.error,"handoff_integrity");
    // A previous journal `passed` must not survive removal of its source.
    await rm(inputPath);
    const missing=await f.view(1,id);
    assert.equal(missing.status,409,JSON.stringify(missing.body));
    assert.equal(missing.body.error,"handoff_integrity");
    const claim=await f.claim(0,id,"review",reviewerKey);
    assert.equal(claim.status,404,JSON.stringify(claim.body));
  }finally {await f.close();}
});
test("review source is blocked when verified Tester dependencies used distinct file snapshots",async()=>{
  const f=await fixture();
  try {
    const declaration={
      consent:true,label:"two independent source inputs",budgetUnits:6,
      tasks:[
        {id:"test-a",role:"tester",owner:"tester-one",dependsOn:[],
          estimatedUnits:2,maxAttempts:1},
        {id:"test-b",role:"tester",owner:"tester-one",dependsOn:[],
          estimatedUnits:2,maxAttempts:1},
        {id:"review",role:"code_reviewer",owner:"reviewer-one",
          dependsOn:["test-a","test-b"],estimatedUnits:2,maxAttempts:1},
      ],
    };
    const id=await f.create(declaration);
    for (const [i,taskId,sourceCode] of [
      [0,"test-a","namespace X; public class A {}"],
      [1,"test-b","namespace X; public class B {}"],
    ]) {
      const lease=await f.claim(i,id,taskId);
      assert.equal(lease.status,200,JSON.stringify(lease.body));
      await sleep(16);
      const job=await f.run({sourceCode});
      const proof=await f.verify(i,id,lease.body.leaseId,job,{taskId});
      assert.equal(proof.status,201,JSON.stringify(proof.body));
    }
    const view=await f.view(1,id);
    assert.equal(view.status,200,JSON.stringify(view.body));
    const review=view.body.tasks.find(task=>task.id==="review");
    assert.equal(review.reviewContext.status,"inputs_recorded");
    assert.equal(review.reviewSource.status,"conflicting_tested_sources");
    assert.equal(review.reviewSource.digest,null);
    assert.equal(review.reviewSource.fingerprint,null);
    assert.equal(review.state,"blocked");
    const attempt=await f.claim(0,id,"review",reviewerKey);
    assert.equal(attempt.status,409,JSON.stringify(attempt.body));
    assert.equal(attempt.body.error,"dependency_blocked");
  }finally {await f.close();}
});

const reviewDocument=()=>({
  version:1,
  summary:"Independent manual inspection of the tested source snapshot.",
  recommendation:"approve",
  findings:[{severity:"low",
    description:"Documentation and invariants were checked without including source."}],
});
const stageReport=(f,api,{id,lease,source,owner,submissionId=randomUUID(),
  document=reviewDocument()})=>
  f.call(api,"POST","/v1/agent-review-artifacts",{
    handoffId:id,taskId:"review",leaseId:lease,
    submissionId,sourceFingerprint:source.fingerprint,document,
  },owner);
const reviewerTaskManifest=()=>({
  consent:true,label:"Independent source-bound manual code review",
  budgetUnits:6,tasks:[
    {id:"test",role:"tester",owner:"tester-one",dependsOn:[],
      estimatedUnits:2,maxAttempts:2},
    {id:"review",role:"code_reviewer",owner:"reviewer-one",
      dependsOn:["test"],estimatedUnits:2,maxAttempts:2},
    {id:"release",role:"release_manager",owner:"release-one",
      dependsOn:["review"],estimatedUnits:2,maxAttempts:1},
  ],
});
async function prepareReviewer(f,{tenants=false}={}) {
  const id=await f.create(tenants?draft():reviewerTaskManifest());
  const claim=await f.claim(0,id);
  assert.equal(claim.status,200,JSON.stringify(claim.body));
  await sleep(20); // job accepted strictly after the Tester claim
  const job=await f.run();
  const verified=await f.verify(1,id,claim.body.leaseId,job);
  assert.equal(verified.status,201,JSON.stringify(verified.body));
  const view=await f.view(0,id);
  assert.equal(view.status,200,JSON.stringify(view.body));
  const source=view.body.tasks.find(t=>t.id==="review").reviewSource;
  assert.equal(source.status,"runner_input_recorded");
  const owner=tenants?tenantReviewKey:reviewerKey;
  const lease=await f.claim(1,id,"review",owner);
  assert.equal(lease.status,200,JSON.stringify(lease.body));
  const staged=await stageReport(f,0,{
    id,source,lease:lease.body.leaseId,owner,
  });
  assert.equal(staged.status,201,JSON.stringify(staged.body));
  assert.equal(staged.body.artifactMode,"stored_review_document_v1");
  return {id,job,source,lease:lease.body.leaseId,owner,
    submissionId:staged.body.submissionId,
    artifactDigest:staged.body.artifactDigest};
}
const reviewSubmitBody=(id,lease,sourceFingerprint,submissionId,artifactDigest)=>({
  action:"submit",handoffId:id,taskId:"review",leaseId:lease,submissionId,
  artifactDigest,sourceFingerprint,
});
const reviewApprovalBody=submission=>({
  action:"approve",handoffId:submission.handoffId,taskId:submission.taskId,
  submissionId:submission.submissionId,
  artifactDigest:submission.artifactDigest,
  sourceFingerprint:submission.sourceFingerprint,
  attestation:"manual_inspection",
});
const postReview=(f,api,body,token)=>
  f.call(api,"POST","/v1/agent-task-reviews",body,token);

test("independent review submit is not completion; manual signoff unlocks only downstream",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    assert.equal((await f.claim(0,id,"release",releaseKey)).status,409);
    const [first,replay]=await Promise.all([
      postReview(f,0,req,owner),
      postReview(f,1,req,owner),
    ]);
    assert.deepEqual([first.status,replay.status].sort(),[200,201],
      JSON.stringify({first,replay}));
    const pending=await f.view(0,id);
    assert.equal(pending.body.tasks[1].state,"review_submitted");
    assert.equal(pending.body.tasks[2].state,"blocked");
    assert.equal(pending.body.tasks[1].evidence,"not_started");
    assert.equal(pending.body.executions,0);
    assert.equal(pending.body.approvedReportedUnits,0);
    assert.equal((await f.claim(1,id,"release",releaseKey)).status,409);
    const approved=await postReview(f,0,reviewApprovalBody(req),reviewApproverKey);
    assert.equal(approved.status,201,JSON.stringify(approved.body));
    assert.equal(approved.body.created,true);
    const twice=await postReview(f,1,reviewApprovalBody(req),reviewApproverKey);
    assert.equal(twice.status,200,JSON.stringify(twice.body));
    assert.equal(twice.body.created,false);
    const done=await f.view(1,id);
    assert.equal(done.status,200,JSON.stringify(done.body));
    assert.deepEqual(done.body.tasks.map(t=>t.state),
      ["runner_verified_test","human_approved_review","ready"]);
    assert.deepEqual(done.body.tasks[1].reviewApproval,{
      submissionId:req.submissionId,artifactDigest,
      sourceFingerprint:source.fingerprint,approvedBy:"human-review",
      attestation:"manual_inspection",
      artifactMode:"stored_review_document_v1",
    });
    assert.equal(done.body.tasks[1].evidence,"human_review_attestation");
    assert.equal(done.body.executions,0);
    assert.equal(done.body.approvedReportedUnits,0);
    assert.equal(JSON.stringify(done.body).includes(lease),false);
    assert.equal((await f.claim(0,id,"release",releaseKey)).status,200);
    assert.equal((await f.claim(0,id,"review",owner)).status,409);
  } finally { await f.close(); }
});

test("review rejects fake source, extra keys, wrong role, self-approval and changed artifact",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    const badSource=await postReview(f,0,{
      ...req,sourceFingerprint:"b".repeat(64),
    },owner);
    assert.equal(badSource.status,409,JSON.stringify(badSource.body));
    assert.equal((await postReview(f,0,{...req,passed:true},owner)).status,422);
    assert.equal((await postReview(f,0,req,actorKey)).status,403);
    assert.equal((await postReview(f,0,reviewApprovalBody(req),owner)).status,403);
    assert.equal((await postReview(f,0,reviewApprovalBody(req),reviewSelfKey)).status,404);
    assert.equal((await postReview(f,0,reviewApprovalBody(req),reviewApproverKey)).status,409);
    assert.equal((await postReview(f,0,req,owner)).status,201);
    assert.equal((await postReview(f,0,{...req,artifactDigest:"c".repeat(64)},owner)).status,409);
    assert.equal((await postReview(f,0,reviewApprovalBody({
      ...req,artifactDigest:"c".repeat(64)}),reviewApproverKey)).status,409);
    assert.equal((await postReview(f,0,{
      ...reviewApprovalBody(req),attestation:"automatic"},reviewApproverKey)).status,422);
    assert.equal((await postReview(f,0,reviewApprovalBody(req),rootKey)).status,401);
    const done=await f.view(0,id);
    assert.equal(done.body.tasks[1].state,"review_submitted");
    assert.equal(done.body.tasks[2].state,"blocked");
  }finally{await f.close();}
});

test("review actor and approver must belong to same tenant as tested input",async()=>{
  const f=await fixture({multiTenant:true});
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f,{tenants:true});
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    assert.equal((await postReview(f,0,req,reviewerKey)).status,404);
    assert.equal((await postReview(f,0,req,owner)).status,201);
    assert.equal((await postReview(f,0,reviewApprovalBody(req),reviewApproverKey)).status,404);
    const result=await postReview(f,0,reviewApprovalBody(req),tenantApproverKey);
    assert.equal(result.status,201,JSON.stringify(result.body));
    const done=await f.view(1,id);
    assert.equal(done.body.tasks[1].state,"human_approved_review");
  }finally{await f.close();}
});

test("review source input disappearance makes approved handoff fail closed",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,job,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    assert.equal((await postReview(f,0,req,owner)).status,201);
    assert.equal((await postReview(f,0,reviewApprovalBody(req),reviewApproverKey)).status,201);
    await rm(path.join(f.dataDir,"jobs",job.report.id,"input.json"));
    const view=await f.view(0,id);
    assert.equal(view.status,409,JSON.stringify(view.body));
    assert.equal((await f.claim(1,id,"release",releaseKey)).status,404);
    // The actor-only endpoint deliberately hides damaged private handoffs
    // as 404 (no existence oracle), while the root GET reports integrity 409.
    const submit=await postReview(f,0,reviewApprovalBody(req),reviewApproverKey);
    assert.equal(submit.status,404);
  }finally{await f.close();}
});

test("review signoff is fenced by key rotation during the admission lock",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    assert.equal((await postReview(f,0,req,owner)).status,201);
    let acquired;
    const entered=new Promise(resolve=>acquired=resolve);
    let release;
    const held=new Promise(resolve=>release=resolve);
    const holder=withAdmissionLock(f.dataDir,async()=>{
      acquired(); await held;
    },4000);
    await entered;
    const approving=postReview(f,1,reviewApprovalBody(req),reviewApproverKey);
    await sleep(35);
    const raw=JSON.parse(await readFile(f.actorFile,"utf8"));
    raw.actors.find(a=>a.id==="human-review" && a.tenantId===null).key=
      "agent.human-review."+"N".repeat(48);
    const replacement=f.actorFile+".replace";
    await writeFile(replacement,JSON.stringify(raw),{mode:0o600});
    await rename(replacement,f.actorFile);
    release(); await holder;
    const outcome=await approving;
    assert.equal(outcome.status,401,JSON.stringify(outcome.body));
    const status=await f.view(0,id);
    assert.equal(status.body.tasks[1].state,"review_submitted");
    assert.equal(status.body.tasks[2].state,"blocked");
  }finally{await f.close();}
});

test("review late completion after lease timeout and forged chained event are rejected",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,submissionId,artifactDigest}=await prepareReviewer(f);
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    let ticks=0; const now=Date.now();
    await assert.rejects(mutateAgentTaskReview({
      dataDir:f.dataDir,actor:{id:"reviewer-one",role:"code_reviewer",tenantId:null},
      request:req,nowMs:()=>++ticks===1?now:now+120000,
    }),{code:"HANDOFF_LEASE_STALE"});
    assert.equal((await f.view(0,id)).body.tasks[1].state,"leased");
    const good=await postReview(f,0,req,reviewerKey);
    assert.equal(good.status,201,JSON.stringify(good.body));
    const recordPath=path.join(f.dataDir,"agent-handoffs",id+".json");
    const record=JSON.parse(await readFile(recordPath,"utf8"));
    record.events.at(-1).sourceFingerprint="c".repeat(64);
    await writeFile(recordPath,JSON.stringify(record),{mode:0o600});
    assert.equal((await f.view(1,id)).status,409);
    assert.equal((await postReview(f,0,reviewApprovalBody(req),reviewApproverKey)).status,404);
  }finally{await f.close();}
});

test("released reviewer lease and old fencing generation cannot submit a review",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const old=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    const release=await f.call(0,"POST","/v1/agent-task-leases",{
      action:"release",handoffId:id,taskId:"review",leaseId:lease,
    },owner);
    assert.equal(release.status,200,JSON.stringify(release.body));
    assert.equal((await postReview(f,0,old,owner)).status,409);
    const replacement=await f.claim(1,id,"review",owner);
    assert.equal(replacement.status,200,JSON.stringify(replacement.body));
    assert.notEqual(replacement.body.leaseId,lease);
    assert.equal(replacement.body.generation,2);
    assert.equal((await postReview(f,1,old,owner)).status,409);
    const newStage=await stageReport(f,0,{
      id,lease:replacement.body.leaseId,source,owner,
    });
    assert.equal(newStage.status,201,JSON.stringify(newStage.body));
    const current=reviewSubmitBody(id,replacement.body.leaseId,
      source.fingerprint,newStage.body.submissionId,newStage.body.artifactDigest);
    assert.equal((await postReview(f,1,current,owner)).status,201);
    const review=(await f.view(0,id)).body.tasks[1];
    assert.equal(review.state,"review_submitted");
    assert.equal(review.fencingVersion,2);
  }finally {await f.close();}
});
test("review approval survives a fresh API instance, without replaying agent execution",async()=>{
  const f=await fixture();
  let restarted;
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const submit=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    assert.equal((await postReview(f,0,submit,owner)).status,201);
    assert.equal((await postReview(f,1,reviewApprovalBody(submit),
      reviewApproverKey)).status,201);
    await new Promise(resolve=>f.servers[0].close(resolve));
    restarted=createRunnerServer({
      dataDir:f.dataDir,apiKey:rootKey,agentActorsFile:f.actorFile,
      allowedOrigins:[origin],
    });
    restarted.listen(0,"127.0.0.1");
    await once(restarted,"listening");
    const host="http://127.0.0.1:"+restarted.address().port;
    const load=await fetch(host+"/v1/agent-handoffs/"+id,{
      headers:{Origin:origin,Authorization:"Bearer "+rootKey},
    });
    assert.equal(load.status,200);
    const board=await load.json();
    assert.equal(board.tasks[1].state,"human_approved_review");
    assert.equal(board.tasks[1].reviewApproval.sourceFingerprint,source.fingerprint);
    assert.equal(board.executions,0);
    const claim=await fetch(host+"/v1/agent-task-leases",{
      method:"POST",headers:{Origin:origin,Authorization:"Bearer "+releaseKey,
        "Content-Type":"application/json"},
      body:JSON.stringify({action:"claim",handoffId:id,taskId:"release",
        ttlSeconds:60}),
    });
    assert.equal(claim.status,200,JSON.stringify(await claim.json()));
  } finally {
    if(restarted?.listening)
      await new Promise(resolve=>restarted.close(resolve));
    await f.close();
  }
});

test("write-once review document is available only after submit to independent approver",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    const pre=f.call(1,"GET","/v1/agent-review-artifacts/"+submissionId,
      undefined,reviewApproverKey);
    assert.equal((await pre).status,404);
    const replay=await stageReport(f,1,{id,lease,source,owner,submissionId});
    assert.equal(replay.status,200,JSON.stringify(replay.body));
    assert.equal(replay.body.created,false);
    assert.equal(replay.body.artifactDigest,artifactDigest);
    const changed=await stageReport(f,0,{id,lease,source,owner,submissionId,
      document:{...reviewDocument(),summary:"A different valid report must never replace this one."}});
    assert.equal(changed.status,409,JSON.stringify(changed.body));
    assert.equal((await postReview(f,0,req,owner)).status,201);
    const get=(i,token)=>f.call(i,"GET","/v1/agent-review-artifacts/"+
      submissionId,undefined,token);
    const fetched=await get(1,reviewApproverKey);
    assert.equal(fetched.status,200,JSON.stringify(fetched.body));
    assert.deepEqual(fetched.body.document,reviewDocument());
    assert.equal(fetched.body.artifactDigest,artifactDigest);
    assert.equal(fetched.body.sourceFingerprint,source.fingerprint);
    assert.equal(fetched.body.artifactMode,"stored_review_document_v1");
    assert.equal(JSON.stringify(fetched.body).includes(lease),false);
    assert.equal((await get(0,owner)).status,200);
    assert.equal((await get(0,rootKey)).status,401);
    assert.equal((await get(0,actorKey)).status,404);
    assert.equal((await get(0,reviewSelfKey)).status,404);
    assert.equal((await get(0,tenantApproverKey)).status,404);
  } finally {await f.close();}
});
test("new reviewer submit never trusts a caller digest without a staged report",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    const forged=await postReview(f,0,{
      ...req,submissionId:randomUUID(),artifactDigest:"c".repeat(64),
    },owner);
    assert.equal(forged.status,409,JSON.stringify(forged.body));
    assert.equal(forged.body.error,"review_evidence_invalid");
    assert.equal((await postReview(f,1,{...req,artifactDigest:"b".repeat(64)},
      owner)).status,409);
    const submitted=await postReview(f,0,req,owner);
    assert.equal(submitted.status,201,JSON.stringify(submitted.body));
    assert.equal(submitted.body.artifactMode,"stored_review_document_v1");
    const board=(await f.view(1,id)).body;
    assert.equal(board.tasks[1].state,"review_submitted");
    assert.equal(board.tasks[2].state,"blocked");
  } finally {await f.close();}
});
test("approved review becomes unusable when retained report changes, disappears or is a symlink",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    assert.equal((await postReview(f,0,req,owner)).status,201);
    assert.equal((await postReview(f,1,reviewApprovalBody(req),reviewApproverKey)).status,201);
    const pathToDoc=path.join(f.dataDir,"agent-review-artifacts",submissionId+".json");
    const stored=await readFile(pathToDoc,"utf8");
    assert.equal(stored.includes(lease),false);
    const forged=JSON.parse(stored);
    forged.document.summary="A deliberately modified but plausible description.";
    await writeFile(pathToDoc,JSON.stringify(forged),{mode:0o600});
    assert.equal((await f.view(1,id)).status,409);
    await writeFile(pathToDoc,stored,{mode:0o600});
    assert.equal((await f.view(0,id)).status,200);
    await rm(pathToDoc);
    await symlink(path.join(f.base,"untrusted.json"),pathToDoc);
    assert.equal((await f.view(1,id)).status,409);
    assert.equal((await f.claim(0,id,"release",releaseKey)).status,404);
    await rm(pathToDoc);
    assert.equal((await f.view(0,id)).status,409);
    assert.equal((await f.call(1,"GET","/v1/agent-review-artifacts/"+
      submissionId,undefined,reviewApproverKey)).status,404);
  } finally {await f.close();}
});
test("staged artifact is bound to lease generation and rejects unsafe report fields",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,owner,submissionId}=await prepareReviewer(f);
    const invalid=await stageReport(f,1,{id,lease,source,owner,
      document:{version:1,summary:"Contains a hidden credential Bearer abcdefgh",
        recommendation:"approve",findings:[]}});
    assert.equal(invalid.status,422);
    const missing=await stageReport(f,1,{id,lease,source,owner,
      document:{version:1,summary:"Enough summary, but missing findings.",recommendation:"approve"}});
    assert.equal(missing.status,422);
    const alternate=await stageReport(f,0,{id,lease,source,owner});
    assert.equal(alternate.status,409);
    const released=await f.call(0,"POST","/v1/agent-task-leases",{
      action:"release",handoffId:id,taskId:"review",leaseId:lease,
    },owner);
    assert.equal(released.status,200);
    const replay=await stageReport(f,0,{id,lease,source,owner,submissionId});
    assert.equal(replay.status,409);
    const newLease=await f.claim(1,id,"review",owner);
    assert.equal(newLease.status,200);
    const newReport=await stageReport(f,1,{
      id,lease:newLease.body.leaseId,source,owner,
    });
    assert.equal(newReport.status,201,JSON.stringify(newReport.body));
    assert.notEqual(newReport.body.submissionId,submissionId);
    assert.notEqual(newReport.body.artifactDigest,
      (await readFile(path.join(f.dataDir,"agent-review-artifacts",
        submissionId+".json"),"utf8")).match(/"digest":"([a-f0-9]{64})"/)?.[1]);
  } finally {await f.close();}
});
test("legacy #115 review events stay readable without falsely claiming stored reports",async()=>{
  const f=await fixture();
  try {
    const {id,lease,source,owner,submissionId,artifactDigest}=await prepareReviewer(f);
    const req=reviewSubmitBody(id,lease,source.fingerprint,submissionId,artifactDigest);
    assert.equal((await postReview(f,0,req,owner)).status,201);
    assert.equal((await postReview(f,0,reviewApprovalBody(req),reviewApproverKey)).status,201);
    const location=path.join(f.dataDir,"agent-handoffs",id+".json");
    const manifest=JSON.parse(await readFile(location,"utf8"));
    let head="0".repeat(64);
    const digest=obj=>createHash("sha256").update(JSON.stringify(obj)).digest("hex");
    for(const event of manifest.events) {
      if(event.kind.startsWith("review_")) delete event.artifactMode;
      event.previousHash=head;
      delete event.hash;
      event.hash=digest(event);
      head=event.hash;
    }
    manifest.head=head;
    delete manifest.hash;
    manifest.hash=digest(manifest);
    await writeFile(location,JSON.stringify(manifest),{mode:0o600});
    await rm(path.join(f.dataDir,"agent-review-artifacts",submissionId+".json"));
    const read=await f.view(1,id);
    assert.equal(read.status,200,JSON.stringify(read.body));
    const reviewed=read.body.tasks[1];
    assert.equal(reviewed.state,"human_approved_review");
    assert.equal(reviewed.reviewApproval.artifactMode,undefined);
    assert.equal((await f.claim(0,id,"release",releaseKey)).status,200);
  } finally {await f.close();}
});
