import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { delimiter, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));

const withTemporaryDirectory = async (run) => {
  const cwd = await mkdtemp(join(tmpdir(), "plugish-cli-test-"));

  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

const runCli = (args, cwd, environment = {}) =>
  spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });

const assertSuccess = (result) => {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test("initializes, adds, toggles, lists, and removes plugins", async () => {
  await withTemporaryDirectory(async (cwd) => {
    assert.match(assertSuccess(runCli(["init"], cwd)), /Initialized/);
    assert.match(
      assertSuccess(runCli(["add", "@sample/plugin@1.2.3", "--no-install"], cwd)),
      /Added and enabled @sample\/plugin/
    );
    assert.match(assertSuccess(runCli(["disable", "@sample/plugin"], cwd)), /Disabled/);

    const list = JSON.parse(assertSuccess(runCli(["list", "--json"], cwd)));
    assert.deepEqual(list, [{ specifier: "@sample/plugin", enabled: false }]);

    assert.match(assertSuccess(runCli(["enable", "@sample/plugin"], cwd)), /Enabled/);
    assert.match(
      assertSuccess(runCli(["remove", "@sample/plugin", "--keep-installed"], cwd)),
      /Removed/
    );

    const config = JSON.parse(await readFile(join(cwd, "plugish.config.json"), "utf8"));
    assert.deepEqual(config, { version: 1, plugins: {} });
  });
});

test("supports custom config files and local plugins without installing them", async () => {
  await withTemporaryDirectory(async (cwd) => {
    const customConfig = "config/plugins.json";
    assert.match(
      assertSuccess(runCli(["--config", customConfig, "init"], cwd)),
      /Initialized/
    );
    assert.match(
      assertSuccess(runCli(["add", "./plugins/local.mjs", "--no-install", "--config", customConfig], cwd)),
      /Added and enabled/
    );
    assert.match(
      assertSuccess(runCli(["list", "--config", customConfig], cwd)),
      /enabled\t\.\/plugins\/local\.mjs/
    );

    const windowsRelativePath = ".\\plugins\\local.mjs";
    assert.match(
      assertSuccess(
        runCli(["add", windowsRelativePath, "--no-install", "--config", customConfig], cwd)
      ),
      /Added and enabled/
    );
    const absoluteLocalPath = join(cwd, "plugins", "absolute.mjs");
    assert.match(
      assertSuccess(
        runCli(["add", absoluteLocalPath, "--no-install", "--config", customConfig], cwd)
      ),
      /Added and enabled/
    );

    const config = JSON.parse(await readFile(join(cwd, customConfig), "utf8"));
    assert.equal(config.plugins["./plugins/local.mjs"].enabled, true);
    assert.equal(config.plugins[windowsRelativePath].enabled, true);
    assert.equal(config.plugins[absoluteLocalPath].enabled, true);
  });
});

test("uses the host package manager for install and removal", async () => {
  await withTemporaryDirectory(async (cwd) => {
    const binDirectory = join(cwd, "bin");
    const capturePath = join(cwd, "invocation.json");
    const captureScript = join(binDirectory, "capture.cjs");
    await mkdir(binDirectory);
    await writeFile(
      captureScript,
      `const { writeFileSync } = require("node:fs");\nwriteFileSync(process.env.PLUGISH_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`
    );

    if (process.platform === "win32") {
      await writeFile(
        join(binDirectory, "pnpm.cmd"),
        `@echo off\r\nnode "%~dp0capture.cjs" %*\r\n`
      );
    } else {
      const pnpmShim = join(binDirectory, "pnpm");
      await writeFile(
        pnpmShim,
        `#!/usr/bin/env node\nrequire(${JSON.stringify(captureScript)});\n`
      );
      await chmod(pnpmShim, 0o755);
    }

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.0.0" })
    );
    const environment = {
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      PLUGISH_CAPTURE: capturePath
    };

    assertSuccess(runCli(["add", "demo-plugin@1.2.3"], cwd, environment));
    assert.deepEqual(
      JSON.parse(await readFile(capturePath, "utf8")),
      ["add", "demo-plugin@1.2.3"]
    );

    assertSuccess(runCli(["remove", "demo-plugin"], cwd, environment));
    assert.deepEqual(
      JSON.parse(await readFile(capturePath, "utf8")),
      ["remove", "demo-plugin"]
    );
  });
});

test("refuses to overwrite config unless forced and reports invalid commands", async () => {
  await withTemporaryDirectory(async (cwd) => {
    assertSuccess(runCli(["init"], cwd));

    const duplicateInit = runCli(["init"], cwd);
    assert.equal(duplicateInit.status, 1);
    assert.match(duplicateInit.stderr, /already exists/);

    const unknown = runCli(["does-not-exist"], cwd);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown command/);

    assert.match(assertSuccess(runCli(["--help"], cwd)), /Usage:/);
  });
});
