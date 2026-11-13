import next from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";
const config = [
  ...next,
  ...typescript,
  { ignores: ["**/.next/**", "**/.eve/**", "**/.output/**", "**/next-env.d.ts", "**/dist/**", "**/node_modules/**"] },
];
export default config;
