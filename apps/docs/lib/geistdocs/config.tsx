import { LogoAiElements } from "@vercel/geistdocs/assets/logos/logo-ai-elements";
import { LogoAiSdk } from "@vercel/geistdocs/assets/logos/logo-ai-sdk";
import { LogoChatSdk } from "@vercel/geistdocs/assets/logos/logo-chat-sdk";
import { LogoFlagsSdk } from "@vercel/geistdocs/assets/logos/logo-flags-sdk";
import { LogoTurborepo } from "@vercel/geistdocs/assets/logos/logo-turborepo";
import { LogoWorkflowSdk } from "@vercel/geistdocs/assets/logos/logo-workflow-sdk";
import { defineConfig, type GeistdocsNavbarOssProduct } from "@vercel/geistdocs/config";
import {
  agent,
  basePath,
  eveAgent,
  github,
  Logo,
  nav,
  prompt,
  siteId,
  suggestions,
  title,
  translations,
} from "@/geistdocs";

const navbarOssProducts: GeistdocsNavbarOssProduct[] = [
  { href: "https://ai-sdk.dev/", label: "AI SDK", logo: <LogoAiSdk height={12} /> },
  { href: "https://flags-sdk.dev/", label: "Flags SDK", logo: <LogoFlagsSdk height={20} /> },
  { href: "https://chat-sdk.dev/", label: "Chat SDK", logo: <LogoChatSdk height={20} /> },
  {
    href: "https://workflow-sdk.dev/",
    label: "Workflow SDK",
    logo: <LogoWorkflowSdk height={12} />,
  },
  { href: "https://turborepo.dev/", label: "Turborepo", logo: <LogoTurborepo height={14} /> },
  {
    href: "https://elements.ai-sdk.dev/",
    label: "AI Elements",
    logo: <LogoAiElements height={12} />,
  },
];

export const config = defineConfig({
  title,
  agent,
  defaultLanguage: "en",
  logo: <Logo />,
  github,
  nav,
  navbarOssProducts,
  basePath,
  siteId,
  translations,
  // Built-in edit link hardcodes `/edit/` and a `content/docs/` prefix; we
  // render our own `/blob/` link instead (see EditOnGithubAction).
  pageActions: { editSource: false },
  content: [{ id: "docs", label: "Docs", dir: "docs", route: "/docs" }],
  ai: {
    eveAgent,
    // Used only if eveAgent is removed and chat falls back to gateway mode.
    prompt,
    suggestions,
  },
});
