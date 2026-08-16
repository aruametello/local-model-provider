# Changelog

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