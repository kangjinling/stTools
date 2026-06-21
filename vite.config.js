import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api/chart": {
        target: "https://query1.finance.yahoo.com",
        changeOrigin: true,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
          "Accept": "application/json,text/plain,*/*"
        },
        rewrite: (path) => path.replace(/^\/api\/chart/, "/v8/finance/chart")
      }
    }
  }
});
