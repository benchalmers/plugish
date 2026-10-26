import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CONFIG_FILENAME,
  readPluginConfig,
  type PluginConfig
} from "./config.js";

export {
  createEmptyPluginConfig,
  DEFAULT_CONFIG_FILENAME,
  PLUGISH_CONFIG_VERSION,
  readPluginConfig,
  writePluginConfig,
  type PluginConfig,
  type PluginConfigEntry
} from "./config.js";

export type MaybePromise<T> = T | Promise<T>;
export type PluginExports = Readonly<Record<string, unknown>>;

export type PluginContext<TServices = unknown> = {
  readonly services: TServices;
  readonly dependencies: Readonly<Record<string, PluginExports>>;
};

export type PluginActivationResult<TExports extends PluginExports = PluginExports> = {
  exports?: TExports;
  dispose?: () => MaybePromise<void>;
};

export type PluginActivation<TExports extends PluginExports = PluginExports> =
  | void
  | (() => MaybePromise<void>)
  | PluginActivationResult<TExports>;

export type PluginDefinition<
  TServices = unknown,
  TOptions = unknown,
  TExports extends PluginExports = PluginExports
> = {
  id: string;
  version?: string;
  dependencies?: readonly string[];
  activate: (
    context: PluginContext<TServices>,
    options?: TOptions
  ) => MaybePromise<PluginActivation<TExports>>;
  deactivate?: (
    context: PluginContext<TServices>,
    options?: TOptions
  ) => MaybePromise<void>;
};

export type PluginRegistrationOptions<TOptions = unknown> = {
  options?: TOptions;
};

export type PluginManagerOptions<TServices> = {
  services: TServices;
  cwd?: string;
  configPath?: string;
};

export type PluginStatus =
  | "registered"
  | "activating"
  | "active"
  | "deactivating"
  | "inactive"
  | "failed";

export type PluginInfo = {
  id: string;
  version?: string;
  dependencies: readonly string[];
  status: PluginStatus;
  specifiers: readonly string[];
};

export type PluginManager<TServices> = {
  register<TOptions, TExports extends PluginExports = PluginExports>(
    plugin: PluginDefinition<TServices, TOptions, TExports>,
    registration?: PluginRegistrationOptions<TOptions>
  ): void;
  load(specifier: string, registration?: PluginRegistrationOptions): Promise<PluginInfo>;
  loadConfigured(): Promise<string[]>;
  start(pluginIds?: readonly string[]): Promise<void>;
  stop(): Promise<void>;
  list(): PluginInfo[];
  getExports(id: string): PluginExports | undefined;
};

type RuntimePluginDefinition<TServices> = {
  id: string;
  version?: string;
  dependencies?: readonly string[];
  activate: (
    context: PluginContext<TServices>,
    options?: unknown
  ) => MaybePromise<PluginActivation>;
  deactivate?: (
    context: PluginContext<TServices>,
    options?: unknown
  ) => MaybePromise<void>;
};

type RegisteredPlugin<TServices> = {
  activate: (context: PluginContext<TServices>) => MaybePromise<PluginActivation>;
  deactivate?: (context: PluginContext<TServices>) => MaybePromise<void>;
  id: string;
  version?: string;
  dependencies: readonly string[];
  status: PluginStatus;
  exports: PluginExports;
  disposer?: () => MaybePromise<void>;
  specifiers: Set<string>;
};

type PluginMetadata = {
  id: string;
  version?: string;
  dependencies: readonly string[];
};

type PluginManagerState<TServices> = {
  services: TServices;
  cwd: string;
  configPath: string;
  plugins: Map<string, RegisteredPlugin<TServices>>;
  loadedSpecifiers: Map<string, string>;
  pendingLoads: Map<string, Promise<PluginInfo>>;
  activationOrder: string[];
  lifecycleQueue: Promise<void>;
};

type PluginContextRequest<TServices> = {
  state: PluginManagerState<TServices>;
  plugin: RegisteredPlugin<TServices>;
  allowMissingDependencies?: boolean;
};

type FindPluginOptions = {
  requestedId: string;
  dependentId?: string;
};

type NormalizedActivation = {
  exports: PluginExports;
  disposer?: () => MaybePromise<void>;
};

type ActivationFailure = {
  error: unknown;
  cleanupErrors: Error[];
};

const EMPTY_EXPORTS: PluginExports = Object.freeze({});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isFunction = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === "function";

const isPluginDisposer = (value: unknown): value is () => MaybePromise<void> =>
  typeof value === "function";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRuntimePlugin = (value: unknown): value is RuntimePluginDefinition<unknown> =>
  isRecord(value) && isString(value.id) && isFunction(value.activate);

