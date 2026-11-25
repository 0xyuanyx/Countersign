import { defineConfig } from "vite";

// 폰은 127.0.0.1에만 열린 주인 API에 직접 못 붙는다.
// 그래서 앱 서버(Vite)가 /api를 주인 API로 넘겨 준다. 폰 → 앱 주소(같은 와이파이·터널) → /api → 127.0.0.1:7420
const ownerApi = process.env.COUNTERSIGN_OWNER_API ?? "http://127.0.0.1:7420";
const proxy = { "/api": { target: ownerApi, changeOrigin: true } };

export default defineConfig({
  server: { host: true, port: 5173, strictPort: true, proxy },
  preview: { host: true, port: 4173, proxy },
  build: { target: "es2022" },
});
