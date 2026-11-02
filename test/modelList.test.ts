/**
 * Model listing, capability detection, configuration loading and chat-error
 * handling (`src/provider.ts`).
 *
 * These are the paths that decide what shows up in the VS Code model picker and
 * what the user sees when the server is down, so the layered vision detection,
 * the TTL cache, the last-known fallback (and its server-URL isolation) and the
 * config validation are all pinned here.
 *
 * The `./vscodeRuntime` import MUST stay first: it installs the `Module._load`
 * hook that serves the `vscode` stub to `../src` modules.
 */
import './vscodeRuntime';

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, run, test } from './harness';
import { createProvider, serverModel, stubClient } from './providerFixture';
import {
  fireConfigurationChange,
  getConfig,
  getNotifications,
  invoke,
  outputText,
  readPrivate,
  setNextMessageAnswer,
  setProviderConfig,
} from './vscodeRuntime';
import type { OpenAIModel, OllamaModelCapabilities } from '../src/types';
import { FALLBACK_CONTEXT_WINDOW, GatewayProvider } from '../src/provider';
import { GatewayError } from '../src/client';

const LAST_KNOWN_KEY = 'localModelProvider.lastKnownModels';

/** Runs `fn` with a provider built from `settings` (+ optional global state). */
function withProvider<T>(
  settings: Record<string, unknown> = {},
  globalState: Record<string, unknown> = {},
  fn: (provider: GatewayProvider, context: any) => T
): T {
  const { provider, context } = createProvider(settings, globalState);
  return fn(provider, context);
}

const cfg = (provider: GatewayProvider) => readPrivate<Record<string, any>>(provider, 'config');

const detectVision = (
  provider: GatewayProvider,
  modelId: string,
  model: { capabilities?: string[]; architecture?: { input_modalities?: string[] } } = {},
  ollamaCaps: OllamaModelCapabilities = {},
  overrides: string[] = []
) => invoke<boolean>(provider, 'detectVision', modelId, model, ollamaCaps, overrides);

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  test('strips a trailing /v1 so the client never builds /v1/v1', () => {
    withProvider({ serverUrl: 'http://host:8000/v1' }, {}, (provider) => {
      assert.equal(cfg(provider).serverUrl, 'http://host:8000');
      assert.match(outputText(), /Stripped trailing \/v1/);
    });
    withProvider({ serverUrl: 'http://host:8000/v1/' }, {}, (provider) => {
      assert.equal(cfg(provider).serverUrl, 'http://host:8000');
    });
  });

  test('leaves a normal server URL alone', () => {
    withProvider({ serverUrl: 'http://host:1234/v2' }, {}, (provider) => {
      assert.equal(cfg(provider).serverUrl, 'http://host:1234/v2');
    });
  });

  test('rejects a server URL that is not a URL at all', () => {
    assert.throws(() => createProvider({ serverUrl: 'no-scheme-no-colon' }), /Invalid server URL/);
  });

  // The classic user typo: WHATWG URL parsing reads `localhost:` as a scheme,
  // so validation must require an actual http(s) protocol instead of any
  // parseable string (which would only fail later on every request).
  test('rejects a scheme-less host:port typo', () => {
    assert.throws(() => createProvider({ serverUrl: 'localhost:8000' }), /Invalid server URL/);
  });

  test('rejects non-http(s) schemes', () => {
    assert.throws(() => createProvider({ serverUrl: 'ftp://localhost:8000' }), /Invalid server URL/);
    assert.throws(() => createProvider({ serverUrl: 'file:///tmp/server' }), /Invalid server URL/);
  });

  test('accepts absolute http and https URLs', () => {
    assert.equal(cfg(createProvider({ serverUrl: 'http://localhost:8000' }).provider).serverUrl, 'http://localhost:8000');
    assert.equal(cfg(createProvider({ serverUrl: 'https://llm.lan:9443' }).provider).serverUrl, 'https://llm.lan:9443');
  });

  test('repairs obviously invalid numeric settings instead of misbehaving', () => {
    withProvider({ requestTimeout: 0, requestLogMaxMb: 0 }, {}, (provider) => {
      assert.equal(cfg(provider).requestTimeout, 60000, 'timeout falls back to the default');
      assert.equal(cfg(provider).requestLogMaxMb, 100, 'a 0/NaN cap becomes a real budget');
    });
  });

  test('trims the request-log directory so whitespace disables logging', () => {
    withProvider({ requestLogDirectory: '   ' }, {}, (provider) => {
      assert.equal(cfg(provider).requestLogDirectory, '');
    });
  });
});

