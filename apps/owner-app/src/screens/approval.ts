// 구매 요청: 처음 보는 판매자면 결제 전에 물어본다.
// 결제 → 비밀번호 → "다음부터 이곳은 요청 없이 바로 결제할까요?" (같은 확인으로 처리, 두 번 묻지 않음)
// 거절 → OWNER_REJECTED로 기록. 시간 안에 답이 없으면 결제하지 않는다.

import { ApiError, type HistoryEntry, type PurchaseRequest } from "../api.js";
import { app, openSheet, refreshSoon, strip } from "../app.js";
import { addrHtml, busy, esc, ic, toast, usdc } from "../ui.js";
import { unlock } from "./gates.js";

let openId: string | undefined;

function left(r: PurchaseRequest): number {
  return r.order_expires_at - Math.floor(Date.now() / 1000);
}
function fmtLeft(s: number): string {
  if (s <= 0) return "시간이 지났어요";
  const m = Math.floor(s / 60);
  return `${m > 0 ? `${m}분 ` : ""}${s % 60}초 남음`;
}

/** 대기 중인 요청의 대조 띠: 서버 내역의 checks를 쓰고, 없으면 "수취인만 주황, 서명자는 아직" */
function requestStripEntry(r: PurchaseRequest): Pick<HistoryEntry, "status" | "checks"> {
  const h = app.data.history.find((e) => e.request_id === r.id);
  if (h?.checks) return { status: "pending", checks: h.checks };
  return {
    status: "pending",
    checks: [
      { field: "payee", result: "needs_approval" },
      { field: "amount", result: "match" },
      { field: "chain", result: "match" },
      { field: "token", result: "match" },
      { field: "expiry", result: "match" },
      { field: "signer", result: "unchecked" },
    ],
  };
}

export function openApproval(r: PurchaseRequest): void {
  if (openId === r.id) return;
  openId = r.id;
  app.prompted.add(r.id);
  const task = app.data.tasks.find((t) => t.id === r.task_id);
  const amt = usdc(r.amount);
  let tick: number | undefined;
  const close = openSheet(
    `
    <span class="t13" style="color:var(--ask)" data-left>${fmtLeft(left(r))} · 답이 없으면 결제하지 않아요</span>
    <h1 class="title-md" style="margin-top:8px" id="ask-title">${r.reason === "every_payment" ? "결제해도 될까요?" : "처음 보는 판매자예요"}</h1>
    ${task ? `<p class="muted" style="margin-top:6px;font-size:14px">맡긴 일: ${esc(task.text)}</p>` : ""}
    <div class="amount-big"><span class="num">${amt}</span><span class="muted" style="font-size:16px">USDC</span></div>
    <div class="inner" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;gap:12px"><span class="t15b">${esc(r.seller)}</span><span class="muted t13 ellipsis">${esc(r.purpose)}</span></div>
      ${addrHtml(r.pay_to)}
      <div style="margin-top:4px">${strip(requestStripEntry(r))}</div>
    </div>
    <p class="dim t13" style="margin-top:12px;line-height:20px">이 주소에 처음 보내는 거라 물어봐요. 금액·체인·토큰·만료는 HSP 주문과 맞았어요</p>
    <div class="bottom-actions" style="padding-top:16px">
      <button class="btn btn-primary press" data-act="pay">${amt} USDC 결제</button>
      <button class="btn btn-ghost btn-danger" data-act="reject">거절</button>
    </div>`,
    (sheet, closeSheet) => {
      const leftEl = sheet.querySelector<HTMLElement>("[data-left]")!;
      const payBtn = sheet.querySelector<HTMLButtonElement>('[data-act="pay"]')!;
      const update = () => {
        const s = left(r);
        leftEl.textContent = s > 0 ? `${fmtLeft(s)} · 답이 없으면 결제하지 않아요` : "시간이 지나 결제하지 않았어요";
        if (s <= 0) {
          payBtn.disabled = true;
          clearInterval(tick);
        }
      };
      tick = window.setInterval(update, 1000);
      sheet.addEventListener("click", async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "pay") {
          clearInterval(tick);
          await closeSheet();
          openId = undefined;
          await pay(r);
        } else if (act === "reject") {
          clearInterval(tick);
          try {
            await busy(sheet.querySelector<HTMLElement>('[data-act="reject"]'), "거절하는 중…", () => app.api.reject(r.id));
            toast("거절했어요. 돈은 나가지 않아요");
          } catch (err) {
            toast(err instanceof ApiError ? err.message : "거절하지 못했어요");
          }
          await closeSheet();
          openId = undefined;
          refreshSoon();
        }
      });
    },
    { label: "구매 요청", dismissable: true },
  );
  // 배경을 눌러 닫으면 다음 새로고침 때 다시 띄우지 않는다 (홈 카드로 다시 열 수 있음)
  const sheetEl = document.querySelector<HTMLElement>("#sheet-root .scrim");
  sheetEl?.addEventListener("click", () => {
    clearInterval(tick);
    openId = undefined;
  });
  void close;
}

