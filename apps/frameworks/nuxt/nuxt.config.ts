import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  modules: ["eve/nuxt"],

  css: ["~/assets/css/main.css"],

  devtools: { enabled: true },

  app: {
    head: {
      link: [{ rel: "icon", href: "/favicon.ico", sizes: "any" }],
    },
  },

  compatibilityDate: "2026-05-27",

  vite: {
    plugins: [tailwindcss()],
  },
});