describe('configuration changes', () => {
  test('a change under local.model.provider reloads config and drops the cache', async () => {
    await withProvider({ modelCacheTtlMs: 600000 }, {}, async (provider) => {
      const counts = stubClient(provider, { models: async () => ({ data: [serverModel('m1')] }) });
      await provider.provideLanguageModelChatInformation({ silent: true }, undefined as any);
      assert.ok(readPrivate<unknown[]>(provider, 'cachedModels'), 'the list was cached');

      setProviderConfig({ serverUrl: 'http://changed:9999' });
      fireConfigurationChange('local.model.provider.serverUrl');

      assert.equal(cfg(provider).serverUrl, 'http://changed:9999');
      assert.equal(readPrivate(provider, 'cachedModels'), null, 'the cache must not outlive its server');
      assert.match(outputText(), /Configuration reloaded/);
      assert.equal(counts.calls.models, 1, 'the reload itself does not fetch');
    });
  });

  test('an unrelated section is ignored', () => {
    withProvider({}, {}, (provider) => {
      const before = cfg(provider).serverUrl;
      setProviderConfig({ serverUrl: 'http://should-not-apply:1' });
      fireConfigurationChange('editor.tabSize');
      assert.equal(cfg(provider).serverUrl, before, 'no reload for another section');
    });
  });
});

// ---------------------------------------------------------------------------
// Vision detection (4 layers, in priority order)
// ---------------------------------------------------------------------------

