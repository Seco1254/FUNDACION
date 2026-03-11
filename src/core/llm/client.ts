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

type LlmProvider = 'openai' | 'anthropic' | 'none';

/**
 * Unified LLM client supporting OpenAI and Anthropic backends.
 *
 * Provider selection (in priority order):
 *   1. OPENAI_API_KEY present  → OpenAI (gpt-4.1-mini by default)
 *   2. ANTHROPIC_API_KEY present OR custom base URL → Anthropic
 *   3. Neither                 → isAvailable() = false, heuristic fallback
 *
 * The API key is read exclusively from env vars and is NEVER logged.
 */
export class LlmClient {
  private readonly provider: LlmProvider;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(config?: LlmClientConfig) {
    const openaiKey = process.env.OPENAI_API_KEY ?? '';
    const anthropicKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    const anthropicBase = config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
    const hasAnthropicProxy = anthropicBase !== 'https://api.anthropic.com';

    if (openaiKey.length > 0) {
      this.provider = 'openai';
      this.apiKey = openaiKey;
      this.baseUrl = 'https://api.openai.com';
      this.model = config?.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
    } else if (anthropicKey.length > 0 || hasAnthropicProxy) {
      this.provider = 'anthropic';
      this.apiKey = anthropicKey;
      this.baseUrl = anthropicBase.replace(/\/$/, '');
      this.model = config?.model ?? process.env.LLM_MODEL ?? 'claude-sonnet-4-5-20250929';
    } else {
      this.provider = 'none';
      this.apiKey = '';
      this.baseUrl = '';
      this.model = '';
    }

    this.maxTokens = config?.maxTokens ?? parseInt(process.env.LLM_MAX_TOKENS ?? '4096', 10);
    this.timeoutMs = config?.timeoutMs ?? parseInt(process.env.LLM_TIMEOUT_MS ?? '60000', 10);
  }

  /** True when at least one provider is configured. */
  isAvailable(): boolean {
    return this.provider !== 'none';
  }

  /** The active backend: 'openai', 'anthropic', or 'none'. */
  get activeProvider(): LlmProvider {
    return this.provider;
  }

  /**
   * Send a chat request and return the assistant text response.
   * Dispatches to the configured provider. Throws on HTTP error or timeout.
   */
  async complete(messages: LlmMessage[], system?: string): Promise<LlmResponse> {
    if (this.provider === 'openai') {
      return this.callOpenAi(messages, system, false);
    }
    return this.callAnthropic(messages, system);
  }

  /**
   * Call the LLM and parse the response as JSON.
   * OpenAI: uses response_format json_object mode.
   * Anthropic: uses assistant prefill `{` to force JSON output.
   */
  async completeJson<T>(messages: LlmMessage[], system?: string): Promise<{ data: T; meta: Omit<LlmResponse, 'text'> }> {
    let response: LlmResponse;
    let jsonStr: string;

    if (this.provider === 'openai') {
      // OpenAI JSON mode — model outputs valid JSON when response_format is set
      response = await this.callOpenAi(messages, system, true);
      jsonStr = response.text.trim();

      // Strip markdown code fences if model wraps response anyway
      const fenceMatch = jsonStr.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      if (fenceMatch) jsonStr = fenceMatch[1];
    } else {
      // Anthropic: assistant prefill forces JSON output starting with `{`
      const messagesWithPrefill: LlmMessage[] = [
        ...messages,
        { role: 'assistant', content: '{' },
      ];
      response = await this.callAnthropic(messagesWithPrefill, system);
      jsonStr = '{' + response.text;
    }

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
    } catch {
      logger.error({ raw: jsonStr.slice(0, 500), provider: this.provider }, 'llm_json_parse_failed');
      throw new Error('LLM returned invalid JSON');
    }
  }

  // ── Private: Anthropic Messages API ────────────────────────────────

  private async callAnthropic(messages: LlmMessage[], system?: string): Promise<LlmResponse> {
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
        throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 200)}`);
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

      return { text, model: json.model, input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens, latency_ms };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Private: OpenAI Chat Completions API ────────────────────────────

  private async callOpenAi(messages: LlmMessage[], system: string | undefined, jsonMode: boolean): Promise<LlmResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;

    // Build OpenAI message array: system goes first as role='system'
    const openAiMessages: Array<{ role: string; content: string }> = [];
    if (system) {
      openAiMessages.push({ role: 'system', content: system });
    }
    for (const m of messages) {
      openAiMessages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: openAiMessages,
      max_tokens: this.maxTokens,
    };
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // API key injected via Authorization header — value never logged
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
        throw new Error(`OpenAI API ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const json = await res.json() as {
        choices: Array<{ message: { content: string } }>;
        model: string;
        usage: { prompt_tokens: number; completion_tokens: number };
      };

      const latency_ms = Date.now() - start;
      const text = json.choices[0]?.message.content ?? '';

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
}
