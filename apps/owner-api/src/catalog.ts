import { parseAmount, type Policy } from "@countersign/wallet-core";
import { z } from "zod";

/**
 * 주인 앱 "맡기기" 추천 칩용 상품 목록. 데모 판매 서버들의 GET / 을 모아서 돌려준다.
 * scenario로 그 판매자에게서 사면 지갑이 무엇을 보여 주는지 알려 준다 (발표·데모용 표시).
 */
export const SCENARIOS = {
  normal: "등록된 판매자: 검증 통과하면 바로 결제 (새 에이전트는 첫 구매 때 주인 승인)",
  new_seller: "처음 보는 판매자: 주인 승인 요청이 뜸",
  payee_swap: "판매자 사칭 + 받는 주소 바꿔치기: 지갑이 거절 (PAYEE_MISMATCH)",
  amount_swap: "말한 가격의 1000배 청구: 지갑이 거절 (AMOUNT_OVER_INTENT)",
  chain_swap: "다른 체인으로 청구: 지갑이 거절 (CHAIN_OR_TOKEN_NOT_ALLOWED)",
  injection: "프롬프트 인젝션으로 금액 올리기 유도: 지갑이 거절",
} as const;
export type Scenario = keyof typeof SCENARIOS;

export interface CatalogSource {
  url: string;
  scenario: Scenario;
}

/** demo.sh가 띄우는 판매자들 */
export const DEMO_SELLERS: CatalogSource[] = [
  { url: "http://127.0.0.1:7430", scenario: "normal" },
  { url: "http://127.0.0.1:7435", scenario: "new_seller" },
  { url: "http://127.0.0.1:7431", scenario: "payee_swap" },
  { url: "http://127.0.0.1:7432", scenario: "amount_swap" },
  { url: "http://127.0.0.1:7433", scenario: "chain_swap" },
  { url: "http://127.0.0.1:7434", scenario: "injection" },
];

const SellerIndexSchema = z.object({
  seller: z.string(),
  items: z.array(
    z.object({ sku: z.string(), name: z.string(), price: z.string(), example: z.string().optional(), chain_id: z.number().optional() }),
  ),
});

export async function loadCatalog(sources: CatalogSource[], policy?: Policy) {
  const sellers = await Promise.all(
    sources.map(async (src) => {
      try {
        const r = await fetch(`${src.url}/`, { signal: AbortSignal.timeout(3000) });
        const idx = SellerIndexSchema.parse(await r.json());
        return { name: idx.seller, url: src.url, scenario: src.scenario, scenario_label: SCENARIOS[src.scenario], reachable: true, items: idx.items };
      } catch {
        return { name: undefined, url: src.url, scenario: src.scenario, scenario_label: SCENARIOS[src.scenario], reachable: false, items: [] };
      }
    }),
  );
  const chips = sellers.flatMap((s) =>
    s.items.map((i) => {
      let exceeds = false;
      try {
        exceeds = !!policy && parseAmount(i.price) > policy.perTxMax;
      } catch {
        // 가격 형식이 이상하면 표시만 생략
      }
      // 한도 초과 상품은 정상 판매자여도 지갑이 막는다 (OVER_LIMIT)
      const scenario: Scenario | "over_limit" = exceeds && s.scenario === "normal" ? "over_limit" : s.scenario;
      return {
        id: `${s.url.split(":").pop()}-${i.sku}`,
        label: i.example ?? i.name,
        item: i.name,
        sku: i.sku,
        price: i.price,
        seller: s.name,
        seller_url: s.url,
        scenario,
        scenario_label: scenario === "over_limit" ? "한도 초과 가격: 지갑이 거절 (OVER_LIMIT)" : s.scenario_label,
        ...(policy && { exceeds_per_tx: exceeds }),
        /** 맡기기(POST /api/tasks)의 text로 그대로 쓰면 되는 문장. 에이전트가 판매자 주소와 상품을 알 수 있게 붙인다 */
        task_text: `${i.example ?? i.name}. 판매자 ${s.url} 에서 상품 ${i.sku}(${i.price} USDC)를 사서 결과를 알려 줘.`,
      };
    }),
  );
  return { sellers, chips };
}
