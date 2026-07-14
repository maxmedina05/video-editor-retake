import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Node server (src/web/server.ts) serves the built assets from web-ui/dist
// and hosts /api/*. In `vite dev` we proxy /api to a running `clean-video ui`.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:5199", changeOrigin: true },
    },
  },
});
