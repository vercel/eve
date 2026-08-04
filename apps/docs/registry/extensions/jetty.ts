import jetty from "@jetty/eve";

export default jetty({
  collection: process.env.JETTY_COLLECTION ?? "",
});
