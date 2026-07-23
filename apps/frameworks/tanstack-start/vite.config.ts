import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";
import { eveNitro } from "eve/nitro";

export default defineConfig(({ command }) => ({
  plugins: [
    tanstackStart(),
    eveNitro(),
    ...nitro({ preset: command === "serve" ? "nitro-dev" : "node-server" }),
    react(),
  ],
}));
