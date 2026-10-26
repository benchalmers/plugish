import { createPluginManager } from "plugish";
import process from "node:process";

const logger = {
  info: (message) => process.stdout.write(`${message}\n`)
};
const manager = createPluginManager({
  services: { logger, userName: "Ada" }
});

await manager.loadConfigured();
await manager.start();

try {
  process.stdout.write(`${manager.getExports("greeter")?.greet("Grace")}\n`);
} finally {
  await manager.stop();
}
