# Changelog

## 1.2.8

### New Features
- **Configurable max generated tokens.** New `local.model.provider.maxOutputTokens` setting (default `65536` / 64k) caps how many tokens the extension requests per generation (`max_tokens`). It is still bounded by the model's context window and the space left after the input, so it cannot overflow. Raise it to allow longer generations on large-context models, or lower it to keep responses short.

## 1.2.7

### Bug Fixes
- **Long generations are no longer cut short at a hardcoded 4096 tokens.** `calculateSafeMaxOutputTokens` capped `max_tokens` at the fixed `DEFAULT_OUTPUT_BUDGET` (4096) on every request, so on a 32k-context model a long answer stopped at 4096 tokens with `finish_reason="length"` — and the diagnostic then misleadingly blamed the upstream server's output limit. The output budget now scales with the model's context window (up to half the window), matching the documented intent that the server's own max-output limit is authoritative. `splitContextWindow` and `retryQwenFinalAnswer` were updated to match.

## 1.2.6

### Bug Fixes
- **Vision requests no longer collapse `max_tokens` to ~64.** The final (post-truncation) token estimate now uses `extractEstimableText()` instead of inline `JSON.stringify`, so image parts are normalized to a fixed placeholder and their base64 payloads no longer inflate the estimate.
- **Retries now fire for real network errors (`fetch failed`).** `isRetryableError` walks the `error.cause` chain and checks `error.code`, so Node's `TypeError: fetch failed` (with `ECONNREFUSED`/`ETIMEDOUT`/`ECONNRESET` nested in `cause`) is retried instead of failing instantly.
- **Context truncation no longer breaks tool-call / tool-result pairing.** `truncateMessagesToFit` prunes orphaned messages (`pruneOrphanedToolMessages`) so every retained `role:"tool"` message has a matching retained assistant `tool_calls` entry and vice versa — OpenAI-compatible servers (vLLM, llama.cpp) reject orphans with HTTP 400.
- **Stale diagnostic no longer references the removed setting.** The `finish_reason="length"` hint now directs users to raise the upstream server's output limit instead of the removed "Default Max Output Tokens" setting.
- **`max_tokens` no longer overflows a near-full context window.** When the input estimate fills the window, `calculateSafeMaxOutputTokens` returns `undefined` and the request omits `max_tokens` entirely (server picks its ceiling) instead of forcing a 64-token floor that could still overflow. `reservedForInput` is clamped to a sane minimum so truncation always has a meaningful budget.
- **Mid-stream stall protection.** Each stream read is now raced against `requestTimeout` (`readWithIdleTimeout`); a server that stops sending data after the first byte is aborted with a retryable error instead of hanging forever.
- **Removed dead duplicate code.** Deleted the never-called `convertMessages()` / `streamChatCompletion()` helpers in `provider.ts` and the unused `ToolCallState.handleSSEError` in `client.ts`.
- **System messages are now sent as `role:"system"`.** `mapRole` maps a system role (duck-typed for older type defs) to `'system'` instead of collapsing it into `'user'`.
- **Cancellations are matched precisely.** `handleChatError` only swallows errors whose message *ends with* "cancelled" (the exact `GatewayError` produced by the cancellation paths), so genuine upstream failures containing that word are no longer hidden.
- **Final-answer retry budgets context.** `retryQwenFinalAnswer` truncates the appended reasoning transcript to fit the remaining context window, so long conversations don't overflow with HTTP 400.

## 1.2.5

### Removed
- Removed the vestigial `defaultMaxTokens` and `defaultMaxOutputTokens` settings entirely. The upstream server is the source of truth for both context and output limits: each model's context window is parsed from server metadata (llama.cpp `status.args`), falling back to a built-in `FALLBACK_CONTEXT_WINDOW` constant; `max_tokens` is still sent but derived from that window (capped by a built-in `DEFAULT_OUTPUT_BUDGET`) so a request never starves the input side, and the server's own max-output limit governs generation length. Removed the old `loadConfig()` validation that warned when output tokens exceeded input tokens.

## 1.2.4

### Bug Fixes
- **Context size no longer double-counts output tokens.** VS Code's model picker and context meter display `maxInputTokens + maxOutputTokens` as the total window. 1.2.3 advertised the full server context as `maxInputTokens` *and* a separate `defaultMaxOutputTokens` as `maxOutputTokens`, so every model appeared inflated by ~`defaultMaxOutputTokens` (e.g. 256k→512k, 512k→768k). The extension now splits each model's shared context window into input + output budgets that sum back to the real size (BYOK convention), caps advertised output at half the window so a large `defaultMaxOutputTokens` cannot starve input, and recovers the full window as `maxInput + maxOutput` for request budgeting.

