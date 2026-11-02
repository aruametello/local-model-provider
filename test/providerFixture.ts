/**
 * Shared GatewayProvider fixture.
 *
 * Builds a REAL GatewayProvider (real constructor, real `loadConfig`, real
 * private methods) on top of the vscode runtime stub, so tests exercise the
 * same code paths production does — including config defaults and the
 * last-known-model persistence. The HTTP client is replaced with a scripted
 * fake in the tests that need one.
 */

import './vscodeRuntime'; // must precede ../src imports (installs the vscode stub)

import { GatewayProvider } from '../src/provider';
import { createContext, resetStub, setGlobalState, setProviderConfig, writePrivate } from './vscodeRuntime';
import type { OpenAIModel, OllamaModelCapabilities } from '../src/types';

export interface ProviderFixture {
  provider: GatewayProvider;
  context: any;
}

/** Settings every provider test can rely on, overridable per test. */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  serverUrl: 'http://localhost:8000',
  apiKey: '',
  requestTimeout: 60000,
  enableToolCalling: true,
  parallelToolCalling: true,
  qwenToolLoopCompat: false,
  finalAnswerRetry: true,
  recoverMalformedToolCalls: true,
  includeUsageInStream: true,
  requestLogDirectory: '',
  requestLogMaxMb: 100,
  maxRetries: 0,
  retryDelayMs: 100,
  modelCacheTtlMs: 0,
  logLevel: 'error',
  visionModels: [],
  maxOutputTokens: 65536,
};

export function createProvider(
  overrides: Record<string, unknown> = {},
  globalState: Record<string, unknown> = {}
): ProviderFixture {
  resetStub();
  setProviderConfig({ ...DEFAULT_SETTINGS, ...overrides });
  for (const [key, value] of Object.entries(globalState)) {
    setGlobalState(key, value);
  }
  const context = createContext();
  const provider = new GatewayProvider(context, undefined);
  return { provider, context };
}

/** An OpenAI /v1/models entry. */
export function serverModel(id: string, extra: Partial<OpenAIModel> = {}): OpenAIModel {
  return { id, object: 'model', created: 0, owned_by: 'local', ...extra };
}

/**
 * Replaces the provider's client with a scripted fake so a test can drive the
 * whole request lifecycle without a network. `models` may throw to simulate an
 * unreachable server; `chat` receives the outgoing request body and returns the
 * chunks to stream back.
 */
export function stubClient(
  provider: GatewayProvider,
  handlers: {
    models?: () => Promise<{ data: OpenAIModel[] }>;
    ollama?: OllamaModelCapabilities;
    chat?: (body: any) => unknown[];
  }
): { calls: { models: number; ollama: number; chat: number }; bodies: any[] } {
  const calls = { models: 0, ollama: 0, chat: 0 };
  const bodies: any[] = [];
  const fake = {
    logSink: undefined,
    updateConfig: () => undefined,
    fetchOllamaCapabilities: async () => {
      calls.ollama++;
      return handlers.ollama ?? {};
    },
    fetchModels: async () => {
      calls.models++;
      if (!handlers.models) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
      }
      return handlers.models();
    },
    streamChatCompletion: async function* (body: any) {
      calls.chat++;
      bodies.push(body);
      for (const chunk of handlers.chat?.(body) ?? []) {
        yield chunk;
      }
    },
  };
  writePrivate(provider, 'client', fake);
  return { calls, bodies };
}

/** Collects everything reported through a `vscode.Progress` sink. */
export function progressSink(): { report: (part: unknown) => void; parts: any[] } {
  const parts: any[] = [];
  return { parts, report: (part: unknown) => parts.push(part) };
}

/** A cancelled / non-cancelled cancellation token. */
export function fakeToken(cancelled = false): any {
  const token: any = {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose() {} }),
  };
  return token;
}
