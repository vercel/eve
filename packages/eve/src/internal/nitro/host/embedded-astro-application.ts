export interface EmbeddedAstroApplication {
  fetch(request: Request): Response | Promise<Response>;
}

const missingEmbeddedAstroApplication: EmbeddedAstroApplication = {
  fetch() {
    throw new Error("The embedded Astro application was not provided to the Nitro build.");
  },
};

export default missingEmbeddedAstroApplication;
