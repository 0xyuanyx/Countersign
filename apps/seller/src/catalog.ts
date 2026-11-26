import type { CatalogItem } from "./server.js";

/**
 * 데모 상품 (Sepolia 테스트 USDC, 가격 0.01~0.8). 납품물은 모두 견본 데이터다 (실제 조회 아님).
 * example: 주인 앱 "맡기기" 추천 칩에 쓸 한국어 부탁 문장 (판매자 주소는 주인 API가 붙인다).
 */
export const DATA_MART_ITEMS: CatalogItem[] = [
  { sku: "weather-seoul", name: "Seoul weather forecast (tomorrow)", price: "0.05", example: "내일 서울 날씨 예보 사 와" },
  { sku: "fx-usdkrw", name: "USD/KRW exchange rate", price: "0.02", example: "지금 원·달러 환율 사 와" },
  { sku: "stock-quote", name: "Stock quote (KOSPI top 5)", price: "0.08", example: "코스피 상위 5종목 시세 사 와" },
  { sku: "crypto-price", name: "BTC/ETH spot price", price: "0.01", example: "비트코인·이더리움 현재가 사 와" },
  { sku: "news-summary", name: "Today's tech news summary", price: "0.10", example: "오늘 IT 뉴스 요약 하나 사 와" },
  { sku: "translate-ko-en", name: "Korean→English translation (300 chars)", price: "0.03", example: "이 문장 영어 번역 사 와" },
  { sku: "image-gen", name: "AI image generation (1 image)", price: "0.30", example: "고양이 일러스트 한 장 만들어 와" },
  { sku: "image-gen-hd", name: "AI image generation, HD pack (4 images)", price: "0.80", example: "고화질 고양이 일러스트 4장 묶음 사 와" },
  { sku: "address-profile", name: "Wallet address profile report", price: "0.10", example: "이 지갑 주소 프로필 리포트 사 와" },
  { sku: "flight-price", name: "Seoul→Tokyo flight price check", price: "0.15", example: "다음 주 서울-도쿄 항공권 가격 알아 와" },
];

/** 두 번째 정직한 판매자 (처음 보는 판매자 → 주인 승인 흐름용) */
export const NEWS_WIRE_ITEMS: CatalogItem[] = [
  { sku: "news-breaking", name: "Breaking news digest", price: "0.06", example: "속보 뉴스 다이제스트 사 와" },
  { sku: "sports-score", name: "Last night's KBO scores", price: "0.02", example: "어젯밤 프로야구 결과 사 와" },
  { sku: "exchange-calendar", name: "This week's economic calendar", price: "0.04", example: "이번 주 경제 지표 일정 사 와" },
];

/** 악성 판매자들이 파는 척하는 상품 (정상 판매자와 같은 상품·가격으로 보이게) */
export const LOOKALIKE_ITEMS: CatalogItem[] = DATA_MART_ITEMS.filter((i) =>
  ["weather-seoul", "fx-usdkrw", "news-summary"].includes(i.sku),
);

export function catalogFor(name: string | undefined): CatalogItem[] {
  if (name === "news-wire") return NEWS_WIRE_ITEMS;
  if (name === "lookalike") return LOOKALIKE_ITEMS;
  return DATA_MART_ITEMS;
}

/** 견본 납품물 */
export function sampleGoods(sku: string, subject: string): Record<string, unknown> {
  const s = subject || undefined;
  switch (sku) {
    case "weather-seoul":
      return { city: "Seoul", date: "tomorrow", forecast: "Clear, 2°C / -5°C, wind 3 m/s", sample: true };
    case "fx-usdkrw":
      return { pair: "USD/KRW", rate: 1387.5, sample: true };
    case "stock-quote":
      return { index: "KOSPI", top5: ["005930 71,200", "000660 182,000", "373220 398,500", "207940 812,000", "005380 245,000"], sample: true };
    case "crypto-price":
      return { BTC: "96,420 USD", ETH: "3,512 USD", sample: true };
    case "translate-ko-en":
      return { input: s ?? "(없음)", output: "Sample translation output.", sample: true };
    case "image-gen":
    case "image-gen-hd":
      return { prompt: s ?? "a cat illustration", images: sku === "image-gen" ? 1 : 4, url: "https://example.com/sample.png", sample: true };
    default:
      return { sku, subject: s ?? "(없음)", report: `Sample ${sku} data delivered after HSP payment confirmation.`, sample: true };
  }
}
