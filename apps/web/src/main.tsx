import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { browserClient } from "./api.tsx";
import { App } from "./app.tsx";
import { installLogging } from "./log.ts";
import "./index.css";

installLogging();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App client={browserClient()} />
    </BrowserRouter>
  </StrictMode>,
);
