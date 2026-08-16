/**
 * Type definitions for OpenAI-compatible API responses
 */

export interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  // Non-standard fields exposed by some servers (e.g. Ollama, LM Studio)
  capabilities?: string[];
  architecture?: { input_modalities?: string[] };
}

/**
 * Per-model capability info from Ollama's native /api/tags endpoint
 */
export interface OllamaModelCapabilities {
  [modelId: string]: string[];
}

export interface OpenAIModelsResponse {
  object: string;
  data: OpenAIModel[];
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream?: boolean;
  // NOTE: sampling parameters (temperature, top_p, frequency/presence penalties)
  // are intentionally NOT sent — the upstream server's own defaults are used.
  // Requests the server to include a usage object in the final streamed chunk
  stream_options?: { include_usage?: boolean };
}

/**
 * Token usage statistics reported by servers that support
 * `stream_options.include_usage` (OpenAI, llama.cpp, vLLM, ...).
 */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GatewayConfig {
  serverUrl: string;
  apiKey?: string;
  requestTimeout: number;
  defaultMaxTokens: number;
  defaultMaxOutputTokens: number;
  enableToolCalling: boolean;
  parallelToolCalling: boolean;
  qwenToolLoopCompat: boolean;
  qwenFinalAnswerRetry: boolean;
  finalAnswerRetry: boolean;
  includeUsageInStream: boolean;
  maxRetries: number;
  retryDelayMs: number;
  modelCacheTtlMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  // Model ids (case-insensitive) that should be advertised as supporting image input
  visionModels: string[];
}
