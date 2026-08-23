import * as vscode from 'vscode';
import { GatewayClient } from './client';
import { GatewayConfig, OpenAIChatCompletionRequest, OpenAIUsage, OllamaModelCapabilities } from './types';
import { SecretManager } from './secrets';
import { StatisticsManager } from './statistics';
import { parseQwenXmlToolCalls } from './qwenXml';

// The authoritative context window for every model now comes from the server
// metadata (`GatewayClient.extractContextLength`, e.g. llama.cpp status.args).
// These are only used as a last-resort fallback when a server does not report
// a context size at all. We deliberately do NOT expose them as settings — the
// upstream server is the source of truth for both context and output limits.
const FALLBACK_CONTEXT_WINDOW = 32768;
// Default share of the context window reserved for output when splitting a
// shared window into VS Code's maxInputTokens + maxOutputTokens. The output
// budget is still capped at half the window; the server's own max-output limit
// remains authoritative for actual generation length.
const DEFAULT_OUTPUT_BUDGET = 4096;

/**
 * Language model provider for OpenAI-compatible inference APIs
 */
export class GatewayProvider implements vscode.LanguageModelChatProvider {
  private readonly client: GatewayClient;
  private config: GatewayConfig;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly secretManager: SecretManager;
  private readonly statsManager: StatisticsManager | null;
  // Store tool schemas for the current request to fill missing required properties
  private readonly currentToolSchemas: Map<string, unknown> = new Map();
  // Preserve reasoning across tool steps for Qwen reasoning models.
  private readonly toolCallReasoning: Map<string, string> = new Map();
  // Track if we've shown the welcome notification this session
  private hasShownWelcomeNotification = false;
  // Model cache
  private cachedModels: vscode.LanguageModelChatInformation[] | null = null;
  private modelCacheTimestamp: number = 0;
  // Ensure async init (API key load) completes before first requests
  private readonly initializationPromise: Promise<void>;
  // Event emitter for model list changes
  private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
  public readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  constructor(private readonly context: vscode.ExtensionContext, statsManager?: StatisticsManager) {
    this.outputChannel = vscode.window.createOutputChannel('Local Model Provider');
    this.secretManager = new SecretManager(context, this.outputChannel);
    this.statsManager = statsManager ?? null;
    this.config = this.loadConfig();
    this.client = new GatewayClient(this.config, {
      maxRetries: this.config.maxRetries,
      baseDelayMs: this.config.retryDelayMs,
    });
    
    // Initialize API key from secure storage (store promise for awaiting later)
    this.initializationPromise = this.initializeApiKey();

    // React to secret storage changes (API key updates)
    context.subscriptions.push(
      context.secrets.onDidChange(async (e) => {
        if (e.key === 'local.model.provider.apiKey') {
          await this.refreshApiKey();
        }
      })
    );

    // Watch for configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
        if (e.affectsConfiguration('local.model.provider')) {
          this.log('info', 'Configuration changed, reloading...');
          this.reloadConfig();
          // Clear model cache on config change
          this.cachedModels = null;
          this.modelCacheTimestamp = 0;
        }
      })
    );
  }

  /**
   * Initialize API key from secure storage asynchronously
   */
  private async initializeApiKey(): Promise<void> {
    try {
      const apiKey = await this.secretManager.getApiKey();
      if (apiKey) {
        this.config.apiKey = apiKey;
        this.client.updateConfig(this.config);
        this.log('info', 'API key loaded from secure storage');
      }
    } catch (error) {
      this.log('error', `Failed to load API key: ${error}`);
    }
  }

  /**
   * Force refresh API key from secure storage and update client immediately
   */
  public async refreshApiKey(): Promise<void> {
    try {
      const apiKey = await this.secretManager.getApiKey();
      this.config.apiKey = apiKey || '';
      this.client.updateConfig(this.config);
      this.log('info', apiKey ? 'API key updated from secure storage' : 'API key cleared');
      // Clear model cache so next call revalidates with new credentials
      this.cachedModels = null;
      this.modelCacheTimestamp = 0;
    } catch (error) {
      this.log('error', `Failed to refresh API key: ${error}`);
    }
  }

  /**
   * Clear the model cache to force a refresh
   */
  public clearModelCache(): void {
    this.cachedModels = null;
    this.modelCacheTimestamp = 0;
    this.log('info', 'Model cache cleared');
    // Notify VS Code that the model list has changed
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /**
   * Immediately reload configuration and update HTTP client.
   * Useful when settings are programmatically changed and we want
   * to ensure subsequent operations use the latest config without
   * waiting for VS Code config change events.
   */
  public applyLatestConfiguration(): void {
    // Reuse existing reload logic
    this.reloadConfig();
  }

  /**
   * Get the SecretManager for external use (e.g., commands)
   */
  public getSecretManager(): SecretManager {
    return this.secretManager;
  }

  /**
   * Get the output channel for external use (e.g., commands)
   */
  public getOutputChannel(): vscode.OutputChannel {
    return this.outputChannel;
  }

  /**
   * Log levels for filtering output
   */
  private readonly LOG_LEVELS: Record<string, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  /**
   * Log a message with the specified level
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const configLevel = this.config?.logLevel || 'info';
    if (this.LOG_LEVELS[level] >= this.LOG_LEVELS[configLevel]) {
      const timestamp = new Date().toISOString();
      const prefix = level.toUpperCase().padEnd(5);
      this.outputChannel.appendLine(`[${timestamp}] [${prefix}] ${message}`);
    }
  }

  /**
   * Map VS Code message role to OpenAI role string
   */
  private mapRole(role: vscode.LanguageModelChatMessageRole): string {
    if (role === vscode.LanguageModelChatMessageRole.User) {
      return 'user';
    }
    if (role === vscode.LanguageModelChatMessageRole.Assistant) {
      return 'assistant';
    }
    return 'user';
  }

  /**
   * Convert a tool result part to OpenAI format
   */
  private convertToolResultPart(part: vscode.LanguageModelToolResultPart): Record<string, unknown> {
    const content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
    return {
      tool_call_id: part.callId,
      role: 'tool',
      content: this.config.qwenToolLoopCompat
        ? `${content}\n\nTool execution completed. Continue from the preserved reasoning, then provide a concise final response in normal assistant content. Do not emit another tool call unless the result is insufficient.`
        : content,
    };
  }

  /**
   * Convert a tool call part to OpenAI format
   */
  private convertToolCallPart(part: vscode.LanguageModelToolCallPart): Record<string, unknown> {
    return {
      id: part.callId,
      type: 'function',
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input),
      },
    };
  }

  // Helper method: convertMessages (kept for potential future use)
  private convertMessages(messages: readonly vscode.LanguageModelChatMessage[]): Record<string, unknown>[] {
    const openAIMessages: Record<string, unknown>[] = [];

    for (const msg of messages) {
      const role = this.mapRole(msg.role);
      const toolResults: Record<string, unknown>[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      const imageParts: Record<string, unknown>[] = [];
      let textContent = '';

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          toolResults.push(this.convertToolResultPart(part));
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(this.convertToolCallPart(part));
        } else {
          const imagePart = this.extractImageContentPart(part);
          if (imagePart) {
            imageParts.push(imagePart);
          }
        }
      }

      if (toolCalls.length > 0) {
        const preservedReasoning = this.config.qwenToolLoopCompat ? this.getPreservedReasoningForToolCalls(toolCalls) : '';
        const assistantContent = preservedReasoning
          ? `${preservedReasoning}${textContent ? `\n\n${textContent}` : ''}`
          : textContent || null;
        openAIMessages.push({ role: 'assistant', content: assistantContent, tool_calls: toolCalls });
      } else if (toolResults.length > 0) {
        openAIMessages.push(...toolResults);
      } else if (imageParts.length > 0 || textContent) {
        const content: unknown = imageParts.length > 0
          ? [
              ...(textContent ? [{ type: 'text', text: textContent }] : []),
              ...imageParts,
            ]
          : textContent;
        openAIMessages.push({ role, content });
      }
    }

    return openAIMessages;
  }

  /**
   * Detect a VS Code image data part (`LanguageModelDataPart`) via duck-typing so it
   * works across VS Code versions (the class is only present in newer releases), and
   * convert it to an OpenAI `image_url` content part using a base64 data URL.
   * Returns undefined for non-image parts.
   */
  private extractImageContentPart(part: unknown): Record<string, unknown> | undefined {
    const p = part as { mimeType?: string; data?: Uint8Array } | null;
    if (!p || typeof p.mimeType !== 'string' || !p.mimeType.startsWith('image/') || !p.data) {
      return undefined;
    }
    const base64 = Buffer.from(p.data).toString('base64');
    return {
      type: 'image_url',
      image_url: { url: `data:${p.mimeType};base64,${base64}` },
    };
  }

  // NOTE: sampling parameters (temperature, top_p, frequency/presence penalties)
  // are intentionally never sent — the upstream server's own defaults are used.

  /**
   * Get default value for a JSON schema type
   */
  private getDefaultForType(schema: Record<string, unknown> | null | undefined): unknown {
    if (!schema?.type) {
      return null;
    }

    switch (schema.type) {
      case 'string':
        return schema.default ?? '';
      case 'number':
      case 'integer':
        return schema.default ?? 0;
      case 'boolean':
        return schema.default ?? false;
      case 'array':
        return schema.default ?? [];
      case 'object':
        return schema.default ?? {};
      case 'null':
        return null;
      default:
        // Handle union types like ["string", "null"]
        if (Array.isArray(schema.type)) {
          if (schema.type.includes('null')) {
            return null;
          }
          // Use first non-null type
          for (const t of schema.type) {
            if (t !== 'null') {
              return this.getDefaultForType({ ...schema, type: t });
            }
          }
        }
        return null;
    }
  }

  /**
   * Fill in missing required properties with default values based on the tool schema
   */
  private fillMissingRequiredProperties(args: Record<string, unknown>, toolName: string, toolSchema: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!toolSchema?.required || !Array.isArray(toolSchema.required)) {
      return args;
    }

    const properties = (toolSchema.properties || {}) as Record<string, Record<string, unknown>>;
    const filledArgs = { ...args };
    const filledProperties: string[] = [];

    for (const requiredProp of toolSchema.required as string[]) {
      if (!(requiredProp in filledArgs)) {
        const propSchema = properties[requiredProp];
        const defaultValue = this.getDefaultForType(propSchema);
        filledArgs[requiredProp] = defaultValue;
        filledProperties.push(`${requiredProp}=${JSON.stringify(defaultValue)}`);
      }
    }

    if (filledProperties.length > 0) {
      this.outputChannel.appendLine(`  AUTO-FILLED missing required properties: ${filledProperties.join(', ')}`);
    }

    return filledArgs;
  }

  /**
   * Approximate token cost of a single image. Vision models downscale inputs,
   * so a fixed budget (~150 tokens) is far more stable than counting the
   * base64 payload, which would otherwise dominate the estimate.
   */
  private static readonly ESTIMATED_IMAGE_TOKENS = 150;

  /**
   * Build an estimable text representation of an OpenAI-format message.
   * Image content parts are replaced with a fixed-length placeholder so their
   * base64 data does not inflate the character-based token estimate.
   */
  private extractEstimableText(message: Record<string, unknown>): string {
    let text = '';
    const content = message.content;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as Record<string, unknown>;
        if (p?.type === 'image_url' || p?.type === 'input_image') {
          // ~4 chars per token to match the estimate below
          text += ' '.repeat(GatewayProvider.ESTIMATED_IMAGE_TOKENS * 4);
        } else if (typeof p?.text === 'string') {
          text += p.text;
        } else {
          text += JSON.stringify(part ?? '');
        }
      }
    } else if (content) {
      text = JSON.stringify(content);
    }
    if (message.tool_calls) {
      text += JSON.stringify(message.tool_calls);
    }
    return text;
  }

  /**
   * Estimate token count for a message
   */
  private estimateMessageTokens(message: any): number {
    const text = this.extractEstimableText(message);
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncate messages to fit within a token limit.
   * Strategy: Keep the first message (usually system prompt) and the most recent messages.
   * Remove older messages from the middle of the conversation.
   */
  private truncateMessagesToFit(messages: any[], maxTokens: number): any[] {
    if (messages.length === 0) {
      return messages;
    }

    // Calculate total tokens
    let totalTokens = 0;
    const messageTokens: number[] = [];
    for (const msg of messages) {
      const tokens = this.estimateMessageTokens(msg);
      messageTokens.push(tokens);
      totalTokens += tokens;
    }

    // If we're within limits, return as-is
    if (totalTokens <= maxTokens) {
      return messages;
    }

    this.outputChannel.appendLine(`Context overflow: ${totalTokens} tokens > ${maxTokens} limit. Truncating...`);

    // Strategy: Keep first message (system) and as many recent messages as possible
    const result: any[] = [];
    let usedTokens = 0;

    // Always keep the first message if it exists (usually system prompt)
    if (messages.length > 0) {
      result.push(messages[0]);
      usedTokens += messageTokens[0];
    }

    // Work backwards from the end, adding messages until we hit the limit
    const recentMessages: any[] = [];
    for (let i = messages.length - 1; i > 0; i--) {
      const msgTokens = messageTokens[i];
      if (usedTokens + msgTokens <= maxTokens) {
        recentMessages.unshift(messages[i]);
        usedTokens += msgTokens;
      } else {
        // Stop when we can't fit more messages
        break;
      }
    }

    // Combine first message with recent messages
    result.push(...recentMessages);

    this.outputChannel.appendLine(`Truncated: kept ${result.length}/${messages.length} messages, ~${usedTokens} tokens`);

    return result;
  }

  /**
   * Count occurrences of a character in a string
   */
  private countChar(str: string, char: string): number {
    // Escape regex special characters in the search char
    const escapePattern = /[.*+?^${}()|[\]\\]/g;
    const escapedChar = char.replaceAll(escapePattern, String.raw`\$&`);
    const regex = new RegExp(escapedChar, 'g');
    let count = 0;
    while (regex.exec(str) !== null) {
      count++;
    }
    return count;
  }

  /**
   * Balance unclosed braces/brackets in a JSON string
   */
  private balanceBrackets(str: string): string {
    let result = str;
    const missingBrackets = this.countChar(result, '[') - this.countChar(result, ']');
    const missingBraces = this.countChar(result, '{') - this.countChar(result, '}');

    result += ']'.repeat(Math.max(0, missingBrackets));
    result += '}'.repeat(Math.max(0, missingBraces));

    return result;
  }

  /**
   * Attempt to repair truncated or malformed JSON arguments
   */
  private tryRepairJson(jsonStr: string): unknown {
    if (!jsonStr || jsonStr.trim() === '') {
      return {};
    }

    // First, try direct parse
    try {
      return JSON.parse(jsonStr);
    } catch {
      // Continue to repair attempts
    }

    // Attempt repairs for common issues
    let repaired = jsonStr.trim();

    // Fix missing closing brackets/braces
    repaired = this.balanceBrackets(repaired);

    // Fix trailing comma before closing brace/bracket
    repaired = repaired.replaceAll(/,\s*([}\]])/g, '$1');

    // Fix truncated string value - close the string if odd number of quotes
    if (this.countChar(repaired, '"') % 2 !== 0) {
      repaired += '"';
      repaired = this.balanceBrackets(repaired);
    }

    try {
      return JSON.parse(repaired);
    } catch {
      this.outputChannel.appendLine(`JSON repair failed. Original: ${jsonStr}`);
      this.outputChannel.appendLine(`Repaired attempt: ${repaired}`);
      return null;
    }
  }

  // Helper method: streamChatCompletion (updated for new client interface)
  private async streamChatCompletion(
    requestOptions: any,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    this.outputChannel.appendLine(`Streaming chat completion...`);
    let totalContent = '';
    let totalToolCalls = 0;

    for await (const chunk of this.client.streamChatCompletion(requestOptions, token)) {
      if (token.isCancellationRequested) {
        break;
      }

      // Report text content immediately
      if (chunk.content) {
        totalContent += chunk.content;
        progress.report(new vscode.LanguageModelTextPart(chunk.content));
      }

      // Process finished tool calls (fully accumulated by client)
      if (chunk.finished_tool_calls && chunk.finished_tool_calls.length > 0) {
        for (const toolCall of chunk.finished_tool_calls) {
          totalToolCalls++;
          this.outputChannel.appendLine(`Tool call received: id=${toolCall.id}, name=${toolCall.name}`);
          this.outputChannel.appendLine(`  Raw arguments: ${toolCall.arguments.substring(0, 500)}${toolCall.arguments.length > 500 ? '...' : ''}`);

          // Parse arguments with repair capability
          let args = this.tryRepairJson(toolCall.arguments) as Record<string, unknown> | null;

          if (args === null) {
            this.log('error', ` Failed to parse tool call arguments for ${toolCall.name}`);
            this.outputChannel.appendLine(`  Full arguments: ${toolCall.arguments}`);
            args = {}; // Fallback to empty args
          }

          progress.report(new vscode.LanguageModelToolCallPart(
            toolCall.id,
            toolCall.name,
            args as object
          ));
        }
      }
    }

    this.outputChannel.appendLine(`Completed chat request, received ${totalContent.length} characters, ${totalToolCalls} tool calls`);
  }

  /**
   * Provide language model information - fetches available models from inference server
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean; },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // Ensure API key (and other async init) has completed
    try {
      await this.initializationPromise;
    } catch {
      // Ignore init errors here; downstream will surface issues
    }
    this.log('debug', `API key configured: ${this.config.apiKey ? 'yes' : 'no'}`);
    // Check cache first
    const now = Date.now();
    if (this.cachedModels && this.config.modelCacheTtlMs > 0 && 
        (now - this.modelCacheTimestamp) < this.config.modelCacheTtlMs) {
      this.log('debug', `Using cached models (${this.cachedModels.length} models, cache age: ${now - this.modelCacheTimestamp}ms)`);
      return this.cachedModels;
    }

    try {
      this.log('info', 'Fetching models from inference server...');
      const [response, ollamaCaps] = await Promise.all([
        this.client.fetchModels(),
        this.client.fetchOllamaCapabilities(),
      ]);

      const visionOverrides = this.config.visionModels ?? [];

      const models = response.data.map((model) => {
        const imageInput = this.detectVision(model.id, model, ollamaCaps, visionOverrides);
        // Use the per-model context window reported by the server (e.g. llama.cpp
        // --ctx-size / context_length override) when available; otherwise fall back
        // to a built-in constant. Removed the configurable `defaultMaxTokens`
        // setting — the upstream server is the source of truth for context size.
        //
        // IMPORTANT: VS Code's model picker and context-usage meter display
        //   maxInputTokens + maxOutputTokens
        // as the total context size (same convention as Copilot BYOK providers).
        // So we must SPLIT the shared window into input + output budgets that sum
        // back to the real context — never advertise full context as maxInput and
        // also a separate maxOutput (that double-counts and inflates the UI).
        const contextWindow = GatewayClient.extractContextLength(model) ?? FALLBACK_CONTEXT_WINDOW;
        const { maxInputTokens, maxOutputTokens } = this.splitContextWindow(contextWindow);
        const modelInfo: vscode.LanguageModelChatInformation = {
          id: model.id,
          name: model.id,
          family: 'custom-local-model-provider',
          maxInputTokens,
          maxOutputTokens,
          version: '1.0.0',
          capabilities: {
            toolCalling: this.config.enableToolCalling,
            imageInput,
          },
        };

        this.log(
          'debug',
          `Model ${model.id}: context=${contextWindow}, maxInput=${maxInputTokens}, maxOutput=${maxOutputTokens}`
        );
        return modelInfo;
      });

      // Update cache
      this.cachedModels = models;
      this.modelCacheTimestamp = now;

      const visionCount = models.filter(m => m.capabilities?.imageInput).length;
      this.log(
        'info',
        `Found ${models.length} models (${visionCount} with image input): ${models.map(m => `${m.id}[${m.maxInputTokens}+${m.maxOutputTokens}]`).join(', ')}`
      );
      return models;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log('error', `Failed to fetch models: ${errorMessage}`);
      if (!options.silent) {
        vscode.window.showErrorMessage(
          `Local Model Provider: Failed to fetch models. ${errorMessage}`,
          'Open Settings'
        ).then((selection: string | undefined) => {
          if (selection === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'local.model.provider');
          }
        });
      }

      return [];
    }
  }

  /**
   * Determine whether a model accepts image input, using layered detection:
   * 1. User override via the `visionModels` setting (exact id match) — wins.
   * 2. Ollama native /api/tags capabilities ("vision").
   * 3. Opportunistic non-standard fields on the OpenAI model object
   *    (e.g. architecture.input_modalities containing "image").
   * 4. Model-id heuristic for common vision families.
   */
  private detectVision(
    modelId: string,
    model: { capabilities?: string[]; architecture?: { input_modalities?: string[] } },
    ollamaCaps: OllamaModelCapabilities,
    overrides: string[]
  ): boolean {
    // 1. Explicit user override (case-insensitive exact match)
    const normalizedId = modelId.toLowerCase();
    if (overrides.length > 0) {
      const matched = overrides.some((o) => o.trim().toLowerCase() === normalizedId);
      if (matched) {
        return true;
      }
    }

    // 2. Ollama native capabilities. Ollama names may be tagged ("llava:7b")
    // while OpenAI-style ids are often bare ("llava"), so try exact,
    // slash-stripped, and tag-stripped matches.
    const baseName = modelId.replace(/^.*\//, '');
    const candidates = [ollamaCaps[modelId], ollamaCaps[baseName]];
    if (!candidates.some((c) => Array.isArray(c))) {
      for (const key of Object.keys(ollamaCaps)) {
        const keyBase = key.split(':')[0];
        if (keyBase === baseName || baseName.startsWith(keyBase + ':')) {
          candidates.push(ollamaCaps[key]);
          break;
        }
      }
    }
    const ollamaCapabilities = candidates.find((c) => Array.isArray(c));
    if (ollamaCapabilities) {
      return ollamaCapabilities.includes('vision');
    }

    // 3. Opportunistic fields on the model object from /v1/models
    if (model.capabilities?.includes('vision')) {
      return true;
    }
    const modalities = model.architecture?.input_modalities ?? [];
    if (modalities.includes('image') || modalities.includes('img')) {
      return true;
    }

    // 4. Heuristic on the model id for well-known vision families
    const heuristicPatterns = [
      /-vl[-_.]/i,        // Qwen2-VL, llama-3.2-vision... (also matches "vl" suffix via next)
      /-vl$/i,
      /\bvision\b/i,
      /llava/i,
      /minicpm.?v/i,
      /gemma3/i,          // Gemma 3 is multimodal by default
      /pixtral/i,
      /moondream/i,
      /bakllava/i,
      /internvl/i,
      /phi-?3.*vision/i,
      /-v[0-9]/i,         // e.g. "smolvlm", less reliable but low risk
    ];
    return heuristicPatterns.some((re) => re.test(normalizedId));
  }

  /**
   * Process a message part using duck-typing for older VS Code versions
   */
  private processPartDuckTyped(
    part: unknown,
    toolResults: Record<string, unknown>[],
    toolCalls: Record<string, unknown>[]
  ): void {
    const anyPart = part as Record<string, unknown>;
    if ('callId' in anyPart && 'content' in anyPart && !('name' in anyPart)) {
      this.outputChannel.appendLine(`  Found tool result (duck-typed): callId=${anyPart.callId}`);
      const content = typeof anyPart.content === 'string' ? anyPart.content : JSON.stringify(anyPart.content);
      toolResults.push({
        tool_call_id: anyPart.callId,
        role: 'tool',
        content: this.config.qwenToolLoopCompat
          ? `${content}\n\nTool execution completed. Continue from the preserved reasoning, then provide a concise final response in normal assistant content. Do not emit another tool call unless the result is insufficient.`
          : content,
      });
    } else if ('callId' in anyPart && 'name' in anyPart && 'input' in anyPart) {
      this.outputChannel.appendLine(`  Found tool call (duck-typed): callId=${anyPart.callId}, name=${anyPart.name}`);
      toolCalls.push({
        id: anyPart.callId,
        type: 'function',
        function: { name: anyPart.name, arguments: JSON.stringify(anyPart.input) },
      });
    }
  }

  /**
   * Convert a single VS Code message to OpenAI format with logging
   */
  private convertSingleMessageWithLogging(msg: vscode.LanguageModelChatMessage): Record<string, unknown>[] {
    const role = this.mapRole(msg.role);
    const toolResults: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    const imageParts: Record<string, unknown>[] = [];
    let textContent = '';

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textContent += part.value;
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        this.outputChannel.appendLine(`  Found tool result: callId=${part.callId}`);
        toolResults.push(this.convertToolResultPart(part));
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        this.outputChannel.appendLine(`  Found tool call: callId=${part.callId}, name=${part.name}`);
        toolCalls.push(this.convertToolCallPart(part));
      } else {
        const imagePart = this.extractImageContentPart(part);
        if (imagePart) {
          this.outputChannel.appendLine('  Found image part (will be sent as image_url)');
          imageParts.push(imagePart);
        } else {
          this.processPartDuckTyped(part, toolResults, toolCalls);
        }
      }
    }

    const result: Record<string, unknown>[] = [];
    if (toolCalls.length > 0) {
      const preservedReasoning = this.config.qwenToolLoopCompat ? this.getPreservedReasoningForToolCalls(toolCalls) : '';
      const assistantContent = preservedReasoning
        ? `${preservedReasoning}${textContent ? `\n\n${textContent}` : ''}`
        : textContent || null;
      result.push({ role: 'assistant', content: assistantContent, tool_calls: toolCalls });
    } else {
      if (toolResults.length > 0) {
        result.push(...toolResults);
      }
      // Emit a multimodal content array when the message carries images,
      // otherwise fall back to plain string content as before.
      if (imageParts.length > 0 || textContent) {
        const content: unknown = imageParts.length > 0
          ? [
              ...(textContent ? [{ type: 'text', text: textContent }] : []),
              ...imageParts,
            ]
          : textContent;
        result.push({ role, content });
      }
    }
    return result;
  }

  /**
   * Return prior reasoning as tagged assistant content so Qwen can continue after tool results.
   */
  private getPreservedReasoningForToolCalls(toolCalls: Record<string, unknown>[]): string {
    const reasoning = toolCalls
      .map((toolCall) => this.toolCallReasoning.get(String(toolCall.id)))
      .find((value) => typeof value === 'string' && value.trim().length > 0);

    if (!reasoning) {
      return '';
    }

    return `<think>\n${reasoning.trim()}\n</think>`;
  }

  /**
   * Split a shared context window into VS Code's maxInputTokens + maxOutputTokens.
   *
   * VS Code displays and meters context as `maxInputTokens + maxOutputTokens`
   * (see chatModelsWidget / chatContextUsageWidget). Local servers (llama.cpp)
   * expose a single shared n_ctx, so both budgets must sum back to that value.
   *
   * Mirrors Copilot BYOK `resolveModelTokenLimits`: output is the configured
   * preference clamped to the window; input is whatever remains.
   */
  private splitContextWindow(contextWindow: number): { maxInputTokens: number; maxOutputTokens: number } {
    const windowSize = Math.max(128, contextWindow);
    const desiredOutput = Math.max(64, DEFAULT_OUTPUT_BUDGET);
    // Cap output at half the window so a large output budget cannot starve the
    // input side — e.g. a 256k output preference on a 256k model would otherwise
    // leave ~1 input token. The server's own max-output limit remains authoritative
    // for how long the model may actually generate.
    const halfWindow = Math.max(64, Math.floor(windowSize / 2));
    const maxOutputTokens = Math.min(desiredOutput, halfWindow, windowSize - 64);
    const maxInputTokens = Math.max(64, windowSize - maxOutputTokens);
    return { maxInputTokens, maxOutputTokens };
  }

  /**
   * Full shared context window for a model advertised to VS Code.
   * Recovered as maxInput + maxOutput (the BYOK/VS Code convention).
   */
  private getModelContextWindow(model: vscode.LanguageModelChatInformation): number {
    const summed = (model.maxInputTokens ?? 0) + (model.maxOutputTokens ?? 0);
    if (summed > 0) {
      return summed;
    }
    return FALLBACK_CONTEXT_WINDOW;
  }

  /**
   * Calculate safe max output tokens based on input estimate.
   *
   * The configured `defaultMaxOutputTokens` setting is gone — the upstream
   * server's own max-output limit is authoritative. We only use a built-in
   * DEFAULT_OUTPUT_BUDGET as a safety cap so a single request can never consume
   * the whole shared context window, then clamp to the space actually left for
   * output after the estimated input + a small buffer. Omitting `max_tokens`
   * entirely lets the server pick its own ceiling.
   */
  private calculateSafeMaxOutputTokens(
    estimatedInputTokens: number,
    toolsOverhead: number,
    modelMaxContext: number
  ): number {
    const totalEstimatedTokens = estimatedInputTokens + toolsOverhead;
    const conservativeInputEstimate = Math.ceil(totalEstimatedTokens * 1.2);
    const bufferTokens = 256;
    const budgetCap = DEFAULT_OUTPUT_BUDGET;

    const safeMaxOutputTokens = Math.min(
      budgetCap,
      Math.floor(modelMaxContext - conservativeInputEstimate - bufferTokens)
    );

    return Math.max(64, safeMaxOutputTokens);
  }

  /**
   * Build tools configuration for request
   */
  private buildToolsConfig(options: vscode.ProvideLanguageModelChatResponseOptions): Record<string, unknown>[] | undefined {
    if (!this.config.enableToolCalling || !options.tools || options.tools.length === 0) {
      return undefined;
    }

    this.currentToolSchemas.clear();

    return options.tools.map((tool) => {
      this.outputChannel.appendLine(`Tool: ${tool.name}`);
      this.outputChannel.appendLine(`  Description: ${tool.description?.substring(0, 100) || 'none'}...`);

      const schema = tool.inputSchema as Record<string, unknown> | undefined;
      this.currentToolSchemas.set(tool.name, schema);

      if (schema?.required && Array.isArray(schema.required)) {
        this.outputChannel.appendLine(`  Required properties: ${(schema.required as string[]).join(', ')}`);
      }

      return {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      };
    });
  }

  /**
   * Process a single tool call from the stream
   */
  private processToolCall(
    toolCall: { id: string; name: string; arguments: string },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    reasoningContent = ''
  ): void {
    this.outputChannel.appendLine(`\n=== TOOL CALL RECEIVED ===`);
    this.outputChannel.appendLine(`  ID: ${toolCall.id}`);
    this.outputChannel.appendLine(`  Name: ${toolCall.name}`);
    this.outputChannel.appendLine(`  Raw arguments: ${toolCall.arguments.substring(0, 1000)}${toolCall.arguments.length > 1000 ? '...' : ''}`);

    let args = this.tryRepairJson(toolCall.arguments) as Record<string, unknown> | null;

    if (args === null) {
      this.outputChannel.appendLine(`  ERROR: Failed to parse tool call arguments`);
      this.outputChannel.appendLine(`  Full arguments: ${toolCall.arguments}`);
      args = {};
    } else {
      const argKeys = Object.keys(args);
      this.outputChannel.appendLine(`  Parsed argument keys: ${argKeys.length > 0 ? argKeys.join(', ') : '(none)'}`);
    }

    const toolSchema = this.currentToolSchemas.get(toolCall.name) as Record<string, unknown> | undefined;
    if (toolSchema) {
      args = this.fillMissingRequiredProperties(args, toolCall.name, toolSchema);
    }

    if (this.config.qwenToolLoopCompat && reasoningContent.trim()) {
      this.toolCallReasoning.set(toolCall.id, reasoningContent.trim());
      this.outputChannel.appendLine(`  Preserved ${reasoningContent.length} reasoning characters for tool follow-up`);
    }

    this.outputChannel.appendLine(`=== END TOOL CALL ===\n`);
    progress.report(new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.name, args));
  }

  /**
   * Parse Qwen XML-style tool calls that may stream as content or reasoning
   * instead of OpenAI-compatible tool_calls.
   */
  private extractXmlToolCalls(text: string): { text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> } {
    return parseQwenXmlToolCalls(text);
  }

  private appendXmlToolBuffer(buffer: string, chunk: string): { buffer: string; buffering: boolean } {
    const nextBuffer = buffer + chunk;
    const lastOpenTag = nextBuffer.lastIndexOf('<tool_call');
    const lastCloseTag = nextBuffer.lastIndexOf('</tool_call>');
    return {
      buffer: nextBuffer,
      buffering: lastOpenTag > lastCloseTag,
    };
  }

  /**
   * Handle empty response from model
   */
  private async handleEmptyResponse(
    model: vscode.LanguageModelChatInformation,
    inputText: string,
    messageCount: number,
    toolCount: number,
    token: vscode.CancellationToken,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): Promise<void> {
    const inputTokenCount = await this.provideTokenCount(model, inputText, token);
    const modelMaxContext = this.getModelContextWindow(model);

    this.log('warn', ` Model returned empty response with no tool calls.`);
    this.outputChannel.appendLine(`  Input tokens estimated: ${inputTokenCount}`);
    this.outputChannel.appendLine(`  Messages in conversation: ${messageCount}`);
    this.outputChannel.appendLine(`  Tools provided: ${toolCount}`);

    const errorHint = toolCount > 0
      ? `The model returned an empty response. This typically indicates the model failed to generate valid output with tool calling enabled. Check the inference server logs for errors.`
      : `The model returned an empty response. Check the inference server logs for details.`;

    this.outputChannel.appendLine(`  Issue: ${errorHint}`);

    const errorMessage = `I was unable to generate a response. ${errorHint}\n\n` +
      `Diagnostic info:\n- Model: ${model.id}\n- Tools provided: ${toolCount}\n` +
      `- Estimated input tokens: ${inputTokenCount}\n- Context limit: ${modelMaxContext}\n\n` +
      `Check the "Local Model Provider" output panel for detailed logs.`;

    progress.report(new vscode.LanguageModelTextPart(errorMessage));
  }

  /**
   * Extract the final answer from a reasoning stream when a server emits it
   * inside `reasoning_content` (common with Ollama + thinking models). The
   * answer is whatever follows the last closing thinking tag.
   */
  private extractAnswerFromReasoning(reasoning: string): string {
    const markers = ['</thinking>', '</think>'];
    let answerStart = -1;
    for (const marker of markers) {
      const idx = reasoning.lastIndexOf(marker);
      if (idx > answerStart) {
        answerStart = idx + marker.length;
      }
    }
    if (answerStart <= 0) {
      return '';
    }
    return reasoning.slice(answerStart).trim();
  }

  /**
   * Qwen can return only reasoning after a tool result. Do one no-tools
   * finalization pass so VS Code receives normal assistant content.
   */
  private async retryQwenFinalAnswer(
    baseRequestOptions: Record<string, unknown>,
    messages: Record<string, unknown>[],
    reasoningContent: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<boolean> {
    const finalMessages = [...messages];
    if (reasoningContent.trim()) {
      finalMessages.push({
        role: 'assistant',
        content: `<think>\n${reasoningContent.trim()}\n</think>`,
      });
    }
    finalMessages.push({
      role: 'user',
      content: 'Tool execution is complete. Return the final answer now in normal assistant content. Do not call tools. Do not output XML tool_call tags.',
    });

    const retryOptions: Record<string, unknown> = {
      ...baseRequestOptions,
      messages: finalMessages,
      max_tokens: Math.min(Number(baseRequestOptions.max_tokens) || DEFAULT_OUTPUT_BUDGET, DEFAULT_OUTPUT_BUDGET),
    };
    delete retryOptions.tools;
    delete retryOptions.tool_choice;
    delete retryOptions.parallel_tool_calls;

    let contentLength = 0;
    let retryReasoningLength = 0;
    this.log('info', 'Qwen tool-loop compatibility: running final-answer retry without tools.');

    for await (const chunk of this.client.streamChatCompletion(retryOptions as unknown as OpenAIChatCompletionRequest, token)) {
      if (token.isCancellationRequested) {
        break;
      }
      if (chunk.reasoning_content) {
        retryReasoningLength += chunk.reasoning_content.length;
      }
      if (chunk.content) {
        contentLength += chunk.content.length;
        progress.report(new vscode.LanguageModelTextPart(chunk.content));
      }
    }

    this.log('info', `Qwen final-answer retry produced ${contentLength} content characters, ${retryReasoningLength} reasoning characters.`);
    return contentLength > 0;
  }

  /**
   * Handle chat request error
   */
  private handleChatError(error: unknown): never {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // A user-initiated cancellation is not an error: the request was aborted
    // (TCP connection torn down) so the upstream server stops generating.
    // Swallow it silently — no notification, no error log.
    if (errorMessage.toLowerCase().includes('cancelled')) {
      this.log('info', 'Chat request cancelled by user.');
      throw error;
    }

    const errorStack = error instanceof Error ? error.stack : '';

    this.log('error', ` Chat request failed: ${errorMessage}`);
    if (errorStack) {
      this.outputChannel.appendLine(`Stack trace: ${errorStack}`);
    }

    const isToolError = errorMessage.includes('HarmonyError') || errorMessage.includes('unexpected tokens');

    if (isToolError) {
      this.outputChannel.appendLine('HINT: This appears to be a tool calling format error.');
      this.outputChannel.appendLine('The model may not support function calling properly.');
      this.outputChannel.appendLine('Try: 1) Using a different model, 2) Disabling tool calling in settings, or 3) Checking inference server logs');

      vscode.window.showErrorMessage(
        `Local Model Provider: Model failed to generate valid tool calls. This model may not support function calling. Check Output panel for details.`,
        'Open Output', 'Disable Tool Calling'
      ).then((selection: string | undefined) => {
        if (selection === 'Open Output') {
          this.outputChannel.show();
        } else if (selection === 'Disable Tool Calling') {
          vscode.workspace.getConfiguration('local.model.provider').update('enableToolCalling', false, vscode.ConfigurationTarget.Global);
        }
      });
    } else {
      vscode.window.showErrorMessage(`Local Model Provider: Chat request failed. ${errorMessage}`);
    }

    throw error;
  }

  /**
   * Provide language model chat response - streams responses from inference server
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    // Ensure API key (and other async init) has completed before first request
    try {
      await this.initializationPromise;
    } catch {
      // Continue; errors will be handled by request path
    }
    this.log('debug', `API key configured: ${this.config.apiKey ? 'yes' : 'no'}`);
    this.log('info', `Sending chat request to model: ${model.id}`);
    this.log('debug', `Tool mode: ${options.toolMode}, Tools: ${options.tools?.length || 0}`);
    this.log('debug', `Message count: ${messages.length}`);

    this.showWelcomeNotification(model.id);

    // Convert messages
    const openAIMessages: Record<string, unknown>[] = [];
    for (const msg of messages) {
      openAIMessages.push(...this.convertSingleMessageWithLogging(msg));
    }
    this.log('debug', `Converted to ${openAIMessages.length} OpenAI messages`);

    // Log message structure
    for (let i = 0; i < openAIMessages.length; i++) {
      const msg = openAIMessages[i];
      const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : 'none';
      this.log('debug', `  Message ${i + 1}: role=${msg.role}, hasContent=${!!msg.content}, hasToolCalls=${!!msg.tool_calls}, toolCallId=${toolCallId}`);
    }

    // Calculate token limits; avoid premature truncation by checking a real estimate first.
    // Full shared context = maxInputTokens + maxOutputTokens (VS Code/BYOK convention).
    // Do NOT use maxInputTokens alone — that is only the input half of the split window.
    const modelMaxContext = this.getModelContextWindow(model);
    // Removed the configurable `defaultMaxOutputTokens` setting: the server's own
    // limit governs generation length. We only reserve a conservative share of
    // the context window (capped at half) for output so truncation has room.
    const desiredOutputTokens = Math.min(
      model.maxOutputTokens || DEFAULT_OUTPUT_BUDGET,
      Math.floor(modelMaxContext / 2)
    );
    const toolsTokenEstimate = options.tools ? Math.ceil(JSON.stringify(options.tools).length / 4 * 1.2) : 0;
    const reservedForInput = modelMaxContext - desiredOutputTokens - toolsTokenEstimate - 256;

    // Build input text for an initial token estimate using ALL messages.
    // Image parts are normalized to a fixed placeholder so base64 payloads
    // do not distort the character-based estimate (see extractEstimableText).
    const fullInputText = openAIMessages
      .map((m) => this.extractEstimableText(m))
      .join('\n');

    const initialInputTokens = await this.provideTokenCount(model, fullInputText, token);

    // Only truncate when the combined estimate truly exceeds the available context
    let truncatedMessages = openAIMessages;
    if (initialInputTokens > reservedForInput) {
      const maxInputTokens = reservedForInput;
      truncatedMessages = this.truncateMessagesToFit(openAIMessages, maxInputTokens);
      if (truncatedMessages.length < openAIMessages.length) {
        this.log('warn', `Truncated conversation from ${openAIMessages.length} to ${truncatedMessages.length} messages to fit context limit`);
      }
    }

    // Build input text for token estimation (final set used in request)
    const inputText = truncatedMessages
      .map((m) => {
        let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        if (m.tool_calls) { text += JSON.stringify(m.tool_calls); }
        return text;
      })
      .join('\n');

    const toolsOverhead = options.tools ? Math.ceil(JSON.stringify(options.tools).length / 4) : 0;
    const estimatedInputTokens = await this.provideTokenCount(model, inputText, token);
    const safeMaxOutputTokens = this.calculateSafeMaxOutputTokens(
      estimatedInputTokens,
      toolsOverhead,
      modelMaxContext
    );

    this.log('debug',
      `Token estimate: input=${estimatedInputTokens}, tools=${toolsOverhead}, model_context=${modelMaxContext}, chosen_max_tokens=${safeMaxOutputTokens}`
    );

    // Build request. Sampling parameters (temperature, top_p, frequency/presence
    // penalties) are intentionally NOT sent so the upstream server's own defaults
    // apply (llama.cpp, vLLM, LM Studio, Ollama, ...).
    const requestOptions: Record<string, unknown> = {
      model: model.id,
      messages: truncatedMessages,
      max_tokens: safeMaxOutputTokens,
    };

    const toolsConfig = this.buildToolsConfig(options);
    if (toolsConfig) {
      requestOptions.tools = toolsConfig;
      if (options.toolMode !== undefined) {
        requestOptions.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
      }
      // Only send parallel_tool_calls when explicitly enabled — some servers
      // (e.g. LM Studio) reject requests containing unknown fields
      if (this.config.parallelToolCalling) {
        requestOptions.parallel_tool_calls = true;
      }
      this.log('info', `Sending ${toolsConfig.length} tools to model (parallel: ${this.config.parallelToolCalling})`);
    }

    if (options.modelOptions) {
      Object.assign(requestOptions, options.modelOptions);
    }

    // Log request
    const debugRequest = JSON.stringify(requestOptions, null, 2);
    this.log('debug', debugRequest.length > 2000 ? `Request (truncated): ${debugRequest.substring(0, 2000)}...` : `Request: ${debugRequest}`);

    // Track timing for statistics
    const requestStartTime = Date.now();

    try {
      let totalContent = '';
      let totalReasoningContent = '';
      let xmlToolBuffer = '';
      let bufferingXmlToolCall = false;
      let totalToolCalls = 0;
      let lastFinishReason: string | undefined;
      let lastUsage: OpenAIUsage | undefined;

      for await (const chunk of this.client.streamChatCompletion(requestOptions as unknown as OpenAIChatCompletionRequest, token)) {
        if (token.isCancellationRequested) { break; }

        if (chunk.finish_reason) {
          lastFinishReason = chunk.finish_reason;
        }

        // Servers with stream_options.include_usage send the final usage object
        // in a trailing chunk (often with an empty choices array).
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }

        // Handle reasoning/thinking content from the model
        if (chunk.reasoning_content) {
          totalReasoningContent += chunk.reasoning_content;
          if (this.config.qwenToolLoopCompat && (chunk.reasoning_content.includes('<tool_call') || bufferingXmlToolCall)) {
            const buffered = this.appendXmlToolBuffer(xmlToolBuffer, chunk.reasoning_content);
            xmlToolBuffer = buffered.buffer;
            bufferingXmlToolCall = buffered.buffering;
          } else if (!this.config.qwenToolLoopCompat && typeof (vscode as any).LanguageModelThinkingPart !== 'undefined') {
            progress.report(new (vscode as any).LanguageModelThinkingPart(chunk.reasoning_content));
          } else if (!this.config.qwenToolLoopCompat) {
            // Fallback: wrap reasoning in <think> tags for visibility
            progress.report(new vscode.LanguageModelTextPart(chunk.reasoning_content));
          }
        }

        if (chunk.content) {
          totalContent += chunk.content;
          if (this.config.qwenToolLoopCompat && bufferingXmlToolCall) {
            const buffered = this.appendXmlToolBuffer(xmlToolBuffer, chunk.content);
            xmlToolBuffer = buffered.buffer;
            bufferingXmlToolCall = buffered.buffering;
          } else if (this.config.qwenToolLoopCompat) {
            const toolStart = chunk.content.indexOf('<tool_call');
            if (toolStart === -1) {
              progress.report(new vscode.LanguageModelTextPart(chunk.content));
            } else {
              const visiblePrefix = chunk.content.slice(0, toolStart);
              if (visiblePrefix) {
                progress.report(new vscode.LanguageModelTextPart(visiblePrefix));
              }
              const buffered = this.appendXmlToolBuffer(xmlToolBuffer, chunk.content.slice(toolStart));
              xmlToolBuffer = buffered.buffer;
              bufferingXmlToolCall = buffered.buffering;
            }
          } else {
            progress.report(new vscode.LanguageModelTextPart(chunk.content));
          }
        }

        if (chunk.finished_tool_calls?.length) {
          for (const toolCall of chunk.finished_tool_calls) {
            totalToolCalls++;
            this.processToolCall(toolCall, progress, totalReasoningContent);
          }
        }
      }

      if (this.config.qwenToolLoopCompat) {
        const parsedXml = this.extractXmlToolCalls(xmlToolBuffer);
        for (const toolCall of parsedXml.toolCalls) {
          totalToolCalls++;
          this.outputChannel.appendLine('Converted Qwen XML tool call from streamed text/reasoning.');
          this.processToolCall(toolCall, progress, totalReasoningContent);
        }
        if (parsedXml.text) {
          progress.report(new vscode.LanguageModelTextPart(parsedXml.text));
        }
      }

      this.outputChannel.appendLine(`Completed chat request, received ${totalContent.length} characters, ${totalReasoningContent.length} reasoning characters, ${totalToolCalls} tool calls`);

      // Report server-reported token usage to VS Code so the chat context-window
      // meter (and conversation compaction) tracks REAL token counts. VS Code
      // consumes a data part with mimeType 'usage' whose payload is an
      // OpenAI-shaped usage object — the same mechanism its built-in BYOK
      // providers use. Duck-typed for older runtimes without LanguageModelDataPart.
      if (lastUsage && typeof (vscode as any).LanguageModelDataPart !== 'undefined') {
        const usageJson = JSON.stringify(lastUsage);
        progress.report(new (vscode as any).LanguageModelDataPart(
          new TextEncoder().encode(usageJson),
          'usage',
        ));
        this.log('info', `Reported token usage to VS Code: prompt=${lastUsage.prompt_tokens}, completion=${lastUsage.completion_tokens}, total=${lastUsage.total_tokens}`);
      }

      // Record statistics — prefer the server's real counts over estimates
      const responseTimeMs = Date.now() - requestStartTime;
      const outputTokens = lastUsage
        ? lastUsage.completion_tokens
        : Math.ceil((totalContent.length + totalReasoningContent.length) / 4);
      if (this.statsManager) {
        this.statsManager.recordRequest({
          modelId: model.id,
          inputTokens: lastUsage ? lastUsage.prompt_tokens : estimatedInputTokens,
          outputTokens,
          responseTimeMs,
        });
      }
      this.log('info', `Response time: ${responseTimeMs}ms, Input tokens: ${lastUsage ? lastUsage.prompt_tokens : `~${estimatedInputTokens}`}, Output tokens: ${lastUsage ? outputTokens : `~${outputTokens}`}`);

      if (totalContent.length === 0 && totalToolCalls === 0) {
        if (totalReasoningContent.length > 0) {
          // Some servers (notably Ollama with certain thinking models) emit the
          // final answer inside the reasoning stream, after the closing
          // thinking tag. Salvage it instead of surfacing an error.
          const salvaged = this.extractAnswerFromReasoning(totalReasoningContent);
          if (salvaged) {
            this.log('info', `Salvaged ${salvaged.length} characters of final answer from the reasoning stream.`);
            progress.report(new vscode.LanguageModelTextPart(salvaged));
            return;
          }

          const hasToolResults = openAIMessages.some((message) => message.role === 'tool');
          if (this.config.finalAnswerRetry || (hasToolResults && this.config.qwenToolLoopCompat && this.config.qwenFinalAnswerRetry)) {
            const retried = await this.retryQwenFinalAnswer(requestOptions, truncatedMessages, totalReasoningContent, progress, token);
            if (retried) {
              return;
            }
          }

          const finishHint = lastFinishReason === 'length'
            ? ' Generation stopped at the maximum output token limit — thinking models spend the whole budget reasoning before answering. Increase "Local Model Provider: Default Max Output Tokens" and try again.'
            : '';
          const message = hasToolResults
            ? 'The tool call completed, but the model produced reasoning without a final summary. Check the tool result above for the completed action.'
            : xmlToolBuffer.includes('<tool_call')
              ? 'The model started a tool call in its reasoning stream but did not complete a structured tool call before generation stopped. Try again with a narrower request, or reduce the reasoning budget if this keeps happening.'
              : `The model produced reasoning but no final answer or tool call. Try again with a narrower request, or reduce the reasoning budget if this keeps happening.${finishHint}`;
          this.log('warn', `Model returned reasoning-only response (${totalReasoningContent.length} reasoning characters, finish_reason=${lastFinishReason ?? 'unknown'}).`);
          progress.report(new vscode.LanguageModelTextPart(message));
        } else {
          await this.handleEmptyResponse(model, inputText, openAIMessages.length, requestOptions.tools ? (requestOptions.tools as unknown[]).length : 0, token, progress);
        }
      }
    } catch (error) {
      this.handleChatError(error);
    }
  }

  /**
   * Provide token count estimation
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    // Simple approximation: ~4 characters per token
    // This is a rough estimate; for more accuracy, could use tiktoken library
    let content: string;

    let imageTokens = 0;
    if (typeof text === 'string') {
      content = text;
    } else {
      // Extract text parts and account for image parts with a fixed budget so
      // vision requests are not under-estimated (base64 is not counted).
      content = text.content
        .map((part) => {
          if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
          }
          if (this.extractImageContentPart(part)) {
            imageTokens += GatewayProvider.ESTIMATED_IMAGE_TOKENS;
          }
          return '';
        })
        .join('');
    }

    const estimatedTokens = Math.ceil(content.length / 4);
    return estimatedTokens + imageTokens;
  }

  /**
   * Show a timed notification with a link to settings (once per session)
   */
  private showWelcomeNotification(modelId: string): void {
    if (this.hasShownWelcomeNotification) {
      return;
    }
    this.hasShownWelcomeNotification = true;

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Local Model Provider: ${modelId}  —  [Settings](command:workbench.action.openSettings?%22local.model.provider%22)`,
        cancellable: false,
      },
      () => new Promise((resolve) => setTimeout(resolve, 3000))
    );
  }

  /**
   * Load configuration from VS Code settings
   */
  private loadConfig(): GatewayConfig {
    const config = vscode.workspace.getConfiguration('local.model.provider');

    // Normalize server URL (strip trailing /v1 to avoid double path like /v1/v1)
    let serverUrlRaw = config.get<string>('serverUrl', 'http://localhost:8000');
    if (/\/v1\/?$/.test(serverUrlRaw)) {
      serverUrlRaw = serverUrlRaw.replace(/\/v1\/?$/, '');
      this.outputChannel.appendLine('NOTE: Stripped trailing /v1 from serverUrl setting to avoid duplicated path.');
    }

    const cfg: GatewayConfig = {
      serverUrl: serverUrlRaw,
      apiKey: '', // Loaded from SecretStorage via initializeApiKey()
      requestTimeout: config.get<number>('requestTimeout', 60000),
      enableToolCalling: config.get<boolean>('enableToolCalling', true),
      parallelToolCalling: config.get<boolean>('parallelToolCalling', true),
      qwenToolLoopCompat: config.get<boolean>('qwenToolLoopCompat', false),
      qwenFinalAnswerRetry: config.get<boolean>('qwenFinalAnswerRetry', true),
      finalAnswerRetry: config.get<boolean>('finalAnswerRetry', true),
      includeUsageInStream: config.get<boolean>('includeUsageInStream', true),
      maxRetries: config.get<number>('maxRetries', 3),
      retryDelayMs: config.get<number>('retryDelayMs', 1000),
      modelCacheTtlMs: config.get<number>('modelCacheTtlMs', 300000),
      logLevel: config.get<'debug' | 'info' | 'warn' | 'error'>('logLevel', 'info'),
      visionModels: config.get<string[]>('visionModels', []),
    };

    // Validate requestTimeout
    if (cfg.requestTimeout <= 0) {
      this.log('error', ` requestTimeout must be > 0; using default 60000`);
      cfg.requestTimeout = 60000;
    }

    // Validate serverUrl format
    try {
      new URL(cfg.serverUrl);
    } catch {
      this.log('error', ` Invalid server URL: ${cfg.serverUrl}`);
      throw new Error(`Invalid server URL: ${cfg.serverUrl}`);
    }

    return cfg;
  }

  /**
   * Reload configuration and update client
   */
  private reloadConfig(): void {
    this.config = this.loadConfig();
    this.client.updateConfig(this.config);
    this.outputChannel.appendLine('Configuration reloaded');
  }
}
