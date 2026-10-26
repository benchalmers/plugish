import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPluginManager,
  DEFAULT_CONFIG_FILENAME,
  writePluginConfig
} from "../dist/index.js";

const withTemporaryDirectory = async (run) => {
  const cwd = await mkdtemp(join(tmpdir(), "plugish-test-"));

  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

test("starts dependencies in order and stops them in reverse", async () => {
  const events = [];
  const manager = createPluginManager({ services: { events } });

  manager.register(
    {
      id: "consumer",
      dependencies: ["storage"],
      activate({ services, dependencies }, options) {
        services.events.push(`start:consumer:${options.greeting}`);
        assert.equal(dependencies.storage.answer, 42);
        return {
          exports: { ready: true },
          dispose: () => services.events.push("stop:consumer")
        };
      }
    },
    { options: { greeting: "hello" } }
  );
  manager.register({
    id: "storage",
    activate({ services }) {
      services.events.push("start:storage");
      return {
        exports: { answer: 42 },
        dispose: () => services.events.push("stop:storage")
      };
    }
  });

  await manager.start();
  await manager.start();

  assert.deepEqual(events, ["start:storage", "start:consumer:hello"]);
  assert.deepEqual(manager.getExports("consumer"), { ready: true });
  assert.deepEqual(
    manager.list().map(({ id, status }) => [id, status]),
    [
      ["consumer", "active"],
      ["storage", "active"]
    ]
  );

  await manager.stop();
  await manager.stop();

  assert.deepEqual(events, [
    "start:storage",
    "start:consumer:hello",
    "stop:consumer",
    "stop:storage"
  ]);
  assert.deepEqual(manager.list().map(({ status }) => status), ["inactive", "inactive"]);
});

test("rolls back plugins activated by a failed start", async () => {
  const events = [];
  const activationError = new Error("broken plugin");
  const manager = createPluginManager({ services: { events } });

  manager.register({
    id: "base",
    activate({ services }) {
      services.events.push("start:base");
      return () => services.events.push("stop:base");
    }
  });
  manager.register({
    id: "broken",
    dependencies: ["base"],
    activate({ services }) {
      services.events.push("start:broken");
      throw activationError;
    }
  });

  await assert.rejects(manager.start(), (error) => error === activationError);
  assert.deepEqual(events, ["start:base", "start:broken", "stop:base"]);
  assert.deepEqual(
    manager.list().map(({ id, status }) => [id, status]),
    [
      ["base", "inactive"],
      ["broken", "failed"]
    ]
  );
});

test("detects dependency cycles before activating plugins", async () => {
  const events = [];
  const manager = createPluginManager({ services: { events } });

  manager.register({
    id: "first",
    dependencies: ["second"],
    activate({ services }) {
      services.events.push("first");
    }
  });
  manager.register({
    id: "second",
    dependencies: ["first"],
    activate({ services }) {
      services.events.push("second");
    }
  });

  await assert.rejects(manager.start(), /dependency cycle/i);
  assert.deepEqual(events, []);
  assert.deepEqual(manager.list().map(({ status }) => status), ["registered", "registered"]);
});

test("reports missing dependencies before activating plugins", async () => {
  const events = [];
  const manager = createPluginManager({ services: { events } });
  manager.register({
    id: "consumer",
    dependencies: ["missing-plugin"],
    activate({ services }) { services.events.push("consumer"); }
  });

  await assert.rejects(
    manager.start(),
    /Dependency "missing-plugin" required by "consumer" could not be loaded/
  );
  assert.deepEqual(events, []);
  assert.equal(manager.list()[0].status, "registered");
});

test("rejects dependency modules whose exported id does not match", async () => {
  await withTemporaryDirectory(async (cwd) => {
    const events = [];
    const manager = createPluginManager({ services: { events }, cwd });

    await writeFile(
      join(cwd, "misnamed.mjs"),
      `export default {
        id: "actual-plugin",
        activate({ services }) { services.events.push("should not activate"); }
      };\n`
    );
    manager.register({
      id: "consumer",
      dependencies: ["./misnamed.mjs"],
      activate({ services }) { services.events.push("consumer"); }
    });

    await assert.rejects(manager.start(), /exported plugin id "actual-plugin"/);
    assert.deepEqual(events, []);
    assert.deepEqual(
      manager.list().map(({ id, status }) => [id, status]),
      [
        ["consumer", "registered"],
        ["actual-plugin", "registered"]
      ]
    );
  });
});

test("loads CommonJS and ESM plugins from the host directory", async () => {
  await withTemporaryDirectory(async (cwd) => {
    const events = [];
    const manager = createPluginManager({ services: { events }, cwd });

    await writeFile(
      join(cwd, "common.cjs"),
      `module.exports = {
        id: "common",
        activate({ services }) {
          services.events.push("common");
          return { exports: { format: "cjs" } };
        }
      };\n`
    );
    await writeFile(
      join(cwd, "module.mjs"),
      `export default {
        id: "module",
        activate({ services }) {
          services.events.push("module");
          return { exports: { format: "esm" } };
        }
      };\n`
    );
    await writeFile(
      join(cwd, "named.mjs"),
      `export const plugin = {
        id: "named",
        activate({ services }) { services.events.push("named"); }
      };\n`
    );

    await manager.load("./common.cjs");
    await manager.load(join(cwd, "module.mjs"));
    await manager.load("./named.mjs");
    await manager.start();

    assert.deepEqual(events, ["common", "module", "named"]);
    assert.deepEqual(manager.getExports("common"), { format: "cjs" });
    assert.deepEqual(manager.getExports("module"), { format: "esm" });
    assert.deepEqual(manager.getExports("named"), {});

    await manager.stop();
  });
});

test("loads enabled config entries and passes their options", async () => {
  await withTemporaryDirectory(async (cwd) => {
    const events = [];
    const manager = createPluginManager({ services: { events }, cwd });

    await writeFile(
      join(cwd, "enabled.mjs"),
      `export default {
        id: "enabled-plugin",
        activate({ services }, options) {
          services.events.push(options.message);
        }
      };\n`
    );
    await writeFile(
      join(cwd, "disabled.mjs"),
      `export default {
        id: "disabled-plugin",
        activate() { throw new Error("disabled plugins must not start"); }
      };\n`
    );
    await writePluginConfig(join(cwd, DEFAULT_CONFIG_FILENAME), {
      version: 1,
      plugins: {
        "./enabled.mjs": { enabled: true, options: { message: "configured" } },
        "./disabled.mjs": { enabled: false, options: {} }
      }
    });

    assert.deepEqual(await manager.loadConfigured(), ["enabled-plugin"]);
    assert.deepEqual(manager.list().map(({ id }) => id), ["enabled-plugin"]);

    await manager.start();
    assert.deepEqual(events, ["configured"]);
    await manager.stop();
  });
});

test("continues stopping plugins when one disposer fails", async () => {
  const events = [];
  const manager = createPluginManager({ services: { events } });

  manager.register({
    id: "first",
    activate() {
      return () => {
        events.push("first");
        throw new Error("cleanup failed");
      };
    }
  });
  manager.register({
    id: "second",
    activate() {
      return () => events.push("second");
    }
  });

  await manager.start();
  await assert.rejects(manager.stop(), AggregateError);

  assert.deepEqual(events, ["second", "first"]);
  assert.deepEqual(manager.list().map(({ status }) => status), ["inactive", "inactive"]);
});

test("exposes both ESM and CommonJS entry points", async () => {
  const commonJsApi = createRequire(import.meta.url)("../dist/index.cjs");

  assert.equal(typeof createPluginManager, "function");
  assert.equal(typeof commonJsApi.createPluginManager, "function");

  await withTemporaryDirectory(async (cwd) => {
    const events = [];
    const manager = commonJsApi.createPluginManager({ services: { events }, cwd });
    await writeFile(
      join(cwd, "plugin.mjs"),
      `export default {
        id: "cjs-host-plugin",
        activate({ services }) { services.events.push("loaded from CJS"); }
      };\n`
    );

    await manager.load("./plugin.mjs");
    await manager.start();
    assert.deepEqual(events, ["loaded from CJS"]);
    await manager.stop();
  });
});