const validatePluginId = (value: unknown): string => {
  if (!isString(value) || !value.trim() || value !== value.trim() || /\s/.test(value)) {
    throw new TypeError("Plugin ids must be non-empty and contain no whitespace.");
  }

  return value;
};

const validatePluginVersion = (value: unknown, id: string): string | undefined => {
  if (value !== undefined && !isString(value)) {
    throw new TypeError(`Plugin "${id}" version must be a string when provided.`);
  }

  return value;
};

const validatePluginDependencies = (value: unknown, id: string): string[] => {
  const rawDependencies = value === undefined ? [] : value;

  if (!Array.isArray(rawDependencies)) {
    throw new TypeError(`Plugin "${id}" dependencies must be an array of non-empty ids.`);
  }

  const dependencies = rawDependencies.filter(isString);
  const hasInvalidDependency = dependencies.length !== rawDependencies.length;

  if (hasInvalidDependency || dependencies.some((dependency) => !dependency.trim())) {
    throw new TypeError(`Plugin "${id}" dependencies must be an array of non-empty ids.`);
  }

  if (new Set(dependencies).size !== dependencies.length) {
    throw new TypeError(`Plugin "${id}" has duplicate dependencies.`);
  }

  return dependencies;
};

const validatePluginDeactivator = (value: unknown, id: string): void => {
  if (value !== undefined && !isFunction(value)) {
    throw new TypeError(`Plugin "${id}" deactivate property must be a function when provided.`);
  }
};

const validateRuntimePlugin = <TServices>(
  plugin: RuntimePluginDefinition<TServices>
): PluginMetadata => {
  if (!isRuntimePlugin(plugin)) {
    throw new TypeError("A plugin must have a string id and an activate() function.");
  }

  const id = validatePluginId(plugin.id);
  validatePluginDeactivator(plugin.deactivate, id);
  const metadata: PluginMetadata = {
    id,
    dependencies: validatePluginDependencies(plugin.dependencies, id)
  };
  const version = validatePluginVersion(plugin.version, id);

  if (version !== undefined) {
    metadata.version = version;
  }

  return metadata;
};

const normalizePluginModule = (moduleValue: unknown): RuntimePluginDefinition<unknown> => {
  const namespace = isRecord(moduleValue) ? moduleValue : {};
  const defaultExport = namespace.default;
  const nestedPlugin = isRecord(defaultExport) ? defaultExport.plugin : undefined;
  const candidates = [defaultExport, namespace.plugin, nestedPlugin, moduleValue];
  const plugin = candidates.find(isRuntimePlugin);

  if (!plugin) {
    throw new TypeError(
      'A plugin module must export a plugin object as its default export or named "plugin" export.'
    );
  }

  validateRuntimePlugin(plugin);
  return plugin;
};

const resolveModuleSpecifier = (specifier: string, cwd: string): string => {
  if (!specifier || specifier !== specifier.trim()) {
    throw new TypeError("A plugin module specifier must be non-empty and have no surrounding whitespace.");
  }

  if (specifier.startsWith("file:")) {
    return specifier;
  }

  const isRelativePath =
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith(".\\") ||
    specifier.startsWith("..\\");

  if (isAbsolute(specifier) || isRelativePath) {
    return pathToFileURL(resolve(cwd, specifier)).href;
  }

  return specifier;
};

const normalizeActivation = (value: PluginActivation): NormalizedActivation => {
  if (value === undefined || value === null) {
    return { exports: EMPTY_EXPORTS };
  }

  if (typeof value === "function") {
    return { exports: EMPTY_EXPORTS, disposer: value };
  }

  if (!isRecord(value)) {
    throw new TypeError(
      "Plugin activate() must return nothing, a disposer function, or an object with exports/dispose."
    );
  }

  const pluginExports = value.exports;

  if (pluginExports !== undefined && !isRecord(pluginExports)) {
    throw new TypeError("A plugin activation result's exports property must be an object.");
  }

  const disposer = value.dispose;

  if (disposer !== undefined && !isPluginDisposer(disposer)) {
    throw new TypeError("A plugin activation result's dispose property must be a function.");
  }

  const normalized: NormalizedActivation = {
    exports: pluginExports === undefined ? EMPTY_EXPORTS : pluginExports
  };

  if (disposer !== undefined) {
    normalized.disposer = () => disposer.call(value);
  }

  return normalized;
};

