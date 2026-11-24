import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyFile } from "./policy-file.js";
import { policyJson } from "./testkit.js";

describe("PolicyFile", () => {
  it("파일이 바뀌면 다시 읽고, 깨지면 throw (fail-closed)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cs-policy-")), "p.json");
    writeFileSync(path, JSON.stringify(policyJson));
    const f = new PolicyFile(path);
    expect(f.get().dailyMax).toBe(1_000_000n);
    writeFileSync(path, JSON.stringify({ ...policyJson, dailyMax: "3.00" }));
    expect(f.get().dailyMax).toBe(3_000_000n);
    writeFileSync(path, "{ broken");
    expect(() => f.get()).toThrow();
  });

  it("update는 agent·accountIndex를 못 바꾸고, null로 선택 항목을 지운다", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cs-policy-")), "p.json");
    writeFileSync(path, JSON.stringify({ ...policyJson, maxAuthorizationSeconds: 600 }));
    const f = new PolicyFile(path);
    expect(() => f.update({ accountIndex: 5 })).toThrow();
    expect(f.update({ maxAuthorizationSeconds: null }).maxAuthorizationSeconds).toBe(3600);
    expect(f.json().maxAuthorizationSeconds).toBeUndefined();
  });
});
