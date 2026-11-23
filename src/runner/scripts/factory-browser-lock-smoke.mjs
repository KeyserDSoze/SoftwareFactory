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
  const { unzipSync, strFromU8 } = require("fflate");
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
    const legacyStoreBuild = await require("esbuild").build({
      entryPoints:[path.join(root,"src/frontend/src/infrastructure/store.ts")],
      bundle:true,write:false,platform:"browser",format:"iife",
      globalName:"FactoryLegacyStore",target:"es2022",
    });
    const legacyStoreBundle=legacyStoreBuild.outputFiles[0].text;

    // #167: root workspace routing must choose the CAS-only React tree BEFORE
    // the live LegacyFactoryApp can initialize its project, writer lock,
    // GitHub autosync, OAuth callback or CodeAgentPanel.
    const standaloneContext=await browser.newContext({acceptDownloads:true});
    try {
      await standaloneContext.addInitScript(()=>{
        // A malformed legacy pointer AND an unowned legacy library slot
        // must remain byte-identical during all CAS-only operations. This
        // settings value would start autosync in a mounted LegacyFactoryApp.
        localStorage.setItem("softwarefactory.project.v1",
          "{CORRUPT_LEGACY_POINTER_CAS_ROOT_167");
        localStorage.setItem(
          "softwarefactory.project.library.v1."+
            "11111111-1111-4111-8111-111111111111",
          "LEGACY_LIBRARY_UNTOUCHED_167");
        localStorage.setItem("softwarefactory.settings.v1",JSON.stringify({
          language:"en",githubAutoSync:true,
        }));
      });
      const page=await standaloneContext.newPage();
      await page.goto("http://127.0.0.1:4174/?workspace=cas",
        {waitUntil:"networkidle"});
      const legacyBefore=await page.evaluate(()=>({
        pointer:localStorage.getItem("softwarefactory.project.v1"),
        slot:localStorage.getItem(
          "softwarefactory.project.library.v1."+
          "11111111-1111-4111-8111-111111111111"),
        settings:localStorage.getItem("softwarefactory.settings.v1"),
        index:localStorage.getItem("softwarefactory.project.index.v1"),
      }));
      await expect(page.getByTestId("cas-root-shell")).toBeVisible();
      await expect(page.getByTestId("cas-root-disclaimer"))
        .toContainText("Exclusive IndexedDB workspace");
      assert.equal(await page.getByRole("button",{name:"New project"}).count(),0,
        "CAS root may not mount legacy New Project writer");
      assert.equal(await page.getByTestId("cas-root-entry").count(),0,
        "CAS root must not mount LegacyFactoryApp");
      assert.equal(await page.getByTestId("cas-isolated-editor").count(),1);
      assert.equal(await page.getByTestId("background-task-toast").count(),0);
      const initialDatabases=await page.evaluate(async()=>
        (await indexedDB.databases()).map(x=>x.name));
      assert.equal(initialDatabases.includes("softwarefactory.project.cas.v1"),
        false,"CAS root may not open IndexedDB before human opens panel");
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{
        name:"Open separate IndexedDB editor",
      }).click();
      await expect(panel.getByTestId("cas-isolated-create")).toBeVisible();
      const form=panel.getByTestId("cas-isolated-create");
      await form.locator("input").fill("CAS-only native project 167");
      await form.locator("textarea")
        .fill("No legacy project was initialized before this CAS insert");
      page.once("dialog",dialog=>void dialog.accept());
      await form.getByRole("button",{
        name:"Create NEW IndexedDB-only project",
      }).click();
      await expect(panel.getByTestId("cas-isolated-library"))
        .toContainText("CAS-only native project 167",{timeout:15000});
      await page.addScriptTag({content:casBundle});
      const created=await page.evaluate(()=>
        window.FactoryProjectCas.listCasProjects());
      assert.equal(created.length,1);
      assert.equal(created[0].revision,1);
      const stored=await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),created[0].id);
      assert.equal(JSON.parse(stored.raw).config.name,
        "CAS-only native project 167");

      // #168: real CAS-root stack composer. A previously completed stage
      // must become pending after an explicitly backed-up stack change.
      const withStage=await page.evaluate(async expected=>{
        const p=JSON.parse(expected.raw);
        p.stages[0].status="complete";
        p.stages[0].output="PRE_STACK_HISTORICAL_UNVERIFIED_168";
        p.stages[0].completionOrigin="manual";
        return await window.FactoryProjectCas.compareAndSwapCasProject(
          p,expected);
      },stored);
      await panel.getByRole("button",{
        name:/Refresh IndexedDB library/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await panel.getByRole("button",{
        name:"Open IDB copy: CAS-only native project 167",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 2");
      const stack=panel.getByTestId("cas-isolated-full-stack");
      await stack.locator("summary").click();
      await stack.getByTestId("cas-isolated-stack-frontend-react-native")
        .check();
      await stack.getByTestId("cas-isolated-stack-frontend-react")
        .uncheck();
      await stack.getByTestId("cas-isolated-stack-deployment")
        .selectOption("aws");
      await stack.getByTestId("cas-isolated-stack-dotnet")
        .selectOption("10.0");
      await stack.getByTestId("cas-isolated-stack-database")
        .selectOption("mysql");
      await stack.getByTestId("cas-isolated-stack-database-production")
        .selectOption("aws-rds");
      await stack.getByTestId("cas-isolated-stack-cache-development")
        .selectOption("redis");
      await expect(stack.getByTestId("cas-isolated-stack-dirty"))
        .toBeVisible();
      const stackSave=panel.getByRole("button",{
        name:"Save IndexedDB edit with backup",
      });
      await expect(stackSave).toBeEnabled();
      // Explicitly declining backup consent means no revision change.
      page.once("dialog",dialog=>void dialog.dismiss());
      await stackSave.click();
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),created[0].id),
        withStage);
      let editConsents=0;
      const approveStack=async dialog=>{
        editConsents++;
        await dialog.accept();
      };
      page.on("dialog",approveStack);
      const sourceBackup=page.waitForEvent("download");
      await stackSave.click();
      const file=await sourceBackup;
      assert.equal(file.suggestedFilename(),
        "softwarefactory-cas-before-edit-"+created[0].id+"-r2.json");
      assert.equal((await readFile(await file.path())).toString("utf8"),
        withStage.raw,"CAS stack backup must match byte-exact source rev");
      assert.equal(editConsents,2);
      page.off("dialog",approveStack);
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 3");
      const edited=await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),created[0].id);
      const savedStack=JSON.parse(edited.raw);
      assert.deepEqual(savedStack.config.frontends,["react-native"]);
      assert.equal(savedStack.config.deployment,"aws");
      assert.equal(savedStack.config.dotnetVersion,"10.0");
      assert.equal(savedStack.config.database,"mysql");
      assert.equal(savedStack.config.services.database.production,"aws-rds");
      assert.equal(savedStack.config.services.cache.development,"redis");
      assert.ok(savedStack.stages.every(stage=>stage.status==="pending" &&
        stage.output==="" && !stage.completionOrigin));
      assert.ok(!edited.raw.includes("PRE_STACK_HISTORICAL_UNVERIFIED_168"));

      // Rival noncooperating writer updates this same ID during the SECOND
      // human consent. An obsolete native CAS stack draft must be retained
      // on-screen; no stale overwrite, merge or automatic retry.
      const rival=await standaloneContext.newPage();
      await rival.goto("http://127.0.0.1:4174/?workspace=cas",
        {waitUntil:"networkidle"});
      await rival.addScriptTag({content:casBundle});
      await stack.getByTestId("cas-isolated-stack-deployment")
        .selectOption("gcp");
      let raceDialogs=0,winner=null;
      page.on("dialog",async dialog=>{
        raceDialogs++;
        if(raceDialogs===2){
          winner=await rival.evaluate(async expected=>{
            const p=JSON.parse(expected.raw);
            p.config.description="RIVAL_STACK_168_WINNER";
            return await window.FactoryProjectCas.compareAndSwapCasProject(
              p,expected);
          },edited);
        }
        await dialog.accept();
      });
      const racedBackup=page.waitForEvent("download");
      await stackSave.click();
      assert.equal((await readFile(await (await racedBackup).path()))
        .toString("utf8"),edited.raw);
      await expect(panel.getByRole("alert"))
        .toContainText("IndexedDB operation not confirmed");
      assert.equal(raceDialogs,2);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),created[0].id),winner);
      await expect(stack.getByTestId("cas-isolated-stack-deployment"))
        .toHaveValue("gcp");
      await expect(stack.getByTestId("cas-isolated-stack-dirty"))
        .toBeVisible();
      assert.ok(!winner.raw.includes('"deployment":"gcp"'),
        "Rejected human draft is not silently accepted in DB");
      page.removeAllListeners("dialog");
      console.log("FACTORY_INDEXEDDB_FULL_STACK_EDIT_E2E_PASS: CAS-only composer edits complete stack, exact JSON backup + 2 consents, source rev and stage evidence invalidation, rival wins second consent without overwriting human draft or legacy");

      assert.deepEqual(await page.evaluate(()=>({
        pointer:localStorage.getItem("softwarefactory.project.v1"),
        slot:localStorage.getItem(
          "softwarefactory.project.library.v1."+
          "11111111-1111-4111-8111-111111111111"),
        settings:localStorage.getItem("softwarefactory.settings.v1"),
        index:localStorage.getItem("softwarefactory.project.index.v1"),
      })),legacyBefore,
        "CAS-only root must not repair or overwrite any legacy slot/settings");
      await page.reload({waitUntil:"networkidle"});
      await expect(page.getByTestId("cas-root-shell")).toBeVisible();
      assert.equal(await page.getByTestId("cas-root-entry").count(),0);
      await expect(page.getByTestId("cas-root-disclaimer"))
        .toContainText("NOT the complete cutover");
    } finally {
      await standaloneContext.close();
    }

    // A guided transition from the ACTUAL live editor exports recoverable
    // legacy JSON with 3 consents, rechecks the persisted raw after all
    // dialogs and forces a full document reload into the disjoint CAS root.
    const transitionContext=await browser.newContext({acceptDownloads:true});
    try {
      const page=await transitionContext.newPage();
      await page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await expect(page.getByRole("button",{name:"Nuovo progetto"}))
        .toBeEnabled({timeout:15000});
      const entry=page.getByTestId("cas-root-enter-action");
      await expect(entry).toBeEnabled({timeout:15000});
      const legacyRaw=await page.evaluate(()=>{
        const active=JSON.parse(localStorage.getItem(
          "softwarefactory.project.v1")||"{}");
        return localStorage.getItem(
          "softwarefactory.project.library.v1."+active.id);
      });
      assert.ok(legacyRaw,"Live editor must have confirmed persistence");
      page.once("dialog",dialog=>void dialog.dismiss());
      await entry.click();
      assert.equal(new URL(page.url()).searchParams.get("workspace"),null);

      const prompts=[];
      page.on("dialog",async dialog=>{
        prompts.push(dialog.message());
        await dialog.accept();
      });
      const backupDownload=page.waitForEvent("download");
      const switched=page.waitForURL(u=>
        new URL(u).searchParams.get("workspace")==="cas",{timeout:15000});
      await entry.click();
      const backup=await backupDownload;
      await switched;
      assert.equal(prompts.length,3,
        "Entering CAS root requires backup, disk save, final mode consent");
      assert.match(prompts[0],/backup JSON/i);
      assert.match(prompts[1],/SALVATO/);
      assert.match(prompts[2],/ULTIMA CONFERMA/);
      const backupDoc=JSON.parse(
        (await readFile(await backup.path())).toString("utf8"));
      assert.equal(JSON.stringify(backupDoc.project),legacyRaw);
      await expect(page.getByTestId("cas-root-shell")).toBeVisible();
      assert.equal(await page.getByRole("button",{name:"Nuovo progetto"}).count(),0);
      assert.equal(await page.getByTestId("cas-root-entry").count(),0);
      assert.equal(await page.evaluate(()=>{
        const active=JSON.parse(localStorage.getItem(
          "softwarefactory.project.v1")||"{}");
        return localStorage.getItem(
          "softwarefactory.project.library.v1."+active.id);
      }),legacyRaw,"Mode switch must not silently migrate or replace legacy");
      page.removeAllListeners("dialog");
      const casEditor=page.getByTestId("cas-isolated-editor");
      await casEditor.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      const returnAction=casEditor.getByTestId("cas-root-return-action");
      await expect(returnAction).toBeEnabled();
      page.once("dialog",dialog=>void dialog.accept());
      const returned=page.waitForURL(u=>
        new URL(u).searchParams.get("workspace")===null,{timeout:15000});
      await returnAction.click();
      await returned;
      await expect(page.getByTestId("cas-root-entry")).toBeVisible();
      await expect(page.getByRole("button",{name:"Nuovo progetto"}))
        .toBeEnabled({timeout:15000});
      const afterReturn=await page.evaluate(()=>{
        const active=JSON.parse(localStorage.getItem(
          "softwarefactory.project.v1")||"{}");
        return localStorage.getItem(
          "softwarefactory.project.library.v1."+active.id);
      });
      assert.equal(afterReturn,legacyRaw);
      console.log("FACTORY_INDEXEDDB_STANDALONE_ROOT_E2E_PASS: CAS-only root skips legacy project/init/autosync, IDB native create while corrupt legacy untouched, reload, guided JSON backup + 3 consents, full reload and explicit legacy return");
    }finally{
      await transitionContext.close();
    }

    // #171: assisted legacy→CAS-only project transfer. A real live SPA
    // produces an exact per-ID backup, native insert-only IDB copy and
    // full page reload with only an ID/rev/SHA-256 URL hint. The CAS page
    // does not open the copy until a SECOND explicit operator decision.
    const handoffContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await handoffContext.newPage();
      await page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await expect(page.getByRole("button",{name:"Nuovo progetto"}))
        .toBeEnabled({timeout:15000});
      await page.addScriptTag({content:casBundle});
      const original=await page.evaluate(()=>{
        const active=JSON.parse(localStorage.getItem(
          "softwarefactory.project.v1")||"{}");
        const raw=localStorage.getItem(
          "softwarefactory.project.library.v1."+active.id);
        return {id:active.id,raw,
          settings:localStorage.getItem("softwarefactory.settings.v1")};
      });
      assert.ok(original.raw && original.id);
      const backupRaw=JSON.parse(original.raw);
      const assisted=page.getByTestId("cas-root-handoff-start");
      await expect(assisted).toBeEnabled();
      assert.equal((await page.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),original.id)).state,
        "missing");
      page.once("dialog",d=>void d.dismiss());
      await assisted.click();
      assert.equal(new URL(page.url()).searchParams.get("workspace"),null);
      assert.equal((await page.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),original.id)).state,
        "missing");
      let consents=0;
      const approve=async d=>{consents++;await d.accept();};
      page.on("dialog",approve);
      const backupEvent=page.waitForEvent("download");
      const navigation=page.waitForURL(u=>
        new URL(u).searchParams.get("workspace")==="cas" &&
        new URL(u).searchParams.get("casHandoff")===original.id,
        {timeout:15000});
      await assisted.click();
      const sourceBackup=await backupEvent;
      await navigation;
      assert.equal(sourceBackup.suggestedFilename(),
        "softwarefactory-before-cas-handoff-"+original.id+".json");
      assert.equal((await readFile(await sourceBackup.path()))
        .toString("utf8"),original.raw,
        "Assisted migration backup must be exact pre-insert per-ID source raw");
      assert.equal(consents,3);
      page.removeAllListeners("dialog");
      const casHref=page.url(),hint=new URL(casHref);
      assert.equal(hint.searchParams.get("casRevision"),"1");
      assert.match(hint.searchParams.get("casDigest"),/^[0-9a-f]{64}$/);
      assert.equal(casHref.includes("source\""),false);
      await expect(page.getByTestId("cas-root-shell")).toBeVisible();
      await expect(page.getByTestId("cas-root-handoff-hint"))
        .toContainText(original.id);
      assert.equal(await page.getByTestId("cas-root-entry").count(),0);
      assert.equal(await page.getByTestId("cas-isolated-active").count(),0,
        "A URL hint alone must NOT auto-select the IDB project");
      assert.equal(await page.getByRole("button",{
        name:"Nuovo progetto",
      }).count(),0);
      await page.addScriptTag({content:casBundle});
      const native=await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id);
      assert.equal(native.revision,1);
      assert.equal(native.raw,original.raw,
        "Handoff must preserve exact historical raw, no sanitizing claims");
      assert.equal(JSON.stringify(JSON.parse(native.raw).config),
        JSON.stringify(backupRaw.config));
      const retired=await page.evaluate(id=>localStorage.getItem(
        "softwarefactory.cas.retired.v1."+id),original.id);
      assert.deepEqual(JSON.parse(retired),{
        schema:1,id:original.id,digest:hint.searchParams.get("casDigest"),
      },"Durable legacy retirement marker must exist for the CAS handoff");
      const handoffOpen=page.getByTestId("cas-root-handoff-open");
      await expect(handoffOpen).toBeEnabled();
      // The hinted open is asynchronous: wait for the ONE dialog to be
      // handled before attempting another click. Otherwise a stale one-shot
      // dismiss listener can race a new accept listener on the same dialog.
      const cancelledDialog=page.waitForEvent("dialog",{timeout:15000});
      const cancelledClick=handoffOpen.click();
      await (await cancelledDialog).dismiss();
      await cancelledClick;
      await expect(handoffOpen).toBeEnabled();
      assert.equal(await page.getByTestId("cas-isolated-active").count(),0);
      const acceptedDialog=page.waitForEvent("dialog",{timeout:15000});
      const acceptedClick=handoffOpen.click();
      await (await acceptedDialog).accept();
      await acceptedClick;
      await expect(page.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      await expect(page.getByTestId("cas-isolated-active"))
        .toContainText(original.id);
      const copiedName=JSON.parse(original.raw).config.name;
      await expect(page.getByTestId("cas-isolated-active").locator("input")
        .first()).toHaveValue(copiedName);
      assert.equal(await page.evaluate(id=>
        localStorage.getItem(
          "softwarefactory.project.library.v1."+id),original.id),
        original.raw,"CAS handoff may not change legacy authoritative slot");
      // Explicit return to legacy strips ALL three untrusted hint fields.
      page.once("dialog",d=>void d.accept());
      const returned=page.waitForURL(u=>{
        const x=new URL(u);
        return !x.searchParams.has("workspace") &&
          !x.searchParams.has("casHandoff") &&
          !x.searchParams.has("casRevision") &&
          !x.searchParams.has("casDigest");
      },{timeout:15000});
      await page.getByTestId("cas-root-return-action").click();
      await returned;
      await expect(page.getByTestId("cas-root-entry")).toBeVisible();
      await expect(page.getByTestId("cas-legacy-retired-banner"))
        .toContainText("Progetto legacy protetto");
      await expect(page.getByPlaceholder("Es. Legal Research Platform"))
        .toBeDisabled();
      assert.equal(await page.evaluate(id=>
        localStorage.getItem(
          "softwarefactory.project.library.v1."+id),original.id),
        original.raw,"Returning to legacy must not auto-merge CAS source");
      // Another browser tab running the CURRENT cooperating store API
      // must not overwrite the historical legacy source.
      const oldWriter=await handoffContext.newPage();
      await oldWriter.goto("http://127.0.0.1:4174/",
        {waitUntil:"networkidle"});
      await expect(oldWriter.getByTestId("cas-legacy-retired-banner"))
        .toBeVisible();
      await oldWriter.addScriptTag({content:legacyStoreBundle});
      const refused=await oldWriter.evaluate(id=>{
        const slot="softwarefactory.project.library.v1."+id;
        const raw=localStorage.getItem(slot),project=JSON.parse(raw);
        project.config.name="FORBIDDEN_LEGACY_WRITE_173";
        try {
          window.FactoryLegacyStore.persistProject(project);
          return {blocked:false,current:localStorage.getItem(slot)};
        }catch{
          return {blocked:true,current:localStorage.getItem(slot)};
        }
      },original.id);
      assert.equal(refused.blocked,true);
      assert.equal(refused.current,original.raw);
      assert.equal(await page.evaluate(id=>localStorage.getItem(
        "softwarefactory.cas.retired.v1."+id),original.id),retired);
      await oldWriter.close();

      // #175: a retired legacy source can create a NEW native CAS-only
      // configuration fork. The old legacy slot and same-ID IDB copy stay
      // untouched. A second CAS tab races us during human final consent.
      const nativeCleanFork=page.getByTestId("cas-retired-native-fork-start");
      await expect(nativeCleanFork).toBeEnabled();
      page.once("dialog",d=>void d.dismiss());
      await nativeCleanFork.click();
      assert.equal(new URL(page.url()).searchParams.get("workspace"),null,
        "Dismissing native clean fork must not switch root");
      const nativeRival=await handoffContext.newPage();
      await nativeRival.goto("http://127.0.0.1:4174/?workspace=cas",
        {waitUntil:"networkidle"});
      await nativeRival.addScriptTag({content:casBundle});
      let nativeRaceDialogs=0, nativeReservedId=null;
      let nativeReservedSnapshot=null;
      page.on("dialog",async d=>{
        nativeRaceDialogs++;
        if(nativeRaceDialogs===3){
          const match=d.message().match(/NEW ID: ([0-9a-f-]{36})/i);
          assert.ok(match,"New CAS fork consent must display fresh UUID");
          nativeReservedId=match[1];
          const rivalProject=JSON.parse(original.raw);
          rivalProject.id=nativeReservedId;
          rivalProject.config.name="RIVAL_NATIVE_IDB_FORK_175";
          nativeReservedSnapshot=await nativeRival.evaluate(async raw=>{
            const candidate=JSON.parse(raw);
            return window.FactoryProjectCas.compareAndSwapCasProject(
              candidate,null);
          },JSON.stringify(rivalProject));
        }
        await d.accept();
      });
      const nativeRaceBackup=page.waitForEvent("download");
      await nativeCleanFork.click();
      const racedBackup=await nativeRaceBackup;
      assert.equal(racedBackup.suggestedFilename(),
        "softwarefactory-before-native-clean-fork-"+original.id+".json");
      assert.equal((await readFile(await racedBackup.path()))
        .toString("utf8"),original.raw,
        "Native clean fork must offer exact source JSON even on target race");
      await expect(page.locator(".alert.error"))
        .toContainText(/Nuova copia CAS non confermata/i);
      assert.equal(nativeRaceDialogs,3);
      assert.deepEqual(await nativeRival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),nativeReservedId),
        nativeReservedSnapshot,
        "Native rival must win collision: no overwrite");
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.project.library.v1."+id),
        original.id),original.raw);
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.cas.retired.v1."+id),
        original.id),retired);
      page.removeAllListeners("dialog");
      await nativeRival.close();

      // New independent recovery attempt: source is still read-only and
      // still pinned; native IDB gets a fresh UUID on three consents.
      let nativeConsents=0;
      page.on("dialog",async d=>{nativeConsents++;await d.accept();});
      const nativeBackup=page.waitForEvent("download");
      const nativeNavigation=page.waitForURL(u=>{
        const url=new URL(u);
        return url.searchParams.get("workspace")==="cas" &&
          url.searchParams.has("casHandoff") &&
          url.searchParams.get("casHandoff")!==original.id &&
          url.searchParams.get("casHandoff")!==nativeReservedId;
      },{timeout:20000});
      await nativeCleanFork.click();
      const nativeFile=await nativeBackup;
      await nativeNavigation;
      page.removeAllListeners("dialog");
      const nativeHint=new URL(page.url());
      const nativeNewId=nativeHint.searchParams.get("casHandoff");
      assert.ok(nativeNewId);
      assert.equal(nativeHint.searchParams.get("casRevision"),"1");
      assert.match(nativeHint.searchParams.get("casDigest"),/^[0-9a-f]{64}$/);
      assert.equal(nativeConsents,3);
      assert.equal((await readFile(await nativeFile.path()))
        .toString("utf8"),original.raw,
        "Native clean fork still requires exact original raw backup");
      await expect(page.getByTestId("cas-root-shell")).toBeVisible();
      await expect(page.getByTestId("cas-root-handoff-hint"))
        .toContainText(nativeNewId);
      assert.equal(await page.getByTestId("cas-isolated-active").count(),0,
        "Native clean fork hint must NOT auto-select new CAS project");
      await page.addScriptTag({content:casBundle});
      const nativeClean=await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),nativeNewId);
      assert.equal(nativeClean.revision,1);
      const nativeCleanBody=JSON.parse(nativeClean.raw);
      assert.notEqual(nativeCleanBody.id,original.id);
      assert.notEqual(nativeCleanBody.id,nativeReservedId);
      assert.deepEqual(nativeCleanBody.config,{
        ...JSON.parse(original.raw).config,
        name:JSON.parse(original.raw).config.name+" (recovery)",
      });
      assert.deepEqual(nativeCleanBody.stages,
        JSON.parse(original.raw).stages.map(s=>({
          id:s.id,label:s.label,status:"pending",output:"",sources:[],
        })));
      assert.deepEqual(Object.keys(nativeCleanBody).sort(),[
        "config","createdAt","id","stages","updatedAt"]);
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.project.library.v1."+id),
        nativeNewId),null,
        "New native CAS fork must NEVER persist a legacy target");
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.project.library.v1."+id),
        original.id),original.raw,
        "Native recovery must preserve old legacy source");
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.cas.retired.v1."+id),
        original.id),retired);
      assert.equal((await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id)).raw,
        native.raw,"Historical native same-ID CAS row unchanged");

      // Only a second explicit user approval opens the new CAS revision.
      const openClean=page.getByTestId("cas-root-handoff-open");
      const openNativeDialog=page.waitForEvent("dialog",{timeout:15000});
      const openNativeClick=openClean.click();
      await (await openNativeDialog).accept();
      await openNativeClick;
      await expect(page.getByTestId("cas-isolated-active"))
        .toContainText(nativeNewId);
      await expect(page.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      // #176: exact native CAS revision resume URL is generated only
      // after consent, with no dirty draft, and never autoopens on reload.
      const resumeAction=page.getByTestId("cas-resume-generate");
      await expect(resumeAction).toBeEnabled();
      const casNameDraft=page.getByTestId("cas-isolated-active")
        .locator("input").first();
      const beforeDraft=await casNameDraft.inputValue();
      await casNameDraft.fill("UNSAVED_CAS_DRAFT_176");
      await expect(resumeAction).toBeDisabled();
      await casNameDraft.fill(beforeDraft);
      await expect(resumeAction).toBeEnabled();
      page.once("dialog",d=>void d.dismiss());
      await resumeAction.click();
      await expect(page.getByTestId("cas-resume-url")).toHaveCount(0);
      page.once("dialog",d=>void d.accept());
      await resumeAction.click();
      const pinnedInput=page.getByTestId("cas-resume-url");
      await expect(pinnedInput).toBeVisible();
      const resumeUrl=await pinnedInput.inputValue();
      const resumeParsed=new URL(resumeUrl);
      assert.equal(resumeParsed.pathname,"/");
      assert.deepEqual([...resumeParsed.searchParams.keys()].sort(),[
        "casDigest","casHandoff","casRevision","workspace",
      ],"CAS return URL must contain only four safe params");
      assert.equal(resumeParsed.searchParams.get("workspace"),"cas");
      assert.equal(resumeParsed.searchParams.get("casHandoff"),nativeNewId);
      assert.equal(resumeParsed.searchParams.get("casRevision"),"1");
      assert.match(resumeParsed.searchParams.get("casDigest"),
        /^[0-9a-f]{64}$/);
      assert.equal(resumeParsed.hash,"");
      await page.goto(resumeUrl,{waitUntil:"networkidle"});
      await expect(page.getByTestId("cas-root-handoff-hint"))
        .toContainText(nativeNewId);
      await expect(page.getByTestId("cas-isolated-active")).toHaveCount(0);
      page.once("dialog",d=>void d.accept());
      await page.getByTestId("cas-root-handoff-open").click();
      await expect(page.getByTestId("cas-isolated-active"))
        .toContainText(nativeNewId);
      await expect(page.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");

      // Return to legacy, preserving selected historic retired ID, so the
      // previous #174 regression can still exercise its alternative fork.
      page.once("dialog",d=>void d.accept());
      const returnNative=page.waitForURL(u=>
        !new URL(u).searchParams.has("workspace") &&
        !new URL(u).searchParams.has("casHandoff"),
        {timeout:15000});
      await page.getByTestId("cas-root-return-action").click();
      await returnNative;
      await expect(page.getByTestId("cas-legacy-retired-banner"))
        .toBeVisible();
      // A different native writer advances the revision AFTER we created
      // the bookmark. The old URL must fail closed without rebasing/opening.
      const resumeRival=await handoffContext.newPage();
      await resumeRival.goto("http://127.0.0.1:4174/?workspace=cas",
        {waitUntil:"networkidle"});
      await resumeRival.addScriptTag({content:casBundle});
      const changedCas=await resumeRival.evaluate(async current=>{
        const p=JSON.parse(current.raw);
        p.config.description="RIVAL_REVISION_AFTER_LINK_176";
        return window.FactoryProjectCas.compareAndSwapCasProject(p,current);
      },nativeClean);
      assert.equal(changedCas.revision,2);
      const staleResume=await handoffContext.newPage();
      await staleResume.goto(resumeUrl,{waitUntil:"networkidle"});
      await expect(staleResume.getByTestId("cas-root-handoff-hint"))
        .toContainText(nativeNewId);
      await expect(staleResume.getByTestId("cas-isolated-active"))
        .toHaveCount(0);
      await staleResume.getByTestId("cas-root-handoff-open").click();
      await expect(staleResume.getByRole("alert"))
        .toContainText(/non più uguale|non corrisponde|Stale/i);
      await expect(staleResume.getByTestId("cas-isolated-active"))
        .toHaveCount(0);
      assert.equal((await resumeRival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),nativeNewId)).revision,
        2,"Stale return must not rebase or overwrite another CAS revision");
      await staleResume.close();await resumeRival.close();
      console.log("FACTORY_CAS_REVISION_RESUME_E2E_PASS: dirty and declined consent rejected, exact native revision URL only safe query keys, full reload no auto-open, explicit re-open succeeds, rival tab advances revision and stale URL refuses opening without mutation");
      console.log("FACTORY_RETIRED_LEGACY_TO_NATIVE_CAS_FORK_E2E_PASS: exact legacy JSON backup + 3 consents, fresh native IDB UUID, two-tab final-consent collision safe, zero new legacy slot, all stages pending, no evidence/GitHub binding, unchanged source/marker/old CAS row, CAS-only full reload with untrusted hint and second explicit open");

      // #174: retired legacy source can be used ONLY as a configuration
      // blueprint for a NEW UUID. Three consents and exact source backup.
      // A noncooperating second tab must not reserve the target while the
      // human final consent dialog is open, even if it skips Web Locks.
      const cleanFork=page.getByTestId("cas-retired-fork-start");
      await expect(cleanFork).toBeEnabled();
      const initialIds=await page.evaluate(()=>
        Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1.")));
      page.once("dialog",d=>void d.dismiss());
      await cleanFork.click();
      assert.deepEqual(await page.evaluate(()=>
        Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))),initialIds,
        "Declining backup consent must not create a new project");
      const forkRival=await handoffContext.newPage();
      await forkRival.goto("http://127.0.0.1:4174/?workspace=cas",
        {waitUntil:"networkidle"});
      let forkRaceDialogs=0,reservedId=null;
      page.on("dialog",async dialog=>{
        forkRaceDialogs++;
        if(forkRaceDialogs===3){
          const matched=dialog.message().match(/NEW ID: ([0-9a-f-]{36})/i);
          assert.ok(matched,"Final clean-fork consent must show target UUID");
          reservedId=matched[1];
          await forkRival.evaluate(id=>localStorage.setItem(
            "softwarefactory.project.library.v1."+id,
            "RIVAL_RESERVED_TARGET_174"),reservedId);
        }
        await dialog.accept();
      });
      const raceBackup=page.waitForEvent("download");
      await cleanFork.click();
      assert.equal((await readFile(await (await raceBackup).path()))
        .toString("utf8"),original.raw,
        "Rival target race must still produce exact original backup");
      await expect(page.locator(".alert.error"))
        .toContainText(/NON riprovare|non confermato/i);
      assert.equal(forkRaceDialogs,3);
      assert.equal(await forkRival.evaluate(id=>localStorage.getItem(
        "softwarefactory.project.library.v1."+id),reservedId),
        "RIVAL_RESERVED_TARGET_174",
        "Rival target must NOT be overwritten by clean fork");
      assert.equal(await page.evaluate(id=>localStorage.getItem(
        "softwarefactory.project.library.v1."+id),original.id),original.raw);
      assert.equal(await page.evaluate(id=>localStorage.getItem(
        "softwarefactory.cas.retired.v1."+id),original.id),retired);
      page.removeAllListeners("dialog");
      await forkRival.close();

      // A NEW attempt requires an independently prepared NEW target UUID,
      // and explicitly acknowledges the saved byte-exact source backup.
      let cleanConsents=0;
      page.on("dialog",async d=>{cleanConsents++;await d.accept();});
      const cleanBackup=page.waitForEvent("download");
      const forkReload=page.waitForEvent("load",{timeout:20000});
      await cleanFork.click();
      const forkFile=await cleanBackup;
      await forkReload;
      page.removeAllListeners("dialog");
      assert.equal(cleanConsents,3,
        "A clean fork must obtain download/saved/final consents");
      assert.equal(forkFile.suggestedFilename(),
        "softwarefactory-before-clean-fork-"+original.id+".json");
      assert.equal((await readFile(await forkFile.path()))
        .toString("utf8"),original.raw,
        "Clean fork backup must preserve byte-exact source including history");
      const clean=await page.evaluate(()=>{
        const active=JSON.parse(localStorage.getItem(
          "softwarefactory.project.v1")||"{}");
        const raw=localStorage.getItem(
          "softwarefactory.project.library.v1."+active.id);
        return {id:active.id,raw,
          activeTab:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
          settings:JSON.parse(localStorage.getItem(
            "softwarefactory.settings.v1")||"{}")};
      });
      assert.notEqual(clean.id,original.id);
      assert.notEqual(clean.id,reservedId);
      assert.equal(clean.activeTab,clean.id);
      assert.ok(clean.raw,"Fresh local project must have confirmed slot");
      const fresh=JSON.parse(clean.raw),oldProject=JSON.parse(original.raw);
      assert.deepEqual(fresh.config,{
        ...oldProject.config,name:oldProject.config.name+" (recovery)",
      });
      assert.deepEqual(fresh.stages,oldProject.stages.map(s=>({
        id:s.id,label:s.label,status:"pending",output:"",sources:[],
      })));
      assert.deepEqual(Object.keys(fresh).sort(),[
        "config","createdAt","id","stages","updatedAt",
      ]);
      assert.equal(fresh.githubSync,undefined);
      assert.equal(fresh.development,undefined);
      assert.equal(fresh.githubTestReceipt,undefined);
      assert.equal(fresh.githubDestination,undefined);
      assert.equal(clean.settings.githubAutoSync,false);
      assert.equal(clean.settings.git.owner,"");
      assert.equal(clean.settings.git.repo,"");
      await expect(page.getByTestId("cas-legacy-retired-banner"))
        .toHaveCount(0);
      assert.equal(await page.evaluate(id=>localStorage.getItem(
        "softwarefactory.project.library.v1."+id),original.id),original.raw);
      assert.equal(await page.evaluate(id=>localStorage.getItem(
        "softwarefactory.cas.retired.v1."+id),original.id),retired);
      assert.equal((await page.evaluate(id=>
        window.FactoryProjectCas?.readCasProjectSlot(id),
        original.id))?.state,undefined,
        "Legacy reload must not execute CAS-only global scripts");
      await page.addScriptTag({content:casBundle});
      assert.equal((await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id)).raw,
        native.raw,"Fork must not change the existing IndexedDB project");
      console.log("FACTORY_RETIRED_LEGACY_CLEAN_FORK_E2E_PASS: exact source JSON backup + 3 consents, new UUID & pending stages, no historical evidence/GitHub settings, rival target race blocked, original marker and native CAS row unchanged after reload");

      // If a non-cooperating native writer modifies the imported copy
      // *after* reload but *before* hinted open, never adopt its new rev.
      const rival=await handoffContext.newPage();
      await rival.goto("http://127.0.0.1:4174/?workspace=cas",
        {waitUntil:"networkidle"});
      await rival.addScriptTag({content:casBundle});
      const winner=await rival.evaluate(async previous=>{
        const p=JSON.parse(previous.raw);
        p.config.description="RIVAL_AFTER_HANDOFF_171";
        return window.FactoryProjectCas.compareAndSwapCasProject(
          p,previous);
      },native);
      assert.equal(winner.revision,2);
      await page.goto(casHref,{waitUntil:"networkidle"});
      await expect(page.getByTestId("cas-root-handoff-hint")).toBeVisible();
      await page.getByTestId("cas-root-handoff-open").click();
      await expect(page.getByRole("alert"))
        .toContainText(/copia trasferita non più uguale/i);
      assert.equal(await page.getByTestId("cas-isolated-active").count(),0);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id),winner);
      console.log("FACTORY_INDEXEDDB_ASSISTED_HANDOFF_E2E_PASS: exact legacy raw backup + 3 consents, native same-ID insert-only, SHA-256 query hint without code/token, full reload CAS-only no automatic IDB project selection, explicit double-read open, return strips hint, rival later revision rejected and legacy unchanged");
      console.log("FACTORY_CAS_LEGACY_RETIREMENT_E2E_PASS: write fence survives reload and return, second-tab cooperative legacy writer rejected, source and CAS copy preserved");
    }finally{
      await handoffContext.close();
    }

    // #171: rival insert and stale legacy writer DURING third consent
    // must NOT create an overwritten/tombstoned IDB source or navigate.
    const deniedHandoffContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await deniedHandoffContext.newPage();
      await page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await expect(page.getByRole("button",{name:"Nuovo progetto"}))
        .toBeEnabled({timeout:15000});
      await page.addScriptTag({content:casBundle});
      const id=await page.evaluate(()=>JSON.parse(localStorage.getItem(
        "softwarefactory.project.v1")).id);
      const sourceRaw=await page.evaluate(id=>
        localStorage.getItem(
          "softwarefactory.project.library.v1."+id),id);
      const rival=await deniedHandoffContext.newPage();
      await rival.goto("http://127.0.0.1:4174/?workspace=cas",
        {waitUntil:"networkidle"});
      await rival.addScriptTag({content:casBundle});
      const action=page.getByTestId("cas-root-handoff-start");
      await expect(action).toBeEnabled();
      let dialogs=0,winner=null;
      page.on("dialog",async d=>{
        dialogs++;
        if(dialogs===3){
          winner=await rival.evaluate(async raw=>
            window.FactoryProjectCas.compareAndSwapCasProject(
              JSON.parse(raw),null),sourceRaw);
        }
        await d.accept();
      });
      const downloaded=page.waitForEvent("download");
      await action.click();
      assert.equal((await readFile(await (await downloaded).path()))
        .toString("utf8"),sourceRaw);
      await expect(page.locator(".alert.error"))
        .toContainText("non confermato");
      assert.equal(dialogs,3);
      assert.equal(new URL(page.url()).searchParams.get("workspace"),null);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),winner);
      assert.equal(winner.revision,1);
      // The rival inserted BEFORE our post-consent IDB preflight.
      // No native insert was attempted, so the legacy retirement fence
      // must NOT be armed for this refused transfer.
      assert.equal(await page.evaluate(id=>localStorage.getItem(
        "softwarefactory.cas.retired.v1."+id),id),null,
        "Pre-insert IDB collision must leave legacy unchanged/unretired");
      assert.equal(await page.getByTestId("cas-legacy-retired-banner").count(),0);
      page.removeAllListeners("dialog");
      // Tombstoned IDs must never be silently resurrected by a stale copy.
      const tomb=await rival.evaluate(async previous=>
        window.FactoryProjectCas.deleteCasProject(previous.id,previous),
        winner);
      assert.equal(tomb.revision,2);
      await action.click();
      await expect(page.locator(".alert.error"))
        .toContainText("non confermato");
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),id),
        {state:"tombstone",revision:2});
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.project.library.v1."+id),
        id),sourceRaw);
    }finally{
      await deniedHandoffContext.close();
    }

    // #171: mutate exact legacy per-ID raw during FINAL consent. The copy
    // must never insert the old revision, even if a rival bypasses Web Locks.
    const staleLegacyHandoffContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await staleLegacyHandoffContext.newPage();
      await page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await expect(page.getByRole("button",{name:"Nuovo progetto"}))
        .toBeEnabled({timeout:15000});
      await page.addScriptTag({content:casBundle});
      const current=await page.evaluate(()=>{
        const active=JSON.parse(localStorage.getItem(
          "softwarefactory.project.v1"));
        return {id:active.id,raw:localStorage.getItem(
          "softwarefactory.project.library.v1."+active.id)};
      });
      const rival=await staleLegacyHandoffContext.newPage();
      await rival.goto("http://127.0.0.1:4174/?workspace=cas",
        {waitUntil:"networkidle"});
      let n=0,newRaw=null;
      page.on("dialog",async d=>{
        n++;
        if(n===3){
          newRaw=await rival.evaluate(({id,raw})=>{
            const p=JSON.parse(raw);
            p.config.description="RIVAL_CHANGED_LEGACY_DURING_CONSENT_171";
            const next=JSON.stringify(p);
            localStorage.setItem(
              "softwarefactory.project.library.v1."+id,next);
            return next;
          },current);
        }
        await d.accept();
      });
      const backup=page.waitForEvent("download");
      await page.getByTestId("cas-root-handoff-start").click();
      assert.equal((await readFile(await (await backup).path()))
        .toString("utf8"),current.raw);
      await expect(page.locator(".alert.error"))
        .toContainText("non confermato");
      assert.equal(n,3);
      assert.ok(newRaw && newRaw!==current.raw);
      assert.equal(new URL(page.url()).searchParams.get("workspace"),null);
      assert.equal((await page.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),
        current.id)).state,"missing",
        "Stale legacy source must not be inserted as a new IndexedDB copy");
      assert.equal(await page.evaluate(id=>
        localStorage.getItem(
          "softwarefactory.project.library.v1."+id),current.id),newRaw);
    }finally{
      await staleLegacyHandoffContext.close();
    }

    const casPipelineBuild=await require("esbuild").build({
      entryPoints:[path.join(root,"src/frontend/src/application/cas-pipeline-session.ts")],
      bundle:true,write:false,platform:"browser",format:"iife",
      globalName:"FactoryCasPipeline",target:"es2022",
    });
    const casPipelineBundle=casPipelineBuild.outputFiles[0].text;
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
      // A generic expected=null insert may NEVER resurrect a tombstone
      // without the deletion generation, exact backup and consent (#147).
      const implicitRestore=await candidate(casA,"unsafe tombstone revival",null);
      assert.equal(implicitRestore.ok,false);
      assert.match(implicitRestore.error,/Conflitto CAS/);
      assert.deepEqual(await casB.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),id),
        {state:"tombstone",revision:3});
      // The explicit restore primitive is the ONLY allowed revival; it
      // preserves monotone revisions and the byte-identical approved backup.
      const restored=await casA.evaluate(async ({id,tombstone})=>{
        const project={id,config:{name:"explicitly restored after tombstone"},
          stages:[],updatedAt:"2026-11-20T20:00:00.000Z"};
        const raw=JSON.stringify(project);
        return await window.FactoryProjectCas.restoreCasTombstoneProject(
          project,{id,revision:tombstone.revision},raw,true);
      },{id,tombstone});
      assert.equal(restored.revision,4);
      const freshPage=await casContext.newPage();
      await freshPage.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await freshPage.addScriptTag({content:casBundle});
      const reopened=await freshPage.evaluate(id =>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.equal(reopened.revision,4,"IndexedDB CAS must survive tab reopen");
      assert.equal(reopened.raw,restored.raw);
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
        {id,name:"explicitly restored after tombstone",updatedAt:"2026-11-20T20:00:00.000Z",
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
      // An invalid existing record makes a new CAS insert fail closed. It
      // must not silently count only the valid rows or mutate the archive.
      const corruptInsert=await casA.evaluate(async()=>{
        const project={id:"99999999-9999-4999-8999-999999999999",
          config:{name:"Corruption must block insert"},stages:[],
          updatedAt:"2026-11-21T10:00:00.000Z"};
        try {
          await window.FactoryProjectCas.compareAndSwapCasProject(project,null);
          return "unexpected success";
        } catch(e) {return String(e);}
      });
      assert.match(corruptInsert,/corrotto/);
      assert.deepEqual(await casB.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),
        "99999999-9999-4999-8999-999999999999"),{state:"missing"});


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
      console.log("FACTORY_INDEXEDDB_CAS_E2E_PASS: Chromium two-tab insert/update races, strict tombstone no-recreate, explicit restore ABA and tab reopen");
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


    // #144: read-only preconsent project switch tickets and coordinated CAS
    // writes. Native Chromium IndexedDB, two tabs, no live-editor cutover.
    const selectionBuild=await require("esbuild").build({
      entryPoints:[path.join(root,"src/frontend/src/infrastructure/project-cas-selection.ts")],
      bundle:true,write:false,platform:"browser",format:"iife",
      globalName:"FactoryCasSelection",target:"es2022",
    });
    const selectionBundle=selectionBuild.outputFiles[0].text;
    const selectionContext=await browser.newContext();
    try {
      const primary=await selectionContext.newPage();
      const rival=await selectionContext.newPage();
      await Promise.all([
        primary.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      for (const tab of [primary,rival]) {
        await tab.addScriptTag({content:casBundle});
        await tab.addScriptTag({content:selectionBundle});
      }
      const fromId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const toId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const original=await primary.evaluate(async({fromId,toId})=>{
        const make=(id,name)=>({
          id,config:{name},stages:[],updatedAt:"2026-11-21T11:00:00.000Z",
        });
        const a=await window.FactoryProjectCas.compareAndSwapCasProject(
          make(fromId,"Source A"),null);
        const b=await window.FactoryProjectCas.compareAndSwapCasProject(
          make(toId,"Destination B"),null);
        window.__casSelection=await window.FactoryCasSelection
          .openCasSelectionController(fromId);
        return {a,b};
      },{fromId,toId});
      const choices=await primary.evaluate(()=>window.__casSelection.list());
      assert.deepEqual(choices.map(x=>x.id).sort(),[fromId,toId].sort(),
        "The selection library must be listed from IndexedDB only");
      const ticket=await primary.evaluate(id=>
        window.__casSelection.prepareSwitch(id),toId);
      assert.deepEqual(ticket.source,original.a);
      assert.deepEqual(ticket.destination,original.b);
      const newB=await rival.evaluate(async b=>{
        const item=JSON.parse(b.raw);
        return window.FactoryProjectCas.compareAndSwapCasProject({
          ...item,config:{...item.config,name:"Rival changes B during confirmation"},
        },b);
      },original.b);
      const stale=await primary.evaluate(async ticket=>{
        try {await window.__casSelection.confirmSwitch(ticket);return "unexpected success";}
        catch(error){return {message:String(error),
          current:window.__casSelection.snapshot(),state:window.__casSelection.state()};}
      },ticket);
      assert.match(stale.message,/non confermato/);
      assert.deepEqual(stale.current,original.a,
        "Stale switch must preserve original writable project");
      assert.equal(stale.state,"ready");
      const validTicket=await primary.evaluate(id=>
        window.__casSelection.prepareSwitch(id),toId);
      assert.deepEqual(validTicket.destination,newB);
      const selected=await primary.evaluate(async ticket=>
        window.__casSelection.confirmSwitch(ticket),validTicket);
      assert.deepEqual(selected,newB);
      assert.deepEqual(await primary.evaluate(()=>
        window.__casSelection.snapshot()),newB);

      // Prepare an old selection ticket; a current-project commit changes
      // the controller generation and must invalidate that old ticket.
      const oldTicket=await primary.evaluate(id=>
        window.__casSelection.prepareSwitch(id),fromId);
      const saved=await primary.evaluate(async()=>{
        const ctrl=window.__casSelection;
        const before=ctrl.snapshot(),project=JSON.parse(before.raw);
        const promise=ctrl.commit({
          ...project,config:{...project.config,name:"New B checkpoint"},
        },before);
        const during=ctrl.state();
        let duringSwitch;
        try {await ctrl.confirmSwitch({
          source:before,destination:before,generation:0,
        });duringSwitch="unexpected success";}
        catch(e){duringSwitch=String(e);}
        return {during,duringSwitch,saved:await promise};
      });
      assert.equal(saved.during,"saving");
      assert.match(saved.duringSwitch,/sospesa/,
        "Selection must refuse an in-flight write");
      assert.equal(saved.saved.revision,newB.revision+1);
      const staleGeneration=await primary.evaluate(async ticket=>{
        try {await window.__casSelection.confirmSwitch(ticket);
          return "unexpected success";}
        catch(e){return String(e);}
      },oldTicket);
      assert.match(staleGeneration,/obsoleto/,
        "A ticket created before a save cannot be accepted afterward");
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),toId),saved.saved);

      // A direct CAS delete by a non-cooperating tab must not make a
      // tombstoned destination silently selectable.
      const deleted=await rival.evaluate(async snap=>
        window.FactoryProjectCas.deleteCasProject(snap.id,snap),original.a);
      assert.equal(deleted.revision,2);
      const tombstoneError=await primary.evaluate(async id=>{
        try {await window.__casSelection.prepareSwitch(id);
          return "unexpected success";}
        catch(e){return String(e);}
      },fromId);
      assert.match(tombstoneError,/eliminato/);
      const missingError=await primary.evaluate(async()=>{
        try {await window.__casSelection.prepareSwitch(
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
          return "unexpected success";}
        catch(e){return String(e);}
      });
      assert.match(missingError,/assente/);

      // Reload creates a fresh controller from IDB, never from localStorage.
      const refreshed=await selectionContext.newPage();
      await refreshed.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await refreshed.addScriptTag({content:casBundle});
      await refreshed.addScriptTag({content:selectionBundle});
      const afterReload=await refreshed.evaluate(async id=>{
        const current=await window.FactoryCasSelection.openCasSelectionController(id);
        return {state:current.state(),snapshot:current.snapshot()};
      },toId);
      assert.equal(afterReload.state,"ready");
      assert.deepEqual(afterReload.snapshot,saved.saved);
      for(const page of [primary,rival,refreshed]) {
        const legacy=await page.evaluate(({fromId,toId})=>[
          localStorage.getItem("softwarefactory.project.library.v1."+fromId),
          localStorage.getItem("softwarefactory.project.library.v1."+toId),
        ],{fromId,toId});
        assert.deepEqual(legacy,[null,null],
          "CAS controller must never write either legacy project slot");
      }
      console.log("FACTORY_INDEXEDDB_SELECTION_E2E_PASS: preconsent exact ticket, rival-tab conflict, writer-switch fencing, tombstone, reload and zero legacy writes");
    } finally {
      await selectionContext.close();
    }


    // #146: native two-tab transaction lifecycle and explicit tombstone
    // restore. Never touch the SPA's active localStorage editor.
    const lifecycleBuild=await require("esbuild").build({
      entryPoints:[path.join(root,"src/frontend/src/infrastructure/project-cas-lifecycle.ts")],
      bundle:true,write:false,platform:"browser",format:"iife",
      globalName:"FactoryCasLifecycle",target:"es2022",
    });
    const lifecycleBundle=lifecycleBuild.outputFiles[0].text;
    const lifecycleContext=await browser.newContext();
    try {
      const first=await lifecycleContext.newPage();
      const second=await lifecycleContext.newPage();
      await Promise.all([
        first.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        second.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      for(const page of [first,second]){
        await page.addScriptTag({content:casBundle});
        await page.addScriptTag({content:selectionBundle});
        await page.addScriptTag({content:lifecycleBundle});
      }
      const idA="66666666-6666-4666-8666-666666666666";
      const idB="55555555-5555-4555-8555-555555555555";
      const backup=await first.evaluate(async({idA,idB})=>{
        const make=(id,name)=>({id,config:{name},stages:[],
          updatedAt:"2026-11-21T15:00:00.000Z"});
        const a=await window.FactoryProjectCas.compareAndSwapCasProject(make(idA,"Before deletion A"),null);
        const b=await window.FactoryProjectCas.compareAndSwapCasProject(make(idB,"Before deletion B"),null);
        window.__casLifecycleSelection=await window.FactoryCasSelection.openCasSelectionController(idA);
        return {a,b};
      },{idA,idB});
      const deleted=await first.evaluate(async a=>{
        const ctrl=window.__casLifecycleSelection;
        const missingConsent=await ctrl.delete(a,false).then(()=>"unexpected success",String);
        const promise=ctrl.delete(a,true);
        const busy=ctrl.state(),old=ctrl.snapshot();
        const blockedWrite=await ctrl.commit(JSON.parse(a.raw),a)
          .then(()=>"unexpected success",String);
        return {missingConsent,busy,old,blockedWrite,tombstone:await promise,
          state:ctrl.state()};
      },backup.a);
      assert.match(deleted.missingConsent,/consenso/);
      assert.equal(deleted.busy,"saving");
      assert.deepEqual(deleted.old,backup.a);
      assert.match(deleted.blockedWrite,/sospesa/);
      assert.equal(deleted.tombstone.revision,2);
      assert.equal(deleted.state,"blocked");
      assert.deepEqual(await second.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),idA),
        {state:"tombstone",revision:2});
      const staleWrite=await second.evaluate(async a=>{
        try{await window.FactoryProjectCas.compareAndSwapCasProject(JSON.parse(a.raw),a);
          return "unexpected success";}catch(e){return String(e);}
      },backup.a);
      assert.match(staleWrite,/Conflitto CAS/);

      // Before restoring, both tabs create tickets from the SAME tombstone.
      const tickets=await Promise.all([first,second].map(page=>
        page.evaluate(async({id,raw})=>window.FactoryCasLifecycle
          .prepareCasTombstoneRestore(id,raw),{id:idA,raw:backup.a.raw})));
      assert.deepEqual(tickets[0],tickets[1]);
      const withoutConsent=await first.evaluate(async ticket=>{
        try{await window.FactoryCasLifecycle.confirmCasTombstoneRestore(ticket,false);
          return "unexpected success";}catch(e){return String(e);}
      },tickets[0]);
      assert.match(withoutConsent,/Conferma/);
      const contenders=await Promise.all([first,second].map((page,index)=>
        page.evaluate(async ticket=>{
          try{
            const snapshot=await window.FactoryCasLifecycle.confirmCasTombstoneRestore(ticket,true);
            return {ok:true,snapshot};
          }catch(e){return {ok:false,error:String(e)};}
        },tickets[index])));
      assert.equal(contenders.filter(x=>x.ok).length,1,
        "Same tombstone generation and backup must have exactly ONE restore winner");
      const resurrected=contenders.find(x=>x.ok).snapshot;
      assert.equal(resurrected.revision,3,
        "Restoring after tombstone must increment revision and prevent ABA");
      assert.equal(resurrected.raw,backup.a.raw,
        "Restored raw checkpoint must be byte-exact from user backup");
      assert.match(contenders.find(x=>!x.ok).error,
        /tombstone|Tombstone|Conflitto/,
        "Losing restore must not overwrite the successful rival");
      const staleTicket=await first.evaluate(async ticket=>{
        try{await window.FactoryCasLifecycle.confirmCasTombstoneRestore(ticket,true);
          return "unexpected success";}catch(e){return String(e);}
      },tickets[0]);
      assert.match(staleTicket,/cambiata/);
      assert.deepEqual(await second.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),idA),resurrected);

      // Capacity is checked in the same readwrite transaction for BOTH
      // explicit restore and generic never-seen inserts. A tombstone must
      // survive an aborted restore when there are 40 active projects.
      const tombB=await second.evaluate(async b=>
        window.FactoryProjectCas.deleteCasProject(b.id,b),backup.b);
      assert.equal(tombB.revision,2);
      await second.evaluate(async()=>{
        const db=await new Promise((resolve,reject)=>{
          const req=indexedDB.open("softwarefactory.project.cas.v1",1);
          req.onsuccess=()=>resolve(req.result);
          req.onerror=()=>reject(Error("Fixture IDB open failed"));
        });
        try{
          await new Promise((resolve,reject)=>{
            const tx=db.transaction("projects","readwrite");
            tx.oncomplete=resolve;
            tx.onabort=()=>reject(Error("Fixture IDB capacity failed"));
            const store=tx.objectStore("projects");
            for(let n=0;n<39;n++){
              const id="44444444-4444-4444-8444-"+String(n).padStart(12,"0");
              store.put({id,revision:1,raw:JSON.stringify({
                id,config:{name:"Capacity "+n},stages:[],
                updatedAt:"2026-11-21T15:01:00.000Z",
              })},id);
            }
          });
        }finally{db.close();}
      });
      assert.equal((await first.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,40);
      const ticketB=await first.evaluate(async b=>
        window.FactoryCasLifecycle.prepareCasTombstoneRestore(b.id,b.raw),backup.b);
      const full=await first.evaluate(async ticket=>{
        try{await window.FactoryCasLifecycle.confirmCasTombstoneRestore(ticket,true);
          return "unexpected success";}catch(e){return String(e);}
      },ticketB);
      assert.match(full,/piena \(40 progetti\)/);
      assert.deepEqual(await first.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),idB),
        {state:"tombstone",revision:2},
        "Capacity abort must not modify the tombstone or any active project");
      // Generic null inserts must also enforce capacity atomically. An
      // update to an existing active project is still allowed at 40.
      const fullInsert=await second.evaluate(async()=>{
        const id="77777777-7777-4777-8777-777777777777";
        const project={id,config:{name:"Forbidden 41st"},stages:[],
          updatedAt:"2026-11-21T15:03:00.000Z"};
        try{
          await window.FactoryProjectCas.compareAndSwapCasProject(project,null);
          return "unexpected success";
        }catch(e){return String(e);}
      });
      assert.match(fullInsert,/piena \(40 progetti\)/);
      const missing41=await first.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),
        "77777777-7777-4777-8777-777777777777");
      assert.deepEqual(missing41,{state:"missing"});
      const atCapacityUpdate=await first.evaluate(async snap=>{
        const project=JSON.parse(snap.raw);
        return window.FactoryProjectCas.compareAndSwapCasProject({
          ...project,config:{...project.config,name:"Updated at capacity"},
        },snap);
      },resurrected);
      assert.equal(atCapacityUpdate.revision,resurrected.revision+1);
      assert.equal((await second.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,40);

      for(const page of [first,second]){
        const legacy=await page.evaluate(({idA,idB})=>[
          localStorage.getItem("softwarefactory.project.library.v1."+idA),
          localStorage.getItem("softwarefactory.project.library.v1."+idB),
        ],{idA,idB});
        assert.deepEqual(legacy,[null,null],
          "IDB tombstone lifecycle must not read/write the legacy project slots");
      }
      console.log("FACTORY_INDEXEDDB_STRICT_INSERT_E2E_PASS: tombstone no-revive, strict 40-capacity generic inserts, corrupted archive rejection and explicit consented restore");
      console.log("FACTORY_INDEXEDDB_TOMBSTONE_RESTORE_E2E_PASS: async delete fence, stale write, dual-tab restore race, exact backup, ABA, strict null insert capacity and no legacy mutation");
    }finally{
      await lifecycleContext.close();
    }


    // #148: actual SPA file picker, IT consent and native IDB restore from a
    // saved JSON. Never changes the live localStorage editor or GitHub. Fresh
    // browser profile prevents inherited consent handlers from other tests.
    const restoreUiContext=await browser.newContext();
    try {
      const page=await restoreUiContext.newPage();
      await page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      await expect(page.getByRole("button",{
        name:"Copia in IndexedDB (anteprima)",
      })).toBeEnabled({timeout:15000});
      const rival=await restoreUiContext.newPage();
      await rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      await rival.addScriptTag({content:casBundle});
      await rival.addScriptTag({content:lifecycleBundle});
      const source=await page.evaluate(async()=>{
        const make=(id,name)=>({id,config:{name,description:"Old draft"},
          stages:[],updatedAt:"2026-11-21T17:00:00.000Z"});
        const ids=[
          "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "ccccccc1-cccc-4ccc-8ccc-cccccccccccc",
        ];
        const snapshots=[];
        for(let index=0;index<ids.length;index++){
          const s=await window.FactoryProjectCas.compareAndSwapCasProject(
            make(ids[index],["Raw saved backup","Envelope saved backup","Rival restored backup"][index]),null);
          await window.FactoryProjectCas.deleteCasProject(s.id,s);
          snapshots.push(s);
        }
        return snapshots;
      });
      const backupFile=page.getByLabel("Ripristina progetto IndexedDB eliminato da backup JSON");
      await expect(backupFile).toBeEnabled();
      const legacyBaseline=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        library:localStorage.getItem("softwarefactory.project.index.v1"),
        slots:Object.keys(localStorage)
          .filter(k=>k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const jsonFile=(name,text)=>({name,mimeType:"application/json",buffer:Buffer.from(text,"utf8")});
      await backupFile.setInputFiles(jsonFile("broken.json","{invalid"));
      await expect(page.getByRole("alert")).toContainText("Backup JSON IndexedDB non valido");
      await expect(backupFile).toBeEnabled();
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),source[0].id),
        {state:"tombstone",revision:2},
        "Bad JSON must not recreate a deleted project");

      // A well-formed backup for a never-seen ID cannot create any project.
      const nonDeleted={...JSON.parse(source[0].raw),
        id:"ddddddd1-dddd-4ddd-8ddd-dddddddddddd"};
      await backupFile.setInputFiles(jsonFile("never-deleted.json",JSON.stringify(nonDeleted)));
      await expect(page.getByRole("alert")).toContainText("tombstone assente");
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),nonDeleted.id),{state:"missing"});

      // Cancel consent. Selecting the same file again must still be possible.
      let declined=0;
      page.once("dialog",dlg=>{declined++;void dlg.dismiss();});
      await backupFile.setInputFiles(jsonFile("saved-project.json",source[0].raw));
      await expect(backupFile).toBeEnabled();
      assert.equal(declined,1,"Explicit consent is required for IDB restore");
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),source[0].id),
        {state:"tombstone",revision:2});

      // Approve an exact raw project export. The user-visible dialog carries
      // only project name, ID, generation and a non-live-editor warning.
      let accepted=0;
      page.once("dialog",dlg=>{
        assert.match(dlg.message(),/Raw saved backup/);
        assert.match(dlg.message(),/Tombstone rev\. 2/);
        assert.match(dlg.message(),/localStorage/);
        accepted++;
        void dlg.accept();
      });
      await backupFile.setInputFiles(jsonFile("saved-project.json",source[0].raw));
      await expect(page.getByText("Copia IndexedDB ripristinata soltanto",{exact:false}))
        .toBeVisible({timeout:15000});
      assert.equal(accepted,1);
      const restoredRaw=await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),source[0].id);
      assert.equal(restoredRaw.revision,3);
      assert.equal(restoredRaw.raw,source[0].raw);
      await backupFile.setInputFiles(jsonFile("saved-project.json",source[0].raw));
      await expect(page.getByRole("alert")).toContainText("tombstone assente");
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),source[0].id),restoredRaw,
        "A second file selection cannot overwrite a restored project");

      // Existing v1 local recovery envelopes from the SPA are accepted, but
      // only the normalized project is inserted into IndexedDB.
      const envelope=JSON.stringify({
        kind:"softwarefactory-local-recovery",schemaVersion:1,
        exportedAt:"2026-11-21T17:00:00.000Z",
        project:JSON.parse(source[1].raw),
      },null,2);
      page.once("dialog",dlg=>void dlg.accept());
      await backupFile.setInputFiles(jsonFile("softwarefactory-recovery.json",envelope));
      await expect(page.getByText("Copia IndexedDB ripristinata soltanto",{exact:false}))
        .toBeVisible({timeout:15000});
      const restoredEnvelope=await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),source[1].id);
      assert.equal(restoredEnvelope.revision,3);
      assert.equal(restoredEnvelope.raw,source[1].raw);

      // Native second-tab CAS mutation WHILE confirmation is open. The UI
      // must fail closed on stale tombstone without retry or local fallback.
      let notifyDialog;
      const dialogSeen=new Promise(resolve=>{notifyDialog=resolve;});
      const handleDialog=dialog=>notifyDialog(dialog);
      page.on("dialog",handleDialog);
      const pendingFile=backupFile.setInputFiles(jsonFile("race.json",source[2].raw));
      const dialog=await dialogSeen;
      assert.match(dialog.message(),/Rival restored backup/);
      const rivalTicket=await rival.evaluate(async({id,raw})=>
        window.FactoryCasLifecycle.prepareCasTombstoneRestore(id,raw),
        {id:source[2].id,raw:source[2].raw});
      const rivalResult=await rival.evaluate(async ticket=>
        window.FactoryCasLifecycle.confirmCasTombstoneRestore(ticket,true),rivalTicket);
      assert.equal(rivalResult.revision,3);
      await dialog.accept();
      await pendingFile;
      page.off("dialog",handleDialog);
      await expect(page.getByRole("alert")).toContainText("Tombstone IndexedDB cambiata");
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),source[2].id),
        rivalResult,"The UI must not overwrite the winner of a rival restore");

      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        library:localStorage.getItem("softwarefactory.project.index.v1"),
        slots:Object.keys(localStorage)
          .filter(k=>k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBaseline,
        "File-driven IDB restore must never write or change legacy editor state");
      const recoveredLibrary=await page.getByRole("button",{
        name:"Mostra copie IndexedDB recuperabili",
      });
      await recoveredLibrary.click();
      await expect(page.getByTestId("cas-recovery-library"))
        .toContainText("Raw saved backup");
      await expect(page.getByTestId("cas-recovery-library"))
        .toContainText("Envelope saved backup");
      console.log("FACTORY_INDEXEDDB_UI_TOMBSTONE_RESTORE_E2E_PASS: actual SPA file upload, invalid/missing, explicit cancel+confirm, raw+envelope backup, two-tab stale ticket, no legacy writes");
    }finally {
      await restoreUiContext.close();
    }


    // #149: actual opt-in isolated CAS editor in the SPA. This UI writes ONLY
    // IndexedDB; the live Factory still edits its separate legacy project.
    const isolatedContext=await browser.newContext({acceptDownloads:true});
    try {
      const page=await isolatedContext.newPage();
      const rival=await isolatedContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      for(const tab of [page,rival])
        await tab.addScriptTag({content:casBundle});
      const original=await page.evaluate(async()=>{
        const ids=[
          "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",
          "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2",
        ];
        const projects=ids.map((id,i)=>({
          id,config:{name:i===0?"IDB pilot A":"IDB pilot B",
            description:"Existing brief "+i,requirements:"Existing constraints "+i},
          stages:[{id:"features",label:"Features",status:"complete",
            output:"HISTORICAL_AI_OUTPUT",sources:[]}],
          createdAt:"2026-11-21T17:00:00.000Z",
          updatedAt:"2026-11-21T17:00:00.000Z",
        }));
        return Promise.all(projects.map(p=>
          window.FactoryProjectCas.compareAndSwapCasProject(p,null)));
      });
      const localBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await expect(panel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      })).toBeVisible();
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      await expect(page.getByTestId("cas-isolated-library"))
        .toContainText("IDB pilot A");
      await expect(page.getByTestId("cas-isolated-library"))
        .toContainText("IDB pilot B");
      page.removeAllListeners("dialog");
      page.once("dialog",dialog=>{
        assert.match(dialog.message(),/IDB pilot A/);
        assert.match(dialog.message(),/non cambia il progetto attivo/i);
        void dialog.accept();
      });
      await panel.getByRole("button",{name:"Apri copia IDB: IDB pilot A"}).click();
      await expect(page.getByTestId("cas-isolated-active")).toContainText("rev. 1");
      const name=panel.getByLabel("Nome progetto (solo IndexedDB)");
      const description=panel.getByLabel("Descrizione progetto (solo IndexedDB)");
      const requirements=panel.getByLabel("Requisiti progetto (solo IndexedDB)");
      await expect(requirements).toHaveValue("Existing constraints 0");
      const save=panel.getByRole("button",{name:"Salva modifica in IndexedDB con backup"});
      await expect(save).toBeDisabled();
      await name.fill("IDB pilot A revised");
      await description.fill("New brief, stage analyses must be reset");
      await requirements.fill("New requirements: no unreviewed publication");
      await expect(save).toBeEnabled();
      // #154: closing the panel must not silently throw away an unsaved
      // requirements/name/brief draft. Declining retains editor and text.
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>{
        assert.match(dlg.message(),/NON SALVATE/);
        void dlg.dismiss();
      });
      await panel.getByRole("button",{name:"Chiudi editor separato"}).click();
      await expect(name).toHaveValue("IDB pilot A revised");
      await expect(description).toHaveValue("New brief, stage analyses must be reset");
      await expect(requirements).toHaveValue("New requirements: no unreviewed publication");
      await expect(page.getByTestId("cas-isolated-active")).toContainText("rev. 1");
      // Refresh on a READY controller is read-only and must keep the draft
      // without prompting, even if there are unsaved edits.
      page.removeAllListeners("dialog");
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      await expect(requirements).toHaveValue("New requirements: no unreviewed publication");
      page.once("dialog",dlg=>void dlg.dismiss());
      await save.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original[0].id),original[0],
        "Declining backup must leave the exact IDB snapshot unchanged");

      // Exact precommit backup + *second* saved-file consent. A refusal
      // after the download must not write the new configuration.
      let declinedSecond=0;
      page.removeAllListeners("dialog");
      page.on("dialog",async dlg=>{
        declinedSecond++;
        if(declinedSecond===1) await dlg.accept();
        else await dlg.dismiss();
      });
      const declineDownload=page.waitForEvent("download");
      await save.click();
      const precommit=await declineDownload;
      assert.equal(precommit.suggestedFilename(),
        "softwarefactory-cas-before-edit-"+original[0].id+"-r1.json");
      assert.equal((await readFile(await precommit.path())).toString("utf8"),
        original[0].raw);
      assert.equal(declinedSecond,2);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original[0].id),original[0]);

      // Both independent consents accepted. Only genuine IDB transaction
      // oncomplete may advance the component's revision and draft.
      page.removeAllListeners("dialog");
      let approved=0;
      page.on("dialog",async dlg=>{approved++;await dlg.accept();});
      const acceptedDownload=page.waitForEvent("download");
      await save.click();
      const savedFile=await acceptedDownload;
      assert.equal((await readFile(await savedFile.path())).toString("utf8"),
        original[0].raw);
      assert.equal(approved,2);
      await expect(page.getByTestId("cas-isolated-active")).toContainText("rev. 2");
      await expect(panel.getByRole("status"))
        .toContainText("Commit IndexedDB confermato");
      const savedA=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original[0].id);
      assert.equal(savedA.revision,2);
      assert.equal(JSON.parse(savedA.raw).config.name,"IDB pilot A revised");
      assert.equal(JSON.parse(savedA.raw).config.description,"New brief, stage analyses must be reset");
      assert.equal(JSON.parse(savedA.raw).config.requirements,
        "New requirements: no unreviewed publication");
      assert.equal(JSON.parse(savedA.raw).stages[0].status,"pending");
      assert.equal(JSON.parse(savedA.raw).stages[0].output,"");
      assert.deepEqual(JSON.parse(savedA.raw).stages[0].sources,[]);

      // The *same controller* switches only after exact ticket preparation,
      // explicit consent and post-consent re-read of the destination.
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      await expect(page.getByTestId("cas-isolated-library")).toContainText("IDB pilot B");
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.accept());
      await panel.getByRole("button",{name:"Apri copia IDB: IDB pilot B"}).click();
      await expect(name).toHaveValue("IDB pilot B");
      await expect(description).toHaveValue("Existing brief 1");
      await expect(requirements).toHaveValue("Existing constraints 1");
      await requirements.fill("Unsaved requirements must lose to rival");

      // Another native CAS writer changes the selected destination while
      // the local editor is waiting for the user's SECOND save consent.
      // The isolated editor MUST fail closed and block the stale controller.
      page.removeAllListeners("dialog");
      let notifyConfirm;
      const onSecondConsent=new Promise(resolve=>{notifyConfirm=resolve;});
      let raceDialogs=0;
      const onDialog=async dialog=>{
        raceDialogs++;
        if(raceDialogs===1) await dialog.accept();
        else notifyConfirm(dialog);
      };
      page.on("dialog",onDialog);
      const raceDownload=page.waitForEvent("download");
      const saving=save.click();
      const backup=await raceDownload;
      assert.equal((await readFile(await backup.path())).toString("utf8"),
        original[1].raw);
      const pausedDialog=await onSecondConsent;
      assert.match(pausedDialog.message(),/SALVATO/);
      const rivalB=await rival.evaluate(async expected=>{
        const p=JSON.parse(expected.raw);
        p.config.description="Written first by noncooperating tab";
        p.config.requirements="Rival constraints take precedence";
        return window.FactoryProjectCas.compareAndSwapCasProject(p,expected);
      },original[1]);
      assert.equal(rivalB.revision,2);
      await pausedDialog.accept();
      await saving;
      page.off("dialog",onDialog);
      await expect(panel.getByRole("alert")).toContainText("non confermata");
      await expect(panel.getByRole("status")).toContainText("Sessione IndexedDB bloccata");
      await expect(save).toBeDisabled();
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original[1].id),rivalB,
        "Rival-tab CAS winner must never be overwritten or auto-merged");
      // #154: after blocked CAS, the rejected draft remains valuable human
      // text. A normal refresh must NOT erase it without another consent.
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>{
        assert.match(dlg.message(),/NON SALVATA/);
        void dlg.dismiss();
      });
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      await expect(requirements).toHaveValue("Unsaved requirements must lose to rival");
      await expect(page.getByTestId("cas-isolated-active")).toContainText("rev. 1");
      // Consent permits discarding ONLY this local draft; the newer rival
      // record is never auto-adopted or overwritten.
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>{
        assert.match(dlg.message(),/NON SALVATA/);
        void dlg.accept();
      });
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      await expect(page.getByTestId("cas-isolated-active")).toHaveCount(0);
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.accept());
      await panel.getByRole("button",{name:"Apri copia IDB: IDB pilot B"}).click();
      await expect(name).toHaveValue("IDB pilot B");
      await expect(description).toHaveValue("Written first by noncooperating tab");
      await expect(requirements).toHaveValue("Rival constraints take precedence");
      await expect(page.getByTestId("cas-isolated-active")).toContainText("rev. 2");
      // Confirming close with a fresh dirty draft drops only React state,
      // never the stored project or the active localStorage Factory.
      await requirements.fill("Close with intentional discard after warning");
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>{
        assert.match(dlg.message(),/NON SALVATE/);
        void dlg.accept();
      });
      await panel.getByRole("button",{name:"Chiudi editor separato"}).click();
      await expect(page.getByTestId("cas-isolated-active")).toHaveCount(0);
      await expect(panel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      })).toBeVisible();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original[1].id),rivalB,
        "Explicit close must not commit or overwrite unreviewed draft");

      const localAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(localAfter,localBefore,
        "Isolated IDB editor must never write the authoritative legacy workspace");
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      const reopened=await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original[0].id);
      assert.deepEqual(reopened,savedA,
        "Confirmed async CAS edits survive Chromium reload and cannot be lost");
      console.log("FACTORY_INDEXEDDB_ISOLATED_EDITOR_E2E_PASS: opt-in CAS name/brief/requirements, two backup consents, exact raw download, stage invalidation, guarded selection, rival-tab conflict, reopen and legacy unchanged");
      console.log("FACTORY_INDEXEDDB_REQUIREMENTS_E2E_PASS: requirements persisted after tx.oncomplete, stale requirements rejected, native rival winner and legacy unchanged");
      console.log("FACTORY_INDEXEDDB_DIRTY_DRAFT_E2E_PASS: close cancel preserves all fields, ready refresh retains draft, blocked refresh refuses discard until consent, accepted discard preserves rival CAS record and legacy unchanged");
    } finally {
      await isolatedContext.close();
    }


    // #162: real IndexedDB Code Agent JSON patch staging, without AI,
    // review, test runner or GitHub operations. Two tab native CAS fencing.
    const codePatchContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await codePatchContext.newPage();
      const rival=await codePatchContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await Promise.all([
        page.addScriptTag({content:casBundle}),
        rival.addScriptTag({content:casBundle}),
      ]);
      const id="16216216-2162-4162-8162-162162162162";
      const conflictId="16216216-2162-4162-8162-162162162163";
      const seed=async (id,name)=>rival.evaluate(async ({id,name})=>{
        const now="2026-11-22T08:30:00.000Z";
        const stages=["features","competitors","technical","architecture",
          "adversarial","implementation"].map(stage=>({
            id:stage,label:stage,status:"pending",output:"",sources:[],
          }));
        return window.FactoryProjectCas.compareAndSwapCasProject({
          id,config:{
            name,description:"Only CAS pilot, never live",
            requirements:"Do not fabricate approvals/runner proof",
            // The Code Agent produces a scaffold-dependent candidate.
            // Real Factory projects have the full typed configuration;
            // a minimal IDB storage fixture is NOT a valid Code Agent brief.
            frontends:["react"],deployment:"docker",dotnetVersion:"11.0",
            database:"postgresql",services:{
              database:{development:"postgresql",production:"postgresql"},
              cache:{development:"none",production:"none"},
              queue:{development:"none",production:"none"},
              telemetry:{development:"opentelemetry-jaeger",
                production:"opentelemetry-jaeger"},
              storage:{development:"local",production:"local"},
            },
          },
          stages,createdAt:now,updatedAt:now,
        },null);
      },{id,name});
      const original=await seed(id,"Code Agent pending fixture");
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      page.once("dialog",dialog=>void dialog.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Code Agent pending fixture",
      }).click();
      const form=panel.getByTestId("cas-isolated-code-proposal");
      const request=form.getByTestId("cas-isolated-code-request");
      const json=form.getByTestId("cas-isolated-code-json");
      const action=form.getByRole("button",{
        name:"Salva proposta Code Agent PENDING SOLO IndexedDB con backup",
      });
      const summary="<img src=x onerror=alert('CODE_AGENT_XSS')> Unreviewed human patch";
      const proposal=JSON.stringify({
        summary,
        files:[{path:"src/frontend/web/src/HumanFeature162.tsx",
          content:"/* <img src=x onerror=alert('CODE_DIFF_XSS')> */\\n"+
            "export const HumanFeature162=()=> <p>Not executed</p>;",
          reason:"Operator supplied full replacement, not executed"}],
        tests:["web-build"],assumptions:["No actual AI/review/build/test was run"],
      });
      await request.fill("Add a human-proposed component");
      await json.fill(proposal);
      await expect(action).toBeEnabled();
      page.once("dialog",dialog=>void dialog.dismiss());
      await action.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),original);
      await expect(json).toHaveValue(proposal);

      let consents=0;
      const acceptDialogs=async dialog=>{consents++;await dialog.accept();};
      page.on("dialog",acceptDialogs);
      const downloadEvent=page.waitForEvent("download");
      await action.click();
      const download=await downloadEvent;
      assert.equal(download.suggestedFilename(),
        "softwarefactory-cas-before-code-pending-"+id+"-r1.json");
      assert.equal((await readFile(await download.path())).toString("utf8"),
        original.raw,"Pending Code Agent pre-write backup must be exact IDB raw");
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 2");
      assert.equal(consents,3,
        "Only 3 consents may permit Code Agent pending CAS write");
      const pending=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const stored=JSON.parse(pending.raw);
      assert.equal(pending.revision,2);
      assert.equal(stored.development.revision,0);
      assert.equal(stored.development.pending.summary,summary);
      assert.equal(stored.development.pending.edits.length,1);
      assert.equal(stored.development.pending.review,undefined);
      assert.equal(stored.development.pending.repairTrail,undefined);
      assert.equal(stored.development.lastRunnerEvidence,undefined);
      assert.equal(stored.development.history.length,0);
      assert.equal(stored.githubTestReceipt,undefined);
      assert.equal(stored.githubSync,undefined);
      assert.deepEqual(stored.stages,JSON.parse(original.raw).stages);
      await expect(form.getByTestId("cas-isolated-code-pending-preview"))
        .toContainText("pending, NON approvato");
      await expect(form.getByTestId("cas-isolated-code-pending-preview"))
        .toContainText(summary);
      assert.equal(await form.locator("img").count(),0,
        "Untrusted Code Agent JSON summary must never render as HTML");
      // #164: source changes are rendered only as bounded inert text. A
      // malicious HTML-looking replacement must NEVER create DOM elements.
      const diff=form.getByTestId("cas-isolated-code-files-preview");
      await diff.locator("summary").click();
      await expect(diff).toContainText("rev. 2");
      await expect(diff.getByTestId("cas-isolated-code-file-path"))
        .toContainText("src/frontend/web/src/HumanFeature162.tsx");
      await expect(diff).toContainText("Nuovo file, assente dalla baseline");
      await expect(diff.getByTestId("cas-isolated-code-file-after"))
        .toContainText("<img src=x onerror=alert('CODE_DIFF_XSS')>");
      assert.equal(await diff.locator("img,script,a").count(),0,
        "Untrusted Code Agent source preview may never activate HTML or URLs");
      await expect(request).toHaveValue("");
      await expect(json).toHaveValue("");
      await expect(action).toBeDisabled();
      page.off("dialog",acceptDialogs);

      // Reload retains only durable IDB pending and never copies it to
      // localStorage, provider, runner or a presumed reviewed workspace.
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      const loaded=page.getByTestId("cas-isolated-editor");
      await loaded.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await loaded.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await loaded.getByRole("button",{
        name:"Apri copia IDB: Code Agent pending fixture",
      }).click();
      await expect(loaded.getByTestId("cas-isolated-code-pending-preview"))
        .toContainText(summary);
      await expect(loaded.getByTestId("cas-isolated-active"))
        .toContainText("rev. 2");
      // #165: source ZIP is generated from the pinned IDB-only scaffold,
      // not from the active legacy App, pending JSON, or unaudited review.
      const sourceZipAction=loaded.getByTestId("cas-isolated-source-zip-action");
      page.once("dialog",dialog=>void dialog.dismiss());
      await sourceZipAction.click();
      let zipConsents=0;
      const allowZip=async dialog=>{zipConsents++;await dialog.accept();};
      page.on("dialog",allowZip);
      const zipEvent=page.waitForEvent("download");
      await sourceZipAction.click();
      const zipped=await zipEvent;
      assert.equal(zipped.suggestedFilename(),
        "softwarefactory-idb-sources-"+id+"-r2.zip");
      const zipFiles=unzipSync(new Uint8Array(await readFile(await zipped.path())));
      assert.ok(zipFiles["README.md"],
        "Native IDB source ZIP must have generated scaffold files");
      assert.ok(zipFiles["docs/cas-idb-export-provenance.md"],
        "Local source ZIP must mark review and test as unverified");
      assert.ok(strFromU8(zipFiles["docs/cas-idb-export-provenance.md"])
        .includes("Unreviewed Code Agent pending edits were NOT included"));
      assert.equal(zipFiles["src/frontend/web/src/HumanFeature162.tsx"],undefined,
        "Never include an unreviewed human pending source in a ZIP");
      assert.ok(zipConsents===2,"ZIP requires consent and disk-save ACK");
      page.off("dialog",allowZip);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),pending,
        "Source ZIP readback must never write the IDB project");

      // #163: only three consents allow discarding an unreviewed pending.
      const discardButton=loaded.getByTestId("cas-isolated-code-discard-action");
      const beforeDiscard=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      page.once("dialog",dialog=>void dialog.dismiss());
      await discardButton.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),beforeDiscard);
      let discardConsents=0;
      const acceptDiscard=async dialog=>{discardConsents++;await dialog.accept();};
      page.on("dialog",acceptDiscard);
      const discardDownload=page.waitForEvent("download");
      await discardButton.click();
      const discardedBackup=await discardDownload;
      assert.equal(discardedBackup.suggestedFilename(),
        "softwarefactory-cas-before-code-discard-"+id+"-r2.json");
      assert.equal((await readFile(await discardedBackup.path())).toString("utf8"),
        beforeDiscard.raw);
      await expect(loaded.getByTestId("cas-isolated-active"))
        .toContainText("rev. 3");
      assert.equal(discardConsents,3);
      page.off("dialog",acceptDiscard);
      const afterDiscard=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.equal(afterDiscard.revision,3);
      assert.equal(JSON.parse(afterDiscard.raw).development.pending,undefined);
      assert.deepEqual(JSON.parse(afterDiscard.raw).stages,stored.stages);
      assert.equal(await discardButton.count(),0);
      const restageForm=loaded.getByTestId("cas-isolated-code-proposal");
      await restageForm.getByTestId("cas-isolated-code-request")
        .fill("A subsequent unreviewed human change");
      await restageForm.getByTestId("cas-isolated-code-json").fill(proposal);
      let restageDialogs=0;
      const restageConsent=async dialog=>{restageDialogs++;await dialog.accept();};
      page.on("dialog",restageConsent);
      await restageForm.getByRole("button",{
        name:"Salva proposta Code Agent PENDING SOLO IndexedDB con backup",
      }).click();
      await expect(loaded.getByTestId("cas-isolated-active"))
        .toContainText("rev. 4");
      assert.equal(restageDialogs,3);
      page.off("dialog",restageConsent);

      // A second never-seen ID enables a fresh pending candidate while the
      // rival commits a DIFFERENT valid raw during the FINAL consent.
      const fresh=await seed(conflictId,"Code Agent conflict fixture");
      await loaded.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await loaded.getByRole("button",{
        name:"Apri copia IDB: Code Agent conflict fixture",
      }).click();
      const form2=loaded.getByTestId("cas-isolated-code-proposal");
      const request2=form2.getByTestId("cas-isolated-code-request");
      const json2=form2.getByTestId("cas-isolated-code-json");
      const action2=form2.getByRole("button",{
        name:"Salva proposta Code Agent PENDING SOLO IndexedDB con backup",
      });
      await request2.fill("CONCURRENT_CODE_AGENT_HUMAN_DRAFT");
      await json2.fill(proposal);
      let raceDialogs=0,winner=null;
      page.on("dialog",async dialog=>{
        raceDialogs++;
        if(raceDialogs===3){
          winner=await rival.evaluate(async expected=>{
            const candidate=JSON.parse(expected.raw);
            candidate.config.description="NATIVE_COMPETING_CAS_WINNER";
            return window.FactoryProjectCas.compareAndSwapCasProject(
              candidate,expected);
          },fresh);
        }
        await dialog.accept();
      });
      const backup2=page.waitForEvent("download");
      await action2.click();
      assert.equal((await readFile(await (await backup2).path())).toString("utf8"),
        fresh.raw);
      await expect(loaded.getByRole("alert"))
        .toContainText("Operazione IndexedDB non confermata");
      await expect(request2).toHaveValue("CONCURRENT_CODE_AGENT_HUMAN_DRAFT");
      await expect(json2).toHaveValue(proposal);
      await expect(action2).toBeDisabled();
      assert.equal(raceDialogs,3);
      assert.equal(winner.revision,2);
      const winnerNow=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),conflictId);
      assert.deepEqual(winnerNow,winner,
        "Never silently merge a human Code Agent patch onto rival CAS winner");
      assert.equal(JSON.parse(winnerNow.raw).development,undefined,
        "Rival winner must not inherit a stale unreviewed code proposal");
      page.removeAllListeners("dialog");

      // A failed refresh after discard consent must not erase draft values.
      await page.evaluate(()=>Object.defineProperty(window,"indexedDB",{
        configurable:true,value:undefined,
      }));
      page.once("dialog",dialog=>void dialog.accept());
      await loaded.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      await expect(loaded.getByRole("alert"))
        .toContainText("IndexedDB non disponibile");
      await expect(json2).toHaveValue(proposal);
      // #163: a rival writes DURING final discard consent, fencing the delete.
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      const discardPanel=page.getByTestId("cas-isolated-editor");
      await discardPanel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await discardPanel.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await discardPanel.getByRole("button",{
        name:"Apri copia IDB: Code Agent pending fixture",
      }).click();
      // choose() opens asynchronously after the click event. Wait for the
      // confirmed pinned selection, not merely the button click returning,
      // before installing consent handlers for the NEXT action.
      await expect(discardPanel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 4");
      await expect(discardPanel.getByTestId("cas-isolated-code-discard-action"))
        .toBeEnabled();
      const pinnedCodeDiff=discardPanel.getByTestId(
        "cas-isolated-code-files-preview");
      await expect(pinnedCodeDiff).toContainText("rev. 4");
      const pinnedPreviewBefore=await pinnedCodeDiff.textContent();
      const beforeDiscardRace=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.equal(beforeDiscardRace.revision,4);
      // The earlier blocked refresh may not show a dialog; Playwright's
      // one-shot handlers survive page reload. Scope this race to exactly one
      // dialog listener, so no stale accept() handles its confirmations.
      page.removeAllListeners("dialog");
      const discardRaceKinds=[];
      let discardWinner=null;
      page.on("dialog",async dialog=>{
        const message=dialog.message();
        const kind=message.startsWith("Scaricare un backup JSON byte-esatto PRIMA")
          ?"backup":message.startsWith("Confermi di avere SALVATO il backup JSON")
          ?"saved":message.startsWith("ULTIMA CONFERMA: scartare SOLO")
          ?"final":"unexpected";
        discardRaceKinds.push(kind);
        if(kind==="final"){
          discardWinner=await rival.evaluate(async expected=>{
            const candidate=JSON.parse(expected.raw);
            candidate.config.description="RIVAL_DISCARD_WINNER";
            return window.FactoryProjectCas.compareAndSwapCasProject(
              candidate,expected);
          },beforeDiscardRace);
        }
        await dialog.accept();
      });
      const racedBackup=page.waitForEvent("download");
      await discardPanel.getByTestId("cas-isolated-code-discard-action")
        .click();
      assert.equal((await readFile(await (await racedBackup).path()))
        .toString("utf8"),beforeDiscardRace.raw);
      await expect(discardPanel.getByRole("alert"))
        .toContainText("Operazione IndexedDB non confermata");
      assert.deepEqual(discardRaceKinds,["backup","saved","final"],
        "Discard race must have precisely three distinct human consents");
      const afterDiscardRace=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.deepEqual(afterDiscardRace,discardWinner);
      assert.equal(afterDiscardRace.revision,5);
      assert.ok(JSON.parse(afterDiscardRace.raw).development.pending);
      // The noncooperating tab owns rev. 5, but read-only source preview
      // stays pinned to rev. 4 until explicit discard/reopen. No auto-adopt.
      assert.equal(await pinnedCodeDiff.textContent(),pinnedPreviewBefore);
      await expect(pinnedCodeDiff).toContainText("rev. 4");
      await expect(discardPanel.getByTestId(
        "cas-isolated-code-discard-action")).toBeDisabled();
      page.removeAllListeners("dialog");
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "Code Agent pending CAS pilot must never touch legacy localStorage");
      console.log("FACTORY_INDEXEDDB_CODE_PROPOSAL_UI_E2E_PASS: real CAS pending unreviewed patch, exact backup and three consents, inert summary, reload, rival final-dialog fencing, outage preserves human draft, legacy unchanged");
      console.log("FACTORY_INDEXEDDB_CODE_DISCARD_UI_E2E_PASS: native CAS pending discard with exact raw backup, 3 consents, restaging, rival final-consent fencing and zero legacy writes");
      console.log("FACTORY_INDEXEDDB_CODE_DIFF_PREVIEW_E2E_PASS: inert bounded source before/after preview, path allowlist, HTML injection escaped, pinned rev after noncooperating writer, reload and zero legacy writes");
      console.log("FACTORY_INDEXEDDB_SOURCE_ZIP_STAGE_E2E_PASS: IDB-only source ZIP includes generated scaffold/provenance, never pending JSON, exact pinned filename and two consents, no DB writes");
    }finally{
      await codePatchContext.close();
    }

    // #169: human-only Code Agent pending → actual source overrides in the
    // root CAS workspace. No independent review, tests, runner or GitHub.
    const applyContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await applyContext.newPage(),rival=await applyContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/?workspace=cas",
          {waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/?workspace=cas",
          {waitUntil:"networkidle"}),
      ]);
      await Promise.all([
        page.addScriptTag({content:casBundle}),
        rival.addScriptTag({content:casBundle}),
      ]);
      const id="16916916-9169-4169-8169-169169169169";
      const initial=await rival.evaluate(async id=>{
        const now="2026-11-22T20:25:00.000Z";
        const stages=["features","competitors","technical","architecture",
          "adversarial","implementation"].map(name=>({
          id:name,label:name,status:"pending",output:"",sources:[],
        }));
        return window.FactoryProjectCas.compareAndSwapCasProject({
          id,createdAt:now,updatedAt:now,stages,
          config:{name:"Human CAS source apply",
            description:"Human changes are never independent reviews",
            requirements:"No tests, runner or GitHub actions are performed",
            frontends:["react"],deployment:"docker",dotnetVersion:"11.0",
            database:"postgresql",services:{
              database:{development:"postgresql",production:"postgresql"},
              cache:{development:"none",production:"none"},
              queue:{development:"none",production:"none"},
              telemetry:{development:"opentelemetry-jaeger",
                production:"opentelemetry-jaeger"},
              storage:{development:"local",production:"local"},
            }},
        },null);
      },id);
      const legacyBefore=await page.evaluate(()=>({
        pointer:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage)
          .filter(k=>k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      await expect(page.getByTestId("cas-root-shell")).toBeVisible();
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await panel.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Human CAS source apply",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      const proposalBox=panel.getByTestId("cas-isolated-code-proposal");
      const proposedPath="src/frontend/web/src/OperatorHuman169.tsx";
      const proposedBody="export const Human169=()=> <div>HUMAN_UNVERIFIED_169</div>;";
      const proposal=JSON.stringify({
        summary:"Operator patch WITHOUT independent review",
        files:[{path:proposedPath,content:proposedBody,
          reason:"Human source transfer, no tests have run"}],
        tests:["web-build"],
        assumptions:["Not a report of tests actually run"],
      });
      await proposalBox.getByTestId("cas-isolated-code-request")
        .fill("Human source change");
      await proposalBox.getByTestId("cas-isolated-code-json")
        .fill(proposal);
      let stagingDialogs=0;
      page.on("dialog",dialog=>{
        stagingDialogs++;void dialog.accept();
      });
      await proposalBox.getByRole("button",{
        name:"Salva proposta Code Agent PENDING SOLO IndexedDB con backup",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 2");
      assert.equal(stagingDialogs,3);
      page.removeAllListeners("dialog");
      const beforeApply=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const apply=proposalBox.getByTestId(
        "cas-isolated-code-human-apply-action");
      await expect(apply).toBeEnabled();
      await expect(proposalBox.getByTestId(
        "cas-isolated-code-human-apply"))
        .toContainText("NON revisionata");
      const sourcePreview=proposalBox.getByTestId(
        "cas-isolated-code-files-preview");
      await sourcePreview.locator("summary").click();
      await expect(sourcePreview).toContainText(proposedBody);
      // Human refusing first dialog never applies or clears the pending.
      page.once("dialog",dialog=>void dialog.dismiss());
      await apply.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),beforeApply);

      let applyConsents=0;
      const approve=async dialog=>{applyConsents++;await dialog.accept();};
      page.on("dialog",approve);
      const backupEvent=page.waitForEvent("download");
      await apply.click();
      const backup=await backupEvent;
      assert.equal(backup.suggestedFilename(),
        "softwarefactory-cas-before-human-apply-"+id+"-r2.json");
      assert.equal((await readFile(await backup.path())).toString("utf8"),
        beforeApply.raw,"Application backup must be byte exact source JSON");
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 3");
      assert.equal(applyConsents,3);
      page.off("dialog",approve);
      const persisted=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const applied=JSON.parse(persisted.raw);
      assert.equal(persisted.revision,3);
      assert.equal(applied.development.pending,undefined);
      assert.equal(applied.development.revision,1);
      assert.equal(applied.development.overrides[proposedPath],proposedBody);
      assert.equal(applied.development.originals[proposedPath],null);
      assert.deepEqual(applied.development.history,[]);
      assert.equal(applied.development.humanApplications.length,1);
      assert.deepEqual(applied.development.humanApplications[0].paths,
        [proposedPath]);
      assert.equal(applied.development.humanApplications[0].status,
        "operator-unverified");
      assert.equal(applied.development.lastRunnerEvidence,undefined);
      assert.equal(applied.githubTestReceipt,undefined);
      assert.equal(applied.githubSync,undefined);
      assert.deepEqual(applied.stages,JSON.parse(initial.raw).stages);
      await expect(apply).toHaveCount(0);
      // Source ZIP now includes the human override but never fabricates
      // feature implementation or independent reviewer history.
      const zipButton=panel.getByTestId("cas-isolated-source-zip-action");
      let zipDialogs=0;
      page.on("dialog",dialog=>{zipDialogs++;void dialog.accept();});
      const zipEvent=page.waitForEvent("download");
      await zipButton.click();
      const zip=await zipEvent;
      const source=unzipSync(new Uint8Array(await readFile(await zip.path())));
      assert.equal(strFromU8(source[proposedPath]),proposedBody);
      assert.equal(source["docs/feature-implementation.md"],undefined);
      assert.ok(strFromU8(source["docs/cas-idb-export-provenance.md"])
        .includes("operator-applied"));
      assert.equal(zipDialogs,2);
      page.removeAllListeners("dialog");
      // Reload is an explicit read-only operation; a human application
      // remains persisted and is not upgraded to a reviewed history record.
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      const reloadedPanel=page.getByTestId("cas-isolated-editor");
      await reloadedPanel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await reloadedPanel.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await reloadedPanel.getByRole("button",{
        name:"Apri copia IDB: Human CAS source apply",
      }).click();
      await expect(reloadedPanel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 3");
      const box=reloadedPanel.getByTestId("cas-isolated-code-proposal");
      await box.getByTestId("cas-isolated-code-request")
        .fill("Second operator source after first human transfer");
      const secondPath="src/frontend/web/src/HumanRace169.tsx";
      await box.getByTestId("cas-isolated-code-json").fill(JSON.stringify({
        summary:"Another pending, no reviewer",
        files:[{path:secondPath,
          content:"export const SecondHuman169=1;",
          reason:"Manual source that must not beat rival"}],
      }));
      let secondStageDialogs=0;
      page.on("dialog",dialog=>{secondStageDialogs++;void dialog.accept();});
      await box.getByRole("button",{
        name:"Salva proposta Code Agent PENDING SOLO IndexedDB con backup",
      }).click();
      await expect(reloadedPanel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 4");
      assert.equal(secondStageDialogs,3);
      page.removeAllListeners("dialog");
      const beforeRace=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const racedApply=box.getByTestId(
        "cas-isolated-code-human-apply-action");
      await expect(racedApply).toBeEnabled();
      let racedDialogs=0,winner=null;
      page.on("dialog",async dialog=>{
        racedDialogs++;
        if(racedDialogs===3){
          winner=await rival.evaluate(async expected=>{
            const next=JSON.parse(expected.raw);
            next.config.description="RIVAL_WINS_HUMAN_APPLY_169";
            return window.FactoryProjectCas.compareAndSwapCasProject(
              next,expected);
          },beforeRace);
        }
        await dialog.accept();
      });
      const racedBackup=page.waitForEvent("download");
      await racedApply.click();
      assert.equal((await readFile(await (await racedBackup).path()))
        .toString("utf8"),beforeRace.raw);
      await expect(reloadedPanel.getByRole("alert"))
        .toContainText("Operazione IndexedDB non confermata");
      assert.equal(racedDialogs,3);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),winner);
      const winnerParsed=JSON.parse(winner.raw);
      assert.ok(winnerParsed.development.pending);
      assert.equal(winnerParsed.development.overrides[secondPath],undefined);
      assert.equal(winnerParsed.development.humanApplications.length,1);
      await expect(racedApply).toBeDisabled();
      page.removeAllListeners("dialog");
      assert.deepEqual(await page.evaluate(()=>({
        pointer:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage)
          .filter(k=>k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      })),legacyBefore);
      console.log("FACTORY_INDEXEDDB_HUMAN_PATCH_APPLY_E2E_PASS: root CAS human-only source transfer, exact backup + 3 consents, no fake review/runner/tests/GitHub, zip provenance and actual overrides, reload, rival final consent conflict fenced, legacy untouched");
    }finally{
      await applyContext.close();
    }

    // #170: full native CAS human patch apply->UNDO, no arbitrary source
    // reconstruction; only exact before/after metadata or proven legacy
    // additions may be restored. Two tabs fence the FINAL human consent.
    const undoContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await undoContext.newPage();
      const rival=await undoContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/?workspace=cas",
          {waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/?workspace=cas",
          {waitUntil:"networkidle"}),
      ]);
      for(const tab of [page,rival])
        await tab.addScriptTag({content:casBundle});
      const id="17017017-0170-4170-8170-170170170170";
      const filePath="src/frontend/web/src/HumanUndo170.tsx";
      const fileBody="export const HumanUndo170=()=> <p>HUMAN_SOURCE_170</p>;";
      const original=await rival.evaluate(async ({id})=>{
        const now="2026-11-22T20:30:00.000Z";
        const project={
          id,createdAt:now,updatedAt:now,config:{
            name:"CAS human undo 170",
            description:"Human source undo only",requirements:"No review",
            frontends:["react"],deployment:"docker",dotnetVersion:"11.0",
            database:"postgresql",services:{
              database:{development:"postgresql",production:"postgresql"},
              cache:{development:"none",production:"none"},
              queue:{development:"none",production:"none"},
              telemetry:{development:"opentelemetry-jaeger",
                production:"opentelemetry-jaeger"},
              storage:{development:"local",production:"local"},
            },
          },
          stages:["features","competitors","technical","architecture",
            "adversarial","implementation"].map((stage,i)=>({
            id:stage,label:stage,status:i===0?"complete":"pending",
            output:i===0?"PRE_UNDO_MANUAL_170":"",
            ...(i===0?{completionOrigin:"manual"}:{}),sources:[],
          })),
        };
        return window.FactoryProjectCas.compareAndSwapCasProject(
          project,null);
      },{id});
      const legacyBefore=await page.evaluate(()=>({
        pointer:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage)
          .filter(k=>k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await panel.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",d=>void d.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: CAS human undo 170",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      const form=panel.getByTestId("cas-isolated-code-proposal");
      const stage=async(body,summary)=>{
        await form.getByTestId("cas-isolated-code-request")
          .fill("Apply an operator supplied source file");
        await form.getByTestId("cas-isolated-code-json").fill(JSON.stringify({
          summary,files:[{path:filePath,content:body,
            reason:"Human source is not reviewed"}],
        }));
        let count=0;
        const dialogs=d=>{count++;void d.accept();};
        page.on("dialog",dialogs);
        await form.getByRole("button",{
          name:"Salva proposta Code Agent PENDING SOLO IndexedDB con backup",
        }).click();
        page.off("dialog",dialogs);
        assert.equal(count,3);
      };
      const apply=async()=>{
        let count=0;
        const dialogs=d=>{count++;void d.accept();};
        page.on("dialog",dialogs);
        await form.getByTestId(
          "cas-isolated-code-human-apply-action").click();
        page.off("dialog",dialogs);
        assert.equal(count,3);
      };
      await stage(fileBody,"First operator unreviewed application");
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 2");
      await apply();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 3");
      const applied=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const before=JSON.parse(applied.raw);
      assert.equal(before.development.overrides[filePath],fileBody);
      assert.deepEqual(before.development.humanApplications[0].files,
        [{path:filePath,before:null,after:fileBody}]);
      const undoPanel=panel.getByTestId("cas-isolated-human-undo");
      const undoAction=undoPanel.getByTestId("cas-isolated-human-undo-action");
      await expect(undoAction).toBeEnabled();
      const undoPreview=undoPanel.getByTestId(
        "cas-isolated-human-undo-preview");
      await undoPreview.locator("summary").click();
      await expect(undoPreview.getByTestId(
        "cas-isolated-human-undo-current")).toContainText(fileBody);
      await expect(undoPreview.getByTestId(
        "cas-isolated-human-undo-remove"))
        .toContainText("RIMOSSO");
      page.once("dialog",d=>void d.dismiss());
      await undoAction.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),applied,
        "Declining undo consent leaves native CAS source unchanged");
      let consents=0;
      const acceptUndo=async d=>{consents++;await d.accept();};
      page.on("dialog",acceptUndo);
      const backupEvent=page.waitForEvent("download");
      await undoAction.click();
      const backup=await backupEvent;
      assert.equal(backup.suggestedFilename(),
        "softwarefactory-cas-before-human-undo-"+id+"-r3.json");
      assert.equal((await readFile(await backup.path())).toString("utf8"),
        applied.raw,"Undo backup is byte-exact prior full project JSON");
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 4");
      assert.equal(consents,3);
      page.off("dialog",acceptUndo);
      const undone=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const restored=JSON.parse(undone.raw);
      assert.equal(restored.development.revision,2);
      assert.equal(restored.development.overrides[filePath],undefined);
      assert.equal(restored.development.originals[filePath],undefined);
      assert.equal(restored.development.pending,undefined);
      assert.equal(restored.development.history.length,0);
      assert.equal(restored.development.humanApplications[0].status,"reverted");
      assert.ok(restored.development.humanApplications[0].revertedAt);
      assert.ok(restored.stages.every(s=>s.status==="pending" &&
        s.output==="" && s.sources.length===0 && !s.completionOrigin));
      assert.equal(restored.githubSync,undefined);
      assert.equal(restored.githubTestReceipt,undefined);
      await expect(undoAction).toBeDisabled();
      // The real source ZIP must NOT include an undone human-added file.
      const zipAction=panel.getByTestId("cas-isolated-source-zip-action");
      let zipDialogCount=0;
      const acceptZip=d=>{zipDialogCount++;void d.accept();};
      page.on("dialog",acceptZip);
      const zipEvent=page.waitForEvent("download");
      await zipAction.click();
      const zip=await zipEvent;
      const files=unzipSync(new Uint8Array(await readFile(await zip.path())));
      assert.equal(files[filePath],undefined);
      assert.equal(files["docs/feature-implementation.md"],undefined);
      assert.ok(strFromU8(files["docs/cas-idb-export-provenance.md"])
        .includes("UNVERIFIED"));
      assert.equal(zipDialogCount,2);
      page.off("dialog",acceptZip);
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      const again=page.getByTestId("cas-isolated-editor");
      await again.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await again.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",d=>void d.accept());
      await again.getByRole("button",{
        name:"Apri copia IDB: CAS human undo 170",
      }).click();
      await expect(again.getByTestId("cas-isolated-active"))
        .toContainText("rev. 4");
      await expect(again.getByTestId(
        "cas-isolated-human-undo-action")).toBeDisabled();
      // New operator source can be applied *after* an earlier reverted
      // ledger record. Its own undo requires exact metadata and native CAS.
      const againForm=again.getByTestId("cas-isolated-code-proposal");
      await againForm.getByTestId("cas-isolated-code-request")
        .fill("Subsequent human source after previous undo");
      await againForm.getByTestId("cas-isolated-code-json").fill(JSON.stringify({
        summary:"Second human code after undo",
        files:[{path:filePath,
          content:"export const HumanUndo170=2;",
          reason:"Unverified operator code"}],
      }));
      let secondStaging=0;
      const approveSecond=d=>{secondStaging++;void d.accept();};
      page.on("dialog",approveSecond);
      await againForm.getByRole("button",{
        name:"Salva proposta Code Agent PENDING SOLO IndexedDB con backup",
      }).click();
      await expect(again.getByTestId("cas-isolated-active"))
        .toContainText("rev. 5");
      page.off("dialog",approveSecond);
      assert.equal(secondStaging,3);
      let secondApply=0;
      const approveSecondApply=d=>{secondApply++;void d.accept();};
      page.on("dialog",approveSecondApply);
      await againForm.getByTestId(
        "cas-isolated-code-human-apply-action").click();
      await expect(again.getByTestId("cas-isolated-active"))
        .toContainText("rev. 6");
      page.off("dialog",approveSecondApply);
      assert.equal(secondApply,3);
      const beforeRace=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const raceUndo=again.getByTestId("cas-isolated-human-undo-action");
      await expect(raceUndo).toBeEnabled();
      let raceDialogs=0,winner=null;
      page.on("dialog",async d=>{
        raceDialogs++;
        if(raceDialogs===3){
          winner=await rival.evaluate(async expected=>{
            const p=JSON.parse(expected.raw);
            p.config.description="RIVAL_WINS_HUMAN_UNDO_170";
            return window.FactoryProjectCas.compareAndSwapCasProject(
              p,expected);
          },beforeRace);
        }
        await d.accept();
      });
      const racedBackupEvent=page.waitForEvent("download");
      await raceUndo.click();
      assert.equal((await readFile(await
        (await racedBackupEvent).path())).toString("utf8"),
        beforeRace.raw);
      await expect(again.getByRole("alert"))
        .toContainText("Operazione IndexedDB non confermata");
      assert.equal(raceDialogs,3);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),winner);
      const raced=JSON.parse(winner.raw);
      assert.equal(raced.development.overrides[filePath],
        "export const HumanUndo170=2;");
      assert.equal(raced.development.humanApplications[1].status,
        "operator-unverified");
      await expect(raceUndo).toBeDisabled();
      page.removeAllListeners("dialog");

      // Historical #169 path-only ledger: only a fresh addition is safe.
      const legacyId="17017017-0170-4170-8170-170170170171";
      const historical=await rival.evaluate(async id=>{
        const now="2026-11-22T20:30:00.000Z";
        const path="src/frontend/web/src/HistoricalHuman170.tsx";
        const content="export const HistoricalHuman170=1;";
        return window.FactoryProjectCas.compareAndSwapCasProject({
          id,createdAt:now,updatedAt:now,
          config:{name:"Historical 169 additive patch",
            description:"Pre-metadata human source addition",
            requirements:"Never guess an overwritten before-image",
            frontends:["react"],deployment:"docker",dotnetVersion:"11.0",
            database:"postgresql",services:{
              database:{development:"postgresql",production:"postgresql"},
              cache:{development:"none",production:"none"},
              queue:{development:"none",production:"none"},
              telemetry:{development:"opentelemetry-jaeger",
                production:"opentelemetry-jaeger"},
              storage:{development:"local",production:"local"},
            },
          },
          stages:["features","competitors","technical","architecture",
            "adversarial","implementation"].map(name=>({
            id:name,label:name,status:"pending",output:"",sources:[],
          })),
          development:{
            revision:1,overrides:{[path]:content},
            originals:{[path]:null},history:[],
            humanApplications:[{
              id:"old-app-169",summary:"Historical manual source",
              appliedAt:now,revision:1,paths:[path],
              status:"operator-unverified",
            }],
          },
        },null);
      },legacyId);
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      const legacyPanel=page.getByTestId("cas-isolated-editor");
      await legacyPanel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await legacyPanel.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",d=>void d.accept());
      await legacyPanel.getByRole("button",{
        name:"Apri copia IDB: Historical 169 additive patch",
      }).click();
      const legacyUndo=legacyPanel.getByTestId(
        "cas-isolated-human-undo-action");
      await expect(legacyUndo).toBeEnabled();
      await expect(legacyPanel.getByTestId(
        "cas-isolated-human-undo-preview"))
        .toContainText("Ledger storico senza before");
      let oldDialogs=0;
      const oldConsent=d=>{oldDialogs++;void d.accept();};
      page.on("dialog",oldConsent);
      const oldBackupEvent=page.waitForEvent("download");
      await legacyUndo.click();
      const oldBackup=await oldBackupEvent;
      assert.equal((await readFile(await oldBackup.path())).toString("utf8"),
        historical.raw);
      await expect(legacyPanel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 2");
      assert.equal(oldDialogs,3);
      page.off("dialog",oldConsent);
      const oldUndone=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),legacyId);
      assert.equal(JSON.parse(oldUndone.raw).development.overrides[
        "src/frontend/web/src/HistoricalHuman170.tsx"],undefined);
      assert.deepEqual(await page.evaluate(()=>({
        pointer:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage)
          .filter(k=>k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      })),legacyBefore);
      console.log("FACTORY_INDEXEDDB_HUMAN_PATCH_UNDO_E2E_PASS: CAS source apply/undo with exact file ledger and pre-write backup + 3 consents, stage invalidation, ZIP excludes removed file, persistent reload, prior reverted audit accepts new apply, rival final-consent write fenced, historical #169 additive-only undo, no legacy writes");
    }finally{
      await undoContext.close();
    }

    // #165: stale native IndexedDB source ZIP must never download/auto-rebase.
    const zipRaceContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await zipRaceContext.newPage();
      const rival=await zipRaceContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await Promise.all([
        page.addScriptTag({content:casBundle}),
        rival.addScriptTag({content:casBundle}),
      ]);
      const id="16516516-5165-4165-8165-165165165165";
      const now="2026-11-22T17:10:00.000Z";
      const original=await rival.evaluate(async ({id,now})=>{
        const stages=["features","competitors","technical","architecture",
          "adversarial","implementation"].map(name=>({
          id:name,label:name,status:"pending",output:"",sources:[],
        }));
        return window.FactoryProjectCas.compareAndSwapCasProject({
          id,createdAt:now,updatedAt:now,
          config:{name:"Native ZIP concurrency fixture",
            description:"Only IndexedDB native source export",
            requirements:"No stale downloads",
            frontends:["react"],deployment:"docker",dotnetVersion:"11.0",
            database:"postgresql",services:{
              database:{development:"postgresql",production:"postgresql"},
              cache:{development:"none",production:"none"},
              queue:{development:"none",production:"none"},
              telemetry:{development:"opentelemetry-jaeger",
                production:"opentelemetry-jaeger"},
              storage:{development:"local",production:"local"},
            },
          },stages,
        },null);
      },{id,now});
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await panel.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Native ZIP concurrency fixture",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      const zipAction=panel.getByTestId("cas-isolated-source-zip-action");
      await expect(zipAction).toBeEnabled();
      // Noncooperating tab wins while the human grants permission to read:
      // the native confirmCasIsolatedExport readback must detect it.
      let winner=null,consents=0,downloads=0;
      page.on("download",()=>{downloads++;});
      page.on("dialog",async dialog=>{
        consents++;
        if(consents===1){
          winner=await rival.evaluate(async expected=>{
            const updated=JSON.parse(expected.raw);
            updated.config.description="Native rival won before ZIP readback";
            return window.FactoryProjectCas.compareAndSwapCasProject(
              updated,expected);
          },original);
        }
        await dialog.accept();
      });
      await zipAction.click();
      await expect(panel.getByText(/ZIP annullato: la copia IndexedDB/))
        .toBeVisible();
      assert.equal(consents,1,"Do not acknowledge a ZIP never downloaded");
      assert.equal(downloads,0,"No stale ZIP on rival CAS win");
      const current=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.deepEqual(current,winner);
      assert.equal(current.revision,2);
      assert.deepEqual(await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      })),legacyBefore);
      console.log("FACTORY_INDEXEDDB_SOURCE_ZIP_E2E_PASS: real Chromium zipped scaffold excludes pending, native revision/raw readback rejects rival writer and never writes legacy");
    }finally{
      await zipRaceContext.close();
    }

    // #166: two real tabs; an atomic native IDB SOURCE read + never-seen
    // target insert. The fork is config-only, no historical AI/Code Agent
    // review/runner/GitHub evidence, no adoption by the active legacy App.
    const forkContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await forkContext.newPage();
      const rival=await forkContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await Promise.all([
        page.addScriptTag({content:casBundle}),
        rival.addScriptTag({content:casBundle}),
      ]);
      const id="16616616-6166-4166-8166-166166166166";
      const original=await rival.evaluate(async id=>{
        const now="2026-11-22T18:25:00.000Z";
        const stages=["features","competitors","technical","architecture",
          "adversarial","implementation"].map((s,i)=>({
          id:s,label:s,status:i===0?"complete":"pending",
          output:i===0?"Unverified historical model research":"",
          sources:[],...(i===0?{completionOrigin:"ai"}:{}),
        }));
        return window.FactoryProjectCas.compareAndSwapCasProject({
          id,createdAt:now,updatedAt:now,stages,
          config:{name:"Configuration fork source",
            description:"Only native IndexedDB source",
            requirements:"No inherited evidence or GitHub bindings",
            frontends:["react"],deployment:"docker",dotnetVersion:"11.0",
            database:"postgresql",services:{
              database:{development:"postgresql",production:"postgresql"},
              cache:{development:"redis",production:"none"},
              queue:{development:"none",production:"none"},
              telemetry:{development:"opentelemetry-jaeger",
                production:"opentelemetry-jaeger"},
              storage:{development:"local",production:"local"},
            }},
          development:{revision:1,overrides:{},originals:{},history:[],
            lastRunnerJobId:"historic-runner-not-copyable",
            pending:{id:"stale-pending",request:"Not verified",
              summary:"No automatic approval",createdAt:now,revision:1,
              edits:[],tests:[],assumptions:[]}},
          githubDestination:{owner:"legacy",repo:"old",
            branch:"main",privateRepo:false,authMode:"pat",appGateway:""},
          githubSync:{owner:"legacy",repo:"old",branch:"main",
            lastCommit:"historic",syncedLocalUpdatedAt:now,
            syncedAt:now,publicConsent:true},
          githubTestReceipt:{requestId:"old",repository:"legacy/old",
            branch:"main",commitSha:"historic",createdAt:now,
            selected:["web-build"],runId:15},
        },null);
      },id);
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await panel.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Configuration fork source",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      const fork=panel.getByTestId("cas-isolated-config-fork-action");
      await expect(fork).toBeEnabled();
      // Declining the initial backup consent never creates a new ID.
      page.once("dialog",dialog=>void dialog.dismiss());
      await fork.click();
      assert.equal((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,1);

      let consentCount=0,createdId=null;
      const acceptAll=async dialog=>{
        consentCount++;
        if(consentCount===3){
          const match=/ID: ([0-9a-f-]{36})/i.exec(dialog.message());
          assert.ok(match,"Final fork consent contains the new immutable ID");
          createdId=match[1];
        }
        await dialog.accept();
      };
      page.on("dialog",acceptAll);
      const downloadPromise=page.waitForEvent("download");
      await fork.click();
      const backup=await downloadPromise;
      assert.equal(backup.suggestedFilename(),
        "softwarefactory-cas-before-fork-"+id+"-r1.json");
      assert.equal((await readFile(await backup.path())).toString("utf8"),
        original.raw,"Fork backup must be byte-exact source JSON");
      await expect(panel.getByText(/Nuovo progetto di configurazione IndexedDB/))
        .toBeVisible();
      assert.equal(consentCount,3,"Fork requires three distinct consents");
      page.off("dialog",acceptAll);
      assert.ok(createdId && createdId!==id);
      const clone=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),createdId);
      assert.equal(clone.revision,1);
      const fresh=JSON.parse(clone.raw),src=JSON.parse(original.raw);
      assert.deepEqual(fresh.config,{...src.config,name:src.config.name+" (copy)"});
      assert.ok(fresh.stages.every(s=>s.status==="pending" &&
        s.output==="" && s.sources.length===0 &&
        s.completionOrigin===undefined));
      assert.equal(fresh.development,undefined);
      assert.equal(fresh.githubDestination,undefined);
      assert.equal(fresh.githubSync,undefined);
      assert.equal(fresh.githubTestReceipt,undefined);
      assert.equal(fresh.createdAt,fresh.updatedAt);
      assert.equal(fresh.id,createdId);
      assert.ok(!clone.raw.includes("historic-runner-not-copyable"));
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText(id);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),original);
      assert.equal((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,2);

      // The uncooperative writer changes SOURCE while the third human
      // consent is open: atomic source CAS must abort target insert, not
      // create a copy of an obsolete configuration.
      let racedId=null,raceWinner=null,raceDialogs=0;
      page.on("dialog",async dialog=>{
        raceDialogs++;
        if(raceDialogs===3){
          const match=/ID: ([0-9a-f-]{36})/i.exec(dialog.message());
          assert.ok(match);racedId=match[1];
          raceWinner=await rival.evaluate(async expected=>{
            const next=JSON.parse(expected.raw);
            next.config.description="SOURCE_RIVAL_WON_DURING_FORK";
            return window.FactoryProjectCas.compareAndSwapCasProject(
              next,expected);
          },original);
        }
        await dialog.accept();
      });
      const racedBackupEvent=page.waitForEvent("download");
      await fork.click();
      assert.equal((await readFile(await (await racedBackupEvent).path()))
        .toString("utf8"),original.raw);
      await expect(panel.getByRole("alert"))
        .toContainText("Operazione IndexedDB non confermata");
      assert.equal(raceDialogs,3);
      assert.equal((await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),racedId)).state,
        "missing","Stale fork never creates a target");
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),raceWinner);
      assert.equal((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,2);
      page.removeAllListeners("dialog");
      assert.deepEqual(await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      })),legacyBefore);

      // Independent reopen can adopt the fork intentionally. It is NOT
      // silently made the active IDB project after successful creation.
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      const reopened=page.getByTestId("cas-isolated-editor");
      await reopened.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await reopened.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await reopened.getByRole("button",{
        name:"Apri copia IDB: Configuration fork source (copy)",
      }).click();
      await expect(reopened.getByTestId("cas-isolated-active"))
        .toContainText(createdId);
      // The new native primitive also rejects an existing destination
      // tombstone and enforces cap40 in the SAME transaction as the insert.
      const targetId="16616616-6166-4166-8166-166166166167";
      const nativeFixture=await rival.evaluate(async ({id,template})=>{
        const created=await window.FactoryProjectCas.compareAndSwapCasProject(
          {...template,id},null);
        return window.FactoryProjectCas.deleteCasProject(id,created);
      },{id:targetId,template:fresh});
      assert.equal(nativeFixture.revision,2);
      const refusedTombstone=await rival.evaluate(async ({source,template,id})=>{
        const target={...template,id,
          config:{...JSON.parse(source.raw).config,name:"Tombstone fork"}};
        try{
          await window.FactoryProjectCas.forkCasProjectConfiguration(
            source,target,true);
          return "unexpected_success";
        }catch{return "refused";}
      },{source:raceWinner,template:fresh,id:targetId});
      assert.equal(refusedTombstone,"refused");
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),targetId),
        {state:"tombstone",revision:2});

      const capacity=await rival.evaluate(async template=>{
        for(let i=1;i<=38;i++){
          const id="16616616-6166-4166-8166-a"+
            String(i).padStart(11,"0");
          await window.FactoryProjectCas.compareAndSwapCasProject(
            {...template,id},null);
        }
        return (await window.FactoryProjectCas.listCasProjects()).length;
      },fresh);
      assert.equal(capacity,40);
      const refusedCapacity=await rival.evaluate(async ({source,template})=>{
        const target={...template,
          id:"16616616-6166-4166-8166-166166166168",
          config:{...JSON.parse(source.raw).config,name:"Overflow fork"}};
        try{
          await window.FactoryProjectCas.forkCasProjectConfiguration(
            source,target,true);
          return "unexpected_success";
        }catch{return "refused";}
      },{source:raceWinner,template:fresh});
      assert.equal(refusedCapacity,"refused");
      assert.equal((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,40);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),raceWinner);
      console.log("FACTORY_INDEXEDDB_CONFIG_FORK_E2E_PASS: atomic native source revision/raw + never-seen fork, exact backup, 3 consents, stage and external evidence reset, rival third-consent abort, explicit reopen, tombstone/cap40 fencing and zero legacy writes");
    }finally{
      await forkContext.close();
    }

    // #161: real Chromium native CAS commit of HUMAN stage output with
    // revision-fenced manual provenance, 3 consents, predecessor/downstream
    // lifecycle and a competing noncooperating tab on final consent.
    const humanStageContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await humanStageContext.newPage();
      const rival=await humanStageContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await Promise.all([
        page.addScriptTag({content:casBundle}),
        rival.addScriptTag({content:casBundle}),
      ]);
      const id="16116116-1161-4161-8161-161161161161";
      const initial=await rival.evaluate(async id=>{
        const now="2026-11-22T01:00:00.000Z";
        return window.FactoryProjectCas.compareAndSwapCasProject({
          id,config:{name:"Human CAS checkpoint",
            description:"Manual output only, no AI provider",
            requirements:"Never misstate human work as an independent review"},
          stages:["features","competitors","technical","architecture",
            "adversarial","implementation"].map(stage=>({
            id:stage,label:stage,status:"pending",output:"",sources:[],
          })),
          createdAt:now,updatedAt:now,
        },null);
      },id);
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      page.once("dialog",dlg=>void dlg.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Human CAS checkpoint",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");

      const manual=panel.getByTestId("cas-isolated-manual-stage");
      const textArea=manual.getByTestId("cas-isolated-manual-input");
      const action=manual.getByRole("button",{
        name:"Salva output UMANO SOLO IndexedDB con backup",
      });
      const humanText="<script>alert('INERT')</script> HUMAN_FEATURE_PLAN";
      await textArea.fill(humanText);
      await expect(action).toBeEnabled();
      page.once("dialog",dlg=>void dlg.dismiss());
      await action.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),initial,
        "Declined manual-stage backup consent cannot mutate native CAS");
      await expect(textArea).toHaveValue(humanText);

      let firstConsents=0;
      const acceptFirst=async dlg=>{firstConsents++;await dlg.accept();};
      page.on("dialog",acceptFirst);
      const backup=page.waitForEvent("download");
      await action.click();
      const firstDownload=await backup;
      assert.equal((await readFile(await firstDownload.path())).toString("utf8"),
        initial.raw,"Human stage pre-edit backup must preserve exact raw JSON");
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 2");
      assert.equal(firstConsents,3,"Human stage needs THREE separate consents");
      await expect(textArea).toHaveValue("");
      const savedFirst=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const firstProject=JSON.parse(savedFirst.raw);
      assert.equal(savedFirst.revision,2);
      assert.equal(firstProject.stages[0].output,humanText);
      assert.equal(firstProject.stages[0].completionOrigin,"manual");
      assert.deepEqual(firstProject.stages[0].sources,[]);
      assert.equal(firstProject.stages[0].status,"complete");
      assert.equal(firstProject.stages[1].status,"pending");
      const firstView=panel.getByTestId("cas-isolated-stage-features");
      await expect(firstView.getByTestId("cas-isolated-stage-origin"))
        .toContainText("testo scritto dall'operatore");
      await firstView.locator("details").first().locator("summary").click();
      await expect(firstView.getByTestId("cas-isolated-stage-output"))
        .toContainText(humanText);
      assert.equal(await firstView.locator("script").count(),0,
        "Human-entered HTML must remain inert text, never executable markup");
      page.off("dialog",acceptFirst);

      // A second stage can be completed manually only after the first.
      await manual.locator("select").selectOption("competitors");
      await textArea.fill("HUMAN_COMPETITOR_RESEARCH");
      let secondConsents=0;
      const acceptSecond=async dlg=>{secondConsents++;await dlg.accept();};
      page.on("dialog",acceptSecond);
      const backup2=page.waitForEvent("download");
      await action.click();
      assert.equal((await readFile(await (await backup2).path())).toString("utf8"),
        savedFirst.raw);
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 3");
      assert.equal(secondConsents,3);
      const savedSecond=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const secondProject=JSON.parse(savedSecond.raw);
      assert.equal(secondProject.stages[1].completionOrigin,"manual");
      assert.equal(secondProject.stages[1].output,"HUMAN_COMPETITOR_RESEARCH");
      page.off("dialog",acceptSecond);

      // Editing an earlier complete stage invalidates ALL successors,
      // including the newly completed human stage; prior stages remain.
      await manual.locator("select").selectOption("features");
      await textArea.fill("CORRECTED_HUMAN_FEATURES");
      let thirdConsents=0;
      const acceptThird=async dlg=>{thirdConsents++;await dlg.accept();};
      page.on("dialog",acceptThird);
      const backup3=page.waitForEvent("download");
      await action.click();
      assert.equal((await readFile(await (await backup3).path())).toString("utf8"),
        savedSecond.raw);
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 4");
      assert.equal(thirdConsents,3);
      const corrected=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      const correctedProject=JSON.parse(corrected.raw);
      assert.equal(correctedProject.stages[0].output,"CORRECTED_HUMAN_FEATURES");
      assert.equal(correctedProject.stages[0].completionOrigin,"manual");
      assert.ok(correctedProject.stages.slice(1).every(stage=>
        stage.status==="pending" && stage.output==="" &&
        stage.sources.length===0 && stage.completionOrigin===undefined),
        "Human correction MUST invalidate every later stage and origin");
      page.off("dialog",acceptThird);

      // Rival changes the SAME CAS slot while the third dialog is open.
      // Candidate is stale: leave the user's text in place, block session,
      // do not auto-merge or add a falsely completed stage.
      await manual.locator("select").selectOption("competitors");
      const conflictDraft="UNSAVED_HUMAN_CONFLICT_DRAFT";
      await textArea.fill(conflictDraft);
      let finalConsents=0,winningRevision=null;
      page.on("dialog",async dlg=>{
        finalConsents++;
        if(finalConsents===3){
          winningRevision=await rival.evaluate(async expected=>{
            const p=JSON.parse(expected.raw);
            p.config.description="RIVAL_NATIVE_WINNER_NO_AUTOMERGE";
            return window.FactoryProjectCas.compareAndSwapCasProject(
              p,expected);
          },corrected);
        }
        await dlg.accept();
      });
      const backup4=page.waitForEvent("download");
      await action.click();
      assert.equal((await readFile(await (await backup4).path())).toString("utf8"),
        corrected.raw);
      await expect(panel.getByRole("alert"))
        .toContainText("Operazione IndexedDB non confermata");
      await expect(textArea).toHaveValue(conflictDraft);
      await expect(action).toBeDisabled();
      assert.equal(finalConsents,3);
      assert.equal(winningRevision.revision,5);
      const actualWinner=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.deepEqual(actualWinner,winningRevision);
      assert.equal(JSON.parse(actualWinner.raw).stages[1].status,"pending");
      assert.equal(JSON.parse(actualWinner.raw).config.description,
        "RIVAL_NATIVE_WINNER_NO_AUTOMERGE");
      page.removeAllListeners("dialog");

      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),winningRevision);
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "Human CAS edits must not write active Factory localStorage");
      console.log("FACTORY_INDEXEDDB_MANUAL_STAGE_UI_E2E_PASS: three consents, exact backups, manual provenance and inert text, predecessor/downstream invalidation, rival token fencing preserving draft, reload, zero legacy writes");
    }finally{
      await humanStageContext.close();
    }

    // #160: native IndexedDB operational faults. A quota-like synchronous
    // store.put exception is INJECTED at the browser API boundary; the
    // transaction and rollback are real. Schema v2 upgrade is real and
    // isolated to this ephemeral browser context, not a production migration.
    const storageFaultContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await storageFaultContext.newPage();
      const rival=await storageFaultContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await rival.addScriptTag({content:casBundle});
      const id="16016016-0160-4160-8160-160160160160";
      const original=await rival.evaluate(async id=>{
        const now="2026-11-22T00:45:00.000Z";
        return await window.FactoryProjectCas.compareAndSwapCasProject({
          id,config:{name:"Storage fault candidate",
            description:"IDB quota/versionchange is never a successful commit",
            requirements:"Preserve the draft and legacy source"},
          stages:["features","competitors","technical","architecture",
            "adversarial","implementation"].map(stage=>({
            id:stage,label:stage,status:"pending",output:"",sources:[],
          })),
          createdAt:now,updatedAt:now,
        },null);
      },id);
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      page.once("dialog",dlg=>void dlg.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Storage fault candidate",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      const draft=panel.getByTestId("cas-isolated-active").locator("input").first();
      await draft.fill("UNSAVED USER DRAFT AFTER QUOTA");
      const save=panel.getByRole("button",{
        name:"Salva modifica in IndexedDB con backup",
      });
      // A browser's native quota error is named QuotaExceededError.
      // Injection exercises the synchronous request-scheduling exception
      // without requiring a destructive browser-wide disk quota change.
      await page.evaluate(()=>{
        const prior=IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put=function(...args){
          if(this.transaction.db.name==="softwarefactory.project.cas.v1")
            throw new DOMException(
              "NEVER_LEAK_NATIVE_QUOTA_SECRET","QuotaExceededError");
          return prior.apply(this,args);
        };
      });
      page.on("dialog",dlg=>void dlg.accept());
      const backup=page.waitForEvent("download");
      await save.click();
      assert.equal((await readFile(await (await backup).path())).toString("utf8"),
        original.raw,"Pre-save snapshot backup must still be byte exact");
      await expect(panel.getByRole("alert"))
        .toContainText("Spazio/quota IndexedDB esaurita");
      await expect(panel.getByRole("alert"))
        .not.toContainText("NEVER_LEAK_NATIVE_QUOTA_SECRET");
      await expect(draft).toHaveValue("UNSAVED USER DRAFT AFTER QUOTA");
      await expect(save).toBeDisabled();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),original,
        "Native quota fault must abort the transaction with no revision advance");
      page.removeAllListeners("dialog");

      // Actually advance the IDB database version to v2 in the other tab,
      // while leaving the projects store/data untouched. The real v1-only
      // app must refuse opening it and MUST NOT downgrade or delete it.
      await rival.evaluate(()=>new Promise((resolve,reject)=>{
        const req=indexedDB.open("softwarefactory.project.cas.v1",2);
        req.onerror=()=>reject(Error("Test schema v2 upgrade failed"));
        req.onblocked=()=>reject(Error("Old v1 connection was not closed"));
        req.onsuccess=()=>{req.result.close();resolve(true);};
      }));
      await page.reload({waitUntil:"networkidle"});
      const reopened=page.getByTestId("cas-isolated-editor");
      await reopened.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await reopened.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      await expect(reopened.getByRole("alert"))
        .toContainText("Versione IndexedDB incompatibile");
      await expect(reopened.getByRole("alert"))
        .toContainText("NON cancellare il database");
      const afterUpgrade=await rival.evaluate(id=>new Promise((resolve,reject)=>{
        const request=indexedDB.open("softwarefactory.project.cas.v1",2);
        request.onerror=()=>reject(Error("Cannot reopen v2"));
        request.onsuccess=()=>{
          const db=request.result;
          const tx=db.transaction("projects","readonly");
          let row;
          tx.objectStore("projects").get(id).onsuccess=e=>{
            row=e.target.result;
          };
          tx.oncomplete=()=>{db.close();resolve(row);};
          tx.onabort=()=>{db.close();reject(Error("v2 read aborted"));};
        };
      }),id);
      assert.equal(afterUpgrade.revision,1);
      assert.equal(afterUpgrade.raw,original.raw,
        "Actual schema upgrade must retain the old project verbatim");

      // Simulate a privacy-restricted browser with no IndexedDB surface.
      // The pilot still refuses to fall back to live localStorage.
      await page.evaluate(()=>Object.defineProperty(window,"indexedDB",{
        configurable:true,value:undefined,
      }));
      await reopened.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      await expect(reopened.getByRole("alert"))
        .toContainText("IndexedDB non disponibile");
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore);
      console.log("FACTORY_INDEXEDDB_STORAGE_FAULT_E2E_PASS: quota-like native abort fenced token and preserved draft, real schema v2 upgrade refused without data loss, unavailable IDB no fallback, legacy unchanged");
    }finally{
      await storageFaultContext.close();
    }

    // #159: exact selected IndexedDB JSON export, read-only and consented.
    // All CAS reads/writes are real Chromium transactions; download bytes
    // must never come from a stale selected tab after a rival change.
    const selectedExportContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await selectedExportContext.newPage();
      const rival=await selectedExportContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await Promise.all([
        page.addScriptTag({content:casBundle}),
        rival.addScriptTag({content:casBundle}),
      ]);
      const id="15915915-1591-4591-8591-159159159159";
      const original=await rival.evaluate(async id=>{
        const now="2026-11-22T00:30:00.000Z";
        const stages=["features","competitors","technical","architecture",
          "adversarial","implementation"].map(stage=>({
          id:stage,label:stage,status:"pending",output:"",sources:[],
        }));
        stages[0].status="complete";
        stages[0].output="PREVIOUS_AI_HISTORY_WITH_UNTRUSTED_HTML_<img src=x>";
        stages[0].sources=[{title:"Unverified history",
          url:"https://example.org/old",snippet:"source as historic text",
          query:"historical",fetchedAt:now}];
        return await window.FactoryProjectCas.compareAndSwapCasProject({
          id,config:{name:"Selected IDB export fixture",
            description:"Backup exact IDB, never legacy",
            requirements:"No silent rebase after race"},
          stages,createdAt:now,updatedAt:now,
        },null);
      },id);
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      page.once("dialog",dialog=>void dialog.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Selected IDB export fixture",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");

      const action=panel.getByTestId("cas-isolated-full-export")
        .getByRole("button",{name:"Esporta backup JSON COMPLETO della revisione IndexedDB"});
      await expect(action).toBeEnabled();
      page.once("dialog",dialog=>void dialog.dismiss());
      await action.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),original,
        "Declined download cannot change native IDB state");

      // The operator may need a backup while their unsaved config draft
      // is on screen. Export durable revision only, preserve draft exactly.
      const nameField=panel.getByTestId("cas-isolated-active")
        .locator("input").first();
      await nameField.fill("UNSAVED HUMAN DRAFT KEEP ME");
      await expect(action).toBeEnabled();
      let confirms=0;
      const allow=async dialog=>{confirms++;await dialog.accept();};
      page.on("dialog",allow);
      const filePending=page.waitForEvent("download");
      await action.click();
      const download=await filePending;
      assert.equal(download.suggestedFilename(),
        "softwarefactory-idb-project-"+id+"-r1.json");
      assert.equal((await readFile(await download.path())).toString("utf8"),
        original.raw,"Download bytes must equal pinned native CAS raw exactly");
      await expect(panel.getByRole("status"))
        .toContainText("Esportazione JSON IndexedDB confermata");
      assert.equal(confirms,2,
        "Separate download consent and saved-file acknowledgement");
      await expect(nameField).toHaveValue("UNSAVED HUMAN DRAFT KEEP ME");
      page.off("dialog",allow);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),original,
        "Export with dirty draft cannot mutate IDB");

      // Race while the operator is reading the confirmation. A native rival
      // bumps revision; the old selected raw is NEVER exported as current.
      let winner=null,staleDownloads=0;
      page.on("download",()=>{staleDownloads++;});
      page.once("dialog",async dialog=>{
        winner=await rival.evaluate(async expected=>{
          const p=JSON.parse(expected.raw);
          p.config.description="RIVAL UPDATED DURING EXPORT CONSENT";
          return await window.FactoryProjectCas.compareAndSwapCasProject(
            p,expected);
        },original);
        await dialog.accept();
      });
      await action.click();
      await expect(panel.getByRole("status"))
        .toContainText("Export IndexedDB BLOCCATO");
      assert.equal(staleDownloads,0,
        "Rival revision change must prevent any stale export download");
      assert.equal(winner.revision,2);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),winner);
      await expect(nameField).toHaveValue("UNSAVED HUMAN DRAFT KEEP ME");
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      page.removeAllListeners("dialog");

      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),winner);
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "Selected export must never mutate the active legacy workspace");
      console.log("FACTORY_INDEXEDDB_SELECTED_EXPORT_E2E_PASS: exact selected raw, two consents, dirty draft preserved, native rival during dialog prevents download, reload and legacy unchanged");
    }finally{
      await selectedExportContext.close();
    }

    // #158: inspect only a pinned native IndexedDB checkpoint. AI strings
    // are text (never active HTML); third-party links are HTTPS-only; a
    // rival CAS write requires explicit reopening, not silent adoption.
    const inspectContext=await browser.newContext();
    try{
      const page=await inspectContext.newPage();
      const rival=await inspectContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await Promise.all([
        page.addScriptTag({content:casBundle}),
        rival.addScriptTag({content:casBundle}),
      ]);
      const id="15815815-1581-4581-8581-158158158158";
      const original=await rival.evaluate(async id=>{
        const now="2026-11-22T08:00:00.000Z";
        const stages=["features","competitors","technical","architecture",
          "adversarial","implementation"].map(id=>({
            id,label:id,status:"pending",output:"",sources:[],
          }));
        stages[0].status="complete";
        stages[0].output="<img src=x onerror=alert('pwn')> AI_MARKDOWN_TEXT";
        stages[0].sources=[
          {title:"Trusted HTTPS article",url:"https://example.org/safe?q=1",
            snippet:"History from outside; not an attestation",query:"q",fetchedAt:now},
          {title:"Injected JS source",url:"javascript:alert(1)",
            snippet:"unsafe but inert",query:"q",fetchedAt:now},
        ];
        stages[1].status="running";
        stages[2].status="failed";
        stages[2].error="SECRET_UNVERIFIED_PROVIDER_ERROR_MUST_NOT_RENDER";
        return window.FactoryProjectCas.compareAndSwapCasProject({
          id,config:{name:"Stage inspection candidate",
            description:"Read-only checkpoint inspection",
            requirements:"Never execute HTML or trust sources"},
          stages,createdAt:now,updatedAt:now,
        },null);
      },id);
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      page.once("dialog",dialog=>void dialog.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Stage inspection candidate",
      }).click();
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      const inspector=panel.getByTestId("cas-isolated-stage-inspection");
      await expect(inspector.locator("li[data-testid^=cas-isolated-stage-]"))
        .toHaveCount(6);
      const features=inspector.getByTestId("cas-isolated-stage-features");
      await expect(features.getByTestId("cas-isolated-stage-status"))
        .toContainText("Checkpoint salvato");
      await expect(features.getByTestId("cas-isolated-stage-origin"))
        .toContainText("Origine storica non attestata");
      await features.locator("details").first().locator("summary").click();
      await expect(features.getByTestId("cas-isolated-stage-output"))
        .toContainText("<img src=x onerror=alert('pwn')>");
      assert.equal(await features.locator("img").count(),0,
        "Model output must never create an active HTML image element");
      assert.equal(await features.locator("script").count(),0,
        "Model output must never create script");
      await features.locator("details").last().locator("summary").click();
      const good=features.getByTestId("cas-isolated-source-link");
      await expect(good).toHaveCount(1);
      await expect(good).toHaveAttribute("href","https://example.org/safe?q=1");
      await expect(good).toHaveAttribute("rel",/noopener noreferrer nofollow/);
      await expect(good).toHaveAttribute("target","_blank");
      await expect(features.getByTestId("cas-isolated-untrusted-source"))
        .toContainText("link non sicuro");
      assert.equal(await features.locator("a[href^='javascript:']").count(),0);
      const running=inspector.getByTestId("cas-isolated-stage-competitors");
      await expect(running.getByTestId("cas-isolated-stage-status"))
        .toContainText("In corso o interrotto");
      await expect(running).toContainText("reset selettivo");
      await expect(inspector.getByTestId("cas-isolated-stage-technical"))
        .toContainText("Errore AI registrato");
      await expect(inspector).not.toContainText(
        "SECRET_UNVERIFIED_PROVIDER_ERROR_MUST_NOT_RENDER");
      await panel.getByTestId("cas-isolated-stage-reset").locator("select")
        .selectOption("competitors");
      await expect(panel.getByTestId("cas-isolated-stage-reset")
        .getByRole("button",{name:/Azzera fase/})).toBeEnabled();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id),original,
        "Inspecting an orphan running stage cannot reset it automatically");
      const winner=await rival.evaluate(async expected=>{
        const project=JSON.parse(expected.raw);
        project.stages[0].output="RIVAL_NEW_OUTPUT_AFTER_INSPECTION";
        return window.FactoryProjectCas.compareAndSwapCasProject(project,expected);
      },original);
      await panel.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      await expect(features.getByTestId("cas-isolated-stage-output"))
        .not.toContainText("RIVAL_NEW_OUTPUT_AFTER_INSPECTION");
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");

      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      const restored=await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),id);
      assert.deepEqual(restored,winner,
        "Reload must preserve the winner, not the pinned historical projection");
      const panelAgain=page.getByTestId("cas-isolated-editor");
      await panelAgain.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      await panelAgain.getByRole("button",{
        name:/Ricarica libreria IndexedDB/,
      }).click();
      page.once("dialog",dialog=>void dialog.accept());
      await panelAgain.getByRole("button",{
        name:"Apri copia IDB: Stage inspection candidate",
      }).click();
      await expect(panelAgain.getByTestId("cas-isolated-active"))
        .toContainText("rev. 2");
      const currentFeatures=panelAgain.getByTestId("cas-isolated-stage-features");
      await currentFeatures.locator("details").first().locator("summary").click();
      await expect(currentFeatures.getByTestId("cas-isolated-stage-output"))
        .toContainText("RIVAL_NEW_OUTPUT_AFTER_INSPECTION");
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "Inspecting native stages must not mutate the live legacy workspace");
      console.log("FACTORY_INDEXEDDB_STAGE_INSPECTION_E2E_PASS: six pinned stages, HTML inert, HTTPS-only links, running recovery guidance, rival read-only reopen and unchanged legacy");
    }finally{
      await inspectContext.close();
    }

    // #157: Real SPA opt-in AI stage; network provider is mocked only at
    // HTTP boundary, while ALL IDB CAS transactions use native Chromium.
    const casAiContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await casAiContext.newPage(),rival=await casAiContext.newPage();
      const stageIds=["features","competitors","technical","architecture",
        "adversarial","implementation"];
      const providerSettings={
        language:"it",
        profiles:[{id:"default",label:"E2E Mock AI",
          baseUrl:"https://cas-ai-provider.example/v1",
          model:"ci-model",enabled:true}],
        assignments:Object.fromEntries(stageIds.map(id=>[id,"default"])),
      };
      await page.addInitScript(settings=>{
        localStorage.setItem("softwarefactory.settings.v1",JSON.stringify(settings));
        sessionStorage.setItem("softwarefactory.secret.ai.default","CI_MOCK_SECRET");
      },providerSettings);
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await Promise.all([page.addScriptTag({content:casBundle}),
        rival.addScriptTag({content:casBundle})]);
      const ids=["15715715-1571-4571-8571-157157157157",
        "15715715-1571-4571-8571-157157157158",
        "15715715-1571-4571-8571-157157157159"];
      const originals=await rival.evaluate(async ids=>{
        const now="2026-11-21T22:30:00.000Z";
        const stages=["features","competitors","technical","architecture",
          "adversarial","implementation"].map(id=>({
            id,label:id,status:"pending",output:"",sources:[],
          }));
        return await Promise.all(ids.map((id,i)=>
          window.FactoryProjectCas.compareAndSwapCasProject({
            id,config:{
              name:["Real AI success","Real AI cancel","Real AI rival"][i],
              description:"AI consent and native CAS only",
              requirements:"Do not invent tests, approvals or reviews",
            },stages,createdAt:now,updatedAt:now,
          },null)));
      },ids);
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      let posts=0,mode="success",pending=null,notifyPending=null;
      const fakeBody=JSON.stringify({choices:[{finish_reason:"stop",
        message:{role:"assistant",content:"PROVIDER_HTTP_RESULT"}}]});
      await page.route("https://cas-ai-provider.example/v1/chat/completions",
        async route=>{
          if(route.request().method()==="OPTIONS"){
            await route.fulfill({status:204,headers:{
              "access-control-allow-origin":"*",
              "access-control-allow-methods":"POST,OPTIONS",
              "access-control-allow-headers":"authorization,content-type",
            }});return;
          }
          posts++;
          if(mode==="success"){
            await route.fulfill({status:200,contentType:"application/json",
              headers:{"access-control-allow-origin":"*"},body:fakeBody});
          }else{
            pending=route;
            notifyPending?.();
          }
        });
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      const pick=async name=>{
        page.removeAllListeners("dialog");
        page.once("dialog",dlg=>void dlg.accept());
        await panel.getByRole("button",{name:"Apri copia IDB: "+name}).click();
        // Opening is async (native IDB read before the confirmation).
        // Wait for the confirmed selection before adding a new dialog
        // handler: otherwise the next handler may accept the same dialog
        // a second time while the first once() is still pending.
        await expect(panel.getByTestId("cas-isolated-active"))
          .toContainText("rev. 1");
      };
      await pick("Real AI success");
      const runner=page.getByTestId("cas-isolated-ai-stage");
      const start=runner.getByRole("button",{
        name:"Esegui UNA fase AI SOLO IndexedDB con backup",
      });
      await expect(start).toBeEnabled();
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.dismiss());
      await start.click();
      assert.equal(posts,0,"No provider I/O before 3 consents");
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[0]),originals[0]);

      // Refuse the saved-file ACK after a genuine exact-raw download.
      page.removeAllListeners("dialog");
      let count=0;
      const denySecond=async dlg=>{
        count++;if(count===1)await dlg.accept();else await dlg.dismiss();
      };
      page.on("dialog",denySecond);
      const download1=page.waitForEvent("download");
      await start.click();
      assert.equal((await readFile(await (await download1).path())).toString("utf8"),
        originals[0].raw);
      assert.equal(count,2);page.off("dialog",denySecond);
      assert.equal(posts,0);

      // Decline provider disclosure despite a saved backup.
      page.removeAllListeners("dialog");
      count=0;
      const denyThird=async dlg=>{
        count++;if(count<3)await dlg.accept();else await dlg.dismiss();
      };
      page.on("dialog",denyThird);
      const download2=page.waitForEvent("download");
      await start.click();
      assert.equal((await readFile(await (await download2).path())).toString("utf8"),
        originals[0].raw);
      assert.equal(count,3);page.off("dialog",denyThird);
      assert.equal(posts,0);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[0]),originals[0]);

      page.removeAllListeners("dialog");
      count=0;
      page.on("dialog",async dlg=>{count++;await dlg.accept();});
      const download3=page.waitForEvent("download");
      await start.click();
      assert.equal((await readFile(await (await download3).path())).toString("utf8"),
        originals[0].raw);
      await expect(panel.getByTestId("cas-isolated-active"))
        .toContainText("rev. 3");
      await expect(panel.getByRole("status"))
        .toContainText("Risposta del provider AI persistita");
      assert.equal(count,3);assert.equal(posts,1);
      const success=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[0]);
      assert.equal(success.revision,3);
      assert.equal(JSON.parse(success.raw).stages[0].status,"complete");
      assert.equal(JSON.parse(success.raw).stages[0].output,"PROVIDER_HTTP_RESULT");
      await expect(start).toBeDisabled();
      page.removeAllListeners("dialog");

      const discard=panel.getByRole("button",{name:"Abbandona bozza e selezione"});
      const chooseNext=async name=>{
        await discard.click();
        await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
        await pick(name);
      };
      await chooseNext("Real AI cancel");
      mode="hold";
      const cancelledReq=new Promise(resolve=>{notifyPending=resolve;});
      page.on("dialog",dlg=>void dlg.accept());
      const cancelFile=page.waitForEvent("download");
      await start.click();
      assert.equal((await readFile(await (await cancelFile).path())).toString("utf8"),
        originals[1].raw);
      await cancelledReq;
      await expect(runner.getByTestId("cas-isolated-pipeline-status"))
        .toContainText("richiesta al provider in corso");
      await runner.getByRole("button",{name:"Annulla richiesta AI IndexedDB"}).click();
      await expect(panel.getByRole("status"))
        .toContainText("Richiesta AI annullata");
      try{await pending.abort("failed");}catch{/* browser already aborted */}
      pending=null;
      const cancelled=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[1]);
      assert.equal(cancelled.revision,3);
      assert.equal(JSON.parse(cancelled.raw).stages[0].status,"pending");
      assert.equal(JSON.parse(cancelled.raw).stages[0].output,"");
      page.removeAllListeners("dialog");

      await chooseNext("Real AI rival");
      let resume;
      mode="hold";
      pending=null;
      const rivalReq=new Promise(resolve=>{notifyPending=resolve;});
      page.on("dialog",dlg=>void dlg.accept());
      const raceFile=page.waitForEvent("download");
      await start.click();
      assert.equal((await readFile(await (await raceFile).path())).toString("utf8"),
        originals[2].raw);
      await rivalReq;
      const running=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[2]);
      assert.equal(running.revision,2);
      assert.equal(JSON.parse(running.raw).stages[0].status,"running");
      const winner=await rival.evaluate(async before=>{
        const project=JSON.parse(before.raw);
        project.config.description="Rival changed brief while AI was pending";
        return window.FactoryProjectCas.compareAndSwapCasProject(project,before);
      },running);
      const held=pending;
      mode="success";
      await held.fulfill({status:200,contentType:"application/json",
        headers:{"access-control-allow-origin":"*"},body:fakeBody});
      await expect(panel.getByRole("status"))
        .toContainText("Conflitto/ACK pipeline IndexedDB non confermato");
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[2]),winner,
        "Stale AI completion MUST lose to native rival CAS writer");
      await expect(start).toBeDisabled();
      page.removeAllListeners("dialog");
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[2]),winner);
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore);
      console.log("FACTORY_INDEXEDDB_AI_STAGE_UI_E2E_PASS: provider HTTP simulated, three consent gates, raw backup, native begin/complete/abort, rival token fencing, reload, no legacy writes");
    }finally{
      await casAiContext.close();
    }

    // #156: native asynchronous pipeline checkpoints, intentionally NOT
    // connected to App's legacy changeProject. This uses real two-tab CAS,
    // and a late AI result must lose against a noncooperating native writer.
    const pipelineContext=await browser.newContext();
    try{
      const page=await pipelineContext.newPage();
      const rival=await pipelineContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      for(const tab of [page,rival]){
        await tab.addScriptTag({content:casBundle});
      }
      await page.addScriptTag({content:casPipelineBundle});
      const ids=[
        "15615615-1561-4561-8561-156156156156",
        "15615615-1561-4561-8561-156156156157",
      ];
      const original=await rival.evaluate(async ids=>{
        const stages=["features","competitors","technical","architecture",
          "adversarial","implementation"].map((id,index)=>({
          id,label:id,status:index<2?"complete":"pending",
          output:index<2?"HISTORICAL_"+id:"",
          sources:[],
        }));
        const now="2026-11-21T21:00:00.000Z";
        return await Promise.all(ids.map((id,index)=>
          window.FactoryProjectCas.compareAndSwapCasProject({
            id,config:{name:"Pipeline native "+index,description:"isolated",
              requirements:"No fake test evidence"},
            stages,createdAt:now,updatedAt:now,
          },null)));
      },ids);
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const started=await page.evaluate(async id=>{
        window.CasPipelineHarness=await window.FactoryCasPipeline
          .openCasPipelineSession(id);
        window.CasPipelineTicket=await window.CasPipelineHarness.begin("technical");
        return window.CasPipelineTicket.started;
      },ids[0]);
      assert.equal(started.revision,2,"Begin must acknowledge native IDB commit");
      const starting=JSON.parse(started.raw);
      assert.equal(starting.stages[2].status,"running");
      assert.deepEqual(starting.stages.slice(0,2),
        JSON.parse(original[0].raw).stages.slice(0,2));
      await expect(page.evaluate(async()=>window.CasPipelineHarness.begin("technical")
        .then(()=>false,()=>true))).resolves.toBe(true);
      const done=await page.evaluate(()=>window.CasPipelineHarness.complete(
        window.CasPipelineTicket,"Confirmed AI output",[]));
      assert.equal(done.revision,3);
      const verified=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[0]);
      assert.deepEqual(done,verified,"Only oncomplete can confirm a stage");
      assert.equal(JSON.parse(verified.raw).stages[2].status,"complete");
      assert.equal(JSON.parse(verified.raw).stages[2].output,"Confirmed AI output");
      const interrupted=await page.evaluate(async()=>{
        window.CasPipelineTicket=await window.CasPipelineHarness.begin("architecture");
        const before=window.CasPipelineTicket.started;
        const done=await window.CasPipelineHarness.abort(window.CasPipelineTicket);
        const late=await window.CasPipelineHarness.complete(
          window.CasPipelineTicket,"Late answer",[]).then(()=>"unexpected",String);
        return {before,done,late};
      });
      assert.equal(interrupted.before.revision,4);
      assert.equal(interrupted.done.revision,5);
      assert.match(interrupted.late,/obsoleto/);
      assert.equal(JSON.parse(interrupted.done.raw).stages[3].status,"pending");
      const failed=await page.evaluate(async()=>{
        const t=await window.CasPipelineHarness.begin("architecture");
        return window.CasPipelineHarness.fail(t,"timeout");
      });
      assert.equal(failed.revision,7);
      assert.equal(JSON.parse(failed.raw).stages[3].status,"failed");
      assert.equal(JSON.parse(failed.raw).stages[3].error,
        "Tempo massimo del provider AI superato.");

      // A late AI request's CAS token cannot overwrite a rival who updated
      // config while the request ran, even if the tab ignores Web Locks.
      const lateStart=await page.evaluate(async id=>{
        window.CasLateSession=await window.FactoryCasPipeline.openCasPipelineSession(id);
        window.CasLateTicket=await window.CasLateSession.begin("technical");
        return window.CasLateTicket.started;
      },ids[1]);
      assert.equal(lateStart.revision,2);
      const winner=await rival.evaluate(async old=>{
        const p=JSON.parse(old.raw);
        p.config.description="Rival changed brief during remote AI request";
        return window.FactoryProjectCas.compareAndSwapCasProject(p,old);
      },lateStart);
      assert.equal(winner.revision,3);
      const rejected=await page.evaluate(()=>
        window.CasLateSession.complete(window.CasLateTicket,"Too late",[])
          .then(()=>"unexpected",String));
      assert.match(rejected,/non confermato|Conflitto CAS/);
      assert.equal(await page.evaluate(()=>window.CasLateSession.state()),"blocked");
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[1]),winner,
        "Rival winning CAS must not be overwritten by delayed AI output");
      const reopened=await page.evaluate(async id=>{
        const session=await window.FactoryCasPipeline.openCasPipelineSession(id);
        const result=await session.begin("technical").then(()=>"unexpected",String);
        return {snapshot:session.snapshot(),result};
      },ids[1]);
      assert.equal(reopened.snapshot.revision,3);
      assert.match(reopened.result,/Predecessori|già in esecuzione/);
      // A stage left running after crash/reload needs explicit operator
      // recovery; never interpret it as completed nor auto-retry the AI.
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),ids[1]),winner);
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "CAS async stage session must never write active legacy state");
      console.log("FACTORY_INDEXEDDB_PIPELINE_ASYNC_E2E_PASS: begin/complete/abort/fail tx acknowledgements, late AI result fenced by rival, manual recovery required and legacy unchanged");
    }finally{
      await pipelineContext.close();
    }

    // #155: an isolated, explicit stage reset uses the SAME native CAS
    // controller, preserving earlier checkpoints and exact pre-reset backup.
    const stageResetContext=await browser.newContext({acceptDownloads:true});
    try {
      const page=await stageResetContext.newPage();
      const rival=await stageResetContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      for(const tab of [page,rival])
        await tab.addScriptTag({content:casBundle});
      const original=await rival.evaluate(async()=>{
        const id="15515515-1551-4551-8551-155155155155";
        const ids=["features","competitors","technical","architecture",
          "adversarial","implementation"];
        const project={
          id,config:{name:"Stage reset CAS",description:"Original brief",
            requirements:"Never infer successful AI tests"},
          stages:ids.map((stage,i)=>({
            id:stage,label:stage,status:"complete",
            output:"HISTORICAL_STAGE_"+i,
            sources:[{title:"Historical",url:"https://example.com/"+i,
              snippet:"old",query:"old",fetchedAt:"2026-11-21T20:00:00.000Z"}],
            updatedAt:"2026-11-21T20:00:00.000Z",
          })),
          createdAt:"2026-11-21T20:00:00.000Z",
          updatedAt:"2026-11-21T20:00:00.000Z",
        };
        return window.FactoryProjectCas.compareAndSwapCasProject(project,null);
      });
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      page.once("dialog",dlg=>void dlg.accept());
      await panel.getByRole("button",{name:"Apri copia IDB: Stage reset CAS"}).click();
      await expect(page.getByTestId("cas-isolated-active")).toContainText("rev. 1");
      const reset=page.getByTestId("cas-isolated-stage-reset");
      const selector=reset.getByLabel("Fase da azzerare (IndexedDB)");
      const action=reset.getByRole("button",{
        name:"Azzera fase e successive SOLO IndexedDB con backup",
      });
      await selector.selectOption("technical");
      await expect(action).toBeEnabled();
      const name=panel.getByLabel("Nome progetto (solo IndexedDB)");
      await name.fill("Unsaved config prevents stage reset");
      await expect(action).toBeDisabled();
      await name.fill("Stage reset CAS");
      await expect(action).toBeEnabled();

      // Declining the backup, or the saved-file acknowledgement, is read-only.
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.dismiss());
      await action.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id),original);

      page.removeAllListeners("dialog");
      let declined=0;
      const declineDialog=async dlg=>{
        declined++;
        if(declined===1)await dlg.accept();
        else await dlg.dismiss();
      };
      page.on("dialog",declineDialog);
      const declinedDownload=page.waitForEvent("download");
      await action.click();
      assert.equal((await readFile(await (await declinedDownload).path())).toString("utf8"),
        original.raw,"Pre-stage-reset backup must preserve exact old AI receipt");
      assert.equal(declined,2);
      page.off("dialog",declineDialog);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id),original);

      page.removeAllListeners("dialog");
      let approved=0;
      const acceptDialog=async dlg=>{approved++;await dlg.accept();};
      page.on("dialog",acceptDialog);
      const savedDownload=page.waitForEvent("download");
      await action.click();
      assert.equal((await readFile(await (await savedDownload).path())).toString("utf8"),
        original.raw);
      assert.equal(approved,3,"Backup, saved-file, destructive consent all required");
      page.off("dialog",acceptDialog);
      await expect(page.getByTestId("cas-isolated-active")).toContainText("rev. 2");
      await expect(panel.getByRole("status"))
        .toContainText("Reset checkpoint IndexedDB confermato");
      const saved=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id);
      const previous=JSON.parse(original.raw),after=JSON.parse(saved.raw);
      assert.equal(saved.revision,2);
      assert.deepEqual(after.stages.slice(0,2),previous.stages.slice(0,2),
        "Earlier approved checkpoints must remain byte-equivalent");
      assert.deepEqual(after.stages.slice(2),
        previous.stages.slice(2).map(({id,label})=>({
          id,label,status:"pending",output:"",sources:[],
        })),"Selected and downstream AI artifacts must become pending and empty");
      assert.deepEqual(after.config,previous.config);
      assert.equal(after.createdAt,previous.createdAt);
      await expect(action).toBeDisabled();

      // A rival wins while the UI is paused on the FINAL consent: the
      // obsolete CAS token must be rejected without overwriting the winner.
      await selector.selectOption("features");
      await expect(action).toBeEnabled();
      page.removeAllListeners("dialog");
      let finalConsent;
      const waiting=new Promise(resolve=>{finalConsent=resolve;});
      let approvedBackup=false,approvedSaved=false;
      const onRace=async dlg=>{
        if(dlg.message().startsWith("ULTIMA CONFERMA:")){
          assert.ok(approvedBackup && approvedSaved);
          finalConsent(dlg);
        }else if(dlg.message().startsWith("Scaricare il backup JSON ESATTO")){
          approvedBackup=true;await dlg.accept();
        }else if(dlg.message().startsWith("Confermi di aver SALVATO")){
          approvedSaved=true;await dlg.accept();
        }else await dlg.dismiss();
      };
      page.on("dialog",onRace);
      const pendingDownload=page.waitForEvent("download");
      const attempt=action.click();
      void attempt.catch(()=>{});
      const paused=await waiting;
      const racedBackup=await pendingDownload;
      assert.equal((await readFile(await racedBackup.path())).toString("utf8"),
        saved.raw);
      const winner=await rival.evaluate(async previous=>{
        const next=JSON.parse(previous.raw);
        next.config.description="Native rival CAS update wins";
        return window.FactoryProjectCas.compareAndSwapCasProject(next,previous);
      },saved);
      assert.equal(winner.revision,3);
      await paused.accept();
      await attempt;
      page.off("dialog",onRace);
      await expect(panel.getByRole("alert")).toContainText("non confermata");
      await expect(panel.getByRole("status")).toContainText("Sessione IndexedDB bloccata");
      await expect(action).toBeDisabled();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id),winner,
        "A stale stage reset must not overwrite a native rival writer");

      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "IDB stage resets and rival conflicts must never write legacy storage");
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),original.id),winner,
        "Checkpoint reset and later rival revision must survive reload");
      console.log("FACTORY_INDEXEDDB_STAGE_RESET_E2E_PASS: exact raw backup, three consents, selective downstream invalidation, no-op, dirty draft, stale rival write, reload and unchanged legacy");
    }finally{
      await stageResetContext.close();
    }


    // #172: persist a running stage as after a tab crash. A rival CAS
    // update during the last operator consent must win, without lost data.
    const runningStageRecoveryContext=await browser.newContext({acceptDownloads:true});
    try {
      const page=await runningStageRecoveryContext.newPage();
      const rival=await runningStageRecoveryContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      for(const tab of [page,rival])
        await tab.addScriptTag({content:casBundle});
      const source=await rival.evaluate(async()=>{
        const id="17217217-1721-4721-8721-172172172172";
        const stages=["features","competitors","technical","architecture",
          "adversarial","implementation"].map((stage,i)=>({
          id:stage,label:stage,
          status:i<2?"complete":i===2?"running":"pending",
          output:i<2?"HISTORICAL_AI_"+i:"",
          sources:[],
          ...(i===2?{updatedAt:"2026-11-23T07:00:00.000Z"}:{}),
        }));
        return window.FactoryProjectCas.compareAndSwapCasProject({
          id,config:{name:"Recover running CAS",description:"Before crash",
            requirements:"Never invent AI completions"},
          stages,createdAt:"2026-11-23T07:00:00.000Z",
          updatedAt:"2026-11-23T07:00:00.000Z",
        },null);
      });
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      const open=async()=>{
        await panel.getByRole("button",{
          name:"Apri editor IndexedDB separato",
        }).click();
        await panel.getByRole("button",{
          name:/Ricarica libreria IndexedDB/,
        }).click();
        page.once("dialog",dlg=>void dlg.accept());
        await panel.getByRole("button",{
          name:"Apri copia IDB: Recover running CAS",
        }).click();
      };
      await open();
      const action=page.getByTestId("cas-isolated-running-recovery-action");
      await expect(action).toBeEnabled();
      await expect(action).toContainText("(technical)");
      // Reject first consent: no download and no mutation.
      page.once("dialog",dlg=>void dlg.dismiss());
      await action.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),source.id),source);

      // A noncooperating native writer updates during FINAL consent.
      let signalFinal;
      const finalDialog=new Promise(resolve=>{signalFinal=resolve;});
      let count=0;
      const onRace=async dialog=>{
        count++;
        if(count===3)signalFinal(dialog);
        else await dialog.accept();
      };
      page.on("dialog",onRace);
      const pendingDownload=page.waitForEvent("download");
      const attempt=action.click();void attempt.catch(()=>{});
      const pause=await finalDialog;
      const backup=await pendingDownload;
      assert.equal((await readFile(await backup.path())).toString("utf8"),
        source.raw,"Recovery backup must be byte-exact");
      const winner=await rival.evaluate(async before=>{
        const next=JSON.parse(before.raw);
        next.config.description="Rival writer wins during recovery";
        return window.FactoryProjectCas.compareAndSwapCasProject(next,before);
      },source);
      await pause.accept();await attempt;
      page.off("dialog",onRace);
      await expect(panel.getByRole("alert")).toContainText("non confermata");
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),source.id),winner);

      // Reload creates a fresh explicit session pinned to the winner.
      await page.reload({waitUntil:"networkidle"});
      await open();
      await expect(action).toBeEnabled();
      page.removeAllListeners("dialog");
      let consents=0;
      const approve=async dialog=>{consents++;await dialog.accept();};
      page.on("dialog",approve);
      const savedDownload=page.waitForEvent("download");
      await action.click();
      assert.equal((await readFile(await (await savedDownload).path()))
        .toString("utf8"),winner.raw);
      assert.equal(consents,3);
      page.off("dialog",approve);
      await expect(page.getByTestId("cas-isolated-active")).toContainText("rev. 3");
      await expect(action).toBeDisabled();
      const saved=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),source.id);
      assert.equal(saved.revision,3);
      const before=JSON.parse(winner.raw),after=JSON.parse(saved.raw);
      assert.deepEqual(after.stages.slice(0,2),before.stages.slice(0,2));
      for(const stage of after.stages.slice(2))
        assert.deepEqual(stage,{id:stage.id,label:stage.label,
          status:"pending",output:"",sources:[]});
      assert.equal(after.config.description,
        "Rival writer wins during recovery");
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "Recovery may not change any legacy project slot");
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),source.id),saved);
      console.log("FACTORY_INDEXEDDB_RUNNING_RECOVERY_E2E_PASS: backup, 3 consents, race, reload, no false AI completion");
    }finally{
      await runningStageRecoveryContext.close();
    }

    // #150: A new project can be created directly in the standalone CAS
    // editor, without touching the legacy workspace or first staging a
    // localStorage project. The same never-seen native transaction fences
    // tabs that ignore all in-memory/editor locks.
    const freshCasContext=await browser.newContext();
    try {
      const page=await freshCasContext.newPage();
      const rival=await freshCasContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      for(const tab of [page,rival])
        await tab.addScriptTag({content:casBundle});
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      const form=page.getByTestId("cas-isolated-create");
      const newName=form.getByLabel("Nome nuovo progetto (solo IndexedDB)");
      const newBrief=form.getByLabel("Brief nuovo progetto (solo IndexedDB)");
      const create=form.getByRole("button",{name:"Crea nuovo progetto SOLO IndexedDB"});
      await newName.fill("Native IDB creation");
      await newBrief.fill("Created without any legacy project migration");

      page.removeAllListeners("dialog");
      let refused=0;
      page.once("dialog",dlg=>{
        assert.match(dlg.message(),/Native IDB creation/);
        assert.match(dlg.message(),/ID: [0-9a-f-]{36}/i);
        refused++;void dlg.dismiss();
      });
      await create.click();
      assert.equal(refused,1);
      assert.deepEqual(await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects()),[],
        "Declining new-project consent must not write IndexedDB");

      let createdId="";
      page.once("dialog",dlg=>{
        assert.match(dlg.message(),/Native IDB creation/);
        const match=dlg.message().match(/ID: ([0-9a-f-]{36})/i);
        assert.ok(match,"Consent UI must expose the new project's UUID");
        createdId=match[1];
        void dlg.accept();
      });
      await create.click();
      await expect(panel.getByRole("status")).toContainText(
        "Nuovo progetto creato in IndexedDB",{timeout:15000});
      const native=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),createdId);
      assert.equal(native.revision,1);
      const project=JSON.parse(native.raw);
      assert.equal(project.id,createdId);
      assert.equal(project.config.name,"Native IDB creation");
      assert.equal(project.config.description,
        "Created without any legacy project migration");
      assert.equal(project.createdAt,project.updatedAt);
      assert.equal(project.stages.length,6);
      assert.ok(project.stages.every(stage=>
        stage.status==="pending" && stage.output==="" &&
        stage.sources.length===0),"Native IDB creation must not inherit AI evidence");
      assert.equal(project.development,undefined);
      assert.equal(project.githubSync,undefined);
      assert.equal(project.githubDestination,undefined);
      assert.equal(await page.evaluate(()=>sessionStorage.getItem(
        "softwarefactory.project.active-tab.v1")),
        legacyBefore.selected,
        "IDB creation must not select a project in the legacy Factory");

      // Opening a newly created project still needs the isolated editor's
      // independent selection consent, never an implicit source-of-truth cut.
      await expect(page.getByTestId("cas-isolated-library"))
        .toContainText("Native IDB creation");
      page.once("dialog",dlg=>void dlg.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Native IDB creation",
      }).click();
      await expect(page.getByTestId("cas-isolated-active"))
        .toContainText("rev. 1");
      await expect(create).toBeDisabled();
      await panel.getByRole("button",{
        name:"Abbandona bozza e selezione",
      }).click();
      // The successful creation intentionally cleared its draft fields;
      // discard re-enables the form, not an empty-name submission.
      await expect(newName).toBeEnabled();
      await expect(create).toBeDisabled();

      // During confirmation a noncooperating tab creates and then deletes
      // the SAME randomly generated ID. Generic expected=null must never
      // resurrect that tombstone. No automatic new-UUID retry is allowed.
      await newName.fill("Rival tombstone insert");
      await newBrief.fill("Must never replace a concurrent tombstone");
      page.removeAllListeners("dialog");
      let notifyDialog;
      const raceDialog=new Promise(resolve=>{notifyDialog=resolve;});
      const onDialog=dialog=>notifyDialog(dialog);
      page.on("dialog",onDialog);
      const attempted=create.click();
      const pending=await raceDialog;
      const match=pending.message().match(/ID: ([0-9a-f-]{36})/i);
      assert.ok(match,"Creation consent must pin a UUID before writing");
      const racedId=match[1];
      const tomb=await rival.evaluate(async id=>{
        const p={id,config:{name:"Rival deleted"},stages:[],
          updatedAt:"2026-11-21T19:00:00.000Z"};
        const existing=await window.FactoryProjectCas.compareAndSwapCasProject(p,null);
        return window.FactoryProjectCas.deleteCasProject(id,existing);
      },racedId);
      assert.equal(tomb.revision,2);
      await pending.accept();
      await attempted;
      page.off("dialog",onDialog);
      await expect(panel.getByRole("alert")).toContainText("non confermata");
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),racedId),
        {state:"tombstone",revision:2},
        "A rival-tab tombstone cannot be revived by stale creation consent");
      assert.deepEqual(await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects()).then(xs=>xs.map(x=>x.id)),
        [createdId],"The failed create must not create a second IDB project");

      // Add 39 other active IDB fixtures in one genuine readwrite txn.
      // The 41st native UI creation must abort at capacity, not overwrite.
      await rival.evaluate(async()=>{
        const db=await new Promise((resolve,reject)=>{
          const req=indexedDB.open("softwarefactory.project.cas.v1",1);
          req.onsuccess=()=>resolve(req.result);
          req.onerror=()=>reject(Error("Capacity fixture open failed"));
        });
        try{
          await new Promise((resolve,reject)=>{
            const tx=db.transaction("projects","readwrite");
            tx.oncomplete=resolve;
            tx.onabort=()=>reject(Error("Capacity fixture aborted"));
            const store=tx.objectStore("projects");
            for(let i=0;i<39;i++){
              const id="77777777-7777-4777-8777-"+String(i).padStart(12,"0");
              store.put({id,revision:1,raw:JSON.stringify({
                id,config:{name:"Capacity IDB "+i},stages:[],
                updatedAt:"2026-11-21T19:00:00.000Z",
              })},id);
            }
          });
        } finally {db.close();}
      });
      assert.equal((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,40);
      await newName.fill("Forbidden 41st IDB project");
      page.removeAllListeners("dialog");
      let capId="";
      page.once("dialog",dlg=>{
        capId=dlg.message().match(/ID: ([0-9a-f-]{36})/i)?.[1]||"";
        void dlg.accept();
      });
      await create.click();
      assert.ok(capId,"Capacity attempt must identify intended new project");
      await expect(panel.getByRole("alert")).toContainText("non confermata");
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),capId),
        {state:"missing"},
        "At 40 active rows no 41st IDB project is created");
      assert.equal((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,40);
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "Native IDB-only creation must never touch legacy Factory slots");
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),createdId),native,
        "Confirmed native IDB insert must survive reload with exact rev/raw");
      console.log("FACTORY_INDEXEDDB_NATIVE_CREATE_UI_E2E_PASS: opt-in never-seen project, denied consent, revision 1 after tx, no fake evidence or GitHub binding, rival tombstone race, 40/41 cap, reload and no legacy writes");
    } finally {
      await freshCasContext.close();
    }


    // #178: manual LOCAL JSON from the CAS-only route must create only a
    // new native configuration, never resurrect historical AI/test proof,
    // touch the legacy store or silently retry after a rival tombstone.
    const externalImportContext=await browser.newContext({acceptDownloads:true});
    try {
      const page=await externalImportContext.newPage();
      const rival=await externalImportContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/?workspace=cas",
          {waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/?workspace=cas",
          {waitUntil:"networkidle"}),
      ]);
      for(const tab of [page,rival])
        await tab.addScriptTag({content:casBundle});
      const legacyBefore=await page.evaluate(()=>({
        pointer:localStorage.getItem("softwarefactory.project.v1"),
        keys:Object.keys(localStorage).sort(),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      const create=panel.getByTestId("cas-isolated-create");
      await create.locator("input").fill("External source 178");
      await create.locator("textarea").fill("Only the stack should be copied");
      page.once("dialog",dialog=>void dialog.accept());
      await create.getByRole("button",{
        name:"Crea nuovo progetto SOLO IndexedDB",
      }).click();
      await expect(panel.getByTestId("cas-isolated-library"))
        .toContainText("External source 178");
      const original=await rival.evaluate(async()=>{
        const list=await window.FactoryProjectCas.listCasProjects();
        return await window.FactoryProjectCas.readCasProject(list[0].id);
      });
      const historical=await rival.evaluate(async snapshot=>{
        const project=JSON.parse(snapshot.raw);
        project.stages[0].status="complete";
        project.stages[0].output="UNVERIFIED_AI_178";
        project.stages[0].completionOrigin="manual";
        project.githubDestination={owner:"historic",repo:"historic",branch:"main",
          authMode:"pat",appGateway:"",privateRepo:false};
        project.githubTestReceipt={requestId:"OLD_RECEIPT_178",
          repository:"historic/historic",branch:"main",
          commitSha:"OLD_SHA_178",createdAt:project.updatedAt,
          selected:["web-build"]};
        return window.FactoryProjectCas.compareAndSwapCasProject(project,snapshot);
      },original);
      const file=panel.getByTestId("cas-isolated-import-file");
      const selected=async(name,content)=>file.setInputFiles({
        name,mimeType:"application/json",buffer:Buffer.from(content,"utf8"),
      });
      await selected("invalid.json","{broken");
      await expect(panel.getByRole("alert"))
        .toContainText("JSON non valido");
      assert.equal((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,1);

      page.once("dialog",dialog=>void dialog.dismiss());
      await selected("source.json",historical.raw);
      assert.equal((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,1,
      "Rejected import consent must never create an IndexedDB row");
      let importedId="";
      page.once("dialog",dialog=>{
        const match=dialog.message().match(/ID: ([0-9a-f-]{36})/i);
        assert.ok(match,"Import must disclose its fresh UUID before consent");
        importedId=match[1];
        void dialog.accept();
      });
      await selected("source.json",historical.raw);
      await expect(panel.getByRole("status")).toContainText(
        "Configurazione importata",{timeout:15000});
      const stored=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),importedId);
      assert.equal(stored.revision,1);
      const clean=JSON.parse(stored.raw);
      assert.notEqual(clean.id,historical.id);
      assert.equal(clean.config.name,"External source 178 (import)");
      assert.equal(clean.config.description,"Only the stack should be copied");
      assert.ok(clean.stages.every(stage=>
        stage.status==="pending" && stage.output==="" &&
        stage.sources.length===0));
      assert.deepEqual(Object.keys(clean).sort(),
        ["config","createdAt","id","stages","updatedAt"]);
      assert.equal(stored.raw.includes("UNVERIFIED_AI_178"),false);
      assert.equal(stored.raw.includes("OLD_RECEIPT_178"),false);
      assert.equal(await panel.getByTestId("cas-isolated-active").count(),0,
        "No automatic selection or auto-reuse of imported evidence");

      // Another tab tombstones the fresh UUID while consent is open.
      // IDB expected=null must not revive it or fabricate a second ID.
      let onDialog;
      const pendingDialog=new Promise(resolve=>{onDialog=resolve;});
      const listener=dialog=>onDialog(dialog);
      page.on("dialog",listener);
      const pending=selected("source.json",historical.raw);
      const dialog=await pendingDialog;
      const raceId=dialog.message().match(/ID: ([0-9a-f-]{36})/i)?.[1];
      assert.ok(raceId);
      const tombstone=await rival.evaluate(async id=>{
        const p={id,config:{name:"Rival tombstone 178"},stages:[],
          updatedAt:"2026-11-23T13:00:00.000Z"};
        const created=await window.FactoryProjectCas.compareAndSwapCasProject(p,null);
        return window.FactoryProjectCas.deleteCasProject(id,created);
      },raceId);
      assert.equal(tombstone.revision,2);
      await dialog.accept();
      await pending;
      page.off("dialog",listener);
      await expect(panel.getByRole("alert")).toContainText(
        "non confermato",{timeout:15000});
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),raceId),
        {state:"tombstone",revision:2});
      assert.equal((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).length,2,
        "Rival tombstone may not create another active project");
      const legacyAfter=await page.evaluate(()=>({
        pointer:localStorage.getItem("softwarefactory.project.v1"),
        keys:Object.keys(localStorage).sort(),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "CAS-only import may not read/write any legacy project slots");
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),importedId),stored,
        "Clean native import must survive reload with exact raw and revision");
      console.log("FACTORY_CAS_EXTERNAL_CONFIG_IMPORT_E2E_PASS: explicit JSON file, invalid and declined consent, new clean native revision, evidence stripped, concurrent tombstone fenced, reload and unchanged legacy");
    } finally {
      await externalImportContext.close();
    }

    // #179: FULL historical tombstone restore in CAS-only ROOT. It is not
    // configuration-only import (#178) and never mounts legacy editor.
    const rootRestoreContext=await browser.newContext({acceptDownloads:true});
    try{
      const page=await rootRestoreContext.newPage();
      const rival=await rootRestoreContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/?workspace=cas",
          {waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/?workspace=cas",
          {waitUntil:"networkidle"}),
      ]);
      for(const tab of [page,rival])await tab.addScriptTag({content:casBundle});
      const initialLegacy=await page.evaluate(()=>({
        project:localStorage.getItem("softwarefactory.project.v1"),
        index:localStorage.getItem("softwarefactory.project.index.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{
        name:"Apri editor IndexedDB separato",
      }).click();
      const creation=panel.getByTestId("cas-isolated-create");
      await creation.locator("input").fill("Root restore 179");
      await creation.locator("textarea").fill("Historical full backup");
      page.once("dialog",d=>void d.accept());
      await creation.getByRole("button",{
        name:"Crea nuovo progetto SOLO IndexedDB",
      }).click();
      await expect(panel.getByTestId("cas-isolated-library"))
        .toContainText("Root restore 179",{timeout:15000});
      const historical=await rival.evaluate(async()=>{
        const list=await window.FactoryProjectCas.listCasProjects();
        const before=await window.FactoryProjectCas.readCasProject(list[0].id);
        const project=JSON.parse(before.raw);
        project.stages[0].status="complete";
        project.stages[0].output="HISTORIC_UNVERIFIED_179";
        project.stages[0].completionOrigin="manual";
        project.githubTestReceipt={
          requestId:"OLD_179",repository:"example/old",
          branch:"main",commitSha:"OLD_SHA_179",
          createdAt:project.updatedAt,selected:["web-build"],
        };
        return await window.FactoryProjectCas.compareAndSwapCasProject(
          project,before);
      });
      const tombstone=await rival.evaluate(snap=>
        window.FactoryProjectCas.deleteCasProject(snap.id,snap),historical);
      assert.equal(tombstone.revision,3);
      const file=panel.getByTestId("cas-isolated-tombstone-restore-file");
      const upload=(name,content)=>file.setInputFiles({
        name,mimeType:"application/json",
        buffer:Buffer.from(content,"utf8"),
      });
      await upload("invalid.json","{broken");
      await expect(panel.getByRole("alert"))
        .toContainText("Backup non valido");
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),historical.id),
        {state:"tombstone",revision:3});

      // setInputFiles can resolve BEFORE React's async preflight reaches
      // window.confirm: wait for and resolve the actual dialog explicitly.
      const deniedReady=page.waitForEvent("dialog");
      const deniedUpload=upload("historical.json",historical.raw);
      const denied=await deniedReady;
      await denied.dismiss();
      await deniedUpload;
      await expect(file).toBeEnabled();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),historical.id),
        {state:"tombstone",revision:3},
        "Refusing the first consent cannot restore an IDB row");

      const firstReady=page.waitForEvent("dialog");
      const acceptedUpload=upload("historical.json",historical.raw);
      const first=await firstReady;
      const secondReady=page.waitForEvent("dialog");
      await first.accept();
      const second=await secondReady;
      await second.accept();
      await acceptedUpload;
      await expect(panel.getByRole("status")).toContainText(
        "Progetto storico ripristinato",{timeout:15000});
      assert.notEqual(first,second,
        "Native historical restore requires two distinct dialogs");
      const restored=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),historical.id);
      assert.equal(restored.revision,4);
      assert.equal(restored.raw,historical.raw,
        "Restored historical JSON must not be silently rewritten");
      assert.equal(restored.raw.includes("HISTORIC_UNVERIFIED_179"),true);
      assert.equal(restored.raw.includes("OLD_SHA_179"),true);
      await expect(panel.getByRole("status")).toContainText(
        "NON sono riverificate");
      assert.equal(await panel.getByTestId("cas-isolated-active").count(),0,
        "Restored historical evidence must never auto-open or reattest");

      // Rival replaces this exact tombstone during the SECOND consent.
      const nextTomb=await rival.evaluate(snap=>
        window.FactoryProjectCas.deleteCasProject(snap.id,snap),restored);
      assert.equal(nextTomb.revision,5);
      const firstRaceReady=page.waitForEvent("dialog");
      const pending=upload("historical.json",historical.raw);
      const firstRace=await firstRaceReady;
      const secondRaceReady=page.waitForEvent("dialog");
      await firstRace.accept();
      const held=await secondRaceReady;
      const winner=await rival.evaluate(async ({snapshot,tomb})=>
        window.FactoryProjectCas.restoreCasTombstoneProject(
          JSON.parse(snapshot.raw),{id:snapshot.id,revision:tomb.revision},
          snapshot.raw,true,
        ),{snapshot:historical,tomb:nextTomb});
      assert.equal(winner.revision,6);
      await held.accept();
      await pending;
      assert.notEqual(firstRace,held,
        "Rival race must be inserted between TWO distinct consents");
      await expect(panel.getByRole("alert")).toContainText(
        "ACK incerto",{timeout:15000});
      const exact=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),historical.id);
      assert.deepEqual(exact,winner,
        "Concurrent native winner must never be overwritten on stale consent");
      const finalLegacy=await page.evaluate(()=>({
        project:localStorage.getItem("softwarefactory.project.v1"),
        index:localStorage.getItem("softwarefactory.project.index.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(finalLegacy,initialLegacy,
        "CAS root restore must never mutate the legacy project store");
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),historical.id),winner,
        "Native tombstone generation and historical raw must survive reload");
      console.log("FACTORY_CAS_ROOT_TOMBSTONE_RESTORE_E2E_PASS: local JSON invalid/declined, historical restore with 2 consents, no auto-open/re-attestation, rival second-dialog fencing, native reload and legacy unchanged");
    }finally{
      await rootRestoreContext.close();
    }

    // #153: the IDB create transaction commits but the next read-only open
    // is deliberately unavailable. The SPA MUST NOT misreport uncommitted
    // creation or encourage a second new UUID; operator can recover via ID.
    const postAckContext=await browser.newContext();
    try {
      const page=await postAckContext.newPage();
      const rival=await postAckContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      await rival.addScriptTag({content:casBundle});
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      const form=page.getByTestId("cas-isolated-create");
      const name=form.getByLabel("Nome nuovo progetto (solo IndexedDB)");
      await name.fill("Committed but unreadable");
      // The create itself uses the first native IDB open. Fail the SECOND
      // open only, which belongs to the after-ACK verification read.
      await page.evaluate(()=>{
        const nativeOpen=indexedDB.open.bind(indexedDB);
        let opens=0;
        Object.defineProperty(indexedDB,"open",{
          configurable:true,
          value:(...args)=>{
            opens++;
            if(opens===2){
              Object.defineProperty(indexedDB,"open",{
                configurable:true,value:nativeOpen,
              });
              throw Error("Deliberate post-ACK readback failure");
            }
            return nativeOpen(...args);
          },
        });
      });
      let confirmedId="";
      page.once("dialog",dlg=>{
        confirmedId=dlg.message().match(/ID: ([0-9a-f-]{36})/i)?.[1]||"";
        void dlg.accept();
      });
      await form.getByRole("button",{
        name:"Crea nuovo progetto SOLO IndexedDB",
      }).click();
      assert.ok(confirmedId,"Create consent must pin ID before commit");
      await expect(panel.getByRole("status"))
        .toContainText("Creazione IndexedDB GIÀ CONFERMATA",{timeout:15000});
      await expect(panel.getByRole("status")).toContainText(confirmedId);
      await expect(panel.getByRole("alert")).toHaveCount(0);
      await expect(name).toHaveValue("");
      await expect(form.getByRole("button",{
        name:"Crea nuovo progetto SOLO IndexedDB",
      })).toBeDisabled();
      const committed=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),confirmedId);
      assert.equal(committed.revision,1);
      assert.equal(JSON.parse(committed.raw).config.name,"Committed but unreadable");
      assert.deepEqual((await rival.evaluate(()=>
        window.FactoryProjectCas.listCasProjects())).map(x=>x.id),
        [confirmedId],"There must be exactly one committed native IDB row");
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      await expect(page.getByTestId("cas-isolated-library"))
        .toContainText("Committed but unreadable");
      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "Post-ACK read fault must not touch active legacy Factory");
      console.log("FACTORY_INDEXEDDB_CREATE_POSTACK_E2E_PASS: one committed project despite failed readback, ID and no-retry warning, explicit recovery and unchanged legacy");
    }finally{
      await postAckContext.close();
    }

    // No-IDB browser must reject new native project creation, not redirect
    // writes to legacy storage or report a false successful save.
    const noIdbContext=await browser.newContext();
    await noIdbContext.addInitScript(()=>{
      Object.defineProperty(window,"indexedDB",{
        configurable:true,value:undefined,
      });
    });
    try{
      const page=await noIdbContext.newPage();
      await page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      const form=page.getByTestId("cas-isolated-create");
      await form.getByLabel("Nome nuovo progetto (solo IndexedDB)")
        .fill("No IndexedDB available");
      const legacy=await page.evaluate(()=>
        localStorage.getItem("softwarefactory.project.v1"));
      page.once("dialog",dlg=>void dlg.accept());
      await form.getByRole("button",{
        name:"Crea nuovo progetto SOLO IndexedDB",
      }).click();
      // #160: the storage fault is now a precise, sanitized diagnostic,
      // not the older generic "save not confirmed" message. Keep the
      // fail-closed + no-legacy-fallback assertion fully active.
      await expect(panel.getByRole("alert"))
        .toContainText("IndexedDB non disponibile");
      await expect(panel.getByRole("alert"))
        .not.toContainText("progetto creato");
      assert.equal(await page.evaluate(()=>
        localStorage.getItem("softwarefactory.project.v1")),legacy,
        "Missing IndexedDB must never fall back to localStorage creation");
    } finally {
      await noIdbContext.close();
    }


    // #151: actual SPA-only isolated IndexedDB delete with exact raw backup,
    // three independent consents, native tombstone, explicit manual restore
    // and a noncooperating writer racing the final destructive dialog.
    const isolatedDeleteContext=await browser.newContext({acceptDownloads:true});
    try {
      const page=await isolatedDeleteContext.newPage();
      const rival=await isolatedDeleteContext.newPage();
      await Promise.all([
        page.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
        rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"}),
      ]);
      for(const tab of [page,rival])
        await tab.addScriptTag({content:casBundle});
      const originals=await page.evaluate(async()=>{
        const make=(id,name)=>({
          id,config:{name,description:"Back up AI checkpoints before deletion",
            requirements:"Keep historical requirements before deletion"},
          stages:[{id:"features",label:"Features",status:"complete",
            output:"HISTORICAL_AI_NOT_CURRENT",sources:[]}],
          createdAt:"2026-11-21T20:00:00.000Z",
          updatedAt:"2026-11-21T20:00:00.000Z",
        });
        const a=await window.FactoryProjectCas.compareAndSwapCasProject(
          make("fa111111-1111-4111-8111-111111111111","Deletion candidate A"),null);
        const b=await window.FactoryProjectCas.compareAndSwapCasProject(
          make("fa222222-2222-4222-8222-222222222222","Deletion race B"),null);
        return {a,b};
      });
      const legacyBefore=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      const panel=page.getByTestId("cas-isolated-editor");
      await panel.getByRole("button",{name:"Apri editor IndexedDB separato"}).click();
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.accept());
      await panel.getByRole("button",{
        name:"Apri copia IDB: Deletion candidate A",
      }).click();
      const deleteButton=panel.getByRole("button",{
        name:"Elimina copia IndexedDB con backup",
      });
      await expect(deleteButton).toBeEnabled();
      const name=panel.getByLabel("Nome progetto (solo IndexedDB)");
      const deleteRequirements=panel.getByLabel("Requisiti progetto (solo IndexedDB)");
      await deleteRequirements.fill("Unsaved constraint: do not delete");
      await expect(deleteButton).toBeDisabled();
      await deleteRequirements.fill("Keep historical requirements before deletion");
      await name.fill("Unsaved draft must not be deleted");
      await expect(deleteButton).toBeDisabled();
      await name.fill("Deletion candidate A");
      await expect(deleteButton).toBeEnabled();

      // First backup consent: declining means no file, no tombstone.
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.dismiss());
      await deleteButton.click();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),originals.a.id),
        originals.a,"Declining download must leave CAS snapshot present");

      // Second saved-file confirmation: user downloaded exact JSON but has
      // not affirmed saving it, so delete must not enter a transaction.
      page.removeAllListeners("dialog");
      let dialogs=0;
      const onDeclineSaved=async dlg=>{
        dialogs++;
        if(dialogs===1) await dlg.accept();
        else await dlg.dismiss();
      };
      page.on("dialog",onDeclineSaved);
      const downloadOne=page.waitForEvent("download");
      await deleteButton.click();
      const fileOne=await downloadOne;
      assert.equal(fileOne.suggestedFilename(),
        "softwarefactory-cas-before-delete-"+originals.a.id+"-r1.json");
      assert.equal((await readFile(await fileOne.path())).toString("utf8"),
        originals.a.raw,"Backup must be byte-exact, including AI checkpoint");
      assert.equal(dialogs,2);
      page.off("dialog",onDeclineSaved);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),originals.a.id),
        originals.a);

      // Destructive final consent: refusing after confirming backup saved
      // still leaves the project active. All three prompts must be distinct.
      page.removeAllListeners("dialog");
      dialogs=0;
      const onDeclineDestructive=async dlg=>{
        dialogs++;
        if(dialogs===3){
          assert.match(dlg.message(),/Deletion candidate A/);
          assert.match(dlg.message(),new RegExp(originals.a.id));
          assert.match(dlg.message(),/rev\. 1/);
          await dlg.dismiss();
        }else await dlg.accept();
      };
      page.on("dialog",onDeclineDestructive);
      const downloadTwo=page.waitForEvent("download");
      await deleteButton.click();
      await downloadTwo;
      assert.equal(dialogs,3,"Three ordered consents: backup, saved, destructive");
      page.off("dialog",onDeclineDestructive);
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),originals.a.id),
        originals.a);

      // Fully consented delete: genuine IDB tombstone rev2 must be acknowledged
      // after native transaction complete; the editor loses its write token.
      page.removeAllListeners("dialog");
      dialogs=0;
      const onApprove=async dlg=>{dialogs++;await dlg.accept();};
      page.on("dialog",onApprove);
      const downloadFinal=page.waitForEvent("download");
      await deleteButton.click();
      const fileFinal=await downloadFinal;
      const exactRaw=(await readFile(await fileFinal.path())).toString("utf8");
      assert.equal(exactRaw,originals.a.raw);
      assert.equal(dialogs,3);
      page.off("dialog",onApprove);
      await expect(panel.getByRole("status"))
        .toContainText("Copia IndexedDB eliminata",{timeout:15000});
      await expect(page.getByTestId("cas-isolated-active")).toHaveCount(0);
      const tombstone=await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProjectSlot(id),originals.a.id);
      assert.deepEqual(tombstone,{state:"tombstone",revision:2});
      await expect(page.getByTestId("cas-isolated-library"))
        .not.toContainText("Deletion candidate A");
      const repeat=await rival.evaluate(async({id,raw})=>
        window.FactoryProjectCas.compareAndSwapCasProject(
          JSON.parse(raw),null).then(()=>"unexpected",String),
        {id:originals.a.id,raw:originals.a.raw});
      assert.notEqual(repeat,"unexpected","Generic CAS cannot resurrect tombstone");

      // The #148 separate restore UI must still accept the exact saved
      // backup with a NEW explicit consent; no automatic resurrection.
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.accept());
      const input=page.getByLabel(
        "Ripristina progetto IndexedDB eliminato da backup JSON");
      await input.setInputFiles({
        name:"deleted-idb-backup.json",mimeType:"application/json",
        buffer:Buffer.from(exactRaw,"utf8"),
      });
      await expect(page.getByText(
        "Copia IndexedDB ripristinata soltanto",{exact:false}))
        .toBeVisible({timeout:15000});
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),originals.a.id),
        {...originals.a,revision:3},
        "Restore must preserve exact project JSON with monotone revision");

      // The second deletion attempt races a noncooperating CAS writer during
      // its FINAL destructive confirmation. It must fail closed and block
      // stale editor token; winner keeps its JSON.
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.accept());
      await panel.getByRole("button",{name:"Apri copia IDB: Deletion race B"}).click();
      // The React click launches an asynchronous, consented IDB open. Do
      // not remove its dialog handler or start delete until the CAS editor
      // has actually acknowledged the selection of this exact snapshot.
      await expect(page.getByTestId("cas-isolated-active"))
        .toContainText(originals.b.id,{timeout:15000});
      await expect(panel.getByLabel("Nome progetto (solo IndexedDB)"))
        .toHaveValue("Deletion race B");
      page.removeAllListeners("dialog");
      let releaseFinal;
      const finalDialog=new Promise(resolve=>{releaseFinal=resolve;});
      let sawBackup=false,sawSaved=false;
      const onRace=async dlg=>{
        // Browser dialogs can be delivered while a download event is still
        // settling. Identify the gate by its content, never by an event count.
        const prompt=dlg.message();
        if(prompt.startsWith("ULTIMA CONFERMA:")){
          assert.ok(sawBackup && sawSaved,
            "Final destructive consent requires BOTH backup acknowledgements");
          releaseFinal(dlg);
        }else if(prompt.startsWith("Scaricare il backup JSON ESATTO")){
          sawBackup=true;
          await dlg.accept();
        }else if(prompt.startsWith("Confermi di aver effettivamente SALVATO")){
          sawSaved=true;
          await dlg.accept();
        }else{
          await dlg.dismiss();
          throw Error("Unexpected isolated CAS deletion consent gate: "+JSON.stringify(prompt));
        }
      };
      page.on("dialog",onRace);
      const raceDownload=page.waitForEvent("download");
      const attempted=deleteButton.click();
      // Observe click rejection early; if another assertion fails during
      // an open dialog, context cleanup must not yield an unhandled promise.
      void attempted.catch(()=>{});
      const waiting=await finalDialog;
      assert.match(waiting.message(),/Deletion race B/);
      const winner=await rival.evaluate(async old=>{
        const next=JSON.parse(old.raw);
        next.config.description="Rival writer won during final consent";
        return window.FactoryProjectCas.compareAndSwapCasProject(next,old);
      },originals.b);
      assert.equal(winner.revision,2);
      await waiting.accept();
      await attempted;
      const downloaded=await raceDownload;
      assert.equal((await readFile(await downloaded.path())).toString("utf8"),
        originals.b.raw);
      page.off("dialog",onRace);
      await expect(panel.getByRole("alert"))
        .toContainText("non confermata");
      await expect(panel.getByRole("status"))
        .toContainText("Sessione IndexedDB bloccata");
      await expect(deleteButton).toBeDisabled();
      assert.deepEqual(await rival.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),originals.b.id),winner,
        "Concurrent CAS update must never be destroyed by stale UI delete");
      await panel.getByRole("button",{name:/Ricarica libreria IndexedDB/}).click();
      page.removeAllListeners("dialog");
      page.once("dialog",dlg=>void dlg.accept());
      await panel.getByRole("button",{name:"Apri copia IDB: Deletion race B"}).click();
      await expect(page.getByTestId("cas-isolated-active")).toContainText("rev. 2");
      await expect(panel.getByLabel("Descrizione progetto (solo IndexedDB)"))
        .toHaveValue("Rival writer won during final consent");

      const legacyAfter=await page.evaluate(()=>({
        active:localStorage.getItem("softwarefactory.project.v1"),
        selected:sessionStorage.getItem("softwarefactory.project.active-tab.v1"),
        slots:Object.keys(localStorage).filter(k=>
          k.startsWith("softwarefactory.project.library.v1."))
          .sort().map(k=>[k,localStorage.getItem(k)]),
      }));
      assert.deepEqual(legacyAfter,legacyBefore,
        "IDB delete and restore must not modify any live legacy project slots");
      await page.reload({waitUntil:"networkidle"});
      await page.addScriptTag({content:casBundle});
      assert.deepEqual(await page.evaluate(id=>
        window.FactoryProjectCas.readCasProject(id),originals.a.id),
        {...originals.a,revision:3});
      console.log("FACTORY_INDEXEDDB_ISOLATED_DELETE_UI_E2E_PASS: exact JSON backup incl. requirements, three consent gates, dirty name/requirements blocked, native tombstone, explicit restore, rival tab conflict, reload and legacy unchanged");
    }finally {
      await isolatedDeleteContext.close();
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

      // #145: standalone, read-only IndexedDB library survives a missing OR
      // corrupted legacy slot. The UI must not silently restore either one.
      const orphanId="99999999-9999-4999-8999-999999999999";
      const brokenLegacyId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const recoverySources=await page.evaluate(async ({orphanId,brokenLegacyId})=>{
        const make=(id,name)=>({
          id,config:{name,requirements:"Historical AI checkpoint"},stages:[],
          updatedAt:"2026-11-21T13:00:00.000Z",
        });
        const orphan=await window.FactoryProjectCas.compareAndSwapCasProject(
          make(orphanId,"Orphan standalone"),null);
        const broken=await window.FactoryProjectCas.compareAndSwapCasProject(
          make(brokenLegacyId,"Legacy corrupted"),null);
        localStorage.removeItem("softwarefactory.project.library.v1."+orphanId);
        localStorage.setItem("softwarefactory.project.library.v1."+brokenLegacyId,"{broken");
        return {orphan,broken};
      },{orphanId,brokenLegacyId});
      const listButton=page.getByRole("button",{
        name:"Mostra copie IndexedDB recuperabili",
      });
      await listButton.click();
      const recoveryList=page.getByTestId("cas-recovery-library");
      await expect(recoveryList).toContainText("Orphan standalone");
      await expect(recoveryList).toContainText("Legacy corrupted");
      const orphanExport=page.getByRole("button",{
        name:"Esporta JSON storico: Orphan standalone",
      });
      // The earlier #142 preview may have registered a one-shot dialog
      // handler for a guard which returned before opening a dialog. Reusing
      // that listener would double-handle this independent confirmation.
      page.removeAllListeners("dialog");
      let recoveryConsentDialogs=0;
      page.once("dialog",dlg=>{
        recoveryConsentDialogs++;
        void dlg.accept();
      });
      const orphanDownload=page.waitForEvent("download",{timeout:20000});
      await orphanExport.click();
      const orphanFile=await orphanDownload;
      assert.equal(recoveryConsentDialogs,1,"Exactly one consent dialog is expected");
      assert.equal(orphanFile.suggestedFilename(),
        "softwarefactory-indexeddb-recovery-"+orphanId+"-r1.json");
      assert.equal((await readFile(await orphanFile.path())).toString("utf8"),
        recoverySources.orphan.raw,"An orphan IDB copy must download exact JSON");
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.project.library.v1."+id),orphanId),
        null,"IDB recovery must not recreate missing legacy data");
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.project.library.v1."+id),brokenLegacyId),
        "{broken","IDB recovery must not overwrite corrupt legacy data");

      // A concurrent regular CAS write makes the old listed revision stale.
      await listButton.click();
      const updatedOrphan=await page.evaluate(async ticket=>{
        const p=JSON.parse(ticket.raw);
        return window.FactoryProjectCas.compareAndSwapCasProject({
          ...p,config:{...p.config,name:"Orphan changed in rival tab"},
        },ticket);
      },recoverySources.orphan);
      await orphanExport.click();
      await expect(page.getByRole("alert")).toContainText("cambiata dall'elenco");
      assert.equal(updatedOrphan.revision,2);

      // Exact raw comparison also catches a noncooperating writer which
      // replaces JSON at the SAME revision between ticket preparation and
      // the post-consent validation. Use the real browser bundle with a
      // deterministic inter-tab barrier: browser dialogs auto-dismiss if
      // acceptance is deferred asynchronously while another tab writes.
      await listButton.click();
      const recoveryBundleBuild=await require("esbuild").build({
        entryPoints:[path.join(root,"src/frontend/src/infrastructure/project-cas-recovery-library.ts")],
        bundle:true,write:false,platform:"browser",format:"iife",
        globalName:"FactoryCasRecover",target:"es2022",
      });
      await page.addScriptTag({content:recoveryBundleBuild.outputFiles[0].text});
      const exactTicket=await page.evaluate(async ({id,revision})=>
        window.FactoryCasRecover.prepareCasRecoveryTicket(id,revision),
        {id:orphanId,revision:updatedOrphan.revision});
      assert.equal(exactTicket.raw,updatedOrphan.raw);
      const rival=await staging.newPage();
      await rival.goto("http://127.0.0.1:4174/",{waitUntil:"networkidle"});
      const badRaw=JSON.stringify({
        ...JSON.parse(updatedOrphan.raw),config:{
          ...JSON.parse(updatedOrphan.raw).config,name:"Orphan tampered same revision",
        },
      });
      await rival.evaluate(async ({id,revision,raw})=>{
        const db=await new Promise((resolve,reject)=>{
          const request=indexedDB.open("softwarefactory.project.cas.v1",1);
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(Error("Fixture IDB open failed"));
        });
        try {
          await new Promise((resolve,reject)=>{
            const tx=db.transaction("projects","readwrite");
            tx.oncomplete=resolve;
            tx.onabort=()=>reject(Error("Fixture IDB write failed"));
            tx.objectStore("projects").put({id,revision,raw},id);
          });
        } finally {db.close();}
      },{id:orphanId,revision:updatedOrphan.revision,raw:badRaw});
      const tamperBlocked=await page.evaluate(async ticket=>{
        try {
          await window.FactoryCasRecover.confirmCasRecoveryTicket(ticket,true);
          return "unexpected success";
        } catch(e){return String(e);}
      },exactTicket);
      assert.match(tamperBlocked,/Copia IndexedDB cambiata/,
        "A same-revision raw change after ticket preparation must be rejected");

      // Tombstones remain excluded from discovery even with corrupt legacy.
      await page.evaluate(async snapshot=>
        window.FactoryProjectCas.deleteCasProject(snapshot.id,snapshot),
        recoverySources.broken);
      await listButton.click();
      await expect(recoveryList).not.toContainText("Legacy corrupted");
      assert.equal(await page.evaluate(id=>
        localStorage.getItem("softwarefactory.project.library.v1."+id),brokenLegacyId),
        "{broken","Tombstone must not change the legacy source");
      console.log("FACTORY_INDEXEDDB_ORPHAN_RECOVERY_E2E_PASS: missing/corrupt legacy, exact JSON, consent, stale list, same-revision tab tamper and tombstone");
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
