#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { isAbsolute as isAbsolutePath, resolve as resolvePath } from "node:path";
import {
  createEmptyPluginConfig,
  DEFAULT_CONFIG_FILENAME,
  readPluginConfig,
  writePluginConfig,
  type PluginConfig
} from "./config.js";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type PackageManagerAction = "add" | "remove";

type PackageManagerCommands = {
  command: string;
  add: readonly string[];
  remove: readonly string[];
};

const PACKAGE_MANAGERS: Record<PackageManager, PackageManagerCommands> = {
  npm: { command: "npm", add: ["install"], remove: ["uninstall"] },
  pnpm: { command: "pnpm", add: ["add"], remove: ["remove"] },
  yarn: { command: "yarn", add: ["add"], remove: ["remove"] },
  bun: { command: "bun", add: ["add"], remove: ["remove"] }
};

const HELP = `plugish - manage JavaScript plugins for a Node.js project

Usage:
  plugish init [--force] [--config <file>]
  plugish add <package[@version]> [--no-install] [--manager <npm|pnpm|yarn|bun>]
  plugish remove <plugin> [--keep-installed] [--manager <npm|pnpm|yarn|bun>]
  plugish enable <plugin>
  plugish disable <plugin>
  plugish list [--json]

Options:
  --config <file>  Use a config file other than ${DEFAULT_CONFIG_FILENAME}
  --help           Show this help

"add" and "remove" use the package manager declared in package.json or detected
from the lockfile. JavaScript plugins execute with the permissions of this process.
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPackageManager = (value: string): value is PackageManager =>
  Object.hasOwn(PACKAGE_MANAGERS, value);

const getOption = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);

  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`Option ${name} requires a value.`);
  }

  args.splice(index, 2);
  return value;
};

const takeFlag = (args: string[], flag: string): boolean => {
  const index = args.indexOf(flag);

  if (index < 0) {
    return false;
  }

  args.splice(index, 1);
  return true;
};

const parseGlobalArguments = (
  argv: readonly string[]
): { args: string[]; configPath?: string } => {
  const args: string[] = [];
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--config") {
      const value = argv[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("Option --config requires a file path.");
      }

      configPath = value;
      index += 1;
      continue;
    }

    args.push(arg);
  }

  return { args, ...(configPath === undefined ? {} : { configPath }) };
};

const parsePackageSpecifier = (
  input: string
): { key: string; installSpecifier: string; local: boolean } => {
  if (!input || input.startsWith("-")) {
    throw new Error("A plugin package or module specifier is required.");
  }

  const isRelativePath =
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith(".\\") ||
    input.startsWith("..\\");

  if (isAbsolutePath(input) || isRelativePath) {
    return { key: input, installSpecifier: input, local: true };
  }

  const separator = input.startsWith("@")
    ? input.indexOf("@", input.indexOf("/") + 1)
    : input.indexOf("@", 1);
  const key = separator < 0 ? input : input.slice(0, separator);
  const version = separator < 0 ? undefined : input.slice(separator + 1);
  const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
  const versionPattern = /^[a-z0-9.*^~+_-]+$/i;

  if (
    !packageNamePattern.test(key) ||
    (separator >= 0 && (!version || !versionPattern.test(version)))
  ) {
    throw new Error(
      `Unsupported package specifier "${input}". Use a package name with an optional version, or a relative path with --no-install.`
    );
  }

  return { key, installSpecifier: input, local: false };
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

const detectPackageManager = async (cwd: string): Promise<PackageManager> => {
  const packageJsonPath = resolvePath(cwd, "package.json");
  let packageJson: unknown;

  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw new Error(`Could not read "${packageJsonPath}": ${String(error)}`, { cause: error });
    }
  }

  if (isRecord(packageJson) && typeof packageJson.packageManager === "string") {
    const declaredManager = packageJson.packageManager.split("@")[0];

    if (isPackageManager(declaredManager)) {
      return declaredManager;
    }

    throw new Error(`Unsupported packageManager value "${packageJson.packageManager}".`);
  }

  const lockfiles: readonly [string, PackageManager][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"]
  ];

  for (const [filename, manager] of lockfiles) {
    if (await fileExists(resolvePath(cwd, filename))) {
      return manager;
    }
  }

  return "npm";
};

const runPackageManager = async (
  manager: PackageManager,
  action: PackageManagerAction,
  packageSpecifier: string,
  cwd: string
): Promise<void> => {
  const commands = PACKAGE_MANAGERS[manager];
  const args = [...commands[action], packageSpecifier];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(commands.command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.once("error", (error) => {
      reject(new Error(`Could not start ${commands.command}: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const result = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      reject(new Error(`${commands.command} ${args.join(" ")} failed with ${result}.`));
    });
  });
};

const selectPackageManager = async (
  requested: string | undefined,
  cwd: string
): Promise<PackageManager> => {
  if (requested === undefined) {
    return detectPackageManager(cwd);
  }

  if (!isPackageManager(requested)) {
    throw new Error(`Unknown package manager "${requested}".`);
  }

  return requested;
};

