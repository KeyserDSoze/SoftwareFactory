import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject, DEFAULT_SETTINGS } from "../domain/defaults";
import RunnerBatchPanel from "./RunnerBatchPanel";

describe("operator-gated batch UI (#104)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const render = (language: "it"|"en", pending = false) => {
    const project=createProject();
    project.config.description="An example application with a relational database";
    if (pending) project.development={revision:0,overrides:{},originals:{},history:[],
      pending:{id:"unreviewed"} as never};
    vi.stubGlobal("sessionStorage", {getItem:()=> "x".repeat(40)});
    return renderToStaticMarkup(createElement(RunnerBatchPanel, {
      project, settings:{...DEFAULT_SETTINGS,language,runnerEndpoint:"https://runner.example.com"},
      selectedSteps:["dotnet-build","dotnet-test"],busy:false,
      onNotice:()=>{},onError:()=>{},
    }));
  };
  it("shows selected ordered DAG and an unchecked, disabled-until-consent submit",()=>{
    const html=render("it");
    expect(html).toContain("Piano test multi-job verificato");
    expect(html).toContain("dotnet-build");
    expect(html).toContain("dotnet-test");
    expect(html).toContain("Autorizzo esplicitamente");
    expect(html).toContain("Invia batch protetto");
    expect(html).toContain("Proponi DAG con Project Manager AI");
    expect(html).toContain("L'operatore deve approvare separatamente");
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain("github_pat_");
  });
  it("shows translated English and never enables batch for an unreviewed patch",()=>{
    const en=render("en");
    expect(en).toContain("Verified multi-job test plan");
    expect(en).toContain("Submit guarded batch");
    expect(en).toContain("Propose DAG with AI Project Manager");
    expect(en).toContain("You must separately approve");
    const unsafe=render("en",true);
    expect(unsafe).toContain("A patch awaits review");
    expect(unsafe).toMatch(/<button[^>]*disabled/);
    expect(unsafe).not.toContain("Registered workflow");
  });
});
