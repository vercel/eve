import flora from "@flora-ai/eve-extension";

export default flora({
  connector: process.env.FLORA_CONNECTOR!,
});