const singleArgument = (args: readonly string[], command: string): string => {
  if (args.length !== 1 || !args[0]) {
    throw new Error(`Usage: plugish ${command} <plugin>`);
  }

  return args[0];
};

const readConfigOrEmpty = (configPath: string): Promise<PluginConfig> =>
  readPluginConfig(configPath);

const addPlugin = async (
  args: string[],
  configPath: string,
  cwd: string
): Promise<void> => {
  const noInstall = takeFlag(args, "--no-install");
  const requestedManager = getOption(args, "--manager");
  const specifier = singleArgument(args, "add");
  const parsed = parsePackageSpecifier(specifier);

  if (requestedManager && noInstall) {
    throw new Error("Option --manager cannot be used with --no-install.");
  }

  if (parsed.local && !noInstall) {
    throw new Error("Local plugin paths require --no-install.");
  }

  const config = await readConfigOrEmpty(configPath);

  if (!noInstall) {
    const manager = await selectPackageManager(requestedManager, cwd);
    await runPackageManager(manager, "add", parsed.installSpecifier, cwd);
  }

  const previous = config.plugins[parsed.key];
  config.plugins[parsed.key] = {
    enabled: true,
    options: previous?.options ?? {}
  };
  await writePluginConfig(configPath, config);
  process.stdout.write(`Added and enabled ${parsed.key}.\n`);
};

const removePlugin = async (
  args: string[],
  configPath: string,
  cwd: string
): Promise<void> => {
  const keepInstalled = takeFlag(args, "--keep-installed");
  const requestedManager = getOption(args, "--manager");
  const specifier = singleArgument(args, "remove");
  const parsed = parsePackageSpecifier(specifier);
  const config = await readConfigOrEmpty(configPath);

  if (!config.plugins[parsed.key]) {
    throw new Error(`Plugin "${parsed.key}" is not managed by plugish.`);
  }

  if (requestedManager && keepInstalled) {
    throw new Error("Option --manager cannot be used with --keep-installed.");
  }

  if (!keepInstalled && !parsed.local) {
    const manager = await selectPackageManager(requestedManager, cwd);
    await runPackageManager(manager, "remove", parsed.key, cwd);
  }

  delete config.plugins[parsed.key];
  await writePluginConfig(configPath, config);
  process.stdout.write(`Removed ${parsed.key}.\n`);
};

const setPluginEnabled = async (
  args: string[],
  configPath: string,
  enabled: boolean
): Promise<void> => {
  const specifier = singleArgument(args, enabled ? "enable" : "disable");
  const config = await readConfigOrEmpty(configPath);
  const entry = config.plugins[specifier];

  if (!entry) {
    throw new Error(`Plugin "${specifier}" is not managed by plugish.`);
  }

  config.plugins[specifier] = { ...entry, enabled };
  await writePluginConfig(configPath, config);
  process.stdout.write(`${enabled ? "Enabled" : "Disabled"} ${specifier}.\n`);
};

const listPlugins = async (args: string[], configPath: string): Promise<void> => {
  const asJson = takeFlag(args, "--json");

  if (args.length > 0) {
    throw new Error("Usage: plugish list [--json]");
  }

  const config = await readConfigOrEmpty(configPath);
  const plugins = Object.entries(config.plugins)
    .map(([specifier, entry]) => ({ specifier, enabled: entry.enabled }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));

  if (asJson) {
    process.stdout.write(`${JSON.stringify(plugins, null, 2)}\n`);
    return;
  }

  if (plugins.length === 0) {
    process.stdout.write("No plugins configured.\n");
    return;
  }

  for (const plugin of plugins) {
    process.stdout.write(`${plugin.enabled ? "enabled" : "disabled"}\t${plugin.specifier}\n`);
  }
};

const initializeConfig = async (args: string[], configPath: string): Promise<void> => {
  const force = takeFlag(args, "--force");

  if (args.length > 0) {
    throw new Error("Usage: plugish init [--force]");
  }

  if (!force && (await fileExists(configPath))) {
    throw new Error(`Config already exists at "${configPath}". Use --force to replace it.`);
  }

  await writePluginConfig(configPath, createEmptyPluginConfig());
  process.stdout.write(`Initialized ${configPath}.\n`);
};

const runCli = async (argv: readonly string[]): Promise<void> => {
  const { args, configPath: requestedConfigPath } = parseGlobalArguments(argv);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const cwd = process.cwd();
  const configPath = resolvePath(cwd, requestedConfigPath ?? DEFAULT_CONFIG_FILENAME);
  const [command, ...commandArgs] = args;

  switch (command) {
    case "init":
      await initializeConfig(commandArgs, configPath);
      return;
    case "add":
      await addPlugin(commandArgs, configPath, cwd);
      return;
    case "remove":
      await removePlugin(commandArgs, configPath, cwd);
      return;
    case "enable":
      await setPluginEnabled(commandArgs, configPath, true);
      return;
    case "disable":
      await setPluginEnabled(commandArgs, configPath, false);
      return;
    case "list":
      await listPlugins(commandArgs, configPath);
      return;
    default:
      throw new Error(`Unknown command "${command}". Run "plugish --help" for usage.`);
  }
};

void runCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`plugish: ${message}\n`);
  process.exitCode = 1;
});
