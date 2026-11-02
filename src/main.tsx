import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AvatarEngineProvider } from "./AvatarEngine";
import "./styles.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AvatarEngineProvider>
      <App />
    </AvatarEngineProvider>
  </React.StrictMode>,
);
