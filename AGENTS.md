# AGENTS.md — (custom) Local Model Provider (VS Code extension)

> ## ⚠️ MAINTENANCE MANDATE (read first)
> **UPDATING THIS FILE IS MANDATORY whenever you change the code.**
> Any change to architecture, file responsibilities, settings, build steps, data-flow
> behavior, or known pitfalls MUST be reflected in this same commit. Stale guidance is
> worse than none — an LLM with a fresh context will act on exactly what is written here.
> When in doubt, update the section that describes the code you touched, and add a line to
> **Change checklist** if your change introduces a new recurring maintenance step.

---

## 1. What this project is

A VS Code extension (`krevas.local-model-provider-custom`) that registers a
`vscode.LanguageModelChatProvider` so **GitHub Copilot Chat can talk to local,
OpenAI-compatible inference servers** (Ollama, vLLM, LM Studio, llama.cpp, LocalAI).

**This repo is a fork** of `krevas/local-model-provider`, branded as
**"(custom) Local Model Provider"** (the `displayName` in `package.json` and all
UI group/command titles). Since **1.2.0 the extension id is
`krevas.local-model-provider-custom`** (`publisher` + new `name` field), so it
installs **side by side** with the official marketplace version instead of
replacing it. All contributed commands live in the `local-model-provider-custom.*`
namespace and the LM vendor id is `custom-local-model-provider`. The repo ships a
self-contained Windows installer in `install_build/` (see §3 and §6) for
distributing it to other machines.

It bridges two worlds:

```
VS Code / Copilot Chat  <—LanguageModelChatProvider API—>  GatewayProvider  <—HTTP/SSE—>  Inference server
   (text + image parts, tools, thinking)                     (this repo)                  (/v1/models, /v1/chat/completions, Ollama /api/tags)
```

Capabilities currently bridged: **chat streaming, tool calling, reasoning/thinking
content, vision (image input), and real token-usage reporting** (server `usage` →
VS Code context-window meter via the `'usage'` data part).

## 2. Fast-start for a fresh context

1. Read this file top to bottom (~5 min).
2. Read `src/provider.ts` — it is the heart of the extension (~1400 lines, one class).
3. Skim `src/client.ts` (HTTP + SSE) and `src/types.ts` (all shared types).
4. Everything else (`extension.ts`, `statusBar.ts`, `statistics.ts`, `secrets.ts`,
   `qwenXml.ts`) is peripheral UI/plumbing.

**Mental model in one paragraph:** `extension.ts` activates the extension, builds a
`GatewayProvider` (which owns a `GatewayClient` + `SecretManager` + config) and registers
it with VS Code under vendor id `custom-local-model-provider`. When Copilot asks for models,
`provideLanguageModelChatInformation()` calls the server's `/v1/models` (+ Ollama
`/api/tags`) and returns `LanguageModelChatInformation[]` including detected
capabilities (`toolCalling`, `imageInput`). When a chat request arrives,
`provideLanguageModelChatResponse()` converts VS Code message parts → OpenAI-format
messages (text, tools, tool results, **images as base64 `image_url` data URLs**),
streams the completion back through `client.streamChatCompletion()`, and reports
`TextPart` / `ThinkingPart` / `ToolCallPart` chunks to VS Code.

## 3. File map & responsibilities

