import plugish = require("plugish");

const manager = plugish.createPluginManager({ services: { hostName: "commonjs-host" } });

manager.register({
  id: "typed-commonjs-plugin",
  activate({ services }) {
    return { exports: { hostName: services.hostName } };
  }
});

manager.getExports("typed-commonjs-plugin");