const createManagerState = <TServices>(
  options: PluginManagerOptions<TServices>
): PluginManagerState<TServices> => {
  const cwd = resolve(options.cwd ?? process.cwd());

  return {
    services: options.services,
    cwd,
    configPath: resolve(cwd, options.configPath ?? DEFAULT_CONFIG_FILENAME),
    plugins: new Map(),
    loadedSpecifiers: new Map(),
    pendingLoads: new Map(),
    activationOrder: [],
    lifecycleQueue: Promise.resolve()
  };
};

const pluginInfo = <TServices>(plugin: RegisteredPlugin<TServices>): PluginInfo => {
  const info: PluginInfo = {
    id: plugin.id,
    dependencies: [...plugin.dependencies],
    status: plugin.status,
    specifiers: [...plugin.specifiers]
  };

  if (plugin.version !== undefined) {
    info.version = plugin.version;
  }

  return info;
};

const registerPlugin = <TServices>(
  state: PluginManagerState<TServices>,
  plugin: RuntimePluginDefinition<TServices>,
  specifier?: string
): RegisteredPlugin<TServices> => {
  const metadata = validateRuntimePlugin(plugin);

  if (state.plugins.has(metadata.id)) {
    throw new Error(`Plugin "${metadata.id}" is already registered.`);
  }

  const registered: RegisteredPlugin<TServices> = {
    id: metadata.id,
    dependencies: metadata.dependencies,
    activate: (context) => plugin.activate(context),
    status: "registered",
    exports: EMPTY_EXPORTS,
    specifiers: new Set()
  };

  if (metadata.version !== undefined) {
    registered.version = metadata.version;
  }

  const deactivate = plugin.deactivate;

  if (deactivate) {
    registered.deactivate = (context) => deactivate(context);
  }

  if (specifier) {
    registered.specifiers.add(specifier);
    state.loadedSpecifiers.set(specifier, registered.id);
  }

  state.plugins.set(registered.id, registered);
  return registered;
};

const bindDirectPlugin = <TServices, TOptions, TExports extends PluginExports>(
  plugin: PluginDefinition<TServices, TOptions, TExports>,
  registration: PluginRegistrationOptions<TOptions>
): RuntimePluginDefinition<TServices> => {
  const runtimePlugin: RuntimePluginDefinition<TServices> = {
    id: plugin.id,
    activate: (context) => plugin.activate(context, registration.options)
  };

  if (plugin.version !== undefined) {
    runtimePlugin.version = plugin.version;
  }

  if (plugin.dependencies !== undefined) {
    runtimePlugin.dependencies = plugin.dependencies;
  }

  const deactivate = plugin.deactivate;

  if (deactivate) {
    runtimePlugin.deactivate = (context) =>
      deactivate.call(plugin, context, registration.options);
  }

  return runtimePlugin;
};

const bindImportedPlugin = <TServices>(
  plugin: RuntimePluginDefinition<unknown>,
  registration: PluginRegistrationOptions
): RuntimePluginDefinition<TServices> => {
  const runtimePlugin: RuntimePluginDefinition<TServices> = {
    id: plugin.id,
    activate: (context) => plugin.activate(context, registration.options)
  };

  if (plugin.version !== undefined) {
    runtimePlugin.version = plugin.version;
  }

  if (plugin.dependencies !== undefined) {
    runtimePlugin.dependencies = plugin.dependencies;
  }

  const deactivate = plugin.deactivate;

  if (deactivate) {
    runtimePlugin.deactivate = (context) =>
      deactivate.call(plugin, context, registration.options);
  }

  return runtimePlugin;
};

const importAndRegisterPlugin = async <TServices>(
  state: PluginManagerState<TServices>,
  specifier: string,
  registration: PluginRegistrationOptions
): Promise<PluginInfo> => {
  try {
    const resolvedSpecifier = resolveModuleSpecifier(specifier, state.cwd);
    const importedModule: unknown = await import(resolvedSpecifier);
    const exportedPlugin = normalizePluginModule(importedModule);
    const runtimePlugin = bindImportedPlugin<TServices>(exportedPlugin, registration);
    return pluginInfo(registerPlugin(state, runtimePlugin, specifier));
  } catch (error) {
    throw new Error(
      `Failed to load plugin module "${specifier}": ${errorMessage(error)}`,
      { cause: error }
    );
  }
};

const loadPlugin = async <TServices>(
  state: PluginManagerState<TServices>,
  specifier: string,
  registration: PluginRegistrationOptions = {}
): Promise<PluginInfo> => {
  const existingId = state.loadedSpecifiers.get(specifier);

  if (existingId) {
    const existing = state.plugins.get(existingId);

    if (!existing) {
      throw new Error(`Plugin module mapping for "${specifier}" is inconsistent.`);
    }

    return pluginInfo(existing);
  }

  const pending = state.pendingLoads.get(specifier);

  if (pending) {
    return pending;
  }

  const pendingLoad = importAndRegisterPlugin(state, specifier, registration);
  state.pendingLoads.set(specifier, pendingLoad);

  try {
    return await pendingLoad;
  } finally {
    state.pendingLoads.delete(specifier);
  }
};

