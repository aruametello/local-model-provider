# (custom) Local Model Provider

> Custom fork of [krevas/local-model-provider](https://github.com/krevas/local-model-provider) — adds vision (image input) support and real token-usage reporting to VS Code's context-window meter.

![VS Code](https://img.shields.io/badge/Visual_Studio_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)
![Local LLM](https://img.shields.io/badge/Local_LLM-f39c12?style=for-the-badge&logo=amazoneks&logoColor=white)
![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg?style=for-the-badge)

![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/krevas.local-model-provider?style=flat-square)
![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/krevas.local-model-provider?style=flat-square)
![License](https://img.shields.io/github/license/krevas/local-model-provider?style=flat-square)

**Connect your local LLMs directly to VS Code for a private and powerful AI coding experience.**

A VS Code extension that connects your editor to self‑hosted or local LLMs via any OpenAI‑compatible server (vLLM, Ollama, TGI, llama.cpp, LocalAI, etc.). Keep source code on your infrastructure while using AI for coding, refactoring, analysis, and more.


## ✨ Highlights

- Works with any OpenAI Chat Completions–compatible endpoint
- Function calling tools with optional parallel execution
- Safe token budgeting based on model context window
- Built‑in retries with exponential backoff and detailed logging
- Model list caching for fewer network calls
- API keys securely stored in VS Code SecretStorage
- Status bar health monitor with quick actions
- Server presets for quick switching between endpoints
- Usage statistics tracking (requests, tokens, response times)
- Default model selection for consistent workflow

## 🔌 Compatible Inference Servers

- vLLM (recommended)
- LM Studio
- Ollama
- llama.cpp
- Text Generation Inference (Hugging Face)
- LocalAI
- Any other OpenAI‑compatible server

## 📥 Installation

**Portable installer (recommended for this fork):**

1) Copy the `install_build` folder to the target machine (USB stick, network share, …).
2) Run `install_build\install.bat` — it installs the bundled `.vsix` into your existing VS Code install.
3) Reload VS Code (`Developer: Reload Window`) if prompted.

**From source:**

```bash
npm run esbuild && npm run package
code --install-extension .\local-model-provider-custom-<version>.vsix
```

> Note: this fork is not published to the VS Code Marketplace; use the installer or build from source.
> Since 1.2.0 it uses its own id (`krevas.local-model-provider-custom`) and can be installed
> **side by side** with the official `krevas.local-model-provider`. If you had a 1.1.x build of
> this fork, uninstall it first: `code --uninstall-extension krevas.local-model-provider`.

## 🚀 Quick Start

1) Start a server
- vLLM example (gpt-oss-120b)
  ```bash
  vllm serve openai/gpt-oss-120b \
  --trust-remote-code \
  --enable-auto-tool-choice \
  --tool-call-parser openai \
  --reasoning-parser openai_gptoss \
  --tensor-parallel-size 2 \
  --host 0.0.0.0 \
  --port 8000 \
  --max-model-len 131072 \
  --gpu-memory-utilization 0.8 \
  --disable-log-requests \
  --enable-prefix-caching \
  --async-scheduling
  ```
  Options explained (brief):
  - `--trust-remote-code`: allow custom model repo code to run (required by some model repos)
  - `--enable-auto-tool-choice`: let the model/server automatically pick and call tools
  - `--tool-call-parser openai`: use OpenAI function calling format
  - `--reasoning-parser openai_gptoss`: reasoning parser compatible with GPT‑OSS
  - `--tensor-parallel-size 2`: split the model across 2 GPUs (tensor parallelism)
  - `--host 0.0.0.0`: listen on all network interfaces
  - `--port 8000`: server port
  - `--max-model-len 131072`: max context length (tokens)
  - `--gpu-memory-utilization 0.8`: VRAM usage ratio per GPU
  - `--disable-log-requests`: reduce request logging noise
  - `--enable-prefix-caching`: enable prefix/KV cache for repeated prompts
  - `--async-scheduling`: schedule requests asynchronously for better throughput
  
- LM Studio example
  1. Download and install [LM Studio](https://lmstudio.ai/)
  2. Load a model in the LM Studio UI
  3. Start the local server (default: `http://localhost:1234`)
  4. Set `local.model.provider.serverUrl` to `http://localhost:1234`
  
  > **Tip:** If tool calling causes errors with your model, disable `local.model.provider.enableToolCalling` in settings.

- Ollama example
  ```bash
  ollama run qwen3:8b
  ```

2) Configure the extension
- Open VS Code Settings and search for “Local Model Provider”.
- Required: set `local.model.provider.serverUrl` (e.g. http://localhost:8000)
- Optional: run “Local Model Provider: Set API Key (Secure)” to store a key in SecretStorage

3) Use your models
- Open the model manager and enable models from the “Local Model Provider”.

