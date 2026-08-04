import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset URLs so the built UI also works behind a path-prefixing
  // reverse proxy (e.g. https://host/understory/), not just at the site root.
  // API calls resolve the same way — see apiUrl() in src/api.ts.
  base: "./",
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/api": "http://localhost:3800",
      "/mcp": "http://localhost:3800",
    },
  },
});