const loadConfiguredPlugins = async <TServices>(
  state: PluginManagerState<TServices>
): Promise<string[]> => {
  const config: PluginConfig = await readPluginConfig(state.configPath);
  const loadedIds: string[] = [];

  for (const [specifier, entry] of Object.entries(config.plugins)) {
    if (!entry.enabled) {
      continue;
    }

    const plugin = await loadPlugin(state, specifier, { options: entry.options });
    loadedIds.push(plugin.id);
  }

  return loadedIds;
};

const createPluginContext = <TServices>({
  state,
  plugin,
  allowMissingDependencies = false
}: PluginContextRequest<TServices>): PluginContext<TServices> => {
  const dependencies: Record<string, PluginExports> = Object.create(null) as Record<
    string,
    PluginExports
  >;

  for (const dependencyId of plugin.dependencies) {
    const dependency = state.plugins.get(dependencyId);

    if (!dependency || dependency.status !== "active") {
      if (allowMissingDependencies) {
        continue;
      }

      throw new Error(`Plugin "${plugin.id}" requires active dependency "${dependencyId}".`);
    }

    dependencies[dependencyId] = dependency.exports;
  }

  return Object.freeze({
    services: state.services,
    dependencies: Object.freeze(dependencies)
  });
};

const findPlugin = async <TServices>(
  state: PluginManagerState<TServices>,
  { requestedId, dependentId }: FindPluginOptions
): Promise<RegisteredPlugin<TServices>> => {
  const registered = state.plugins.get(requestedId);

  if (registered) {
    return registered;
  }

  try {
    const loaded = await loadPlugin(state, requestedId);

    if (loaded.id !== requestedId) {
      throw new Error(
        `Module specifier "${requestedId}" exported plugin id "${loaded.id}"; expected "${requestedId}".`
      );
    }

    const loadedPlugin = state.plugins.get(loaded.id);

    if (!loadedPlugin) {
      throw new Error(`Plugin "${requestedId}" was not registered after loading.`);
    }

    return loadedPlugin;
  } catch (error) {
    const description = dependentId
      ? `Dependency "${requestedId}" required by "${dependentId}" could not be loaded`
      : `Plugin "${requestedId}" could not be loaded`;
    throw new Error(`${description}: ${errorMessage(error)}`, { cause: error });
  }
};

const visitPlugin = async <TServices>(
  state: PluginManagerState<TServices>,
  requestedId: string,
  stack: readonly string[],
  visited: Set<string>,
  order: string[]
): Promise<void> => {
  const dependentId = stack.at(-1);
  const plugin = await findPlugin(state, { requestedId, dependentId });
  const cycleIndex = stack.indexOf(plugin.id);

  if (cycleIndex >= 0) {
    const cycle = [...stack.slice(cycleIndex), plugin.id].join(" -> ");
    throw new Error(`Plugin dependency cycle detected: ${cycle}.`);
  }

  if (visited.has(plugin.id)) {
    return;
  }

  const nextStack = [...stack, plugin.id];

  for (const dependencyId of plugin.dependencies) {
    await visitPlugin(state, dependencyId, nextStack, visited, order);
  }

  visited.add(plugin.id);
  order.push(plugin.id);
};

const resolvePluginOrder = async <TServices>(
  state: PluginManagerState<TServices>,
  requestedIds: readonly string[]
): Promise<string[]> => {
  const visited = new Set<string>();
  const order: string[] = [];

  for (const requestedId of requestedIds) {
    await visitPlugin(state, requestedId, [], visited, order);
  }

  return order;
};

const cleanupPlugin = async <TServices>(
  state: PluginManagerState<TServices>,
  plugin: RegisteredPlugin<TServices>
): Promise<Error[]> => {
  const errors: Error[] = [];
  const context = createPluginContext({ state, plugin, allowMissingDependencies: true });

  if (plugin.disposer) {
    try {
      await plugin.disposer();
    } catch (error) {
      errors.push(
        new Error(`Disposer for plugin "${plugin.id}" failed: ${errorMessage(error)}`, {
          cause: error
        })
      );
    }
  }

  if (plugin.deactivate) {
    try {
      await plugin.deactivate(context);
    } catch (error) {
      errors.push(
        new Error(`deactivate() for plugin "${plugin.id}" failed: ${errorMessage(error)}`, {
          cause: error
        })
      );
    }
  }

  plugin.disposer = undefined;
  plugin.exports = EMPTY_EXPORTS;
  return errors;
};

