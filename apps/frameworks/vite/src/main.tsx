import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { EveAgentConsole } from "./EveAgentConsole";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EveAgentConsole />
  </StrictMode>,
);
