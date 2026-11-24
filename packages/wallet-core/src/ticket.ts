import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalize } from "@ouryn/hsp";
import { z } from "zod";
import { orderFromJson, orderToJson, type Order } from "./order.js";
import type { Intent } from "./policy.js";

/**
 * 검증 티켓: 지갑(검증기)이 "이 typed data 해시는 검증을 통과했다"고 signer에게 알리는 1회용 쪽지.
 * HMAC-SHA256(OURYN_TICKET_SECRET)으로 묶는다. signer는 티켓이 없거나, 위조됐거나, 만료됐거나,
 * 이미 쓰였거나, typed data 해시가 다르면 서명하지 않는다. 그리고 티켓을 믿지 않고 정책 검사를 다시 한다.
 *
 * HMAC 키는 서명 키가 아니다. 이것이 새도 정책 밖 결제는 signer의 재검사에서 막힌다.
 */
export const TICKET_TTL_SECONDS = 60;

const OrderJsonSchema = z
  .object({
    orderRef: z.string().min(1).max(200),
    payTo: z.string(),
    amount: z.string().regex(/^\d+$/),
    chainId: z.number().int().positive(),
    token: z.string(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const TicketBodySchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(/^[0-9a-f]{32}$/),
    typedDataHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    order: OrderJsonSchema,
    intent: z.unknown(),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict();

export const TicketSchema = TicketBodySchema.extend({ mac: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type Ticket = z.infer<typeof TicketSchema>;

export function parseTicketSecret(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64,}$/.test(hex)) throw new Error("OURYN_TICKET_SECRET: 32바이트 이상 hex 필요");
  return Buffer.from(hex, "hex");
}

function mac(secret: Buffer, body: unknown): string {
  return createHmac("sha256", secret).update(canonicalize(body)).digest("hex");
}

export function issueTicket(
  secret: Buffer,
  args: { typedDataHash: string; order: Order; intent: Intent; now: number; ttl?: number },
): Ticket {
  const body = {
    v: 1 as const,
    id: randomBytes(16).toString("hex"),
    typedDataHash: args.typedDataHash.toLowerCase(),
    order: orderToJson(args.order),
    intent: args.intent,
    issuedAt: args.now,
    expiresAt: args.now + (args.ttl ?? TICKET_TTL_SECONDS),
  };
  return { ...body, mac: mac(secret, body) };
}

export type TicketCheck =
  | { ok: true; id: string; typedDataHash: string; order: Order; intent: unknown }
  | { ok: false; reason: string };

/** MAC·만료만 확인한다. 1회용 확인(id 재사용)은 signer가 상태를 들고 한다. */
export function verifyTicket(secret: Buffer, input: unknown, now: number): TicketCheck {
  const p = TicketSchema.safeParse(input);
  if (!p.success) return { ok: false, reason: "티켓 형식이 아님" };
  const { mac: given, ...body } = p.data;
  const expected = Buffer.from(mac(secret, body), "hex");
  if (!timingSafeEqual(expected, Buffer.from(given, "hex"))) return { ok: false, reason: "티켓 MAC 불일치" };
  if (body.expiresAt <= now) return { ok: false, reason: "티켓 만료" };
  if (body.issuedAt > now + 5) return { ok: false, reason: "티켓 발급 시각이 미래" };
  let order: Order;
  try {
    order = orderFromJson(body.order);
  } catch {
    return { ok: false, reason: "티켓 주문 형식이 아님" };
  }
  return { ok: true, id: body.id, typedDataHash: body.typedDataHash, order, intent: body.intent };
}
