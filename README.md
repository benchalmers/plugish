# plugish

`plugish` is a small, framework-agnostic plugin manager for Node.js applications. Plugins are ordinary JavaScript modules; the host decides which services to expose, and plugins get explicit lifecycle and dependency handling. The package provides an ESM/CommonJS library and a CLI for installing and enabling plugins in a project.

- Node.js 20 or newer
- ESM and CommonJS plugin modules
- No runtime dependencies
- Plugins run in-process with the host application's privileges; this is **not** a sandbox

## Install

```sh
npm install plugish
```

The CLI uses the package manager declared in the host project's `package.json`, or detects `pnpm`, `yarn`, or `bun` from its lockfile. It falls back to npm.

## Create a plugin

An ESM plugin exports an object as its default export:

```js
// plugins/greeter.js
export default {
  id: "greeter",
  version: "1.0.0",
  dependencies: ["storage"],

  async activate({ services, dependencies }, options = {}) {
    const greeting = options.greeting ?? "Hello";
    const storage = dependencies.storage;

    services.logger.info(`${greeting}, ${storage.getUserName()}`);
    const api = { greet: (name) => `${greeting}, ${name}` };

    return {
      exports: api,
      dispose: async () => services.logger.info("Greeter stopped")
    };
  }
};
```

A CommonJS plugin can instead use `module.exports = { id, activate, ... }`. Modules may also export the plugin as a named `plugin` export.

A plugin must have a unique `id` and an `activate(context, options)` function. `dependencies` contains plugin IDs whose APIs the plugin needs. `activate` may return:

- nothing;
- a disposer function; or
- `{ exports, dispose }`, where `exports` is an object exposed to dependent plugins and `dispose` is an optional cleanup function.

An optional `deactivate(context, options)` hook is also supported. If both `dispose` and `deactivate` are provided, both run during shutdown. Services are supplied by the host, and options are supplied at registration or through the config file.

## Use the library

Register plugin objects directly when the application owns discovery:

```js
import { createPluginManager } from "plugish";
import greeter from "./plugins/greeter.js";

const manager = createPluginManager({
  services: { logger, registerRoute, database }
});

manager.register(greeter, { options: { greeting: "Welcome" } });
await manager.start();

try {
  await runApplication();
} finally {
  await manager.stop();
}
```

Or load modules by package name or path. Relative paths resolve from the configured host directory:

```js
const manager = createPluginManager({
  services: { logger, database },
  cwd: process.cwd()
});

await manager.load("my-plugin", { options: { mode: "safe" } });
await manager.start(["my-plugin"]); // Starts declared dependencies first.

const pluginApi = manager.getExports("my-plugin");
await manager.stop();
```

`start()` without IDs starts all registered plugins. `start(["id"])` starts the selected plugin and its dependencies. Dependencies are activated before dependents; shutdown runs in reverse order. The manager detects missing dependencies and dependency cycles before activation. If activation fails, newly activated plugins are rolled back. `stop()` is idempotent and attempts every cleanup before reporting cleanup failures with an `AggregateError`.

### Load the CLI-managed config

`plugish.config.json` records module specifiers, enabled state, and per-plugin options:

```json
{
  "version": 1,
  "plugins": {
    "my-plugin": {
      "enabled": true,
      "options": {
        "mode": "safe"
      }
    },
    "./plugins/local.mjs": {
      "enabled": false,
      "options": {}
    }
  }
}
```

Load enabled entries and start them in your application:

```js
const manager = createPluginManager({ services: { logger, database } });

await manager.loadConfigured();
await manager.start();

try {
  await runApplication();
} finally {
  await manager.stop();
}
```

`loadConfigured()` does not load disabled entries. A disabled plugin can still be loaded if another enabled plugin declares it as a dependency. When a dependency is not already registered, the manager also tries to load it by its plugin ID as a module specifier.

The package can also be loaded from CommonJS:

```js
const { createPluginManager } = require("plugish");
```

## CLI

Initialize the config file, then add and manage plugins:

```sh
npx plugish init
npx plugish add @example/cache-plugin@^2
npx plugish disable @example/cache-plugin
npx plugish enable @example/cache-plugin
npx plugish list
npx plugish remove @example/cache-plugin
```

`add` installs the package using the detected package manager and enables it. `remove` uninstalls it as well as removing its config entry. Use `--no-install` to manage a package that is already installed, or a local path; use `--keep-installed` to remove only the config entry. `list --json` prints plugin specifiers and enabled states without exposing options.

```sh
plugish add ./plugins/local.mjs --no-install
plugish list --json
plugish remove ./plugins/local.mjs
```

Pass `--config <file>` to use a different config path, or `plugish --help` for all commands. Config writes are validated and atomic.

## CI and publishing

`.github/workflows/ci.yml` runs `pnpm check` on Node.js 20, 22, and 24 for pushes and pull requests. `.github/workflows/publish.yml` publishes stable GitHub Releases to npm after verifying that the `vX.Y.Z` tag matches `package.json`; prereleases are skipped.

Configure npm Trusted Publishing once for this package:

1. If the npm package does not exist yet, publish its first version manually with your npm account. npm requires an existing package to configure a trusted publisher.
2. In the npm package settings, add a **GitHub Actions** trusted publisher with this repository's owner and name, workflow filename `publish.yml`, no environment (unless you add one), and permission to run `npm publish`.
3. Update `package.json`'s version, push the change, and publish a GitHub Release whose tag is `v<version>` (for example, `v0.2.0`). The workflow uses GitHub OIDC; no `NPM_TOKEN` secret is needed.

The publish workflow sets the package repository URL from `GITHUB_REPOSITORY` for npm's provenance verification. Once published, other Node.js projects can install it with `npm install plugish` or `pnpm add plugish`.

## Security

Loading a plugin evaluates its module, and activating it runs arbitrary JavaScript in the same process as the host. Plugins can access the filesystem, network, environment, and host services available to the process. The CLI's `add` command invokes the host package manager, which may also run install lifecycle scripts. Only install and load plugins you trust. `plugish` does not claim to isolate or sandbox plugins, and it does not install process signal handlers for the host.
