/**
 * Real Chromium concurrency and GitHub import race smoke for the Factory SPA (#91/#92).
 * Only trusted GitHub-hosted CI runs the outer Docker invocation. The browser
 * container is networkless, read-only, capability-dropped, with no Docker socket.
 * It serves the pre-built Factory SPA over container-local loopback.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const inside = process.argv.includes("--inside");
if (!inside) {
  assert.equal(process.env.CI, "true", "Rootful CI Docker is never a browser fallback");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Docker browser harness runs only in GitHub Actions");
  assert.notEqual(process.getuid?.(), 0, "Use unprivileged CI checkout");
  const image = "mcr.microsoft.com/playwright:v1.64.1-noble";
  const args = [
    "run", "--rm", "--network", "none", "--read-only",
    "--cap-drop=ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "2g", "--cpus", "2",
    "--shm-size", "512m",
    "--tmpfs", "/tmp:rw,size=512m,mode=1777",
    "--mount", "type=bind,src=" + root + ",dst=/factory,readonly",
    "--workdir", "/factory", "--env", "HOME=/tmp",
    image, "node", "src/runner/scripts/factory-browser-lock-smoke.mjs", "--inside",
  ];
  const result = spawnSync("docker", args, { stdio: "inherit", timeout: 150_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error("FACTORY_BROWSER_LOCK_SMOKE_FAILED: " + result.status);
  console.log("FACTORY_BROWSER_LOCK_SMOKE_PASS");
} else {
  const require = createRequire(path.join(root,
    "src/frontend/generated-fixture/src/frontend/web/package.json"));
  const { chromium, expect } = require("@playwright/test");
  // A minimal static server never writes to the read-only checkout. Vite's
  // preview command would attempt a .vite-temp config file under node_modules.
  const dist = path.join(root,"src/frontend/dist");
  const server = createServer(async (req,res) => {
    let pathname;
    try { pathname = new URL(req.url || "/", "http://127.0.0.1").pathname; }
    catch { res.writeHead(400).end(); return; }
    if (!/^\/(?:|assets\/[A-Za-z0-9._-]+)$/.test(pathname)) {
      res.writeHead(404).end(); return;
    }
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    try {
      const bytes=await readFile(path.join(dist,name));
      const type=name.endsWith(".js") ? "text/javascript" :
        name.endsWith(".css") ? "text/css" : "text/html";
      res.writeHead(200,{"Content-Type":type,"Cache-Control":"no-store"}).end(bytes);
    } catch {res.writeHead(404).end();}
  });
  await new Promise((resolve,reject) => {
    server.once("error",reject);
    server.listen(4174,"127.0.0.1",resolve);
  });
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    // IndexedDB CAS primitive (#138): actual Chromium, same-origin tabs and
    // genuine readwrite transactions. The live SPA remains on localStorage;
    // this explicitly tests the isolated CAS protocol BEFORE any migration.
    const casBuild = await require("esbuild").build({
      entryPoints:[path.join(root,"src/frontend/src/infrastructure/project-cas.ts")],
      bundle:true,write:false,platform:"browser",format:"iife",
      globalName:"FactoryProjectCas",target:"es2022",
    });
    const casBundle = casBuild.outputFiles[0].text;
    const casContext = await browser.newContext();
    try {
      const casA=await casContext.newPage(),casB=await casContext.newPage();
      await Promise.all([
        casA.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        casB.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await Promise.all([casA.addScriptTag({content:casBundle}),
        casB.addScriptTag({content:casBundle})]);
      const id="11111111-1111-4111-8111-111111111111";
      const candidate = (page,label,expected) => page.evaluate(async ({id,label,expected}) => {
        const project={id,config:{name:label},stages:[],
          updatedAt:"2026-11-20T20:00:00.000Z"};
        try {return {ok:true,snapshot:await window.FactoryProjectCas
          .compareAndSwapCasProject(project,expected)};}
        catch(error){return {ok:false,error:String(error)};}
      },{id,label,expected});
      const initial=await Promise.all([
        candidate(casA,"first insert A",null),
        candidate(casB,"first insert B",null),
      ]);
      assert.equal(initial.filter(x=>x.ok).length,1,
        "Concurrent insert-only CAS must permit exactly one winner");
      assert.match(initial.find(x=>!x.ok).error,/Conflitto CAS/);
      const latest=await casA.evaluate(id =>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.equal(latest.revision,1);
      assert.equal(latest.raw,initial.find(x=>x.ok).snapshot.raw);
      const updates=await Promise.all([
        candidate(casA,"stale update A",latest),
        candidate(casB,"stale update B",latest),
      ]);
      assert.equal(updates.filter(x=>x.ok).length,1,
        "Concurrent CAS with the same revision must permit only one update");
      assert.match(updates.find(x=>!x.ok).error,/Conflitto CAS/);
      const updated=await casB.evaluate(id =>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.equal(updated.revision,2);
      assert.equal(updated.raw,updates.find(x=>x.ok).snapshot.raw);
      const staleDelete=await casA.evaluate(async ({id,latest}) => {
        try {await window.FactoryProjectCas.deleteCasProject(id,latest);
          return "unexpected success";}
        catch(error){return String(error);}
      },{id,latest});
      assert.match(staleDelete,/Conflitto CAS/);
      const tombstone=await casB.evaluate(async ({id,updated}) =>
        window.FactoryProjectCas.deleteCasProject(id,updated),{id,updated});
      assert.equal(tombstone.revision,3);
      const afterDelete=await casA.evaluate(id =>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.equal(afterDelete,null,"A tombstone must read as deleted");
      const emptyLibrary=await casA.evaluate(() =>
        window.FactoryProjectCas.listCasProjects());
      assert.deepEqual(emptyLibrary,[],"Tombstones must not appear in the library");
      // Recreating must advance generation instead of resetting to 1 (ABA).
      const reinsert=await candidate(casA,"re-created after tombstone",null);
      assert.equal(reinsert.ok,true);
      assert.equal(reinsert.snapshot.revision,4);
      const freshPage=await casContext.newPage();
      await freshPage.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await freshPage.addScriptTag({content:casBundle});
      const reopened=await freshPage.evaluate(id =>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.equal(reopened.revision,4,"IndexedDB CAS must survive tab reopen");
      assert.equal(reopened.raw,reinsert.snapshot.raw);
      const staleAgain=await candidate(casB,"stale after reopen",updated);
      assert.equal(staleAgain.ok,false);
      assert.match(staleAgain.error,/Conflitto CAS/);
      const secondId="22222222-2222-4222-8222-222222222222";
      const second=await casB.evaluate(async id =>
        window.FactoryProjectCas.compareAndSwapCasProject({
          id,config:{name:"Second project"},stages:[],
          updatedAt:"2026-11-21T10:00:00.000Z",
          githubDestination:{owner:"example",repo:"repo"},
        },null),secondId);
      assert.equal(second.revision,1);
      const library=await freshPage.evaluate(() =>
        window.FactoryProjectCas.listCasProjects());
      assert.deepEqual(library,[
        {id:secondId,name:"Second project",updatedAt:"2026-11-21T10:00:00.000Z",
          repository:"example/repo",revision:1},
        {id,name:"re-created after tombstone",updatedAt:"2026-11-20T20:00:00.000Z",
          repository:"",revision:4},
      ],"The IDB library must be consistent after tab reload");
      assert.equal((await casA.evaluate(() =>
        window.FactoryProjectCas.listCasProjects())).length,2,
        "Both tabs must discover the same IDB projects");

      // Deliberate corruption only in this disposable test browser profile.
      await casA.evaluate(async id => {
        const db=await new Promise((resolve,reject) => {
          const request=indexedDB.open("softwarefactory.project.cas.v1",1);
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(Error("Test fixture open failed"));
        });
        try {
          await new Promise((resolve,reject) => {
            const tx=db.transaction("projects","readwrite");
            tx.oncomplete=resolve;
            tx.onabort=()=>reject(Error("Test fixture write failed"));
            tx.objectStore("projects").put({id,revision:2,raw:"not-json"},id);
          });
        } finally {db.close();}
      },secondId);
      const badList=await casB.evaluate(async () => {
        try {await window.FactoryProjectCas.listCasProjects();return "unexpected success";}
        catch(e){return String(e);}
      });
      assert.match(badList,/corrotto/,"Malformed IDB row must reject entire library");
      assert.doesNotMatch(badList,/not-json/,"Never echo raw storage content");

      // Recreate a valid row and then exceed 40 active projects; discovery
      // must refuse rather than silently truncate.
      await casA.evaluate(async ({secondId,second}) => {
        const db=await new Promise((resolve,reject) => {
          const request=indexedDB.open("softwarefactory.project.cas.v1",1);
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(Error("Test fixture open failed"));
        });
        try {
          await new Promise((resolve,reject) => {
            const tx=db.transaction("projects","readwrite");
            tx.oncomplete=resolve;
            tx.onabort=()=>reject(Error("Test fixture write failed"));
            const store=tx.objectStore("projects");
            store.put({id:secondId,revision:1,raw:second.raw},secondId);
            for(let i=0;i<39;i++) {
              const extraId="33333333-3333-4333-8333-"+String(i).padStart(12,"0");
              store.put({id:extraId,revision:1,raw:JSON.stringify({
                id:extraId,config:{name:"Extra"},stages:[],
                updatedAt:"2026-11-21T10:00:00.000Z",
              })},extraId);
            }
          });
        } finally {db.close();}
      },{secondId,second});
      const overfull=await freshPage.evaluate(async () => {
        try {await window.FactoryProjectCas.listCasProjects();return "unexpected success";}
        catch(e){return String(e);}
      });
      assert.match(overfull,/oltre 40/,"Never hide a 41st IDB project");
      console.log("FACTORY_INDEXEDDB_LIBRARY_E2E_PASS: two tabs, tombstone, reload, corruption and overfull fail-closed");
      console.log("FACTORY_INDEXEDDB_CAS_E2E_PASS: Chromium two-tab insert/update races, stale delete, tombstone ABA and tab reopen");
    } finally {
      await casContext.close();
    }


    // #143: REAL Chromium multi-tab async editor session, isolated from the
    // live localStorage editor. Same-origin, separate browser profile.
    const editorBuild=await require("esbuild").build({
      entryPoints:[path.join(root,"src/frontend/src/infrastructure/project-cas-editor-session.ts")],
      bundle:true,write:false,platform:"browser",format:"iife",
      globalName:"FactoryCasEditor",target:"es2022",
    });
    const editorBundle=editorBuild.outputFiles[0].text;
    const editorContext=await browser.newContext();
    try {
      const tabA=await editorContext.newPage(),tabB=await editorContext.newPage();
      await Promise.all([
        tabA.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        tabB.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await Promise.all([
        tabA.addScriptTag({content:casBundle}),
        tabB.addScriptTag({content:casBundle}),
        tabA.addScriptTag({content:editorBundle}),
        tabB.addScriptTag({content:editorBundle}),
      ]);
      const editorId="77777777-7777-4777-8777-777777777777";
      const initial=await tabA.evaluate(async id=>{
        return await window.FactoryProjectCas.compareAndSwapCasProject({
          id,config:{name:"CAS editor initial"},stages:[],
          updatedAt:"2026-11-21T11:00:00.000Z",
        },null);
      },editorId);
      assert.equal(initial.revision,1);
      const opened=await Promise.all([tabA,tabB].map(page=>page.evaluate(async id=>{
        window.__factoryEditorSession=await window.FactoryCasEditor.openCasEditorSession(id);
        return {state:window.__factoryEditorSession.state(),
          token:window.__factoryEditorSession.snapshot()};
      },editorId)));
      assert.equal(opened[0].state,"ready");
      assert.deepEqual(opened[0].token,initial);
      assert.deepEqual(opened[1].token,initial);

      const race=await Promise.all([tabA,tabB].map((page,index)=>
        page.evaluate(async name=>{
          const session=window.__factoryEditorSession;
          const expected=session.snapshot(),project=JSON.parse(expected.raw);
          try {
            const saved=await session.commit({
              ...project,config:{...project.config,name},
            },expected);
            return {ok:true,saved,status:session.state()};
          } catch(error) {
            return {ok:false,reason:String(error),status:session.state(),
              token:session.snapshot()};
          }
        },"CAS tab "+index)));
      assert.equal(race.filter(x=>x.ok).length,1,
        "Exactly one async editor session must win the same-revision race");
      const winnerIndex=race[0].ok?0:1;
      const winner=winnerIndex===0?tabA:tabB;
      const loser=winnerIndex===0?tabB:tabA;
      assert.equal(race[winnerIndex].saved.revision,2);
      assert.equal(race[1-winnerIndex].status,"blocked");
      assert.deepEqual(race[1-winnerIndex].token,initial,
        "Failed transaction must not advance the losing editor session token");
      assert.match(race[1-winnerIndex].reason,/non confermato/);
      const retry=await loser.evaluate(async()=>{
        const h=window.__factoryEditorSession,token=h.snapshot();
        try {await h.commit(JSON.parse(token.raw),token);return "unexpected success";}
        catch(e){return String(e);}
      });
      assert.match(retry,/bloccata/,"Conflict must disable automatic retry");

      // A NONCOOPERATING IndexedDB writer bypasses the session protocol but
      // cannot bypass native transactional CAS. The surviving session must
      // fail closed rather than overwrite this later update.
      const rev2=race[winnerIndex].saved;
      const rev3=await loser.evaluate(async prev=>{
        const p=JSON.parse(prev.raw);
        return await window.FactoryProjectCas.compareAndSwapCasProject({
          ...p,config:{...p.config,name:"Noncooperating writer"},
        },prev);
      },rev2);
      assert.equal(rev3.revision,3);
      const stale=await winner.evaluate(async()=>{
        const h=window.__factoryEditorSession,expected=h.snapshot();
        const p=JSON.parse(expected.raw);
        try {await h.commit({...p,config:{...p.config,name:"Lost draft"}},expected);
          return "unexpected success";}
        catch(e){return {error:String(e),state:h.state(),token:h.snapshot()};}
      });
      assert.match(stale.error,/non confermato/);
      assert.equal(stale.state,"blocked");
      assert.deepEqual(stale.token,rev2);
      const authoritative=await tabA.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),editorId);
      assert.deepEqual(authoritative,rev3,
        "Noncooperating writer's revision must remain untouched");

      // Browser reload/reopen is the ONLY recovery path; a stale session
      // must not silently adopt a newer commit.
      const reloaded=await editorContext.newPage();
      await reloaded.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await reloaded.addScriptTag({content:casBundle});
      await reloaded.addScriptTag({content:editorBundle});
      const reopened=await reloaded.evaluate(async id=>{
        window.__factoryEditorSession=await window.FactoryCasEditor.openCasEditorSession(id);
        return window.__factoryEditorSession.snapshot();
      },editorId);
      assert.deepEqual(reopened,rev3);
      const doubleClick=await reloaded.evaluate(async()=>{
        const h=window.__factoryEditorSession,old=h.snapshot();
        const p=JSON.parse(old.raw);
        const first=h.commit({...p,config:{...p.config,name:"Double-click winner"}},old);
        const during=h.snapshot(),state=h.state();
        let concurrent;
        try {await h.commit({...p,config:{...p.config,name:"Double-click loser"}},old);
          concurrent="unexpected success";}
        catch(e){concurrent=String(e);}
        return {during,state,concurrent,result:await first,final:h.snapshot()};
      });
      assert.equal(doubleClick.state,"saving");
      assert.deepEqual(doubleClick.during,rev3,
        "Token is not advanced until the IDB transaction completes");
      assert.match(doubleClick.concurrent,/già in corso/);
      assert.equal(doubleClick.result.revision,4);
      assert.deepEqual(doubleClick.final,doubleClick.result);
      const last=await tabB.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),editorId);
      assert.deepEqual(last,doubleClick.result);

      const tombstone=await tabA.evaluate(async ({id,last})=>
        window.FactoryProjectCas.deleteCasProject(id,last),{id:editorId,last});
      assert.equal(tombstone.revision,5);
      const tombError=await reloaded.evaluate(async id=>{
        try {await window.FactoryCasEditor.openCasEditorSession(id);
          return "unexpected success";}
        catch(e){return String(e);}
      },editorId);
      assert.match(tombError,/eliminato/,"Deleted projects cannot be reopened as writable");

      const missingError=await reloaded.evaluate(async()=>{
        try {await window.FactoryCasEditor.openCasEditorSession(
          "88888888-8888-4888-8888-888888888888");
          return "unexpected success";}
        catch(e){return String(e);}
      });
      assert.match(missingError,/assente/);
      for (const page of [tabA,tabB,reloaded]) {
        const writtenLegacy=await page.evaluate(id=>
          localStorage.getItem("softwarefactory.project.library.v1."+id),editorId);
        assert.equal(writtenLegacy,null,
          "Async CAS protocol must never write a legacy localStorage project");
      }
      console.log("FACTORY_INDEXEDDB_ASYNC_EDITOR_E2E_PASS: dual tab CAS race, noncooperating writer, stale fencing, reload, double-click, tombstone and no legacy writes");
    } finally {
      await editorContext.close();
    }

    // Real user-consented, non-destructive localStorage -> IndexedDB staging
    // in a separate browser profile (#141), before any live editor cutover.
    const staging=await browser.newContext({acceptDownloads:true});
    try {
      const page=await staging.newPage();
      await page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      const copyButton=page.getByRole("button",{name:"Copia in IndexedDB (anteprima)"});
      await expect(copyButton).toBeEnabled({timeout:15000});
      const original=await page.evaluate(()=>{
        const id=JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}").id;
        return {id,raw:localStorage.getItem("softwarefactory.project.library.v1."+id)};
      });
      assert.ok(original.id && original.raw,"Live per-ID slot must exist");
      page.once("dialog",dlg=>void dlg.dismiss());
      await copyButton.click();
      assert.equal(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id),null,
        "Declining first consent must not create a CAS copy");

      let consents=0;
      page.on("dialog",async dlg=>{consents++;await dlg.accept();});
      const pendingDownload=page.waitForEvent("download",{timeout:20000});
      await copyButton.click();
      const downloaded=await pendingDownload;
      assert.equal(downloaded.suggestedFilename(),
        "softwarefactory-pre-indexeddb-"+original.id+".json");
      assert.equal((await readFile(await downloaded.path())).toString("utf8"),original.raw,
        "Downloaded JSON must exactly match the legacy slot including checkpoints");
      await expect(page.getByText("Copia IndexedDB creata.",{exact:false}))
        .toBeVisible({timeout:15000});
      assert.equal(consents,2,"Both independent backup confirmations are required");
      const copied=await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id);
      assert.equal(copied.revision,1);
      assert.equal(copied.raw,original.raw);
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.project.library.v1."+id),original.id),
        original.raw,"Legacy project is still authoritative and unmodified");

      const retryDownload=page.waitForEvent("download",{timeout:20000});
      await copyButton.click();
      await retryDownload;
      await expect(page.getByRole("alert")).toContainText("già presente");
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id),copied,
        "A second attempt must not overwrite a committed CAS record");


      // #142: the staged copy matches only until the live legacy editor writes.
      const inspectButton=page.getByRole("button",{
        name:"Confronta copia IndexedDB (sola lettura)",
      });
      await inspectButton.click();
      await expect(page.getByTestId("cas-inspection-status"))
        .toContainText("identici",{timeout:15000});
      await page.getByLabel("Nome progetto").fill("Legacy changed after initial staging");
      await page.waitForFunction(id=>{
        const slot=localStorage.getItem("softwarefactory.project.library.v1."+id);
        return slot && JSON.parse(slot).config.name === "Legacy changed after initial staging";
      },original.id,{timeout:15000});
      await inspectButton.click();
      await expect(page.getByTestId("cas-inspection-status"))
        .toContainText("DIVERSA",{timeout:15000});
      const exportButton=page.getByRole("button",{
        name:"Esporta copia IndexedDB storica (JSON)",
      });
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.dismiss());
      await exportButton.click();
      await expect(exportButton).toBeVisible();
      page.once("dialog",dlg=>void dlg.accept());
      const exportDownload=page.waitForEvent("download",{timeout:20000});
      await exportButton.click();
      const recoveredDownload=await exportDownload;
      assert.equal(recoveredDownload.suggestedFilename(),
        "softwarefactory-indexeddb-recovery-"+original.id+"-r1.json");
      assert.equal((await readFile(await recoveredDownload.path())).toString("utf8"),
        original.raw,"Recovery download must match historical IndexedDB JSON");
      const legacyNow=await page.evaluate(id=>
        localStorage.getItem("softwarefactory.project.library.v1."+id),original.id);
      assert.notEqual(legacyNow,original.raw,"Export must not revert active legacy project");
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id),copied,
        "Export must not mutate IDB");
      await inspectButton.click();
      await expect(page.getByTestId("cas-inspection-status")).toContainText("rev. 1");
      await page.evaluate(async copied=>{
        const old=JSON.parse(copied.raw);
        await window.FactoryProjectCas.compareAndSwapCasProject({
          ...old,config:{...old.config,name:"Other tab IDB edit"},
        },copied);
      },copied);
      page.once("dialog",dlg=>void dlg.accept());
      await exportButton.click();
      await expect(page.getByRole("alert")).toContainText("cambiata");
      await inspectButton.click();
      await expect(page.getByTestId("cas-inspection-status")).toContainText("rev. 2");
      const reconciliationBuild=await require("esbuild").build({
        entryPoints:[path.join(root,"src/frontend/src/infrastructure/project-cas-reconciliation.ts")],
        bundle:true,write:false,platform:"browser",format:"iife",
        globalName:"FactoryCasReconcile",target:"es2022",
      });
      await page.addScriptTag({content:reconciliationBuild.outputFiles[0].text});
      // Inject the non-UI copy helper in two same-origin pages. Even without
      // Web Locks, the strict readwrite transaction admits only one insert.
      const second=await staging.newPage();
      await second.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      const migrationBuild=await require("esbuild").build({
        entryPoints:[path.join(root,"src/frontend/src/infrastructure/project-cas-migration.ts")],
        bundle:true,write:false,platform:"browser",format:"iife",
        globalName:"FactoryLegacyCasCopy",target:"es2022",
      });
      const migrationBundle=migrationBuild.outputFiles[0].text;
      await Promise.all([page.addScriptTag({content:migrationBundle}),
        second.addScriptTag({content:migrationBundle})]);
      await second.addScriptTag({content:casBundle});
      const rivalId="44444444-4444-4444-8444-444444444444";
      await page.evaluate(id=>localStorage.setItem(
        "softwarefactory.project.library.v1."+id,JSON.stringify({
          id,config:{name:"Both tabs"},stages:[],
          updatedAt:"2026-11-21T10:00:00.000Z",
        })),rivalId);
      const submit=(tab,id)=>tab.evaluate(async id=>{
        const ticket=window.FactoryLegacyCasCopy.prepareLegacyCasCopy(id);
        try {
          return {ok:true,result:await window.FactoryLegacyCasCopy.copyLegacyCasTicket(ticket,true)};
        } catch(error) {return {ok:false,error:String(error)};}
      },id);
      const race=await Promise.all([submit(page,rivalId),submit(second,rivalId)]);
      assert.equal(race.filter(x=>x.ok).length,1,
        "Two independent tabs must not overwrite the same imported project");
      assert.match(race.find(x=>!x.ok).error,/già presente/);
      const staleId="55555555-5555-4555-8555-555555555555";
      const stale=await page.evaluate(id=>{
        const key="softwarefactory.project.library.v1."+id;
        const project={id,config:{name:"Before"},stages:[],
          updatedAt:"2026-11-21T10:00:00.000Z"};
        localStorage.setItem(key,JSON.stringify(project));
        const ticket=window.FactoryLegacyCasCopy.prepareLegacyCasCopy(id);
        localStorage.setItem(key,JSON.stringify({...project,config:{name:"After"}}));
        return ticket;
      },staleId);
      const staleFailure=await second.evaluate(async ticket=>{
        try {await window.FactoryLegacyCasCopy.copyLegacyCasTicket(ticket,true);
          return "unexpected success";}
        catch(error){return String(error);}
      },stale);
      assert.match(staleFailure,/cambiato/);
      assert.equal(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),staleId),null);

      // A tombstone must not be silently resurrected by an old backup.
      const tombId="66666666-6666-4666-8666-666666666666";
      await page.evaluate(async id=>{
        const p={id,config:{name:"Deleted"},stages:[],
          updatedAt:"2026-11-21T10:00:00.000Z"};
        const active=await window.FactoryProjectCas.compareAndSwapCasProject(p,null);
        await window.FactoryProjectCas.deleteCasProject(id,active);
        localStorage.setItem("softwarefactory.project.library.v1."+id,JSON.stringify(p));
      },tombId);
      const tomb=await submit(second,tombId);
      assert.equal(tomb.ok,false);
      assert.match(tomb.error,/già presente/);


      const missingCheck=await page.evaluate(id=>
        window.FactoryCasReconcile.inspectLegacyCasCopy(id),staleId);
      assert.equal(missingCheck.status,"missing","Absent IDB row is not a tombstone");
      const tombCheck=await page.evaluate(id=>
        window.FactoryCasReconcile.inspectLegacyCasCopy(id),tombId);
      assert.equal(tombCheck.status,"tombstone","Deleted IDB row remains a tombstone");
      assert.equal(tombCheck.revision,2);
      const tombExport=await page.evaluate(async id=>{
        try {await window.FactoryCasReconcile.readCasExportSnapshot(id,2);
          return "unexpected success";}
        catch(e){return String(e);}
      },tombId);
      assert.match(tombExport,/cambiata/);
      console.log("FACTORY_INDEXEDDB_RECONCILE_E2E_PASS: equality/divergence, historical export, revision race, missing and tombstone");
      console.log("FACTORY_INDEXEDDB_LEGACY_COPY_E2E_PASS: exact backup, two consents, dual-tab insert race, stale source and tombstone");
    } finally {await staging.close();}
    const context = await browser.newContext({acceptDownloads:true});
    const first = await context.newPage();
    await first.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
    const create1 = first.getByRole("button",{name:"Nuovo progetto"});
    await expect(create1).toBeEnabled({timeout:15000});
    const edit1 = first.getByLabel("Nome progetto");
    await edit1.fill("Tab A holds exclusive writer lease");
    await expect(edit1).toHaveValue("Tab A holds exclusive writer lease");
    const firstId = await first.evaluate(() => {
      const p=JSON.parse(localStorage.getItem("softwarefactory.project.v1") || "{}");
      if (!p.id || p.config?.name !== "Tab A holds exclusive writer lease")
        throw Error("First tab snapshot missing");
      return p.id;
    });

    const second = await context.newPage();
    await second.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
    await expect(second.getByText("Conflitto locale tra schede"))
      .toBeVisible({timeout:15000});
    await expect(second.getByRole("button",{name:"Nuovo progetto"})).toBeEnabled();
    // The writer can keep editing while the rival is blocked, without
    // preventing the rival from creating a DIFFERENT project.
    await first.getByLabel("Nome progetto").fill("Tab A updated while rival waits");
    await expect(second.getByRole("button",{name:"Nuovo progetto"})).toBeEnabled();
    await first.getByLabel("Nome progetto").fill("Tab A holds exclusive writer lease");
    // A stale tab cannot persist a draft even if its text field is editable.
    await second.getByLabel("Nome progetto").fill("Stale tab must not write");
    const guardedName = await second.evaluate(() =>
      JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}").config?.name);
    assert.equal(guardedName, "Tab A holds exclusive writer lease");
    const secondId = await second.evaluate(() =>
      JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}").id);
    assert.equal(secondId,firstId,"The two tabs must refer to the same project");

    // Closing the owner releases the actual Web Lock. The rival tab must
    // explicitly export its stale snapshot before adopting the latest version.
    await first.close();
    const recovery=second.getByRole("button",{name:"Salva backup e carica versione aggiornata"});
    // Declining the first consent must leave the rival tab blocked.
    second.once("dialog",dialog => void dialog.dismiss());
    await recovery.click();
    await expect(second.getByText("Conflitto locale tra schede")).toBeVisible();
    await expect(second.getByRole("button",{name:"Nuovo progetto"})).toBeEnabled();
    let approvals=0;
    second.on("dialog",async dialog => {approvals++;await dialog.accept();});
    const downloadPromise=second.waitForEvent("download",{timeout:20000});
    await second.getByRole("button",{name:"Salva backup e carica versione aggiornata"}).click();
    const downloaded = await downloadPromise;
    assert.match(downloaded.suggestedFilename(),/^softwarefactory-recovery-[a-f0-9-]{36}\.json$/);
    // Download starts BEFORE acquireProjectWriterLease completes. A rival tab
    // may allow creating a DIFFERENT project during contention, so the New
    // project button alone is not proof that takeover has finished.
    await expect(second.getByText("Conflitto locale tra schede"))
      .toBeHidden({timeout:15000});
    await expect(second.getByRole("button",{name:"Nuovo progetto"}))
      .toBeEnabled({timeout:15000});
    await expect(second.getByLabel("Nome progetto"))
      .toHaveValue("Tab A holds exclusive writer lease");
    assert.equal(approvals,2,"Both destructive recovery confirmations are mandatory");
    await second.getByLabel("Nome progetto").fill("Tab B recovered project safely");
    await expect(second.getByLabel("Nome progetto")).toHaveValue("Tab B recovered project safely");
    const persisted = await second.evaluate(() =>
      JSON.parse(localStorage.getItem("softwarefactory.project.v1") || "{}").config?.name);
    assert.equal(persisted,"Tab B recovered project safely");
    const third = await context.newPage();
    await third.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
    await expect(third.getByText("Conflitto locale tra schede")).toBeVisible({timeout:15000});
    // Another tab must be able to work on a DIFFERENT project without stealing
    // or modifying the first project's lease or snapshot.
    await expect(third.getByRole("button",{name:"Nuovo progetto"})).toBeEnabled();
    third.on("dialog",dialog => void dialog.accept());
    await third.getByRole("button",{name:"Nuovo progetto"}).click();
    // The button is already enabled while A is contended; it is not an ACK
    // for the asynchronous lock acquisition and guarded creation of project B.
    await third.waitForFunction(expectedId => {
      const current=JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}").id;
      return typeof current === "string" && current !== expectedId;
    }, firstId, {timeout:15000});
    await expect(third.getByText("Conflitto locale tra schede"))
      .toBeHidden({timeout:15000});
    const newId = await third.evaluate(() =>
      JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}").id);
    assert.notEqual(newId,firstId,"Creating another project must use a separate lease");
    await expect(second.getByLabel("Nome progetto")).toHaveValue("Tab B recovered project safely");
    await context.close();
    console.log("FACTORY_BROWSER_LOCK_E2E_PASS: owner → blocked rival → explicit backup → takeover → concurrent distinct-project editor");

    // Browser-level GitHub import race (#91/#92). No network is enabled:
    // Playwright fulfils each GitHub REST GET with a synthetic checkpoint
    // while the remote HEAD advances during the SECOND human confirmation.
    const importContext = await browser.newContext({acceptDownloads:true});
    try {
      const page = await importContext.newPage();
      await page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await expect(page.getByRole("button",{name:"Nuovo progetto"})).toBeEnabled({timeout:15000});
      await page.getByLabel("Descrizione dell'idea").fill(
        "Application created solely for the GitHub import concurrency browser test.");
      await expect(page.getByLabel("Descrizione dell'idea"))
        .toHaveValue("Application created solely for the GitHub import concurrency browser test.");
      const before = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("softwarefactory.project.v1") || "{}"));
      assert.match(before.id,/^[0-9a-f-]{36}$/i);
      const remoteProject = {
        id:before.id, createdAt:before.createdAt, updatedAt:before.updatedAt,
        config:{...before.config,name:"Remote checkpoint that must NOT be imported"},
        stages:before.stages,
        ...(before.development ? {development: {
          revision:before.development.revision,
          overrides:before.development.overrides,
          originals:before.development.originals,
          history:before.development.history,
        }} : {}),
      };
      const checkpoint=JSON.stringify({
        schemaVersion:1,kind:"softwarefactory-workspace",project:remoteProject,
      })+"\n";
      const encoded=Buffer.from(checkpoint,"utf8").toString("base64");
      const initialSha="a".repeat(40),advancedSha="f".repeat(40);
      const pat="github_pat_"+"x".repeat(50);
      await page.evaluate(token => {
        const settings=JSON.parse(localStorage.getItem("softwarefactory.settings.v1") || "{}");
        settings.git={owner:"octocat",repo:"demo",branch:"main",
          privateRepo:true,authMode:"pat",appGateway:""};
        settings.githubAutoSync=false;
        localStorage.setItem("softwarefactory.settings.v1",JSON.stringify(settings));
        sessionStorage.setItem("softwarefactory.secret.github.pat",token);
      },pat);
      let headReads=0,restCalls=0;
      await page.route("https://api.github.com/repos/octocat/demo/**",async route => {
        const request=route.request(),url=request.url();
        // Authorization/X-GitHub-Api-Version can cause a browser CORS preflight.
        // Respond to OPTIONS without treating it as a GitHub write.
        if (request.method()==="OPTIONS") {
          await route.fulfill({status:204,headers:{
            "access-control-allow-origin":"*","access-control-allow-methods":"GET, OPTIONS",
            "access-control-allow-headers":"authorization, x-github-api-version, accept, content-type",
          }});
          return;
        }
        assert.equal(request.method(),"GET","Import may not write to GitHub");
        restCalls++;
        let body;
        if (url.endsWith("/repos/octocat/demo/git/ref/heads/main")) {
          headReads++;
          body={object:{sha:headReads>=3 ? advancedSha : initialSha}};
        } else if (url.includes("/repos/octocat/demo/contents/.softwarefactory/workspace-state.v1.json?ref="+initialSha)) {
          body={type:"file",encoding:"base64",size:Buffer.byteLength(checkpoint,"utf8"),content:encoded};
        } else throw Error("Unexpected GitHub import route: "+url);
        await route.fulfill({status:200,headers:{"access-control-allow-origin":"*",
          "content-type":"application/json"},body:JSON.stringify(body)});
      });
      await page.reload({waitUntil:"networkidle"});
      await expect(page.getByRole("button",{name:"Nuovo progetto"})).toBeEnabled({timeout:15000});
      await page.getByTitle("Impostazioni").click();
      const importButton=page.getByRole("button",{name:"Importa checkpoint GitHub"});
      await expect(importButton).toBeEnabled({timeout:15000});
      let confirmCount=0;
      page.on("dialog",dialog => {confirmCount++;void dialog.accept();});
      const backupPromise=page.waitForEvent("download",{timeout:10000}).catch(async () => {
        const alerts=await page.getByRole("alert").allTextContents();
        throw Error("No import backup; HEAD GETs="+headReads+
          " GitHub GETs="+restCalls+" confirmations="+confirmCount+
          " alerts="+JSON.stringify(alerts.map(x=>x.slice(0,200))));
      });
      await importButton.click();
      const backup=await backupPromise;
      assert.match(backup.suggestedFilename(),/^softwarefactory-recovery-[a-f0-9-]{36}\.json$/);
      await expect(page.getByRole("alert")).toContainText("HEAD avanzata",{timeout:15000});
      const after=await page.evaluate(() =>
        JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}"));
      assert.equal(after.config.name,before.config.name,"A stale import must not overwrite local work");
      assert.equal(after.updatedAt,before.updatedAt);
      assert.equal(after.githubSync?.lastCommit,before.githubSync?.lastCommit);
      assert.equal(headReads,3,"HEAD should be checked on read, after fetch, and after human approval");
      assert.equal(restCalls,4,"Only three HEAD GETs and one checkpoint GET should occur");
      assert.equal(confirmCount,2,"Both destructive import confirmations must be accepted before the race guard");
      console.log("FACTORY_GITHUB_IMPORT_RACE_E2E_PASS: synthetic GitHub GETs → approved backup → remote HEAD advance → local snapshot unchanged");
    } finally {
      await importContext.close();
    }

    // Browser-level reconciliation of a lost GitHub push acknowledgement (#91).
    // Build expected Git blob IDs using the REAL scaffold generator: a matching
    // checkpoint alone cannot validate arbitrary remote source contents.
    const recoveryContext=await browser.newContext({acceptDownloads:true});
    try {
      const page=await recoveryContext.newPage();
      await page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await expect(page.getByRole("button",{name:"Nuovo progetto"}))
        .toBeEnabled({timeout:15000});
      await page.getByLabel("Descrizione dell'idea").fill(
        "Valid fully generated fixture for a real Chromium lost GitHub commit acknowledgement test.");
      await expect(page.getByLabel("Descrizione dell'idea"))
        .toHaveValue("Valid fully generated fixture for a real Chromium lost GitHub commit acknowledgement test.");
      const before=await page.evaluate(() =>
        JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}"));
      const fixture=spawnSync("node",[
        path.join(root,"src/frontend/node_modules/tsx/dist/cli.mjs"),
        path.join(root,"src/runner/scripts/github-ack-browser-fixture.ts"),
      ],{input:JSON.stringify(before),encoding:"utf8",maxBuffer:2_000_000,timeout:20000});
      if(fixture.status!==0)
        throw Error("Unable to compute actual generated Git fixture: "+
          String(fixture.stderr||fixture.error||fixture.status).slice(0,600));
      const {checkpoint,tree}=JSON.parse(fixture.stdout);
      assert.ok(tree.length>20,"Reconciliation must validate real application source files");
      const remoteSha="d".repeat(40),parentSha="a".repeat(40),treeSha="b".repeat(40);
      const pat="github_pat_"+"y".repeat(50);
      await page.evaluate(token => {
        const settings=JSON.parse(localStorage.getItem("softwarefactory.settings.v1")||"{}");
        settings.git={owner:"octocat",repo:"demo",branch:"main",
          privateRepo:true,authMode:"pat",appGateway:""};
        settings.githubAutoSync=false;
        localStorage.setItem("softwarefactory.settings.v1",JSON.stringify(settings));
        sessionStorage.setItem("softwarefactory.secret.github.pat",token);
      },pat);
      let tampered=true,headReads=0,restReads=0,writeCalls=0;
      await page.route("https://api.github.com/repos/octocat/demo**",async route => {
        const request=route.request(),url=new URL(request.url());
        if(request.method()==="OPTIONS") {
          await route.fulfill({status:204,headers:{
            "access-control-allow-origin":"*",
            "access-control-allow-methods":"GET, OPTIONS",
            "access-control-allow-headers":"authorization, x-github-api-version, accept, content-type",
          }});
          return;
        }
        if(request.method()!=="GET") {
          writeCalls++;
          await route.fulfill({status:405,headers:{"access-control-allow-origin":"*"}});
          return;
        }
        restReads++;
        let body;
        if(url.pathname==="/repos/octocat/demo/git/ref/heads/main") {
          headReads++;
          body={object:{sha:remoteSha}};
        } else if(url.pathname==="/repos/octocat/demo/contents/.softwarefactory/workspace-state.v1.json" &&
          url.searchParams.get("ref")===remoteSha) {
          body={type:"file",encoding:"base64",size:Buffer.byteLength(checkpoint,"utf8"),
            content:Buffer.from(checkpoint,"utf8").toString("base64")};
        } else if(url.pathname==="/repos/octocat/demo/git/commits/"+remoteSha) {
          body={sha:remoteSha,parents:[{sha:parentSha}],tree:{sha:treeSha}};
        } else if(url.pathname==="/repos/octocat/demo/git/trees/"+treeSha &&
          url.searchParams.get("recursive")==="1") {
          body={truncated:false,tree:tampered ?
            tree.map(entry=>entry.path==="README.md" ?
              {...entry,sha:"f".repeat(40)} : entry) : tree};
        } else if(url.pathname==="/repos/octocat/demo") {
          body={owner:{login:"octocat"},name:"demo",private:true,
            default_branch:"main",archived:false,disabled:false,permissions:{push:true}};
        } else throw Error("Unexpected GitHub recovery REST request: "+url.href);
        await route.fulfill({status:200,headers:{"access-control-allow-origin":"*",
          "content-type":"application/json"},body:JSON.stringify(body)});
      });
      await page.reload({waitUntil:"networkidle"});
      await expect(page.getByRole("button",{name:"Nuovo progetto"}))
        .toBeEnabled({timeout:15000});
      await page.getByTitle("Impostazioni").click();
      const recover=page.getByRole("button",{name:"Recupera conferma commit"});
      await expect(recover).toBeEnabled({timeout:15000});
      // Refusing the initial consent must NOT even read remote GitHub.
      page.once("dialog",dialog=>void dialog.dismiss());
      await recover.click();
      assert.equal(restReads,0,"User-declined recovery must not contact GitHub");
      let approvals=0;
      page.on("dialog",dialog=>{approvals++;void dialog.accept();});
      await recover.click();
      await expect(page.getByRole("alert")).toContainText(
        "Contenuto dei file GitHub diverso",{timeout:15000});
      const rejected=await page.evaluate(() =>
        JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}"));
      assert.equal(rejected.githubSync?.lastCommit,undefined,
        "One corrupted source blob must reject acknowledgement");
      assert.equal(rejected.config.description,before.config.description);
      assert.equal(approvals,1,"Tampered tree must fail before the final confirmation");
      tampered=false;
      await recover.click();
      await expect(page.getByText("Conferma locale recuperata per il commit",{exact:false}))
        .toBeVisible({timeout:20000});
      await page.waitForFunction(sha =>
        JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}")
          .githubSync?.lastCommit===sha,remoteSha,{timeout:15000});
      const saved=await page.evaluate(() => ({
        project:JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}"),
        settings:JSON.parse(localStorage.getItem("softwarefactory.settings.v1")||"{}"),
      }));
      assert.equal(saved.project.id,before.id);
      assert.equal(saved.project.updatedAt,before.updatedAt,
        "Recovery must never claim generated source contents changed");
      assert.deepEqual(saved.project.config,before.config);
      assert.deepEqual(saved.project.stages,before.stages);
      assert.equal(saved.project.githubSync.syncedLocalUpdatedAt,before.updatedAt);
      assert.equal(saved.project.githubSync.publicConsent,false,
        "Recovering a private repo cannot create future public publish consent");
      assert.equal(saved.settings.githubAutoSync,false,
        "Recovery must not silently enable GitHub autosync");
      assert.equal(approvals,3,"Recovery success requires TWO explicit confirmations");
      assert.equal(headReads,4,
        "Failed tree: one HEAD; successful recovery: initial, verify and post-confirmation");
      assert.equal(writeCalls,0,"Lost-ack reconciliation is strictly read-only");
      assert.ok(restReads>=10,"Real commit, tree, checkpoint, repo and HEAD must all be fetched");
      await page.reload({waitUntil:"networkidle"});
      const afterReload=await page.evaluate(() =>
        JSON.parse(localStorage.getItem("softwarefactory.project.v1")||"{}"));
      assert.equal(afterReload.githubSync.lastCommit,remoteSha,
        "Acknowledgement must survive reload, with no implicit GitHub write");
      assert.equal(afterReload.updatedAt,before.updatedAt);
      assert.equal(writeCalls,0);
      console.log("FACTORY_GITHUB_ACK_BROWSER_E2E_PASS: refused → corrupted Git blob blocked → exact source tree recovered → reload preserved, GET only");
    } finally {
      await recoveryContext.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
