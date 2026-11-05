import { createApp } from "./app";
import { config } from "./config";
import { seedCatalogue, seedDemoUser } from "./db/seed";

// Catalog is required for recommendations to return anything, so seed it on boot.
// Both functions are idempotent; the demo account exists only outside production.
seedCatalogue();
if (!config.isProd) seedDemoUser();

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
