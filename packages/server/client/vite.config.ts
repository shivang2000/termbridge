import { defineConfig } from "vite";

// Lean xterm client. Built into ./dist and served statically by the server.
export default defineConfig({
	build: { outDir: "dist", emptyOutDir: true },
});