const stopOnePlugin = async <TServices>(
  state: PluginManagerState<TServices>,
  id: string
): Promise<Error[]> => {
  const plugin = state.plugins.get(id);

  if (!plugin || plugin.status !== "active") {
    return [];
  }

  plugin.status = "deactivating";
  const errors = await cleanupPlugin(state, plugin);
  plugin.status = "inactive";
  state.activationOrder = state.activationOrder.filter((activeId) => activeId !== id);
  return errors;
};

const stopPlugins = async <TServices>(
  state: PluginManagerState<TServices>,
  ids: readonly string[]
): Promise<Error[]> => {
  const errors: Error[] = [];

  for (const id of ids) {
    errors.push(...(await stopOnePlugin(state, id)));
  }

  return errors;
};

const activatePlugin = async <TServices>(
  state: PluginManagerState<TServices>,
  plugin: RegisteredPlugin<TServices>
): Promise<ActivationFailure | undefined> => {
  plugin.status = "activating";

  try {
    const activation = await plugin.activate(createPluginContext({ state, plugin }));
    const normalized = normalizeActivation(activation);
    plugin.exports = normalized.exports;
    plugin.disposer = normalized.disposer;
    plugin.status = "active";
    state.activationOrder.push(plugin.id);
    return undefined;
  } catch (error) {
    plugin.status = "failed";
    return { error, cleanupErrors: await cleanupPlugin(state, plugin) };
  }
};

const reverseOrder = <T>(items: readonly T[]): T[] =>
  items.map((_, index) => items[items.length - index - 1]);

const startPlugins = async <TServices>(
  state: PluginManagerState<TServices>,
  requestedIds?: readonly string[]
): Promise<void> => {
  const roots = requestedIds ?? [...state.plugins.keys()];
  const order = await resolvePluginOrder(state, roots);
  const newlyStarted: string[] = [];

  for (const id of order) {
    const plugin = state.plugins.get(id);

    if (!plugin || plugin.status === "active") {
      continue;
    }

    const failure = await activatePlugin(state, plugin);

    if (!failure) {
      newlyStarted.push(id);
      continue;
    }

    const rollbackErrors = await stopPlugins(state, reverseOrder(newlyStarted));
    const cleanupErrors = [...failure.cleanupErrors, ...rollbackErrors];

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [failure.error, ...cleanupErrors],
        `Starting plugin "${id}" failed and rollback encountered cleanup errors.`,
        { cause: failure.error }
      );
    }

    throw failure.error;
  }
};

const scheduleLifecycle = <TServices, TResult>(
  state: PluginManagerState<TServices>,
  task: () => Promise<TResult>
): Promise<TResult> => {
  const current = state.lifecycleQueue.then(task, task);
  state.lifecycleQueue = current.then(
    () => undefined,
    () => undefined
  );
  return current;
};

const startManager = <TServices>(
  state: PluginManagerState<TServices>,
  pluginIds?: readonly string[]
): Promise<void> => scheduleLifecycle(state, () => startPlugins(state, pluginIds));

const stopManager = <TServices>(state: PluginManagerState<TServices>): Promise<void> =>
  scheduleLifecycle(state, async () => {
    const errors = await stopPlugins(state, reverseOrder(state.activationOrder));

    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more plugins failed to stop cleanly.");
    }
  });

const listPlugins = <TServices>(state: PluginManagerState<TServices>): PluginInfo[] =>
  [...state.plugins.values()].map(pluginInfo);

const getPluginExports = <TServices>(
  state: PluginManagerState<TServices>,
  id: string
): PluginExports | undefined => {
  const plugin = state.plugins.get(id);

  if (!plugin) {
    return undefined;
  }

  if (plugin.status !== "active") {
    throw new Error(`Plugin "${id}" is not active.`);
  }

  return plugin.exports;
};

export const createPluginManager = <TServices>(
  options: PluginManagerOptions<TServices>
): PluginManager<TServices> => {
  const state = createManagerState(options);

  return {
    register: (plugin, registration = {}) =>
      registerPlugin(state, bindDirectPlugin(plugin, registration)),
    load: (specifier, registration = {}) => loadPlugin(state, specifier, registration),
    loadConfigured: () => loadConfiguredPlugins(state),
    start: (pluginIds) => startManager(state, pluginIds),
    stop: () => stopManager(state),
    list: () => listPlugins(state),
    getExports: (id) => getPluginExports(state, id)
  };
};
