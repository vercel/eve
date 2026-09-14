export default defineAppConfig({
  site: {
    name: "V",
    title: "V",
    description:
      "Your personal AI agent. Chat on the web, Slack, or iMessage — query Linear and pick up where you left off.",
    tagline: "Vercel × Eve",
    author: "Hugo Richard",
    repo: "https://github.com/vercel/eve/tree/main/apps/templates/personal-agent-template",
    deployUrl:
      "https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Fpersonal-agent-template&env=BETTER_AUTH_SECRET,BETTER_AUTH_URL,INTERNAL_API_SECRET&envDescription=BETTER_AUTH_SECRET%3A%20run%20openssl%20rand%20-base64%2032%20%7C%20BETTER_AUTH_URL%3A%20your%20production%20URL%20%7C%20INTERNAL_API_SECRET%3A%20shared%20secret%20for%20web%20%2B%20eve&envLink=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Fblob%2Fmain%2Fapps%2Ftemplates%2Fpersonal-agent-template%2Fdocs%2FENVIRONMENT.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22tursocloud%22%2C%22productSlug%22%3A%22database%22%2C%22protocol%22%3A%22storage%22%7D%5D&project-name=personal-agent&repository-name=personal-agent",
    ogImage: "/og.png",
    twitter: "@hugorcd",
  },
  ui: {
    colors: {
      primary: "neutral",
      neutral: "neutral",
    },
    button: {
      slots: {
        base: "active:translate-y-px transition-transform duration-200",
      },
      defaultVariants: {
        size: "sm",
      },
    },
  },
});
