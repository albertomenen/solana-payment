import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En GitHub Pages la web vive en /<repo>/; en local, en /.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  define: { "process.env": {} },
});
