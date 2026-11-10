import { createRoot } from "react-dom/client";
import { setupIonicReact } from "@ionic/react";
import App from "./App";
import { platform } from "./config";

import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/padding.css";
import "@ionic/react/css/flex-utils.css";
import "@ionic/react/css/display.css";
import "@ionic/react/css/palettes/dark.system.css";
import "./theme.css";

setupIonicReact({ mode: platform === "android" ? "md" : undefined });

if (platform === "web" && "serviceWorker" in navigator && import.meta.env.PROD) {
  void import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}

createRoot(document.getElementById("root")!).render(<App />);
