import { defineConfig } from "@vercel/geistdocs/config";
import { LogoEve } from "@vercel/geistdocs/assets/logos/logo-eve";
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
import { defaultLanguage } from "./languages";

export const config = defineConfig({
  title,
  agent,
  defaultLanguage,
  logo: <Logo />,
  github,
  nav,
  // Drops eve (this site) from geistdocs' default OSS products menu.
  navbarActiveProduct: "eve",
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
    // Ask AI is answered by an agent built on eve (help-eve).
    footer: (
      <div className="flex justify-center">
        <a
          aria-label="Powered by eve"
          className="inline-flex items-center gap-1.5 text-gray-700 text-label-12 transition-colors hover:text-gray-900"
          href="https://eve.dev"
        >
          <span>Powered by</span>
          <LogoEve height={10} />
        </a>
      </div>
    ),
  },
});