| File | Role | Notes |
|------|------|-------|
| `src/extension.ts` | Activation, command registration (setApiKey, showStatus, selectModel, switchServer, showStats, refreshModels), status bar wiring | Commands call into `provider` / `statusBar` / `statsManager`. Preset switching updates config then calls `provider.applyLatestConfiguration()` + `clearModelCache()`. |
| `src/provider.ts` | **Core.** `GatewayProvider implements vscode.LanguageModelChatProvider` | Message conversion, token estimation/truncation, tool-call handling (incl. JSON repair), Qwen XML tool-call compat, vision detection + image forwarding, reasoning salvage + final-answer retry, model caching. |
| `src/client.ts` | `GatewayClient`: HTTP with retry/backoff/jitter, SSE streaming parser for `/v1/chat/completions`, `/v1/models` fetch, Ollama `/api/tags` capability probe | Yields chunks `{ content, reasoning_content?, tool_calls, finished_tool_calls, finish_reason?, usage? }`. Tool calls accumulate **by index** during streaming (ids may arrive late). Injects `stream_options: { include_usage: true }` when `includeUsageInStream` is set; the trailing usage chunk arrives with an **empty `choices` array**, so `parseSSEData` must capture `usage` independently of delta/message. |
| `src/types.ts` | All shared interfaces: `OpenAIModel`, `OpenAIMessage`, request/response/chunk types, `OllamaModelCapabilities`, `GatewayConfig` | Keep in sync with what `client.ts` sends/reads and what `loadConfig()` fills. |
| `src/secrets.ts` | `SecretManager`: API key in `vscode.SecretStorage` (key: `local.model.provider.apiKey`), legacy settings migration | Never log the key. |
| `src/statusBar.ts` | Status bar item (`$(plug)/$(check)/$(error)` "Local LLM"), quick-pick status menu, server presets UI types (`ServerPreset`, `ServerStatus`) | |
| `src/statistics.ts` | In-memory per-session request stats + `onStatsUpdate` event feeding the status bar | `formatTokens`/`formatDuration` are static helpers used by `extension.ts`. |
| `src/qwenXml.ts` | Pure function `parseQwenXmlToolCalls()` — parses Qwen's raw XML tool-call format (`<tool_call><function=...><parameter=...>`) into structured calls; the only unit-tested module | Keep it dependency-free (no vscode import) so `tsconfig.test.json` can compile it standalone. |
| `test/qwenXml.test.ts` | Plain Node test runner for `qwenXml` (no framework) | Run via `npm test`. |
| `docs/API.md` | Internal architecture docs (partially historical — verify against code before trusting) | |
| `package.json` | Manifest: contributes commands + all `local.model.provider.*` settings; build scripts. `name` is `local-model-provider-custom` (fork id, coexists with the official extension); `displayName` is "(custom) Local Model Provider" | **Every new setting must be added here AND to `GatewayConfig` + `loadConfig()`.** Contributed command ids follow the `local-model-provider-custom.*` namespace — if you rename the `name` field again, update them in `package.json`, `extension.ts`, and `statusBar.ts` (and the model `family` in `provider.ts`). |
| `install_build/` | **Portable Windows installer folder** — copy the whole folder to any machine and double-click `install.bat` | Contains `install.bat` (finds VS Code CLI on PATH or in standard install dirs, runs `code --install-extension`), a **bundled `local-model-provider-custom-<version>.vsix`**, and a short `README.md`. The vsix here is the *distributable artifact* — it is git-tracked via the `!install_build/*.vsix` exception in `.gitignore`. **Must be refreshed on every release** (see §6). |

## 4. Request lifecycle (the path you'll touch most)

```
provideLanguageModelChatResponse(model, messages, options, progress, token)
 ├─ await initializationPromise            (API key loaded from SecretStorage)
 ├─ convertSingleMessageWithLogging(msg)   for each VS Code message:
 │    TextPart      → string content
 │    ToolCallPart  → assistant tool_calls[]
 │    ToolResultPart→ role:"tool" messages
 │    image DataPart→ { type:"image_url", image_url:{ url:"data:<mime>;base64,…" } }
 │                    (duck-typed: part.mimeType starts with "image/" && part.data)
 ├─ token estimation (extractEstimableText; images = fixed 150-token budget)
 ├─ truncateMessagesToFit if estimate > reserved input space
 ├─ build requestOptions { model, messages, max_tokens[, tools…] }
 │    - NO sampling params are ever sent (temperature/top_p/penalties removed in 1.2.1) —
 │      the upstream server's own defaults apply; do NOT re-add them
 │    - parallel_tool_calls only when enabled
 │    - client injects stream_options.include_usage when includeUsageInStream is set
 ├─ stream via client.streamChatCompletion()
 │    reasoning_content → ThinkingPart (duck-typed class) or  tags fallback
 │    content           → TextPart (with Qwen XML tool-call buffering if enabled)
 │    finished_tool_calls → JSON-repair args, fill missing required props, ToolCallPart
 │    usage             → tracked as lastUsage (from trailing stream_options chunk)
 ├─ post-stream:
 │    report lastUsage to VS Code as a LanguageModelDataPart(mime 'usage', JSON payload)
 │    — this is what feeds the chat context-window meter / compaction; duck-typed,
 │    only sent when the runtime has LanguageModelDataPart
 │    if qwenToolLoopCompat: parse leftover XML tool calls from buffer
 │    if no content & no tools:
 │       1) salvage answer after last </thinking>/</think> in reasoning (extractAnswerFromReasoning)
 │       2) else finalAnswerRetry (or legacy qwen gate): one no-tools "give the final answer" request
 │       3) else fallback message; finish_reason==="length" hints to raise defaultMaxOutputTokens
 └─ record stats, log response time
```