async function pay(r: PurchaseRequest): Promise<void> {
  const amt = usdc(r.amount);
  const ok = await unlock({ title: `${r.seller}에 ${amt} USDC를 결제해요`, closable: true, autoFace: true });
  if (!ok) return;
  try {
    await busy(undefined, `${r.seller}에 결제하는 중…`, () => app.api.approve(r.id));
  } catch (err) {
    toast(err instanceof ApiError && err.status === 410 ? "시간이 지나 결제하지 않았어요" : err instanceof ApiError ? err.message : "승인하지 못했어요");
    refreshSoon();
    return;
  }
  refreshSoon();
  const known = app.data.policy?.sellers.some((s) => s.name === r.seller && s.address.toLowerCase() === r.pay_to.toLowerCase());
  if (r.reason === "unknown_seller" && !known) askRemember(r);
  else toast(`${r.seller} 결제를 승인했어요`);
}

/** 결제 직후 한 번: 다음부터 이곳은 요청 없이 바로 결제할까요? (비밀번호는 방금 확인했으니 다시 묻지 않음) */
function askRemember(r: PurchaseRequest): void {
  openSheet(
    `
    <span class="t13" style="display:flex;align-items:center;gap:6px;color:var(--ok)">${ic.check(16, "#00C896")}${esc(r.seller)}에 ${usdc(r.amount)} USDC 결제를 승인했어요</span>
    <h1 class="title-md" style="margin-top:10px">다음부터 이곳은 요청 없이 바로 결제할까요?</h1>
    <div class="inner" style="margin-top:16px;flex-direction:row;justify-content:space-between;align-items:center">
      <span class="t15b">${esc(r.seller)}</span>${addrHtml(r.pay_to, { short: true })}
    </div>
    <p class="muted t13" style="margin-top:12px;line-height:20px">승인하면 이 주소가 바로 결제하는 판매자에 들어가요. 한도는 그대로 지켜요</p>
    <div class="btn-pair" style="margin-top:20px">
      <button class="btn btn-card press" data-act="no">취소</button>
      <button class="btn btn-primary press" data-act="yes">승인</button>
    </div>`,
    (sheet, close) => {
      sheet.addEventListener("click", async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "no") await close();
        if (act === "yes") {
          try {
            const file = await app.api.policyFile();
            const cur = file.sellers[r.seller];
            if (cur && cur.toLowerCase() !== r.pay_to.toLowerCase()) {
              toast(`"${r.seller}"은 이미 다른 주소로 등록돼 있어요. 정책에서 확인해 주세요`);
            } else {
              await busy(sheet.querySelector<HTMLElement>('[data-act="yes"]'), "저장하는 중…", () => app.api.patchPolicy({ sellers: { ...file.sellers, [r.seller]: r.pay_to } }));
              toast(`이제 ${r.seller}는 묻지 않고 바로 결제해요`);
            }
          } catch (err) {
            toast(err instanceof ApiError ? err.message : "정책을 바꾸지 못했어요");
          }
          await close();
          refreshSoon();
        }
      });
    },
    { label: "다음부터 바로 결제" },
  );
}

/** 새 요청이 들어오면 한 번 자동으로 띄운다 */
export function autoPrompt(): void {
  if (document.querySelector("#sheet-root .sheet") || document.querySelector('[style*="z-index:80"]')) return;
  const r = app.data.requests.find((x) => x.status === "pending" && !app.prompted.has(x.id) && left(x) > 0);
  if (r) openApproval(r);
}
