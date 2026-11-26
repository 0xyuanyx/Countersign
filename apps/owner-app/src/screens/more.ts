// 정책 탭과 설정 탭 (한도 바꾸기·판매자 보기·체인은 서버 정책 그대로, HSK 메인넷은 수상 후. 설정은 연결·Face ID·다시 매칭)

import { ApiError, chainIds } from "../api.js";
import { app, openSheet, refreshSoon, type Screen } from "../app.js";
import { createPasskey, isStandalone, passkeySupported, store } from "../auth.js";
import { addrHtml, esc, ic, toast, usdc } from "../ui.js";
import { agentState, chainName, offlineBanner, tabs } from "./common.js";
import { installGuide, pinChange, unlock } from "./gates.js";
import { enableNotifications, notifyPermission } from "../notify.js";

const row = (label: string, value: string, act?: string) =>
  `<${act ? `button type="button" data-act="${act}"` : "div"} class="list-row" style="width:100%;text-align:left;min-height:56px">
    <span class="stack"><span class="t15">${label}</span></span><span class="muted t15" style="display:flex;align-items:center;gap:6px">${value}${act ? ic.chevR() : ""}</span>
  </${act ? "button" : "div"}>`;

/** 네트워크 줄: 서버 정책의 체인을 그대로 보여 주기만 한다 (체인은 정책 파일에서 바꿈). HSK 메인넷은 수상 후 옮길 때까지 비활성 */
const chainRow = (label: string, on: boolean, note: string, disabled = false) =>
  `<div class="list-row" style="min-height:60px">
    <span class="stack"><span class="t15" style="${disabled ? "color:var(--fg3)" : ""}">${label}</span>${note ? `<span class="dim t12">${note}</span>` : ""}</span>
    <span class="switch ${on ? "on" : ""} ${disabled ? "disabled" : ""}" role="switch" aria-checked="${on}" aria-disabled="true"><span></span></span>
  </div>`;

export function policy(): Screen {
  const p = app.data.policy;
  const html = `
  <div class="screen with-tabs">
    <div class="topbar"><h1 class="title-md">정책</h1><span></span></div>
    ${offlineBanner()}
    <p class="muted t13" style="margin-top:8px;line-height:20px">에이전트는 이 값을 바꿀 수 없어요. 바꿀 때마다 비밀번호를 물어봐요</p>
    <section class="card" style="margin-top:16px;padding:0 16px">
      ${row("1회 최대", `${usdc(p?.per_tx_max)} USDC`, "per")}
      <div class="divider"></div>
      ${row("하루 최대", `${usdc(p?.daily_max)} USDC`, "daily")}
      <div class="divider"></div>
      ${row("오늘 남은 돈", `${usdc(p?.remaining_24h)} USDC`)}
    </section>
    <div class="section-head"><span class="h">허용 네트워크 · 토큰은 USDC만</span></div>
    <section class="card" style="margin-top:8px;padding:0 16px">
      ${chainIds(p)
        .map((id) => chainRow(esc(chainName(id)), true, `체인 ${id}`))
        .join('<div class="divider"></div>')}
      ${chainIds(p).length ? '<div class="divider"></div>' : ""}
      ${chainIds(p).includes(177) ? "" : chainRow(esc(chainName(177)), false, "수상 후 옮겨요 · 지금은 켤 수 없어요", true)}
    </section>
    <div class="section-head"><span class="h">바로 결제하는 판매자</span><span class="dim t13">${p?.sellers.length ?? 0}곳</span></div>
    <section class="card" style="margin-top:8px;padding:4px 16px">
      ${
        p?.sellers.length
          ? p.sellers.map((s, i) => `${i ? '<div class="divider"></div>' : ""}<div style="padding:12px 0;display:flex;flex-direction:column;gap:4px"><span class="t15">${esc(s.name)}</span>${addrHtml(s.address)}</div>`).join("")
          : `<p class="empty">아직 없어요. 처음 보는 판매자는 결제 전에 물어봐요</p>`
      }
    </section>
    <p class="dim t12" style="margin-top:8px;line-height:18px">등록한 이름인데 주소가 다르면 묻지 않고 거절해요</p>
  </div>
  ${tabs("policy")}`;
  return {
    html,
    bind: (root) =>
      root.addEventListener("click", (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "per") editLimit("perTxMax", p?.per_tx_max ?? "0.5", p?.daily_max ?? "5");
        if (act === "daily") editLimit("dailyMax", p?.daily_max ?? "5", p?.per_tx_max ?? "0.5");
      }),
  };
}

