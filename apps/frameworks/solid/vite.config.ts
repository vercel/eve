import solid from "@solidjs/vite-plugin";
import { eveVite } from "eve/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [solid({ start: true, ssr: true }), nitro(), eveVite()],
});
