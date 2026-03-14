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

type Provider = 'anthropic' | 'openai';

/**
 * Multi-provider LLM client (Anthropic + OpenAI) using native fetch.
 * Zero external dependencies.
 *
 * Provider priority:
 *   1. ANTHROPIC_API_KEY → Anthropic Messages API
 *   2. OPENAI_API_KEY   → OpenAI Chat Completions API
 */
export class LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly provider: Provider;

  constructor(config?: LlmClientConfig) {
    const anthropicKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    const openaiKey = process.env.OPENAI_API_KEY ?? '';

    if (anthropicKey) {
      this.provider = 'anthropic';
      this.apiKey = anthropicKey;
      this.baseUrl = (config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
      this.model = config?.model ?? process.env.LLM_MODEL ?? 'claude-sonnet-4-5-20250929';
    } else if (openaiKey) {
      this.provider = 'openai';
      this.apiKey = openaiKey;
      this.baseUrl = (config?.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
      this.model = config?.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
    } else {
      // No key — default to anthropic (will fail isAvailable check)
      this.provider = 'anthropic';
      this.apiKey = '';
      this.baseUrl = (config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
      this.model = config?.model ?? process.env.LLM_MODEL ?? 'claude-sonnet-4-5-20250929';
    }

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
    if (this.provider === 'openai') {
      return this.completeOpenAI(messages, system);
    }
    return this.completeAnthropic(messages, system);
  }

  private async completeAnthropic(messages: LlmMessage[], system?: string): Promise<LlmResponse> {
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
        { provider: 'anthropic', model: json.model, latency_ms, input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens },
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

  private async completeOpenAI(messages: LlmMessage[], system?: string): Promise<LlmResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;

    // Build OpenAI messages array with system message
    const oaiMessages: Array<{ role: string; content: string }> = [];
    if (system) {
      oaiMessages.push({ role: 'system', content: system });
    }
    for (const m of messages) {
      oaiMessages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: oaiMessages,
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.apiKey}`,
    };

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
        choices: Array<{ message: { content: string } }>;
        model: string;
        usage: { prompt_tokens: number; completion_tokens: number };
      };

      const latency_ms = Date.now() - start;
      const text = json.choices?.[0]?.message?.content ?? '';

      logger.info(
        { provider: 'openai', model: json.model, latency_ms, input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens },
        'llm_call_completed',
      );

      return {
        text,
        model: json.model,
        input_tokens: json.usage.prompt_tokens,
        output_tokens: json.usage.completion_tokens,
        latency_ms,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Call the LLM and parse the response as JSON.
   * For Anthropic: uses assistant prefill `{` to force JSON output.
   * For OpenAI: uses response_format json_object.
   */
  async completeJson<T>(messages: LlmMessage[], system?: string): Promise<{ data: T; meta: Omit<LlmResponse, 'text'> }> {
    if (this.provider === 'openai') {
      return this.completeJsonOpenAI<T>(messages, system);
    }

    // Anthropic: Add prefill to force JSON
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

  private async completeJsonOpenAI<T>(messages: LlmMessage[], system?: string): Promise<{ data: T; meta: Omit<LlmResponse, 'text'> }> {
    const url = `${this.baseUrl}/v1/chat/completions`;

    const oaiMessages: Array<{ role: string; content: string }> = [];
    if (system) {
      oaiMessages.push({ role: 'system', content: system });
    }
    // Skip assistant prefill messages for OpenAI (not supported)
    for (const m of messages) {
      if (m.role === 'assistant') continue;
      oaiMessages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: oaiMessages,
      response_format: { type: 'json_object' },
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.apiKey}`,
    };

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
        choices: Array<{ message: { content: string } }>;
        model: string;
        usage: { prompt_tokens: number; completion_tokens: number };
      };

      const latency_ms = Date.now() - start;
      const text = json.choices?.[0]?.message?.content ?? '{}';

      logger.info(
        { provider: 'openai', model: json.model, latency_ms, input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens },
        'llm_call_completed',
      );

      try {
        const data = JSON.parse(text) as T;
        return {
          data,
          meta: {
            model: json.model,
            input_tokens: json.usage.prompt_tokens,
            output_tokens: json.usage.completion_tokens,
            latency_ms,
          },
        };
      } catch (err) {
        logger.error({ raw: text.slice(0, 500) }, 'llm_json_parse_failed');
        throw new Error('LLM returned invalid JSON');
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
