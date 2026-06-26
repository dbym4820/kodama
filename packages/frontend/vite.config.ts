import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// バックエンド(52525)の /ws をプロキシし, Web UIから同一オリジンで接続する.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:52525", ws: true },
      "/health": { target: "http://localhost:52525" },
    },
  },
});
