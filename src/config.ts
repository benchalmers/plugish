import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const DEFAULT_CONFIG_FILENAME = "plugish.config.json";
export const PLUGISH_CONFIG_VERSION = 1 as const;

export type PluginConfigEntry = {
  enabled: boolean;
  options?: unknown;
};

export type PluginConfig = {
  version: typeof PLUGISH_CONFIG_VERSION;
  plugins: Record<string, PluginConfigEntry>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const emptyConfig = (): PluginConfig => ({
  version: PLUGISH_CONFIG_VERSION,
  plugins: Object.create(null) as Record<string, PluginConfigEntry>
});

const validateConfig = (value: unknown): PluginConfig => {
  if (!isRecord(value)) {
    throw new TypeError("The config must be a JSON object.");
  }

  if (value.version !== PLUGISH_CONFIG_VERSION) {
    throw new TypeError(
      `Unsupported config version ${String(value.version)}; expected ${PLUGISH_CONFIG_VERSION}.`
    );
  }

  if (!isRecord(value.plugins)) {
    throw new TypeError('The config must contain a "plugins" object.');
  }

  const plugins: Record<string, PluginConfigEntry> = Object.create(null) as Record<
    string,
    PluginConfigEntry
  >;

  for (const [specifier, rawEntry] of Object.entries(value.plugins)) {
    if (!specifier.trim() || specifier !== specifier.trim()) {
      throw new TypeError("Plugin specifiers must be non-empty and have no surrounding whitespace.");
    }

    if (!isRecord(rawEntry) || typeof rawEntry.enabled !== "boolean") {
      throw new TypeError(`Plugin "${specifier}" must have a boolean "enabled" value.`);
    }

    plugins[specifier] = {
      enabled: rawEntry.enabled,
      options: Object.hasOwn(rawEntry, "options") ? rawEntry.options : {}
    };
  }

  return { version: PLUGISH_CONFIG_VERSION, plugins };
};

export const createEmptyPluginConfig = (): PluginConfig => emptyConfig();

export const readPluginConfig = async (
  configPath: string = DEFAULT_CONFIG_FILENAME
): Promise<PluginConfig> => {
  const absolutePath = resolve(configPath);
  let contents: string;

  try {
    contents = await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return emptyConfig();
    }

    throw error;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`Invalid plugin config at "${absolutePath}": ${message}`, {
      cause: error
    });
  }

  try {
    return validateConfig(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid plugin config at "${absolutePath}": ${message}`, {
      cause: error
    });
  }
};

export const writePluginConfig = async (
  configPath: string,
  config: PluginConfig
): Promise<void> => {
  const absolutePath = resolve(configPath);
  const normalized = validateConfig(config);
  const sortedPlugins = Object.fromEntries(
    Object.entries(normalized.plugins).sort(([left], [right]) => left.localeCompare(right))
  );
  let serialized: string;

  try {
    const json = JSON.stringify(
      { version: PLUGISH_CONFIG_VERSION, plugins: sortedPlugins },
      null,
      2
    );

    if (json === undefined) {
      throw new TypeError("Plugin options must be JSON-serializable.");
    }

    serialized = json;
  } catch (error) {
    throw new TypeError("Plugin options must be JSON-serializable.", { cause: error });
  }

  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(absolutePath), { recursive: true });

  try {
    await writeFile(temporaryPath, `${serialized}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};
