import tailwindcss from "@tailwindcss/vite";
import type { NuxtConfig } from "nuxt/schema";

export default {
  modules: ["eve/nuxt"],

  css: ["~/assets/css/main.css"],

  devtools: { enabled: true },

  compatibilityDate: "2026-05-27",

  vite: {
    plugins: [tailwindcss()],
  },
} satisfies NuxtConfig;
