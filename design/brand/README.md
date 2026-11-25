# Countersign 브랜드: 에이전트 아이콘

Ouryn 로고(열린 링 + 작은 점)에서 점이 커져 에이전트가 되고, 링은 작아져 왼쪽 아래로 밀려나 에이전트를 받쳐 주는 모양. 마지막에 눈이 떠진다.
색은 Ouryn 그대로: 배경 `#0B0B0D`, 링은 Ouryn `Brand`의 은색 선형 그라데이션, 원은 은색 방사형, 눈은 배경색.

애니메이션(스플래시·로고): Ouryn 모양 → 점 커짐과 링 작아짐을 같은 구간(0~78%)·같은 속도로, 링 양 끝은 원에서 10px 떨어진 곳에서 끊겨 서로 겹치지 않음 → 눈 뜸(72~100%), 1.6초, ease-out.
좌표(320 viewBox): 시작 링 중심(160,160) r102 굵기40 각도 0°→293°, 점 (248,102) r20 / 끝 링 중심(124,200) r66 굵기18 각도 45°→221°, 원 (184,136) r92, 눈 ±25, 10.5×17.

## 아이콘 애니메이션 (`animation/`)

| 파일 | 내용 |
|---|---|
| `animation/icon-animation.js` | 재사용 모듈. `mountIconAnimation(el, { size, autoplay, background })` → `{ play(), seek(t), destroy() }`. 좌표·타이밍은 `ICON_ANIMATION`에 모여 있음 |
| `animation/demo.html` | 브라우저로 바로 여는 데모 (다시 재생, 장면 슬라이더). 모듈 코드를 안에 넣어 둬서 파일 하나로 열림 |
| `animation/icon-animation.gif` | 240px 미리보기 (발표 자료·README용) |

```js
import { mountIconAnimation } from './icon-animation.js';
const anim = mountIconAnimation(document.getElementById('splash-logo'), { size: 160 });
await anim.play(); // 끝나면 홈으로 넘어가기
```
`prefers-reduced-motion: reduce`이면 바로 끝 모양을 보여 준다.

| 파일 | 용도 |
|---|---|
| `mark.svg` | 배경 없는 심볼 |
| `icon.svg`, `icon-512.png`, `icon-192.png` | PWA `purpose: any` |
| `icon-maskable.svg`, `icon-maskable-512.png`, `icon-maskable-192.png` | PWA `purpose: maskable` (80%) |
| `apple-touch-icon.png` | iOS 홈 화면 180×180 |
| `favicon.svg`, `favicon.ico`, `favicon-32.png`, `favicon-16.png` | 브라우저 탭 |

```json
"icons": [
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
  { "src": "/icon-maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
  { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
],
"background_color": "#0B0B0D",
"theme_color": "#0B0B0D"
```
```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```
