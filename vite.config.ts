import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: "dist/ui" },
});
