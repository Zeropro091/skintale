import { createApp } from "./app";
import { config } from "./config";
import { seedCatalogue } from "./db/seed";

// The catalogue is required for recommendations to return anything, so seed it on boot.
// Idempotent: existing rows are left alone.
seedCatalogue();

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[facewish] api listening on :${config.port} (${config.nodeEnv}, provider=${config.vision.provider})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[facewish] ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
