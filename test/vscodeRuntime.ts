/**
 * Runtime stand-in for the `vscode` module.
 *
 * `tsconfig.test.json` type-checks the compiled sources against the REAL
 * `@types/vscode` (see its `types` array), so `src/*.ts` is checked exactly as
 * it is for shipping — this file only supplies the *runtime* values, because
 * `require('vscode')` obviously does not exist under plain `node`.
 *
 * It installs a `Module._load` hook the moment it is imported, so every test
 * file MUST import it (any symbol, or a bare `import './vscodeRuntime'`)
 * BEFORE importing anything from `../src/`. TypeScript emits `require` calls in
 * source order, so the hook is always installed first.
 *
 * The stub also records what the code did (output-channel lines, notifications,
 * executed commands, config writes), which is what most tests actually assert.
 */

import Module from 'node:module';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

const CONFIG_SECTION = 'local.model.provider';

/** Everything a test may want to inspect or preset. */
interface StubState {
  config: Map<string, Record<string, unknown>>;
  outputLines: string[];
  info: string[];
  warn: string[];
  error: string[];
  executedCommands: Array<{ command: string; args: unknown[] }>;
  openedExternals: string[];
  configListeners: Array<(e: unknown) => unknown>;
  globalState: Map<string, unknown>;
  registeredProviders: Array<{ vendor: string; provider: unknown }>;
  /** Answer forced for the next show*Message call that offers items. */
  nextMessageAnswer: string | undefined;
  /** Directories created + files written through `workspace.fs`. */
  fsWrites: string[];
}

const state: StubState = {
  config: new Map(),
  outputLines: [],
  info: [],
  warn: [],
  error: [],
  executedCommands: [],
  openedExternals: [],
  configListeners: [],
  globalState: new Map(),
  registeredProviders: [],
  nextMessageAnswer: undefined,
  fsWrites: [],
};

// --------------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------------

/** Clears all recorded state and config. Call between tests. */
export function resetStub(): void {
  state.config.clear();
  state.outputLines.length = 0;
  state.info.length = 0;
  state.warn.length = 0;
  state.error.length = 0;
  state.executedCommands.length = 0;
  state.openedExternals.length = 0;
  state.configListeners.length = 0;
  state.globalState.clear();
  state.registeredProviders.length = 0;
  state.nextMessageAnswer = undefined;
  state.fsWrites.length = 0;
}

export function setConfig(section: string, key: string, value: unknown): void {
  const bucket = state.config.get(section) ?? {};
  bucket[key] = value;
  state.config.set(section, bucket);
}

/** Presets several `local.model.provider.*` settings at once. */
export function setProviderConfig(values: Record<string, unknown>): void {
  const bucket = state.config.get(CONFIG_SECTION) ?? {};
  for (const [key, value] of Object.entries(values)) {
    bucket[key] = value;
  }
  state.config.set(CONFIG_SECTION, bucket);
}

export function getConfig(section: string, key: string): unknown {
  return state.config.get(section)?.[key];
}

/** Every line written to any output channel, in order. */
export function getOutputLines(): string[] {
  return [...state.outputLines];
}

export function outputText(): string {
  return state.outputLines.join('\n');
}

export function getNotifications(): { info: string[]; warn: string[]; error: string[] } {
  return { info: [...state.info], warn: [...state.warn], error: [...state.error] };
}

/** Forces the answer for the next notification/quick-select that offers items. */
export function setNextMessageAnswer(answer: string | undefined): void {
  state.nextMessageAnswer = answer;
}

/** Fires a configuration-change event at every registered listener. */
export function fireConfigurationChange(changedKey: string): void {
  const event = {
    affectsConfiguration: (candidate: string) => changedKey.startsWith(candidate),
  };
  for (const listener of [...state.configListeners]) {
    listener(event);
  }
}

export function setGlobalState(key: string, value: unknown): void {
  state.globalState.set(key, value);
}

/** A throwaway directory for tests that write to disk. */
export function makeTempDir(prefix = 'lmp-test-'): string {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
}

/** Minimal `ExtensionContext` good enough for GatewayProvider and crashLog. */
export function createContext(storageDir = makeTempDir('lmp-ctx-')): any {
  return {
    subscriptions: [] as Array<{ dispose: () => unknown }>,
    globalState: {
      get: (key: string, defaultValue?: unknown) =>
        state.globalState.has(key) ? state.globalState.get(key) : defaultValue,
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          state.globalState.delete(key);
        } else {
          state.globalState.set(key, value);
        }
      },
      keys: () => [...state.globalState.keys()],
      setKeysForSync: () => undefined,
    },
    workspaceState: {
      get: (key: string, defaultValue?: unknown) =>
        state.globalState.has(key) ? state.globalState.get(key) : defaultValue,
      update: async () => undefined,
      keys: () => [],
    },
    globalStorageUri: vscode.Uri.file(storageDir),
    storageUri: vscode.Uri.file(storageDir),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    extensionPath: storageDir,
    extensionUri: vscode.Uri.file(storageDir),
  };
}

