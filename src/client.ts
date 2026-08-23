import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  OpenAIChatCompletionRequest,
  OpenAIModel,
  OpenAIModelsResponse,
  OpenAIUsage,
  OllamaModelCapabilities,
  GatewayConfig
} from './types';

/**
 * Retry configuration for failed requests
 */
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatusCodes: number[];
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

/**
 * Error class for Gateway-specific errors
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly isRetryable: boolean = false,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * Accumulated tool call during streaming
 */
interface StreamingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * State for tracking tool calls during streaming
 */
interface ToolCallState {
  toolCallsByIndex: Map<number, StreamingToolCall>;
  finalizedIndices: Set<number>;
  requestId: string;
  toolCallCounter: number;
}

/**
 * Parsed SSE chunk data
 */
interface ParsedChunk {
  delta?: {
    content?: string;
    // Reasoning/thinking content fields (various API formats)
    reasoning_content?: string;  // OpenAI o1/o3 format
    reasoning?: string;          // Alternative format
    thinking?: string;           // Anthropic format
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
    function_call?: { name?: string; arguments?: string };
  };
  message?: {
    content?: string;
    // Reasoning/thinking content fields (various API formats)
    reasoning_content?: string;
    reasoning?: string;
    thinking?: string;
    text?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
    function_call?: { name?: string; arguments?: string };
  };
  finishReason?: string;
  id?: string;
  // Token usage reported by servers that support stream_options.include_usage.
  // Note: this chunk typically arrives with an EMPTY choices array, so it must
  // be captured independently of delta/message.
  usage?: OpenAIUsage;
}

/**
 * HTTP client for OpenAI-compatible inference servers
 */
export class GatewayClient {
  private config: GatewayConfig;
  private retryConfig: RetryConfig;

