import { createPluginManager } from "plugish";

const manager = createPluginManager({
  services: {
    appName: "esm-host",
    logger: { info: (message: string) => message }
  }
});

manager.register(
  {
    id: "typed-esm-plugin",
    activate({ services }, options = { greeting: "Hello" }) {
      services.logger.info(`${options.greeting}, ${services.appName}`);
      return { exports: { ready: true } };
    }
  },
  { options: { greeting: "Hello" } }
);

manager.getExports("typed-esm-plugin");