## 1.2.3

### Bug Fixes
- **Per-model context windows are now honored.** Previously every model was advertised with the same global `defaultMaxTokens` context size, so the chat context-window meter and truncation logic used one value for all models. The extension now reads each model's own context window from the server metadata (llama.cpp `--ctx-size` / `context_length` override in `status.args`) and passes it to VS Code via `maxInputTokens`, and uses it for token budgeting/truncation in chat requests. Models that don't report a context size still fall back to the `defaultMaxTokens` setting.

## 1.2.2

### Improvements
- **Cancellation now aborts the upstream request.** When you stop/cancel a chat request, the extension immediately aborts the HTTP connection (via `AbortController`) instead of only stopping the local stream loop. This tears down the TCP connection so the upstream server (llama.cpp, vLLM, Ollama, …) stops generating an abandoned response instead of wasting compute. Cancellation also short-circuits retry backoff, and no error notification is shown for a user-initiated cancel.

## 1.2.1

### Removed
- Removed the `agentTemperature`, `topP`, `frequencyPenalty`, and `presencePenalty` settings entirely: the extension no longer sends **any** sampling parameters (`temperature`, `top_p`, penalties) in requests, so the upstream server's own defaults (e.g. llama.cpp's `-temp`, `--top-p`) always apply
- Removed dead code: the unused `buildRequestOptions()`/`addTooling()` helpers that hardcoded `temperature: 0.7`

## 1.2.0

### Breaking Changes
- Changed the extension id from `krevas.local-model-provider` to **`krevas.local-model-provider-custom`** (new `"name"` field), so this fork can now be installed **side by side** with the official marketplace version instead of replacing it. All contributed commands moved to the `local-model-provider-custom.*` namespace and the language-model vendor id is now `custom-local-model-provider`.
- If you had the 1.1.x fork installed, uninstall it first (`code --uninstall-extension krevas.local-model-provider`) — otherwise the official marketplace extension may overwrite it while this one installs under the new id.

## 1.1.6

### Improvements
- Renamed to **"(custom) Local Model Provider"** (display name, command categories, settings title, model-picker vendor group) to mark this as a fork of `krevas/local-model-provider`
- Added `install_build/` portable installer: drop the folder on any Windows machine and run `install.bat` to install the bundled `.vsix` into an existing VS Code install (no Node.js or Marketplace access required)

## 1.1.5

### New Features
- Real token-usage reporting to VS Code: the extension now sends `stream_options: { include_usage: true }` (llama.cpp, vLLM, OpenAI-compatible servers) and reports the server's final `usage` object back to VS Code as a `'usage'` data part — the same mechanism VS Code's built-in BYOK providers use. This feeds the chat **context-window meter** ("X / 260K tokens") and conversation compaction with real numbers instead of estimates
- New setting `local.model.provider.includeUsageInStream` (default on) to disable the request for servers that reject unknown fields
- Session statistics now prefer the server's real `prompt_tokens`/`completion_tokens` over character-based estimates when available

### Bug Fixes
- Fixed SSE parser dropping trailing usage chunks: llama.cpp-style usage arrives in a chunk with an **empty `choices` array**, which previously produced no yield at all

## 1.1.4

### New Features
- Vision (image) input support: models are now advertised to VS Code with `capabilities.imageInput` when they accept images, so image attachments in Copilot Chat are routed to them
  - Capability detection is layered: `local.model.provider.visionModels` override → Ollama native `/api/tags` (`vision` capability) → opportunistic server fields → model-id heuristics (e.g. `-vl`, `llava`, `minicpm-v`, `gemma3`)
  - Image parts are forwarded to the upstream server as OpenAI-style `image_url` content parts (base64 data URLs)
  - New setting `local.model.provider.visionModels` (array of model IDs) to force vision on for models whose servers don't expose capabilities
  - Model picker now shows `Vision: Yes/No` per model

