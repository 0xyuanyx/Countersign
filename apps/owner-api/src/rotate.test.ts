import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyFile, readOrCreateSharedSecret, rotateSharedSecret, statePaths } from "@countersign/wallet-core";
import { policyJson } from "@countersign/wallet-core/testkit";
import { describe, expect, it } from "vitest";
import { createOwnerApi, listenOwnerApi } from "./server.js";

describe("주인 토큰 바꾸기", () => {
  it("파일을 바꾸면 재시작 없이 이전 토큰은 401, 새 토큰은 통과", async () => {
    const paths = statePaths({ COUNTERSIGN_HOME: mkdtempSync(join(tmpdir(), "cs-rot-")) });
    const policyPath = join(paths.dir, "p.json");
    writeFileSync(policyPath, JSON.stringify(policyJson));
    const old = readOrCreateSharedSecret(paths.ownerToken, true)!;
    const server = createOwnerApi({
      policy: new PolicyFile(policyPath),
      paths,
      ownerToken: () => readOrCreateSharedSecret(paths.ownerToken, false) ?? "",
      requireTokenAll: true,
    });
    const base = await listenOwnerApi(server, 0);
    const get = (t: string) => fetch(`${base}/api/pause`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.status);
    try {
      expect(await get(old)).toBe(200);
      rotateSharedSecret(paths.ownerToken);
      const fresh = readOrCreateSharedSecret(paths.ownerToken, false)!;
      expect(fresh).not.toBe(old);
      expect(await get(old)).toBe(401);
      expect(await get(fresh)).toBe(200);
    } finally {
      server.close();
    }
  });
});
