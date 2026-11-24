import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Normal bundled build: every dependency (React, viem, Ammora SDK) is
 * bundled from node_modules into dist. The app has no runtime CDN
 * dependency.
 *
 * History: an earlier revision externalized the heavy deps and loaded
 * them from esm.sh / jsDelivr via an import map, because the deploy path
 * at the time uploaded files one by one through a CLI argument capped at
 * ~128 KB. That constraint does not apply to GitHub Pages, where Actions
 * builds from source with no such limit — so the externalization was
 * reverted on 24 Nov 2026.
 *
 * Deploy note (24 Nov 2026): four rapid successive pushes raced each other
 * at the GitHub Pages deploy step and all four runs failed there with
 * "No artifacts named 'github-pages'" (build itself passed each time).
 * This comment re-triggered a clean deploy run.
 */
export default defineConfig({
  // Relative base so the same build works at a domain root (Vercel) and
  // under a subpath (GitHub Pages project site, e.g. /kongpad/).
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
  },
});
