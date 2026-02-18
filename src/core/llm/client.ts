import { logger } from '../logging/logger.js';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

export interface LlmClientConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Minimal Anthropic Messages API client using native fetch.
 * Zero external dependencies.
 */
export class LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(config?: LlmClientConfig) {
    this.apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.baseUrl = (config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.model = config?.model ?? process.env.LLM_MODEL ?? 'claude-sonnet-4-5-20250929';
    this.maxTokens = config?.maxTokens ?? parseInt(process.env.LLM_MAX_TOKENS ?? '4096', 10);
    this.timeoutMs = config?.timeoutMs ?? parseInt(process.env.LLM_TIMEOUT_MS ?? '60000', 10);
  }

  /** True when at least an API key or base URL proxy is configured. */
  isAvailable(): boolean {
    return this.apiKey.length > 0 || this.baseUrl !== 'https://api.anthropic.com';
  }

  /**
   * Send a messages request and return the assistant text response.
   * Throws on HTTP error or timeout.
   */
  async complete(messages: LlmMessage[], system?: string): Promise<LlmResponse> {
    const url = `${this.baseUrl}/v1/messages`;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
    };
    if (system) body.system = system;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`LLM API ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const json = await res.json() as {
        content: Array<{ type: string; text?: string }>;
        model: string;
        usage: { input_tokens: number; output_tokens: number };
      };

      const latency_ms = Date.now() - start;
      const text = json.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');

      logger.info(
        { model: json.model, latency_ms, input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens },
        'llm_call_completed',
      );

      return {
        text,
        model: json.model,
        input_tokens: json.usage.input_tokens,
        output_tokens: json.usage.output_tokens,
        latency_ms,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Call the LLM and parse the response as JSON.
   * Uses assistant prefill `{` to force JSON output.
   */
  async completeJson<T>(messages: LlmMessage[], system?: string): Promise<{ data: T; meta: Omit<LlmResponse, 'text'> }> {
    // Add prefill to force JSON
    const messagesWithPrefill: LlmMessage[] = [
      ...messages,
      { role: 'assistant', content: '{' },
    ];

    const response = await this.complete(messagesWithPrefill, system);

    // Reconstruct full JSON (prefill `{` + response)
    const jsonStr = '{' + response.text;

    try {
      const data = JSON.parse(jsonStr) as T;
      return {
        data,
        meta: {
          model: response.model,
          input_tokens: response.input_tokens,
          output_tokens: response.output_tokens,
          latency_ms: response.latency_ms,
        },
      };
    } catch (err) {
      logger.error({ raw: jsonStr.slice(0, 500) }, 'llm_json_parse_failed');
      throw new Error('LLM returned invalid JSON');
    }
  }
}
