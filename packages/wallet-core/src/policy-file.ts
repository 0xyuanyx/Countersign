import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { PolicyFileSchema, parsePolicy, type Policy } from "./policy.js";

/**
 * 정책 파일 읽기·쓰기. signer·지갑 MCP는 서명·결제 때마다 get()으로 다시 읽는다 (바뀌었을 때만 파싱).
 * 파일이 깨졌거나 형식이 틀리면 throw → 호출한 쪽은 결제를 거부한다 (fail-closed).
 * 쓰기는 주인 API만 한다. 에이전트용 MCP에는 쓰기 도구가 없다 (AGENTS.md 규칙 4).
 */
export class PolicyFile {
  private cache: { key: string; policy: Policy; json: PolicyFileJson } | undefined;

  constructor(readonly path: string) {}

  get(): Policy {
    return this.load().policy;
  }

  /** 현재 파일 내용 (정책 화면 편집용) */
  json(): PolicyFileJson {
    return structuredClone(this.load().json);
  }

  /**
   * 주인이 바꿀 수 있는 값만 고친다. agent·accountIndex(서명 계정)는 바꿀 수 없다: signer가 시작할 때 키를 정했기 때문.
   * 검증을 통과한 경우에만 원자적으로 바꿔 쓴다.
   */
  update(patch: unknown): Policy {
    const p = PolicyPatchSchema.parse(patch);
    const { tokenAddresses, maxAuthorizationSeconds, ...rest } = p;
    const next: PolicyFileJson = { ...this.json(), ...rest };
    // null이면 그 항목을 지운다 (기본값으로), undefined면 그대로 둔다
    if (tokenAddresses === null) delete next.tokenAddresses;
    else if (tokenAddresses !== undefined) next.tokenAddresses = tokenAddresses;
    if (maxAuthorizationSeconds === null) delete next.maxAuthorizationSeconds;
    else if (maxAuthorizationSeconds !== undefined) next.maxAuthorizationSeconds = maxAuthorizationSeconds;
    const policy = parsePolicy(next);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
    this.cache = undefined;
    return policy;
  }

  private load() {
    const st = statSync(this.path);
    const key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (this.cache?.key !== key) {
      const json = PolicyFileSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      this.cache = { key, policy: parsePolicy(json), json };
    }
    return this.cache;
  }
}

export type PolicyFileJson = z.infer<typeof PolicyFileSchema>;

/** 주인 앱이 보낼 수 있는 변경. 모르는 필드·agent·accountIndex는 거부 */
export const PolicyPatchSchema = z
  .object({
    chains: PolicyFileSchema.shape.chains.optional(),
    perTxMax: PolicyFileSchema.shape.perTxMax.optional(),
    dailyMax: PolicyFileSchema.shape.dailyMax.optional(),
    sellers: PolicyFileSchema.shape.sellers.optional(),
    tokenAddresses: PolicyFileSchema.shape.tokenAddresses.unwrap().nullable().optional(),
    maxAuthorizationSeconds: PolicyFileSchema.shape.maxAuthorizationSeconds.unwrap().nullable().optional(),
  })
  .strict();
