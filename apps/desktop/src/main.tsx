import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initSql, SqliteStorage } from "./storage/index.js";
import { App } from "./ui/App.js";
import "./ui/styles.css";

async function bootstrap() {
  const SQL = await initSql({
    // sql.js is shipped as a static asset under /sql-wasm.wasm by Vite —
    // see vite.config.ts + the public/ directory. The Tauri build copies
    // it the same way through the webview's asset pipeline.
    locateFile: (file) => `/${file}`,
  });
  const storage = new SqliteStorage(SQL);
  await storage.init();

  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Root element not found in document — did index.html change?");
  }
  createRoot(rootElement).render(
    <StrictMode>
      <App storage={storage} />
    </StrictMode>,
  );
}

void bootstrap();
