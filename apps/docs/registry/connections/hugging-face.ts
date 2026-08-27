import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://huggingface.co/mcp?login&gradio=none",
  description: "Hugging Face: models, datasets, Spaces, and Gradio apps on the Hub.",
  auth: connect("hugging-face"),
});