## 🖼️ Screenshots

- Model configuration

![Model configuration](assets/1_model_config.png)

- Model selection

![Model selection](assets/2_model_select.PNG)

- Test execution

![Test execution](assets/3_test.PNG)

- Feature menu

![Feature menu](assets/4_menu.PNG)

- Server preset

![Server preset](assets/5_server_preset.PNG)

## ⚙️ Configuration

All settings are under the `local.model.provider.*` namespace.

### Server Configuration
- `serverUrl` (string): base URL, e.g. `http://localhost:8000`
- `serverPresets` (array): saved server configurations for quick switching
- `defaultModel` (string): default model ID to use (leave empty for auto-select)
- `requestTimeout` (number, ms): default 60000

### Token & Context Settings
Context and output limits are **no longer configurable** — the upstream server is
the source of truth. Each model's context window is read from the server metadata
(e.g. llama.cpp `--ctx-size` / `context_length` in `status.args`) and advertised to
VS Code; `max_tokens` is still sent but computed from that window so a request never
starves the input side. The server's own max-output limit governs generation length.

### Function Calling
- `enableToolCalling` (boolean): enable function calling (default true)
- `parallelToolCalling` (boolean): allow parallel tool calls (default true)
- `qwenToolLoopCompat` (boolean): enable Qwen-specific compatibility for XML-style tool calls and reasoning-only post-tool responses (default false)
- `qwenFinalAnswerRetry` (boolean): when Qwen compatibility is enabled, run one no-tools final-answer retry after reasoning-only tool responses (default true)

> Sampling parameters (temperature, top‑p, frequency/presence penalties) are intentionally **not** exposed: the extension never sends them, so your server's own defaults (e.g. llama.cpp's) always apply.

### Reliability & Performance
- `maxRetries` (number): retry attempts (default 3)
- `retryDelayMs` (number): backoff base delay (default 1000)
- `modelCacheTtlMs` (number): model list cache TTL (default 300000)
- `logLevel` ("debug" | "info" | "warn" | "error")

API keys are not stored in settings. Use the command palette:
- “Local Model Provider: Set API Key (Secure)”

## ⌨️ Commands

- "Local Model Provider: Set API Key (Secure)" — Store/remove API key in SecretStorage
- "Local Model Provider: Show Server Status" — Open the status bar menu with quick actions
- "Local Model Provider: View Models & Set Default" — Browse available models and set a default
- "Local Model Provider: Switch Server Preset" — Quick switch between configured server endpoints
- "Local Model Provider: View Usage Statistics" — Display session statistics (requests, tokens, response times)
- "Local Model Provider: Refresh Model Cache" — Clear cache and fetch models from server

## 🏥 Status Bar Health Monitor

See connection status at a glance. Click to open quick actions:
- View and set default model
- Switch server presets
- View usage statistics
- Refresh model cache
- Set API key
- Open settings
- Show logs

The status bar displays:
- Connection status (connected/error/unknown)
- Number of available models
- Session statistics when available

## 🔧 Troubleshooting

Models don’t appear
1) `curl http://HOST:PORT/v1/models` and confirm the server responds
2) Verify `serverUrl` is correct (protocol/port included)
3) Run “Local Model Provider: Test Server Connection”

Empty response
1) Ensure the correct tool‑call parser for your model family (e.g. vLLM `--tool-call-parser`)
2) Disable `enableToolCalling` to test plain chat
3) Large conversations are truncated automatically; try with fewer messages

Tool call formatting issues
1) Disable `parallelToolCalling` for unstable models
2) Lower the server-side temperature (e.g. llama.cpp's `-temp 0`) for more consistent tool-call formatting — the extension never overrides sampling parameters
3) For Qwen models that emit raw XML tool calls such as `<tool_call>` or return only reasoning after tools complete, enable `qwenToolLoopCompat`

LM Studio connection errors ("terminated" / "request failed")
1) Set `serverUrl` to `http://localhost:1234` (LM Studio default port)
2) Do NOT include `/v1` in the URL — the extension adds it automatically
3) Disable `parallelToolCalling` — LM Studio may not support this parameter
4) If tool calling causes crashes, disable `enableToolCalling` in settings
5) Increase `requestTimeout` if the model takes a long time to load (e.g. 120000)
6) Check the LM Studio server logs for detailed error messages

Out‑of‑memory (OOM)
- Reduce `--max-model-len`, use a quantized model (AWQ/GPTQ/FP8), or pick a smaller model

## 🔒 Security & Privacy

- Requests are sent only to the server you configure.
- If authentication is required, API keys are stored securely via VS Code SecretStorage.
- Sensitive data (like API keys) is never written to logs.

## 📜 License

Licensed under the [MIT](LICENSE) license.

## 💬 Support

- Issues & Feature Requests: https://github.com/krevas/local-model-provider/issues