describe('detectVision', () => {
  test('layer 1: an explicit override wins, case-insensitively and trimmed', () => {
    withProvider({}, {}, (provider) => {
      assert.equal(detectVision(provider, 'My-Custom-Model', {}, {}, ['my-custom-model']), true);
      assert.equal(detectVision(provider, 'My-Custom-Model', {}, {}, ['  MY-CUSTOM-MODEL  ']), true);
    });
  });

  test('layer 1: a non-matching override does not veto the other layers', () => {
    withProvider({}, {}, (provider) => {
      assert.equal(detectVision(provider, 'llava-1.6', {}, {}, ['something-else']), true, 'heuristic still applies');
      assert.equal(detectVision(provider, 'llama-3.1-8b', {}, {}, ['something-else']), false);
    });
  });

  test('layer 2: Ollama capabilities match by exact, slashed and tagged id', () => {
    withProvider({}, {}, (provider) => {
      assert.equal(detectVision(provider, 'llava', {}, { llava: ['vision', 'tools'] }, []), true);
      assert.equal(detectVision(provider, 'llava:7b', {}, { llava: ['vision'] }, []), true, 'tagged id vs bare key');
      assert.equal(detectVision(provider, 'llava', {}, { 'llava:7b': ['vision'] }, []), true, 'bare id vs tagged key');
      assert.equal(detectVision(provider, 'hf.co/user/minicpm-v', {}, { minicpm: ['vision'] }, []), true, 'org-prefixed id');
    });
  });

  test('layer 2: a server that knows the model without vision vetoes the id heuristic', () => {
    withProvider({}, {}, (provider) => {
      assert.equal(detectVision(provider, 'llava-fictional', {}, { 'llava-fictional': ['tools'] }, []), false,
        'an authoritative Ollama entry beats a lookalike name');
    });
  });

  test('layer 3: non-standard fields on the model object', () => {
    withProvider({}, {}, (provider) => {
      assert.equal(detectVision(provider, 'mystery-1', {}, {}, []), false);
      assert.equal(detectVision(provider, 'mystery-1', { capabilities: ['vision'] }, {}, []), true);
      assert.equal(detectVision(provider, 'mystery-1', { architecture: { input_modalities: ['text', 'image'] } }, {}, []), true);
      assert.equal(detectVision(provider, 'mystery-1', { architecture: { input_modalities: ['img'] } }, {}, []), true);
      assert.equal(detectVision(provider, 'mystery-1', { architecture: { input_modalities: ['text'] } }, {}, []), false);
    });
  });

  test('layer 4: well-known vision families are recognised by name', () => {
    withProvider({}, {}, (provider) => {
      for (const id of ['qwen2-vl-7b', 'Qwen2.5-VL-3B', 'llama-3.2-vision-11b', 'llava-1.6-mistral',
        'minicpm-v-2.6', 'gemma3-4b', 'pixtral-12b', 'moondream2', 'internvl2-4b', 'phi-3-vision-128k']) {
        assert.equal(detectVision(provider, id), true, `${id} should be detected as a vision model`);
      }
    });
  });

  test('layer 4: the SmolVLM family is recognised by name', () => {
    withProvider({}, {}, (provider) => {
      assert.equal(detectVision(provider, 'smolvlm-2.2'), true);
      assert.equal(detectVision(provider, 'SmolVLM2-2.2B-Instruct'), true);
    });
  });

  test('layer 4: text-only models are not flagged', () => {
    withProvider({}, {}, (provider) => {
      for (const id of ['llama-3.1-8b-instruct', 'qwen2.5-coder-32b', 'deepseek-r1-distill-qwen-7b', 'phi-4', 'gemma2-9b']) {
        assert.equal(detectVision(provider, id), false, `${id} must not claim image input`);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The model list VS Code sees
// ---------------------------------------------------------------------------

describe('provideLanguageModelChatInformation', () => {
  const silent = { silent: true };

  test('maps server models to VS Code shape, in server order', async () => {
    await withProvider({ enableToolCalling: true }, {}, async (provider) => {
      stubClient(provider, {
        models: async () => ({ data: [serverModel('z-last'), serverModel('a-first'), serverModel('llava:7b')] }),
      });
      const models = await provider.provideLanguageModelChatInformation(silent, undefined as any);
      assert.deepEqual(models.map((m) => m.id), ['z-last', 'a-first', 'llava:7b'], 'no client-side reordering');
      assert.equal(models[0].name, 'z-last');
      assert.equal(models[0].family, 'custom-local-model-provider');
      assert.equal(models[0].capabilities?.toolCalling, true);
      assert.equal(models[0].capabilities?.imageInput, false);
      assert.equal(models[2].capabilities?.imageInput, true, 'the llava heuristic marks the picker entry');
      assert.equal(provider.getLastModelListSource(), 'live');
    });
  });

  test('advertises input+output budgets that sum back to the real context window', async () => {
    await withProvider({}, {}, async (provider) => {
      stubClient(provider, {
        models: async () => ({
          data: [
            serverModel('plain'),
            serverModel('llamacpp', { status: { args: ['--ctx-size', '131072'] } } as Partial<OpenAIModel>),
          ],
        }),
      });
      const [plain, big] = await provider.provideLanguageModelChatInformation(silent, undefined as any);
      assert.equal(plain.maxInputTokens! + plain.maxOutputTokens!, FALLBACK_CONTEXT_WINDOW,
        'a server that reports nothing falls back to the built-in window, split (not doubled)');
      assert.equal(big.maxInputTokens! + big.maxOutputTokens!, 131072, 'a reported n_ctx is honoured exactly');
    });
  });

  test('serves the TTL cache instead of hammering the server', async () => {
    await withProvider({ modelCacheTtlMs: 600000 }, {}, async (provider) => {
      const counts = stubClient(provider, { models: async () => ({ data: [serverModel('m1')] }) });
      await provider.provideLanguageModelChatInformation(silent, undefined as any);
      await provider.provideLanguageModelChatInformation(silent, undefined as any);
      assert.equal(counts.calls.models, 1, 'second call came from the cache');
    });
  });

  test('a zero TTL disables caching', async () => {
    await withProvider({ modelCacheTtlMs: 0 }, {}, async (provider) => {
      const counts = stubClient(provider, { models: async () => ({ data: [serverModel('m1')] }) });
      await provider.provideLanguageModelChatInformation(silent, undefined as any);
      await provider.provideLanguageModelChatInformation(silent, undefined as any);
      assert.equal(counts.calls.models, 2);
    });
  });

  test('clearModelCache forces a refetch and tells VS Code', async () => {
    await withProvider({ modelCacheTtlMs: 600000 }, {}, async (provider) => {
      let fired = 0;
      provider.onDidChangeLanguageModelChatInformation(() => fired++);
      const counts = stubClient(provider, { models: async () => ({ data: [serverModel('m1')] }) });
      await provider.provideLanguageModelChatInformation(silent, undefined as any);
      provider.clearModelCache();
      await provider.provideLanguageModelChatInformation(silent, undefined as any);
      assert.equal(counts.calls.models, 2);
      assert.equal(fired, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// Resilience: last-known list
// ---------------------------------------------------------------------------

describe('last-known model fallback', () => {
  const silent = { silent: true };
  const A = 'http://127.0.0.1:8001';
  const B = 'http://127.0.0.1:8002';

  /** Fetches a live list from server A and returns the persisted global state. */
  async function seedLastKnown(): Promise<Record<string, unknown>> {
    const { provider, context } = createProvider({ serverUrl: A, modelCacheTtlMs: 0 });
    stubClient(provider, { models: async () => ({ data: [serverModel('model-from-A')] }) });
    await provider.provideLanguageModelChatInformation(silent, undefined as any);
    const stored = context.globalState.get(LAST_KNOWN_KEY);
    assert.ok(stored, 'a live list is persisted for the next IDE start');
    return { [LAST_KNOWN_KEY]: stored };
  }

  test('a failed fetch keeps the previous list and reports the source', async () => {
    const state = await seedLastKnown();
    await withProvider({ serverUrl: A, modelCacheTtlMs: 0 }, state, async (provider) => {
      stubClient(provider, {}); // no handler -> refuses the connection
      const models = await provider.provideLanguageModelChatInformation(silent, undefined as any);
      assert.deepEqual(models.map((m) => m.id), ['model-from-A']);
      assert.equal(provider.getLastModelListSource(), 'lastKnown');
      assert.equal(getNotifications().error.length, 0, 'a silent call shows no toast');
    });
  });

  test('a user-initiated refresh surfaces the failure', async () => {
    const state = await seedLastKnown();
    await withProvider({ serverUrl: A, modelCacheTtlMs: 0 }, state, async (provider) => {
      stubClient(provider, {});
      await provider.provideLanguageModelChatInformation({ silent: false }, undefined as any);
      const errors = getNotifications().error;
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Failed to fetch models/);
    });
  });

  test('a server that reports no models yet keeps the last list', async () => {
    const state = await seedLastKnown();
    await withProvider({ serverUrl: A, modelCacheTtlMs: 0 }, state, async (provider) => {
      stubClient(provider, { models: async () => ({ data: [] }) });
      const models = await provider.provideLanguageModelChatInformation(silent, undefined as any);
      assert.deepEqual(models.map((m) => m.id), ['model-from-A']);
      assert.equal(provider.getLastModelListSource(), 'lastKnown');
    });
  });

  test('a list from a different server is never used as a fallback', async () => {
    const state = await seedLastKnown();
    await withProvider({ serverUrl: B, modelCacheTtlMs: 0 }, state, async (provider) => {
      stubClient(provider, {});
      const models = await provider.provideLanguageModelChatInformation(silent, undefined as any);
      assert.deepEqual(models, [], "server B must not inherit server A's models");
      assert.equal(provider.getLastModelListSource(), 'empty');
    });
  });

  test('with nothing cached and nothing reachable the list is simply empty', async () => {
    await withProvider({ serverUrl: B, modelCacheTtlMs: 0 }, {}, async (provider) => {
      stubClient(provider, {});
      const models = await provider.provideLanguageModelChatInformation(silent, undefined as any);
      assert.deepEqual(models, []);
      assert.equal(provider.getLastModelListSource(), 'empty');
    });
  });

  test('a successful fetch replaces the persisted list', async () => {
    const state = await seedLastKnown();
    await withProvider({ serverUrl: A, modelCacheTtlMs: 0 }, state, async (provider, context) => {
      stubClient(provider, { models: async () => ({ data: [serverModel('replacement')] }) });
      await provider.provideLanguageModelChatInformation(silent, undefined as any);
      const stored = context.globalState.get(LAST_KNOWN_KEY) as { models?: Array<{ id: string }> };
      assert.deepEqual((stored.models ?? []).map((m) => m.id), ['replacement']);
    });
  });
});

// ---------------------------------------------------------------------------
// Chat error handling
// ---------------------------------------------------------------------------

describe('handleChatError', () => {
  /** Lets the `showErrorMessage(...).then(...)` handlers run. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const handle = (provider: GatewayProvider, error: unknown) =>
    invoke<Promise<never>>(provider, 'handleChatError', error, { id: 'test-model' } as any, { messageCount: 1 });

  test('rethrows a user cancellation without notifying or writing a report', async () => {
    await withProvider({}, {}, async (provider, context) => {
      await assert.rejects(() => handle(provider, new GatewayError('Chat completion cancelled')), /cancelled/);
      assert.equal(getNotifications().error.length, 0, 'a cancel is not an error');
      assert.equal(getNotifications().warn.length, 0);
      assert.ok(!outputText().includes('Crash report written'), 'no crash report for a cancellation');
      assert.equal(fs.readdirSync(context.globalStorageUri.fsPath).length, 0);
    });
  });

  test('a near-miss message that merely contains "cancelled" is still reported', async () => {
    await withProvider({}, {}, async (provider) => {
      await assert.rejects(() => handle(provider, new GatewayError('The upstream server cancelled the batch')));
      assert.equal(getNotifications().error.length, 1, 'only an exact cancellation suffix is swallowed');
    });
  });

  test('an upstream failure raises one error notification mentioning the model problem', async () => {
    await withProvider({}, {}, async (provider) => {
      await assert.rejects(() => handle(provider, new Error('upstream exploded')));
      const errors = getNotifications().error;
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Chat request failed\. upstream exploded/);
    });
  });

  test('recognises a tool-calling format failure and can disable tool calling', async () => {
    await withProvider({ enableToolCalling: true }, {}, async (provider) => {
      setNextMessageAnswer('Disable Tool Calling');
      await assert.rejects(() => handle(provider, new Error('HarmonyError: unexpected tokens')));
      await settle();
      assert.match(outputText(), /tool calling format error/);
      assert.equal(
        getConfig('local.model.provider', 'enableToolCalling'),
        false,
        'picking "Disable Tool Calling" persists the setting globally'
      );
    });
  });

  test('the crash report path is handed to the user', async () => {
    await withProvider({}, {}, async (provider, context) => {
      await assert.rejects(() => handle(provider, new Error('boom')));
      // The "Crash report written to …" line is an info log (suppressed at the
      // default logLevel), so assert on what the user actually sees plus the
      // file on disk.
      assert.match(getNotifications().error[0], /A crash report was saved to:/);
      const written = fs.readdirSync(context.globalStorageUri.fsPath).filter((f) => f.startsWith('crash-'));
      assert.equal(written.length, 1, 'exactly one crash snapshot is written per failure');
      assert.match(fs.readFileSync(path.join(context.globalStorageUri.fsPath, written[0]), 'utf8'), /boom/);
    });
  });

  test('a non-Error throw is stringified instead of crashing the handler', async () => {
    await withProvider({}, {}, async (provider) => {
      await assert.rejects(() => handle(provider, 'plain string failure'), /plain string failure/);
      assert.match(getNotifications().error[0], /plain string failure/);
    });
  });
});

void run();
