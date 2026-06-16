import adapter from "@sveltejs/adapter-vercel";

const config = {
  kit: {
    adapter: adapter(),
  },
};

export default config;
