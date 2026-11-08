import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where `pnpm dev` sends API calls: a server started with `pnpm --filter @highground/server start`. */
const server = process.env.HIGHGROUND_SERVER_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/rpc", "/auth"].map((path) => [path, { target: server, changeOrigin: false }]),
    ),
  },
  build: { outDir: "dist", sourcemap: true },
});
