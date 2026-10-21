/**
 * Starts the API server with environment variables injected by Replit.
 * Credentials are never loaded from the tracked PM2 configuration.
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Replit injects shared secrets into the workflow environment. Keep the
// development runner on that secure path rather than loading credentials from
// the PM2 deployment config.
const env = { ...process.env };

const child = spawn(
  "node",
  ["--enable-source-maps", resolve(__dirname, "../artifacts/api-server/dist/index.mjs")],
  { env, stdio: "inherit" }
);

child.on("exit", (code) => process.exit(code ?? 0));
