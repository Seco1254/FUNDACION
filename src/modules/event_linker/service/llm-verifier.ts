/**
 * LLM Verifier for MAYBE_LINK decisions (v3).
 *
 * Called ONLY for pairs in the MAYBE_LINK zone — heuristics are inconclusive.
 * Sends a focused prompt with headline + lead text from both sides and returns
 * a clean tristate: SAME_EVENT | DIFFERENT_EVENT | UNCERTAIN.
 *
 * Design principles:
 *   - Single-pair verification (not top-N) — simpler, cheaper, auditable
 *   - Short prompt (~300-500 tokens input) → fast, low cost
 *   - Structured JSON output for deterministic routing
 *   - Graceful degradation: errors → UNCERTAIN → heuristic fallback
 */

import { LlmClient } from '../../../core/llm/client.js';
import { logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import {
  LLM_VERIFY_ENABLED,
  LLM_VERIFY_MAX_CHARS,
  LLM_VERIFY_TIMEOUT_MS,
  LLM_VERIFY_MODEL,
} from './config.js';

// ── Types ──

export type VerifyVerdict = 'SAME_EVENT' | 'DIFFERENT_EVENT' | 'UNCERTAIN';

export interface VerifyInput {
  /** Article headline */
  articleTitle: string;
  /** Article lead text (first N chars of snippet) */
  articleText: string;
  /** Article media source name */
  articleSource?: string;
  /** Event representative headline */
  eventTitle: string;
  /** Event sample text (first N chars of concatenated article texts) */
  eventText: string;
  /** Event media sources */
  eventSources?: string[];
}

export interface VerifyResult {
  verdict: VerifyVerdict;
  confidence: number;
  reasoning: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

// ── Constants ──

const SYSTEM_PROMPT = `You are a news event classifier for Colombian media. Your ONLY job is to determine whether two news items cover the SAME real-world event.

Rules:
- SAME_EVENT: Both items describe the same specific incident, decision, announcement, or happening. Different editorial angles on the SAME event count as SAME_EVENT.
- DIFFERENT_EVENT: The items cover clearly different events, even if they share the same topic, actors, or location.
- UNCERTAIN: You cannot determine with reasonable confidence. This is rare — use it only when truly ambiguous.

Key distinctions:
- "Petro announces pension reform" and "Congress debates pension reform" → SAME_EVENT (same reform process)
- "Petro announces pension reform" and "Petro travels to Europe" → DIFFERENT_EVENT (different events, same actor)
- "Bombing in Cauca" and "Another bombing in Cauca" → could be SAME or DIFFERENT depending on dates/details

Respond with JSON only: { "verdict": "SAME_EVENT"|"DIFFERENT_EVENT"|"UNCERTAIN", "confidence": 0.0-1.0, "reasoning": "<1 sentence>" }`;

// ── Core function ──

/**
 * Ask LLM whether an article and event represent the same real-world event.
 * Returns null if LLM verification is disabled, unavailable, or fails.
 */
export async function verifyMaybeLink(
  input: VerifyInput,
  llm: LlmClient,
): Promise<VerifyResult | null> {
  if (!LLM_VERIFY_ENABLED) {
    return null;
  }

  if (!llm.isAvailable()) {
    return null;
  }

  const maxChars = LLM_VERIFY_MAX_CHARS;

  const articleTextTrunc = input.articleText.slice(0, maxChars);
  const eventTextTrunc = input.eventText.slice(0, maxChars);

  const sourceInfo = [
    input.articleSource ? `Source A: ${input.articleSource}` : '',
    input.eventSources?.length ? `Source B: ${input.eventSources.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const userPrompt = `Item A:
Headline: ${input.articleTitle}
Text: ${articleTextTrunc}

Item B:
Headline: ${input.eventTitle}
Text: ${eventTextTrunc}
${sourceInfo ? '\n' + sourceInfo : ''}

Are these the SAME real-world event? Respond with JSON.`;

  // Use dedicated model/timeout if configured, otherwise use LLM client defaults
  const verifyLlm = (LLM_VERIFY_MODEL || LLM_VERIFY_TIMEOUT_MS !== 15000)
    ? new LlmClient({
        model: LLM_VERIFY_MODEL || undefined,
        maxTokens: 256,
        timeoutMs: LLM_VERIFY_TIMEOUT_MS,
      })
    : llm;

  metrics.incCounter('linking.llm_verify_total');
  const start = Date.now();

  try {
    const response = await verifyLlm.completeJson<{
      verdict: string;
      confidence: number;
      reasoning: string;
    }>([{ role: 'user', content: userPrompt }], SYSTEM_PROMPT);

    const latencyMs = Date.now() - start;
    const { data, meta } = response;

    // Normalize verdict to valid tristate
    const rawVerdict = (data.verdict ?? '').toUpperCase();
    let verdict: VerifyVerdict;
    if (rawVerdict === 'SAME_EVENT') {
      verdict = 'SAME_EVENT';
      metrics.incCounter('linking.llm_verify_same_event');
    } else if (rawVerdict === 'DIFFERENT_EVENT') {
      verdict = 'DIFFERENT_EVENT';
      metrics.incCounter('linking.llm_verify_different_event');
    } else {
      verdict = 'UNCERTAIN';
      metrics.incCounter('linking.llm_verify_uncertain');
    }

    const result: VerifyResult = {
      verdict,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
      reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
      latencyMs,
      inputTokens: meta.input_tokens,
      outputTokens: meta.output_tokens,
    };

    logger.info({
      verdict: result.verdict,
      confidence: result.confidence,
      reasoning: result.reasoning.slice(0, 120),
      latency_ms: result.latencyMs,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      article_title: input.articleTitle.slice(0, 80),
      event_title: input.eventTitle.slice(0, 80),
    }, 'llm_verify_result');

    return result;
  } catch (err) {
    const latencyMs = Date.now() - start;
    metrics.incCounter('linking.llm_verify_error');
    logger.error({
      error: err instanceof Error ? err.message : String(err),
      latency_ms: latencyMs,
      article_title: input.articleTitle.slice(0, 80),
      event_title: input.eventTitle.slice(0, 80),
    }, 'llm_verify_failed');
    return null;
  }
}
