import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyMaybeLink, VerifyInput } from './llm-verifier.js';
import { LlmClient } from '../../../core/llm/client.js';

// Mock config to control LLM_VERIFY_ENABLED in tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    // Default: enabled for tests
    get LLM_VERIFY_ENABLED() { return (globalThis as any).__LLM_VERIFY_ENABLED ?? true; },
    LLM_VERIFY_MAX_CHARS: 500,
    LLM_VERIFY_TIMEOUT_MS: 15000,
    LLM_VERIFY_MODEL: '',
  };
});

function makeInput(overrides: Partial<VerifyInput> = {}): VerifyInput {
  return {
    articleTitle: 'Reforma tributaria aprobada por el Congreso',
    articleText: 'El Congreso de la República aprobó la reforma tributaria propuesta por el gobierno.',
    articleSource: 'el-tiempo',
    eventTitle: 'Congreso aprueba la reforma tributaria',
    eventText: 'La reforma tributaria fue aprobada en segundo debate por el Congreso colombiano.',
    eventSources: ['semana'],
    ...overrides,
  };
}

function makeMockLlm(response: { verdict: string; confidence: number; reasoning: string }): LlmClient {
  const llm = new LlmClient({ apiKey: 'test-key' });
  vi.spyOn(llm, 'isAvailable').mockReturnValue(true);
  vi.spyOn(llm, 'completeJson').mockResolvedValue({
    data: response,
    meta: { model: 'test-model', input_tokens: 100, output_tokens: 50, latency_ms: 200 },
  });
  return llm;
}

describe('verifyMaybeLink', () => {
  beforeEach(() => {
    (globalThis as any).__LLM_VERIFY_ENABLED = true;
  });

  it('returns SAME_EVENT when LLM says same event', async () => {
    const llm = makeMockLlm({
      verdict: 'SAME_EVENT',
      confidence: 0.95,
      reasoning: 'Both cover the same tax reform approval.',
    });

    const result = await verifyMaybeLink(makeInput(), llm);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('SAME_EVENT');
    expect(result!.confidence).toBe(0.95);
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns DIFFERENT_EVENT when LLM says different event', async () => {
    const llm = makeMockLlm({
      verdict: 'DIFFERENT_EVENT',
      confidence: 0.90,
      reasoning: 'Article is about Iran sanctions, event is about coal mining.',
    });

    const result = await verifyMaybeLink(makeInput(), llm);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('DIFFERENT_EVENT');
    expect(result!.confidence).toBe(0.90);
  });

  it('returns UNCERTAIN when LLM is unsure', async () => {
    const llm = makeMockLlm({
      verdict: 'UNCERTAIN',
      confidence: 0.45,
      reasoning: 'Could be the same event but insufficient detail.',
    });

    const result = await verifyMaybeLink(makeInput(), llm);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('UNCERTAIN');
  });

  it('normalizes unknown verdicts to UNCERTAIN', async () => {
    const llm = makeMockLlm({
      verdict: 'MAYBE',
      confidence: 0.5,
      reasoning: 'Not sure.',
    });

    const result = await verifyMaybeLink(makeInput(), llm);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('UNCERTAIN');
  });

  it('returns null when LLM verification is disabled', async () => {
    (globalThis as any).__LLM_VERIFY_ENABLED = false;

    const llm = makeMockLlm({
      verdict: 'SAME_EVENT',
      confidence: 0.95,
      reasoning: 'Same event.',
    });

    const result = await verifyMaybeLink(makeInput(), llm);
    expect(result).toBeNull();
  });

  it('returns null when LLM is not available', async () => {
    const llm = new LlmClient(); // no API key
    vi.spyOn(llm, 'isAvailable').mockReturnValue(false);

    const result = await verifyMaybeLink(makeInput(), llm);
    expect(result).toBeNull();
  });

  it('returns null on LLM error (graceful degradation)', async () => {
    const llm = new LlmClient({ apiKey: 'test-key' });
    vi.spyOn(llm, 'isAvailable').mockReturnValue(true);
    vi.spyOn(llm, 'completeJson').mockRejectedValue(new Error('API timeout'));

    const result = await verifyMaybeLink(makeInput(), llm);
    expect(result).toBeNull();
  });

  it('truncates text to LLM_VERIFY_MAX_CHARS', async () => {
    const llm = makeMockLlm({
      verdict: 'SAME_EVENT',
      confidence: 0.9,
      reasoning: 'Same.',
    });

    const longText = 'A'.repeat(2000);
    const input = makeInput({ articleText: longText, eventText: longText });

    const completeSpy = vi.spyOn(llm, 'completeJson');
    await verifyMaybeLink(input, llm);

    // Verify the prompt doesn't contain the full 2000 chars
    const promptArg = (completeSpy.mock.calls[0][0] as any)[0].content;
    expect(promptArg.length).toBeLessThan(longText.length);
  });

  it('includes source info in prompt when provided', async () => {
    const llm = makeMockLlm({
      verdict: 'SAME_EVENT',
      confidence: 0.9,
      reasoning: 'Same.',
    });

    const completeSpy = vi.spyOn(llm, 'completeJson');
    await verifyMaybeLink(makeInput({ articleSource: 'el-tiempo', eventSources: ['semana', 'rcn'] }), llm);

    const promptArg = (completeSpy.mock.calls[0][0] as any)[0].content;
    expect(promptArg).toContain('el-tiempo');
    expect(promptArg).toContain('semana, rcn');
  });
});