/** 한도 바꾸기 (LimitSheet): 지금 값, 새 값, 다른 한도와의 관계 → 저장 → 비밀번호 */
function editLimit(key: "perTxMax" | "dailyMax", cur: string, other: string): void {
  const label = key === "perTxMax" ? "1회 최대 금액" : "하루 최대 금액";
  const hint =
    key === "perTxMax"
      ? `하루 최대 ${usdc(other)} USDC보다 클 수 없어요. 바꾸면 다음 결제부터 적용돼요`
      : `1회 최대 ${usdc(other)} USDC보다 작을 수 없어요. 바꾸면 다음 결제부터 적용돼요`;
  openSheet(
    `<h1 class="title-md" id="limit-title">${label}</h1>
     <p class="muted t13" style="margin-top:6px">지금 ${usdc(cur)} USDC</p>
     <label class="t13 dim" for="limit" style="margin-top:20px">새 ${label}</label>
     <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
       <input id="limit" class="field" inputmode="decimal" autocomplete="off" style="font-size:22px;font-weight:600" value="${esc(usdc(cur))}" data-v>
       <span class="muted" style="flex:none">USDC</span>
     </div>
     <p class="dim t12" style="margin-top:10px;line-height:18px" data-hint>${hint}</p>
     <div class="bottom-actions" style="padding-top:16px"><button class="btn btn-primary press" data-act="save">저장</button></div>`,
    (sheet, close) => {
      const input = sheet.querySelector<HTMLInputElement>("[data-v]")!;
      const hintEl = sheet.querySelector<HTMLElement>("[data-hint]")!;
      setTimeout(() => input.select(), 380);
      const invalid = (v: string): string | undefined => {
        if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(v) || Number(v) <= 0) return "0보다 큰 숫자를 넣어 주세요 (소수 6자리까지)";
        if (key === "perTxMax" && Number(v) > Number(other)) return `하루 최대 ${usdc(other)} USDC보다 클 수 없어요`;
        if (key === "dailyMax" && Number(v) < Number(other)) return `1회 최대 ${usdc(other)} USDC보다 작을 수 없어요`;
        return undefined;
      };
      input.addEventListener("input", () => {
        const bad = invalid(input.value.trim());
        hintEl.textContent = bad ?? hint;
        hintEl.style.color = bad ? "var(--bad-text)" : "";
      });
      sheet.querySelector('[data-act="save"]')!.addEventListener("click", async () => {
        const v = input.value.trim();
        const bad = invalid(v);
        if (bad) {
          hintEl.textContent = bad;
          hintEl.style.color = "var(--bad-text)";
          return;
        }
        if (Number(v) === Number(cur)) return void close();
        await close();
        if (!(await unlock({ title: `${label}을 ${usdc(cur)}에서 ${usdc(v)} USDC로 바꿔요`, closable: true }))) return;
        try {
          await app.api.patchPolicy({ [key]: v });
          toast("정책을 바꿨어요. 다음 결제부터 적용돼요");
        } catch (e) {
          toast(e instanceof ApiError ? e.message : "바꾸지 못했어요");
        }
        refreshSoon();
      });
    },
    { label },
  );
}