/** Invokes a private instance method without casting at every call site. */
export function invoke<T = unknown>(target: object, method: string, ...args: unknown[]): T {
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== 'function') {
    throw new Error(`No such method on target: ${method}`);
  }
  return (fn as (...a: unknown[]) => T).apply(target, args);
}

/** Reads a private instance property. */
export function readPrivate<T = unknown>(target: object, property: string): T {
  return (target as Record<string, unknown>)[property] as T;
}

/** Writes a private instance property (e.g. swapping in a fake client). */
export function writePrivate(target: object, property: string, value: unknown): void {
  (target as Record<string, unknown>)[property] = value;
}

// --------------------------------------------------------------------------
// The stub itself
// --------------------------------------------------------------------------

class Uri {
  private constructor(readonly fsPath: string, readonly scheme = 'file') {}

  static file(path: string): Uri {
    return new Uri(path);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(nodePath.join(base.fsPath, ...parts));
  }

  static parse(value: string): Uri {
    return new Uri(value.replace(/^file:\/\//, ''));
  }

  get path(): string {
    return this.fsPath;
  }

  with(change: { path?: string }): Uri {
    return new Uri(change.path ?? this.fsPath, this.scheme);
  }

  toString(): string {
    return `file://${this.fsPath}`;
  }
}

class Disposable {
  constructor(private readonly onDispose?: () => unknown) {}
  dispose(): void {
    this.onDispose?.();
  }
}

class EventEmitter<T> {
  private listeners: Array<(e: T) => unknown> = [];

  readonly event = (listener: (e: T) => unknown): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  };

  fire(data?: T): void {
    for (const listener of [...this.listeners]) {
      listener(data as T);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

class CancellationToken {
  isCancellationRequested = false;
  private readonly handlers = new Set<() => unknown>();

  onCancellationRequested = (handler: () => unknown): Disposable => {
    this.handlers.add(handler);
    return new Disposable(() => this.handlers.delete(handler));
  };

  fire(): void {
    this.isCancellationRequested = true;
    for (const handler of [...this.handlers]) {
      handler();
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

class CancellationTokenSource {
  readonly token = new CancellationToken();

  cancel(): void {
    if (this.token.isCancellationRequested) {
      return;
    }
    this.token.fire();
  }

  dispose(): void {
    (this.token as unknown as { clear(): void }).clear();
  }
}

function createOutputChannel(name: string) {
  return {
    name,
    append: (value: string) => {
      state.outputLines.push(value);
    },
    appendLine: (value: string) => {
      state.outputLines.push(value);
    },
    replace: (value: string) => {
      state.outputLines.length = 0;
      state.outputLines.push(value);
    },
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };
}

/**
 * `showInformationMessage('msg', { modal: true }, 'A', 'B')` has an optional
 * options object, so the offered items are the arguments after any plain object.
 */
function offeredItems(args: unknown[]): string[] {
  return args.filter((a): a is string => typeof a === 'string');
}

function pickAnswer(items: string[]): Promise<string | undefined> {
  const forced = state.nextMessageAnswer;
  state.nextMessageAnswer = undefined;
  if (forced !== undefined && (items.length === 0 || items.includes(forced))) {
    return Promise.resolve(forced);
  }
  return Promise.resolve(undefined);
}

export const vscode: any = {
  Uri,
  Disposable,
  EventEmitter,
  CancellationTokenSource,
  MarkdownString: class {
    constructor(public value = '') {}
    isTrusted = false;
    supportThemeIcons = false;
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  CodeActionKind: { QuickFix: { value: 'quickfix' } },

  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  ViewColumn: { Active: -1, One: 1 },

  // Response parts. Deleting one of these (see `withoutPartClass`) exercises the
  // duck-typed fallback branches in provider.ts.
  LanguageModelTextPart: class {
    constructor(public value: string, public name?: string, public censored?: boolean) {}
  },
  LanguageModelThinkingPart: class {
    constructor(public value: string, public title?: string) {}
  },
  LanguageModelToolCallPart: class {
    callId: string;
    name: string;
    input: unknown;
    constructor(callId: string, name: string, input: unknown) {
      this.callId = callId;
      this.name = name;
      this.input = input ?? {};
    }
  },
  LanguageModelToolResultPart: class {
    callId: string;
    content: unknown;
    constructor(callId: string, content: unknown) {
      this.callId = callId;
      this.content = content ?? [];
    }
  },
  LanguageModelDataPart: class {
    data: Uint8Array;
    mimeType: string;
    constructor(data: Uint8Array, mimeType: string) {
      this.data = data;
      this.mimeType = mimeType;
    }
  },

  window: {
    createOutputChannel: (name: string) => createOutputChannel(name),
    createStatusBarItem: () => ({
      text: '',
      tooltip: undefined,
      color: undefined,
      command: undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    }),
    showInformationMessage: (message: string, ...args: unknown[]) => {
      state.info.push(message);
      return pickAnswer(offeredItems(args));
    },
    showWarningMessage: (message: string, ...args: unknown[]) => {
      state.warn.push(message);
      return pickAnswer(offeredItems(args));
    },
    showErrorMessage: (message: string, ...args: unknown[]) => {
      state.error.push(message);
      return pickAnswer(offeredItems(args));
    },
    showQuickPick: (items: unknown[]) => {
      const forced = state.nextMessageAnswer;
      state.nextMessageAnswer = undefined;
      if (forced === undefined) {
        return Promise.resolve(undefined);
      }
      const match = (items as Array<{ label?: string }>).find((i) => i?.label === forced);
      return Promise.resolve(match);
    },
    showInputBox: () => Promise.resolve(state.nextMessageAnswer),
    withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
      task(
        { report: () => undefined },
        { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }
      ),
    activeEditor: undefined,
    onDidChangeConfiguration: () => new Disposable(),
  },

  workspace: {
    getConfiguration: (section?: string) => {
      const bucketFor = () => state.config.get(section ?? '') ?? {};
      return {
        get: (key?: string, defaultValue?: unknown) => {
          if (key === undefined) {
            return { ...bucketFor() };
          }
          const bucket = bucketFor();
          if (!(key in bucket)) {
            return defaultValue;
          }
          const value = bucket[key];
          // Hand out a copy so a caller mutating an array setting cannot leak
          // into the next test the way the real API's fresh object does.
          return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
        },
        inspect: (key: string) => {
          const bucket = bucketFor();
          const value = bucket[key];
          return {
            key: section ? `${section}.${key}` : key,
            defaultValue: undefined,
            globalValue: value,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
          };
        },
        has: (key: string) => key in bucketFor(),
        update: async (key: string, value: unknown) => {
          setConfig(section ?? '', key, value);
        },
      };
    },
    onDidChangeConfiguration: (listener: (e: unknown) => unknown) => {
      state.configListeners.push(listener);
      return new Disposable(() => {
        state.configListeners = state.configListeners.filter((l) => l !== listener);
      });
    },
    fs: {
      createDirectory: async (uri: Uri) => {
        nodeFs.mkdirSync(uri.fsPath, { recursive: true });
      },
      readFile: async (uri: Uri) => new Uint8Array(nodeFs.readFileSync(uri.fsPath)),
      writeFile: async (uri: Uri, content: Uint8Array) => {
        nodeFs.writeFileSync(uri.fsPath, Buffer.from(content));
        state.fsWrites.push(uri.fsPath);
      },
      delete: async (uri: Uri) => {
        nodeFs.rmSync(uri.fsPath, { recursive: true, force: true });
      },
      stat: async (uri: Uri) => {
        const stat = nodeFs.statSync(uri.fsPath);
        return {
          type: stat.isDirectory() ? 2 : stat.isFile() ? 1 : 0,
          ctime: stat.ctimeMs,
          mtime: stat.mtimeMs,
          size: stat.size,
          permissions: 1,
        };
      },
      readDirectory: async (uri: Uri) => nodeFs.readdirSync(uri.fsPath).map((n) => [n, 1 | 2]),
    },
    workspaceFolders: undefined,
    openTextDocument: async () => {
      throw new Error('workspace.openTextDocument is not implemented in the vscode stub');
    },
    applyEdit: async () => true,
  },

  commands: {
    registerCommand: (command: string, handler: (...args: unknown[]) => unknown) => {
      return new Disposable();
    },
    executeCommand: async (command: string, ...args: unknown[]) => {
      state.executedCommands.push({ command, args });
      return undefined;
    },
    getCommands: async () => [],
  },

  env: {
    openExternal: async (uri: Uri) => {
      state.openedExternals.push(uri.fsPath);
      return true;
    },
    machineId: 'test-machine',
    sessionId: 'test-session',
    language: 'en',
  },

  lm: {
    registerLanguageModelChatProvider: (vendor: string, provider: unknown) => {
      state.registeredProviders.push({ vendor, provider });
      return new Disposable();
    },
  },
};

/**
 * Temporarily removes a part class so `typeof (vscode as any).X !== 'undefined'`
 * guards in provider.ts take their fallback branch. Always pass the returned
 * restore function's result to a `finally`.
 */
export function withoutPartClass(name: 'LanguageModelThinkingPart' | 'LanguageModelDataPart'): () => void {
  const original = vscode[name];
  delete vscode[name];
  return () => {
    vscode[name] = original;
  };
}

// Install the hook. `require('vscode')` from compiled src/ now returns the stub.
{
  const loader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = loader._load;
  loader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