## 5. Conventions & patterns (follow these when editing)

- **Duck-type new VS Code part classes.** `LanguageModelThinkingPart` and image
  `LanguageModelDataPart` are only present in newer VS Code runtimes; the code checks
  via property shape (`mimeType`/`data`, or `typeof (vscode as any).X !== 'undefined'`).
  Do NOT use `instanceof vscode.LanguageModelDataPart`.
- **Capability detection is layered** (`GatewayProvider.detectVision`): user override
  setting `visionModels` → Ollama `/api/tags` `"vision"` entry (tolerant of `name:tag`)
  → opportunistic model-object fields (`capabilities[]`, `architecture.input_modalities`)
  → id heuristics (`-vl`, `llava`, `minicpm-v`, `gemma3`, …). Preserve this order.
- **Never count base64 in token estimates.** Use `extractEstimableText()`; images cost a
  fixed `ESTIMATED_IMAGE_TOKENS` (150) budget.
- **Server compatibility first.** OpenAI-compatible servers vary wildly: **never send
  sampling parameters** (`temperature`/`top_p`/penalties were removed in 1.2.1 — the
  server's own defaults apply; do not re-add them or their settings), handle `\r\n` SSE
  lines, treat post-data connection drops as end-of-stream, retry only retryable
  statuses (429/5xx + network errors).
- **Errors:** throw `GatewayError(message, statusCode?, isRetryable?, original?)`.
  User-facing failures go through `handleChatError()` (notification + output channel).
- **Logging:** `this.log(level, msg)` writes to the "Local Model Provider" output channel,
  filtered by `logLevel` setting. Never log API keys or full base64 payloads.
- **Config changes:** any new setting requires edits in THREE places:
  1. `package.json` → `contributes.configuration.properties` (note: `order` values are
     reused; pick a free one)
  2. `src/types.ts` → `GatewayConfig` field
  3. `src/provider.ts` → `loadConfig()` `config.get(...)` with default
  Config reloads happen automatically via the `onDidChangeConfiguration` watcher in the
  constructor (clears model cache); programmatic changes must call
  `provider.applyLatestConfiguration()`.
- **Model cache:** `cachedModels` + TTL (`modelCacheTtlMs`, default 5 min). Clear on
  config change, API-key refresh, and server switch. Fire
  `_onDidChangeLanguageModelChatInformation` when clearing externally.
- **Report token usage with the `'usage'` mime data part.** VS Code feeds the chat
  context-window meter (and conversation compaction) from a `LanguageModelDataPart`
  with `mimeType === 'usage'` whose payload is an OpenAI-shaped JSON object
  (`prompt_tokens`, `completion_tokens`, `total_tokens`) — the same mechanism used by
  VS Code's built-in BYOK providers. It is reported post-stream in
  `provideLanguageModelChatResponse` (duck-typed, only when the runtime has
  `LanguageModelDataPart`). Keep it if you touch post-stream handling.

## 6. Build / test / package / install (verified working, Windows PowerShell)

```powershell
npm install                 # dev deps (esbuild, typescript, @types/vscode, vsce)
npx tsc -p ./ --noEmit      # type-check (expect exit 0; a pre-existing moduleResolution deprecation warning in tsconfig.json is NOT an error)
npm test                    # compiles tsconfig.test.json + runs qwenXml tests (plain node, no framework)
npm run esbuild             # bundle src/extension.ts -> out/extension.js (+sourcemap)
npm run package             # vsce package -> local-model-provider-custom-<version>.vsix
code --install-extension .\local-model-provider-custom-<version>.vsix   # install into the user's VS Code
```

**Release workflow after any code change:**
1. Bump `version` in `package.json`.
2. Add a `CHANGELOG.md` entry (keep the existing `## X.Y.Z` / New Features / Bug Fixes style).
3. `npm run esbuild` → `npm run package` → `code --install-extension .\…vsix`.
4. **Refresh the portable installer:** copy the new vsix into `install_build/`
   (replacing the old one) and, if the version changed, update the `VSIX=` line
   at the top of `install_build/install.bat` to match the new filename.
5. User must **Developer: Reload Window** for it to take effect.

Notes:
- Use `;` to chain commands in PowerShell (never `&&`).
- `npm run esbuild`/`package` print red-looking PowerShell stderr noise from Node
  deprecation warnings — check the **exit code / "Done"/"DONE Packaged"** line, not colors.
- Root-level `*.vsix` build artifacts are gitignored (delete stale ones after
  reinstalling), EXCEPT `install_build/*.vsix`, which is intentionally tracked so
  a fresh clone of this fork already contains a working installer.
- `install_build/install.bat` must keep **CRLF line endings** (cmd.exe parsing)

## 7. Known pitfalls (learned the hard way)

- **`@types/vscode` version quirk:** `package.json` pins `"^1.100.0"`, which resolves to
  the latest published types (≥1.125) containing `vscode.lm.registerLanguageModelChatProvider`,
  `LanguageModelChatInformation.capabilities.imageInput`, and `LanguageModelDataPart`.
  The *exact* 1.100.0 types do NOT have these — don't be fooled when inspecting unpkg.
- **Thinking models + images produce reasoning-only responses.** Two root causes:
  (a) the server emits the final answer inside `reasoning_content` after the closing
  thinking tag; (b) `max_tokens` is exhausted mid-thinking (`finish_reason=length`).
  Handled by salvage → `finalAnswerRetry` → diagnostics that mention raising
  `defaultMaxOutputTokens`. If you change response post-processing, keep all three.
- **Ollama model ids are tagged** (`llava:7b`) while OpenAI-style ids may be bare
  (`llava`) — capability lookup must try exact, slash-stripped, and tag-stripped keys.
- **Streaming tool-call ids arrive late.** Accumulate by `index`, not id; finalize with
  generated ids at stream end (`getRemainingToolCalls`).
- **`qwenXml.ts` must stay vscode-free** or the standalone test compile breaks.
- **Extension id is `krevas.local-model-provider-custom` (1.2.0+), NOT the official
  `krevas.local-model-provider`.** The fork deliberately coexists with the marketplace
  version; command ids are `local-model-provider-custom.*`. If you ever rename the
  `name` field, remember the old id keeps any previously installed copies — users must
  uninstall the old id manually.

## 8. Change checklist (do ALL that apply per change)

- [ ] Code change compiles: `npx tsc -p ./ --noEmit` → exit 0
- [ ] Tests pass: `npm test`
- [ ] New/changed setting? → `package.json` + `GatewayConfig` + `loadConfig()` (3 places)
- [ ] New server-side behavior? → extend `client.ts` (+ `types.ts`), keep retry/compat rules
- [ ] Model capability change? → update `detectVision` layers AND the model quick-pick detail line in `extension.ts`
- [ ] Version bump + `CHANGELOG.md` entry
- [ ] Rebuild + repackage + reinstall (`esbuild` → `package` → `code --install-extension`)
- [ ] Portable installer refreshed: new vsix copied into `install_build/`, `VSIX=` line in `install.bat` matches the version
- [ ] **Update this AGENTS.md** (mandatory — see header)
