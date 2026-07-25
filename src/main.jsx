import React from "react";
import { createRoot } from "react-dom/client";
import { ApiErrorProvider } from "./ApiErrorModal.jsx";
import { App } from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ApiErrorProvider>
      <App />
    </ApiErrorProvider>
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
