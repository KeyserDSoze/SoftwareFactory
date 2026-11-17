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
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
