import react from "@vitejs/plugin-react";
import { eveVite } from "eve/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), eveVite()],
});
