/**
 * Real Chromium concurrency smoke for the Factory SPA (#92).
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
    await expect(second.getByRole("button",{name:"Nuovo progetto"})).toBeDisabled();
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
    await expect(second.getByRole("button",{name:"Nuovo progetto"})).toBeDisabled();
    let approvals=0;
    second.on("dialog",async dialog => {approvals++;await dialog.accept();});
    const downloadPromise=second.waitForEvent("download",{timeout:20000});
    await second.getByRole("button",{name:"Salva backup e carica versione aggiornata"}).click();
    const downloaded = await downloadPromise;
    assert.match(downloaded.suggestedFilename(),/^softwarefactory-recovery-[a-f0-9-]{36}\.json$/);
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
    await expect(third.getByRole("button",{name:"Nuovo progetto"})).toBeDisabled();
    await context.close();
    console.log("FACTORY_BROWSER_LOCK_E2E_PASS: owner → blocked rival → explicit backup → takeover → blocked third tab");
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