  constructor(config: GatewayConfig, retryConfig?: Partial<RetryConfig>) {
    this.config = config;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * Update client configuration
   */
  public updateConfig(config: GatewayConfig): void {
    this.config = config;
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateBackoffDelay(attempt: number): number {
    const exponentialDelay = this.retryConfig.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay; // 30% jitter
    return Math.min(exponentialDelay + jitter, this.retryConfig.maxDelayMs);
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: unknown, statusCode?: number): boolean {
    if (statusCode && this.retryConfig.retryableStatusCodes.includes(statusCode)) {
      return true;
    }
    // Node's fetch surfaces connection failures as `TypeError: fetch failed`
    // with the real error (ECONNREFUSED, timeout, ECONNRESET) nested in the
    // `cause` property. Walk the cause chain and also check `error.code` so a
    // stopped local server is retried instead of failing instantly.
    let current: unknown = error;
    while (current instanceof Error) {
      const message = current.message.toLowerCase();
      const code = (current as { code?: string }).code?.toLowerCase() ?? '';
      if (message.includes('timeout') || message.includes('econnreset') ||
          message.includes('econnrefused') || message.includes('network') ||
          message.includes('abort') || code === 'econnrefused' ||
          code === 'econnreset' || code === 'etimedout' || code === 'aborted') {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Sleep that resolves early (false) if the caller cancels, so a retry
   * backoff does not keep waiting on an abandoned request.
   */
  private sleepCancellable(ms: number, cancellationToken?: vscode.CancellationToken): Promise<boolean> {
    return new Promise((resolve) => {
      if (cancellationToken?.isCancellationRequested) {
        resolve(false);
        return;
      }
      let disposable: vscode.Disposable | undefined;
      const timer = setTimeout(() => {
        disposable?.dispose();
        resolve(true);
      }, ms);
      disposable = cancellationToken?.onCancellationRequested(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /**
   * Fetch with retry logic.
   *
   * When a cancellationToken is provided, cancellation aborts the in-flight
   * request immediately (tearing down the TCP connection so the upstream server
   * stops generating) and also short-circuits any retry backoff.
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    operation: string,
    cancellationToken?: vscode.CancellationToken
  ): Promise<Response> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      if (cancellationToken?.isCancellationRequested) {
        throw new GatewayError(`${operation} cancelled`, undefined, false);
      }

      try {
        const response = await this.fetch(url, options, cancellationToken);
        
        if (!response.ok && this.isRetryableError(null, response.status)) {
          if (attempt < this.retryConfig.maxRetries) {
            const delay = this.calculateBackoffDelay(attempt);
            console.log(`[LLM Gateway] ${operation} failed with status ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${this.retryConfig.maxRetries})`);
            const waited = await this.sleepCancellable(delay, cancellationToken);
            if (!waited) {
              throw new GatewayError(`${operation} cancelled`, undefined, false);
            }
            continue;
          }
        }
        
        return response;
      } catch (error) {
        // A user cancellation aborts the fetch; surface it as a clean cancellation
        // rather than a retryable network error.
        if (cancellationToken?.isCancellationRequested) {
          throw new GatewayError(`${operation} cancelled`, undefined, false);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (this.isRetryableError(error) && attempt < this.retryConfig.maxRetries) {
          const delay = this.calculateBackoffDelay(attempt);
          console.log(`[LLM Gateway] ${operation} failed with error: ${lastError.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${this.retryConfig.maxRetries})`);
          const waited = await this.sleepCancellable(delay, cancellationToken);
          if (!waited) {
            throw new GatewayError(`${operation} cancelled`, undefined, false);
          }
          continue;
        }
        
        throw new GatewayError(
          `${operation} failed after ${attempt + 1} attempts: ${lastError.message}`,
          undefined,
          false,
          lastError
        );
      }
    }
    
    throw new GatewayError(
      `${operation} failed after ${this.retryConfig.maxRetries + 1} attempts`,
      undefined,
      false,
      lastError
    );
  }

  /**
   * Fetch available models from /v1/models endpoint
   */
  public async fetchModels(): Promise<OpenAIModelsResponse> {
    const url = `${this.config.serverUrl}/v1/models`;

    try {
      const response = await this.fetchWithRetry(url, {
        method: 'GET',
        headers: this.getHeaders(),
      }, 'Fetch models');

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new GatewayError(
          `Failed to fetch models: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
          response.status,
          this.isRetryableError(null, response.status)
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }
      if (error instanceof Error) {
        throw new GatewayError(
          `Failed to connect to inference server: ${error.message}`,
          undefined,
          this.isRetryableError(error),
          error
        );
      }
      throw error;
    }
  }

  /**
   * Extract the effective context window (in tokens) for a model from its
   * server metadata. Currently supports llama.cpp, which exposes the launch
   * args under `status.args`:
   *   - `--ctx-size <n>` sets the KV-cache context size
   *   - `--override-kv <key>=context_length=int:<n>` overrides the model's
   *     native context length (e.g. YARN scaling)
   * The override wins when present (it reflects the true usable context).
   * Returns undefined when the server does not report a context size, so the
   * caller falls back to a built-in context window.
   */
  public static extractContextLength(model: OpenAIModel): number | undefined {
    const args = model.status?.args;
    if (!Array.isArray(args) || args.length === 0) {
      return undefined;
    }

    // 1. Prefer an explicit context_length override (--override-kv ...context_length=int:<n>)
    for (const arg of args) {
      const overrideMatch = /context_length\s*=\s*int:(\d+)/i.exec(arg);
      if (overrideMatch) {
        const value = Number(overrideMatch[1]);
        if (Number.isFinite(value) && value > 0) {
          return value;
        }
      }
    }

    // 2. Fall back to --ctx-size <n>
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--ctx-size') {
        const value = Number(args[i + 1]);
        if (Number.isFinite(value) && value > 0) {
          return value;
        }
      }
    }

    return undefined;
  }

  /**
   * Fetch per-model capabilities from Ollama's native /api/tags endpoint.
   * Returns a map of model name -> capability list (e.g. ["vision", "tools"]).
   * Resolves to an empty map for non-Ollama servers or on any failure, so
   * callers can safely treat a missing entry as "unknown".
   */
  public async fetchOllamaCapabilities(): Promise<OllamaModelCapabilities> {
    const url = `${this.config.serverUrl}/api/tags`;

    try {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        return {};
      }

      const json = (await response.json()) as { models?: Array<{ name?: string; capabilities?: string[] }> };
      const result: OllamaModelCapabilities = {};
      for (const model of json.models ?? []) {
        if (model.name) {
          result[model.name] = model.capabilities ?? [];
        }
      }
      return result;
    } catch {
      // Non-Ollama servers (vLLM, LM Studio, llama.cpp, ...) do not expose
      // /api/tags — fall back to heuristic/override detection.
      return {};
    }
  }

  /**
   * Create initial tool call tracking state
   */
  private createToolCallState(): ToolCallState {
    return {
      toolCallsByIndex: new Map<number, StreamingToolCall>(),
      finalizedIndices: new Set<number>(),
      requestId: `req_${Date.now()}_${randomBytes(4).toString('hex')}`,
      toolCallCounter: 0,
    };
  }

  /**
   * Process a single streamed tool call delta
   */
  private processToolCallDelta(
    tc: { index?: number; id?: string; function?: { name?: string; arguments?: string } },
    state: ToolCallState
  ): void {
    const index = tc.index ?? state.toolCallCounter++;
    const existing = state.toolCallsByIndex.get(index);

    if (existing) {
      if (tc.id) { existing.id = tc.id; }
      if (tc.function?.name) { existing.name = tc.function.name; }
      if (tc.function?.arguments) { existing.arguments += tc.function.arguments; }
    } else {
      state.toolCallsByIndex.set(index, {
        id: tc.id || '',
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '',
      });
    }
  }

  /**
   * Process legacy function_call format
   */
  private processLegacyFunctionCall(
    functionCall: { name?: string; arguments?: string },
    parsedId: string,
    state: ToolCallState
  ): void {
    const index = 0;
    const existing = state.toolCallsByIndex.get(index);

    if (existing) {
      if (functionCall.name) { existing.name = functionCall.name; }
      if (functionCall.arguments) { existing.arguments += functionCall.arguments; }
    } else {
      state.toolCallsByIndex.set(index, {
        id: parsedId || '',
        name: functionCall.name || '',
        arguments: functionCall.arguments || '',
      });
    }
  }

  /**
   * Finalize all pending tool calls
   */
  private finalizeToolCalls(state: ToolCallState): StreamingToolCall[] {
    const finishedToolCalls: StreamingToolCall[] = [];

    for (const [index, tc] of state.toolCallsByIndex.entries()) {
      if (!state.finalizedIndices.has(index)) {
        state.finalizedIndices.add(index);
        if (!tc.id) {
          tc.id = `call_${state.requestId}_${index}`;
        }
        finishedToolCalls.push({ ...tc });
      }
    }

    return finishedToolCalls;
  }

  /**
   * Extract reasoning content from delta or message (supports multiple API formats)
   */
  private extractReasoningContent(obj: { reasoning_content?: string; reasoning?: string; thinking?: string } | undefined): string | undefined {
    if (!obj) return undefined;
    // Check various reasoning field formats used by different APIs
    return obj.reasoning_content || obj.reasoning || obj.thinking || undefined;
  }

  /**
   * Process delta format from streaming response
   */
  private processDeltaFormat(
    parsed: ParsedChunk,
    state: ToolCallState
  ): { content: string; reasoning_content?: string; finishedToolCalls: StreamingToolCall[] } {
    const delta = parsed.delta!;
    const finishedToolCalls: StreamingToolCall[] = [];

    // Handle streamed tool_calls
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        this.processToolCallDelta(tc, state);
      }
    }

    // Handle legacy function_call format
    if (delta.function_call) {
      this.processLegacyFunctionCall(delta.function_call, parsed.id || '', state);
    }

    // Check if tool calls are complete
    if (parsed.finishReason === 'tool_calls' || parsed.finishReason === 'function_call') {
      finishedToolCalls.push(...this.finalizeToolCalls(state));
    }

    // Extract reasoning content from various API formats
    const reasoning_content = this.extractReasoningContent(delta);

    return { content: delta.content || '', reasoning_content, finishedToolCalls };
  }

  /**
   * Process non-delta (final) message format
   */
  private processMessageFormat(
    parsed: ParsedChunk,
    state: ToolCallState
  ): { content: string; reasoning_content?: string; finishedToolCalls: StreamingToolCall[] } {
    const message = parsed.message!;
    const finishedToolCalls: StreamingToolCall[] = [];

    // Handle complete tool_calls array
    if (Array.isArray(message.tool_calls)) {
      for (let i = 0; i < message.tool_calls.length; i++) {
        const tc = message.tool_calls[i];
        const index = tc.index ?? i;
        if (!state.finalizedIndices.has(index)) {
          state.finalizedIndices.add(index);
          finishedToolCalls.push({
            id: tc.id || `call_${state.requestId}_${index}`,
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '',
          });
        }
      }
    }

    // Handle legacy function_call format
    if (message.function_call && !state.finalizedIndices.has(0)) {
      state.finalizedIndices.add(0);
      finishedToolCalls.push({
        id: parsed.id || `call_${state.requestId}_0`,
        name: message.function_call.name || '',
        arguments: message.function_call.arguments || '',
      });
    }

    // Extract reasoning content from various API formats
    const reasoning_content = this.extractReasoningContent(message);

    return { content: message.content || message.text || '', reasoning_content, finishedToolCalls };
  }

  /**
   * Parse a raw SSE data string into structured chunk data
   */
  private parseSSEData(data: string): ParsedChunk | null {
    try {
      const parsed = JSON.parse(data);
      return {
        delta: parsed.choices?.[0]?.delta,
        message: parsed.choices?.[0]?.message,
        finishReason: parsed.choices?.[0]?.finish_reason,
        id: parsed.id,
        usage: parsed.usage,
      };
    } catch {
      console.error('Failed to parse SSE chunk:', data);
      return null;
    }
  }

  /**
   * Process a single SSE line and return yield data if applicable
   */
  private processSSELine(
    line: string,
    state: ToolCallState
  ): { content: string; reasoning_content?: string; tool_calls: StreamingToolCall[]; finished_tool_calls: StreamingToolCall[]; finish_reason?: string; usage?: OpenAIUsage } | null {
    const trimmed = line.trim();

    if (trimmed === '' || trimmed === 'data: [DONE]') {
      return null;
    }

    if (!trimmed.startsWith('data: ')) {
      return null;
    }

    const data = trimmed.slice(6);
    const parsed = this.parseSSEData(data);
    if (!parsed) { return null; }

    if (parsed.delta) {
      const { content, reasoning_content, finishedToolCalls } = this.processDeltaFormat(parsed, state);
      return { content, reasoning_content, tool_calls: [], finished_tool_calls: finishedToolCalls, finish_reason: parsed.finishReason, usage: parsed.usage };
    }

    if (parsed.message) {
      const { content, reasoning_content, finishedToolCalls } = this.processMessageFormat(parsed, state);
      return { content, reasoning_content, tool_calls: [], finished_tool_calls: finishedToolCalls, finish_reason: parsed.finishReason, usage: parsed.usage };
    }

    // Usage-only chunk (stream_options.include_usage): the server sends a final
    // chunk with an EMPTY `choices` array carrying the `usage` object.
    if (parsed.usage) {
      return { content: '', tool_calls: [], finished_tool_calls: [], usage: parsed.usage };
    }

    return null;
  }

  /**
   * Get remaining unfinalised tool calls
   */
  private getRemainingToolCalls(state: ToolCallState): StreamingToolCall[] {
    const remaining: StreamingToolCall[] = [];

    for (const [index, tc] of state.toolCallsByIndex.entries()) {
      if (!state.finalizedIndices.has(index) && (tc.name || tc.arguments)) {
        state.finalizedIndices.add(index);
        if (!tc.id) {
          tc.id = `call_${state.requestId}_${index}`;
        }
        remaining.push({ ...tc });
      }
    }

    return remaining;
  }

  /**
   * Stream chat completions from /v1/chat/completions endpoint
   *
   * IMPORTANT: Tool calls are tracked by INDEX during streaming, not by ID.
   * OpenAI streaming format sends tool calls incrementally with an `index` field
   * to identify which tool call is being updated. The `id` may arrive in a later chunk.
   */
  public async *streamChatCompletion(
    request: OpenAIChatCompletionRequest,
    cancellationToken: vscode.CancellationToken
  ): AsyncGenerator<{ content: string; reasoning_content?: string; tool_calls: StreamingToolCall[]; finished_tool_calls: StreamingToolCall[]; finish_reason?: string; usage?: OpenAIUsage }, void, unknown> {
    const url = `${this.config.serverUrl}/v1/chat/completions`;
    const state = this.createToolCallState();

    try {
      // Request per-response token usage (OpenAI/llama.cpp/vLLM support this via
      // stream_options; the final chunk carries a `usage` object). Disabled by
      // setting for servers that reject unknown fields.
      const body: Record<string, unknown> = { ...request, stream: true };
      if (this.config.includeUsageInStream) {
        body.stream_options = { include_usage: true };
      }

      const response = await this.fetchWithRetry(url, {
        method: 'POST',
        headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 'Chat completion', cancellationToken);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new GatewayError(
          `Chat completion failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
          response.status,
          this.isRetryableError(null, response.status)
        );
      }

      if (!response.body) {
        throw new GatewayError('Response body is null');
      }

      // Use plain TextDecoder for maximum compatibility across runtimes
      // (TextDecoderStream + pipeThrough can cause "terminated" errors in some environments)
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let receivedAnyData = false;

      while (true) {
        if (cancellationToken.isCancellationRequested) {
          await reader.cancel();
          break;
        }

        // Idle/read timeout: `requestTimeout` is only enforced by the fetch()
        // wrapper, which clears its timer once headers arrive. A server that
        // stalls AFTER the first byte would otherwise hang forever. Race each
        // read against a timer so a silent stream is aborted and surfaced as a
        // retryable error.
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await this.readWithIdleTimeout(reader, cancellationToken);
        } catch (readError) {
          // A user cancellation aborts the reader; surface it cleanly.
          if (cancellationToken.isCancellationRequested) {
            throw new GatewayError('Chat completion cancelled', undefined, false);
          }
          // If we already received data, treat stream termination as end-of-stream
          // Some servers (e.g. LM Studio) close the connection without sending [DONE]
          if (receivedAnyData && !(readError instanceof GatewayError)) {
            console.warn('[LLM Gateway] Stream read interrupted after receiving data, treating as end-of-stream:', readError);
            break;
          }
          throw readError;
        }

        const { done, value } = readResult;
        if (done) { break; }

        buffer += decoder.decode(value, { stream: true });
        receivedAnyData = true;

        // Split on \n and also handle \r\n (some servers use Windows-style line endings)
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const result = this.processSSELine(line, state);
          if (result) { yield result; }
        }
      }

      // Flush decoder
      buffer += decoder.decode();

      // Process remaining buffer content
      if (buffer.trim()) {
        const result = this.processSSELine(buffer, state);
        if (result) { yield result; }
      }

      // Finalize any remaining tool calls
      const remaining = this.getRemainingToolCalls(state);
      if (remaining.length > 0) {
        yield { content: '', tool_calls: [], finished_tool_calls: remaining };
      }
    } catch (error) {
      // A user cancellation aborts the fetch/reader; surface it as a clean
      // cancellation instead of a misleading "connection terminated" error.
      if (cancellationToken.isCancellationRequested) {
        throw new GatewayError('Chat completion cancelled', undefined, false);
      }
      if (error instanceof GatewayError) {
        throw error;
      }
      if (error instanceof Error) {
        const msg = error.message?.toLowerCase() || '';
        // Detect common connection-drop errors from various OpenAI-compatible servers
        // (LM Studio, Ollama, llama.cpp, etc.) that close the connection unexpectedly
        if (msg === 'terminated' || msg.includes('other side closed') ||
            msg.includes('aborted') || msg.includes('socket hang up') ||
            msg.includes('econnreset') || msg.includes('premature close')) {
          throw new GatewayError(
            `Chat completion request failed: connection was terminated by the server. ` +
            `This often happens when the inference server does not support certain request parameters. ` +
            `Troubleshooting: 1) Check the inference server logs for errors, ` +
            `2) Try disabling 'parallel_tool_calls' in settings, ` +
            `3) Try disabling tool calling entirely, ` +
            `4) Ensure the model is fully loaded on the server.`,
            undefined,
            false,
            error
          );
        }
        throw new GatewayError(
          `Chat completion request failed: ${error.message}`,
          undefined,
          this.isRetryableError(error),
          error
        );
      }
      throw error;
    }
  }

  /**
   * Get headers for API requests
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    if (this.config.apiKey) {
      const raw = String(this.config.apiKey).trim();
      const bearer = raw.toLowerCase().startsWith('bearer ') ? raw : `Bearer ${raw}`;
      // Standard OpenAI-compatible header
      headers['Authorization'] = bearer;
      // Common alternative used by some gateways
      headers['x-api-key'] = raw;
    }

    headers['Accept'] = 'application/json';

    return headers;
  }

  /**
   * Fetch wrapper with timeout support.
   *
   * When a cancellationToken is provided, user cancellation aborts the request
   * immediately (closing the TCP connection so the upstream server stops
   * generating an abandoned response).
   */
  private async fetch(
    url: string,
    options: RequestInit,
    cancellationToken?: vscode.CancellationToken
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeout);

    // Abort the request as soon as the user cancels, so the upstream server
    // does not keep building a response nobody will read.
    const cancelDisposable = cancellationToken?.onCancellationRequested(() => controller.abort());

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
      cancelDisposable?.dispose();
    }
  }

  /**
   * Read a chunk from a stream reader, aborting if no data arrives within
   * `requestTimeout`. Guards against servers that stall mid-stream (after the
   * response headers have already been received, so the fetch() timeout no
   * longer applies). A user cancellation aborts the reader immediately.
   */
  private async readWithIdleTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    cancellationToken: vscode.CancellationToken
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    const controller = new AbortController();
    const cancelDisposable = cancellationToken?.onCancellationRequested(() => {
      controller.abort();
      void reader.cancel();
    });

    try {
      return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          controller.abort();
          void reader.cancel();
          reject(new GatewayError(
            `Chat completion stream timed out after ${this.config.requestTimeout}ms with no data`,
            undefined,
            true
          ));
        }, this.config.requestTimeout);

        reader.read().then(
          (result) => {
            clearTimeout(timeoutId);
            resolve(result);
          },
          (err) => {
            clearTimeout(timeoutId);
            reject(err);
          }
        );
      });
    } finally {
      cancelDisposable?.dispose();
    }
  }
}
