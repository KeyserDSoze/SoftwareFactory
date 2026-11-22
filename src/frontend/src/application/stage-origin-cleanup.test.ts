import {describe,expect,it} from "vitest";
import {createProject} from "../domain/defaults";
import {commitStage,invalidateStages} from "./pipeline";

describe("stage origin cleanup on non-CAS pipeline invalidation #161",()=>{
  it("clears manual and AI origin when resetting or correcting",()=>{
    const p=createProject();
    p.stages[0].status="complete";
    p.stages[0].output="human";
    p.stages[0].completionOrigin="manual";
    p.stages[1].status="complete";
    p.stages[1].output="AI";
    p.stages[1].completionOrigin="ai";
    const changed=commitStage(p,"features","replacement",[]);
    expect(changed.stages[0].completionOrigin).toBeUndefined();
    expect(changed.stages[1].completionOrigin).toBeUndefined();
    expect(changed.stages[1].status).toBe("pending");
    const cleared=invalidateStages(p);
    expect(cleared.stages.every(stage=>stage.completionOrigin===undefined))
      .toBe(true);
    expect(JSON.stringify(cleared)).not.toContain("completionOrigin");
    expect(p.stages[0].completionOrigin).toBe("manual");
    expect(p.stages[1].completionOrigin).toBe("ai");
  });
});