export function settings(): Screen {
  const pair = store.pairing();
  const html = `
  <div class="screen with-tabs">
    <div class="topbar"><h1 class="title-md">설정</h1><span></span></div>
    <section class="card" style="margin-top:16px;padding:0 16px">
      ${row("앱 비밀번호", "6자리 · 바꾸기", "pin")}
      <div class="divider"></div>
      ${passkeySupported() ? row("Face ID", store.passkeyId() ? '<span style="color:var(--ok)">켜짐</span>' : "꺼짐", store.passkeyId() ? "face-off" : "face-on") : row("Face ID", '<span class="dim">HTTPS에서만</span>')}
    </section>
    <div class="section-head"><span class="h">에이전트</span></div>
    <section class="card" style="margin-top:8px;padding:0 16px">
      ${app.data.agents
        .filter((a) => a.connected)
        .map(
          (a) => `<a class="list-row press" href="#/agent/${esc(a.id)}" style="min-height:56px;gap:12px"><img src="/mark.svg" width="24" height="24" alt="" style="${a.paused ? "opacity:0.4" : ""}">
            <span class="t15" style="flex:1">${esc(a.name)}</span><span class="muted t13" style="display:flex;align-items:center;gap:6px">${agentState(a)}${ic.chevR()}</span></a><div class="divider"></div>`,
        )
        .join("")}
      <a class="list-row press" href="#/connect" style="min-height:56px;gap:12px">${ic.plus()}<span class="t15" style="flex:1">새 에이전트 연결</span>${ic.chevR()}</a>
    </section>
    <div class="section-head"><span class="h">알림</span></div>
    <section class="card" style="margin-top:8px;padding:0 16px">
      <p class="muted t13" style="padding:14px 0;line-height:20px">구매 요청과 막은 결제는 항상 알려요. 결제가 끝난 건 알리지 않아요. 알림은 홈 화면에 추가한 앱에서만 받을 수 있어요</p>
      <div class="divider"></div>
      ${row("이 폰에서 알림", { granted: '<span style="color:var(--ok)">켜짐</span>', denied: "꺼짐 (폰 설정에서 허용)", default: "켜기", unsupported: isStandalone() ? "이 브라우저는 안 됨" : "홈 화면 앱에서" }[notifyPermission()], notifyPermission() === "default" ? "notify" : undefined)}
      <div class="divider"></div>
      ${row("홈 화면에 추가하는 법", isStandalone() ? '<span style="color:var(--ok)">추가됨</span>' : "", "install")}
    </section>
    <div class="section-head"><span class="h">지갑 서버</span></div>
    <section class="card" style="margin-top:8px;padding:0 16px">
      ${row("연결", `${esc(pair?.mock ? "데모 데이터" : (pair?.label ?? "—"))}`)}
      <div class="divider"></div>
      ${row("에이전트 계정", app.data.policy?.account ? addrHtml(app.data.policy.account, { short: true }) : "—")}
      <div class="divider"></div>
      <button type="button" class="list-row" data-act="repair" style="width:100%;min-height:56px;color:var(--bad)">이 폰 연결 끊고 다시 매칭</button>
    </section>
    <p class="dim t12" style="margin-top:8px;line-height:18px">폰에는 키가 없어요. 폰을 잃어버리면 지갑 서버에서 새 QR을 띄워 다시 매칭해요</p>
  </div>
  ${tabs("settings")}`;
  return {
    html,
    bind: (root) =>
      root.addEventListener("click", async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "face-on") {
          if (await unlock({ title: "Face ID를 켜요", closable: true })) {
            toast((await createPasskey()) ? "Face ID를 켰어요" : "켜지 못했어요");
            app.render();
          }
        }
        if (act === "pin") {
          if (await pinChange()) toast("앱 비밀번호를 바꿨어요");
        }
        if (act === "face-off") {
          store.setPasskeyId(undefined);
          toast("Face ID를 껐어요");
          app.render();
        }
        if (act === "notify") {
          const r = await enableNotifications();
          toast(r === "granted" ? "알림을 켰어요" : "알림을 켜지 못했어요");
          app.render();
        }
        if (act === "install") {
          await installGuide({ hadPairLink: false, closable: true });
          app.render();
        }
        if (act === "repair") {
          if (!(await unlock({ title: "이 폰의 연결을 끊어요", subtitle: "비밀번호와 Face ID도 지워져요", closable: true }))) return;
          store.reset();
          location.hash = "";
          location.reload();
        }
      }),
  };
}
