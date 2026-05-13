import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // During `npm run dev`, proxy API calls to the Worker on its default port.
    proxy: {
      "/api":     { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/webhook": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/auth":    { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/healthz": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