### Bug Fixes
- Fixed "The model produced reasoning but no final answer" on thinking/reasoning models (common with image inputs): the final answer is now salvaged from the reasoning stream when a server emits it after the closing `</thinking>` tag
- New setting `local.model.provider.finalAnswerRetry` (default on): runs one extra no-tools request for the final answer whenever a response contains only reasoning, generalizing the previous Qwen-only retry
- Reasoning-only responses now report the upstream `finish_reason`; when generation stopped at the token limit (`length`), the error message tells you to increase "Default Max Output Tokens" (thinking models can spend their whole budget reasoning before answering)
- Token estimation no longer counts base64 image payloads; each image uses a fixed ~150-token budget so vision requests are neither truncated nor over-truncated

## 1.1.3

### New Features
- Added opt-in Qwen tool-loop compatibility for local reasoning models (e.g. `unsloth/Qwen3.5-9B-GGUF` via llama.cpp)
- `qwenToolLoopCompat`: parses Qwen's raw XML-style tool calls (`<tool_call>` / `<function=...>`) into structured tool calls, and preserves reasoning across tool steps
- `qwenFinalAnswerRetry`: when enabled alongside `qwenToolLoopCompat`, runs one no-tools retry to get a final assistant message if Qwen returns only reasoning after a tool result

### Bug Fixes
- Fixed trailing text after a Qwen XML tool call being silently dropped by resetting the XML buffering state per tool-call block instead of once per response

## 1.1.2

### Improvements
- Fixed "terminated" / "request failed" errors when connecting to LM Studio and similar servers
- Replaced `TextDecoderStream` + `pipeThrough` with plain `TextDecoder` to avoid stream termination in certain runtimes
- Gracefully handle stream disconnection when data has already been received (some servers close without sending `[DONE]`)
- Added `\r\n` line ending support in SSE stream parsing
- Only send `top_p`, `frequency_penalty`, `presence_penalty` when non-default to avoid rejection by servers that don't accept unknown parameters
- Only send `parallel_tool_calls` when enabled (LM Studio rejects this field)
- Improved "terminated" error messages with actionable troubleshooting steps
- Added LM Studio to compatible servers list, keywords, and README setup guide

## 1.1.1

### Bug Fixes
- Prevented premature message truncation caused by an overly conservative token estimate. We now compute a real input-token estimate for the full conversation first and only truncate when it truly exceeds the available context window. This resolves cases where input was truncated despite ample room.
- Clearer token budgeting: context is now calculated as `model_context - desired_output - tools_overhead - buffer` and truncation is gated on the real estimate against this value.

## 1.1.0

- Fixed UTF-8 decoding issues causing garbled characters (e.g. arrows) by implementing `TextDecoderStream`
- Improved stream processing stability and ensured all data is flushed at the end of the response
- Fixed missing property error in tool call state creation

## 1.0.9

- Ensure model list refresh after server switch
- Apply latest config immediately on serverUrl update to avoid stale models
- Minor UX tweaks in server preset picker

## 1.0.8

### Bug Fixes
- Fixed server switching not immediately reflecting in "Manage Language Models" menu
- Fixed new preset creation not loading models from the new server

### Improvements
- Server switching now fetches models immediately with progress notification
- New preset creation now validates server connection and displays model count
- Enhanced user feedback when switching servers (shows model count or error)

## 1.0.7

### New Features
- **Delete Server Presets**: Remove saved server presets with confirmation dialog

### Improvements
- Server preset menu now shows delete option when presets exist
- Better model selection responsiveness with immediate cache refresh

## 1.0.6

### New Features
- **Model Viewer & Default Selection**: View available models and quickly set a default model
- **Server Presets**: Save and switch between multiple server configurations (vLLM, Ollama, OpenAI, etc.)
- **Token Usage Statistics**: Track input/output tokens and view per-model statistics
- **Response Time Monitoring**: Display last response time in status bar, track average response times
- **Manual Model Refresh**: Refresh model cache on demand via command

### Improvements
- Enhanced status bar with session statistics in tooltip
- New quick actions menu with all features accessible
- Added 4 new commands: View Models, Switch Server, View Statistics, Refresh Models
- Removed redundant "Test Connection" command (consolidated into Refresh Models)
- Enhanced "Refresh Models" to display model names in the success message

## 1.0.5

- Lowered minimum VS Code engine version to 1.100.0 for Antigravity compatibility

## 1.0.4

- Added reasoning/thinking content output support for models like o1, o3, Claude, etc.

## 1.0.3

- Fixed error when using API Key

## 1.0.2

- Bug fixes

## 1.0.1

- Bug fixes