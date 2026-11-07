import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { LlmHttpError, LlmInvalidResponseError, describeError } from '../errors.js';
import type { Logger } from '../logger.js';
import { Semaphore } from '../util/concurrency.js';
import { retry } from '../util/retry.js';
import { sha256 } from '../util/text.js';
import { postJson } from './http.js';
import type { SchemaPair } from './schemas.js';

const ChatEnvelope = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
            refusal: z.string().nullable().optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export interface CompletionRequest<T> {
  /** Used for logging and cache keying, e.g. "analysis". */
  stage: string;
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  schema: SchemaPair<T>;
  temperature?: number;
  /** Opt into DeepSeek thinking; other calls retain non-thinking mode. */
  deepseekThinking?: 'high' | 'max';
  signal?: AbortSignal;
}

export interface LlmUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheHits: number;
}

/**
 * Single entry point for every LLM call.
 *
 * Replaces the per-call-site `fetch` blocks so that timeouts, retry/backoff, concurrency
 * limiting, secret redaction, response validation and usage accounting are applied uniformly
 * and cannot be forgotten at a new call site.
 */
export class LlmClient {
  private readonly semaphore: Semaphore;
  private readonly cache = new Map<string, unknown>();
  private readonly usage: LlmUsage = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHits: 0,
  };
  /** Set once a provider rejects json_schema, so we stop paying for the failed attempt. */
  private structuredOutputSupported = true;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.semaphore = new Semaphore(config.llm.concurrency);
    this.structuredOutputSupported = config.llm.provider !== 'deepseek';
  }

  getUsage(): Readonly<LlmUsage> {
    return { ...this.usage };
  }

  async complete<T>(request: CompletionRequest<T>): Promise<T> {
    const cacheKey = sha256(request.model, request.system, request.user, request.schema.name,
      JSON.stringify(request.schema.jsonSchema),
      JSON.stringify({ maxOutputTokens: request.maxOutputTokens, temperature: request.temperature, deepseekThinking: request.deepseekThinking }));

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.usage.cacheHits++;
      this.logger.debug('llm cache hit', { stage: request.stage });
      return cached as T;
    }

    const result = await this.semaphore.run(() =>
      retry(() => this.execute(request), {
        retries: this.config.llm.maxRetries,
        baseDelayMs: 500,
        maxDelayMs: this.config.llm.maxRetryDelayMs,
        ...(request.signal ? { signal: request.signal } : {}),
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn('llm retry', {
            stage: request.stage,
            attempt,
            delayMs,
            error: describeError(error),
          });
        },
      }),
    );

    this.cache.set(cacheKey, result);
    return result;
  }

  private async execute<T>(request: CompletionRequest<T>): Promise<T> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        {
          role: 'system',
          content: this.structuredOutputSupported
            ? request.system
            : `${request.system}\nReturn only a JSON object matching this schema:\n${JSON.stringify(request.schema.jsonSchema)}`,
        },
        { role: 'user', content: request.user },
      ],
      [this.config.llm.provider === 'deepseek' ? 'max_tokens' : 'max_completion_tokens']:
        request.maxOutputTokens,
      response_format: this.structuredOutputSupported
        ? {
            type: 'json_schema',
            json_schema: {
              name: request.schema.name,
              strict: true,
              schema: request.schema.jsonSchema,
            },
          }
        : { type: 'json_object' },
    };

    const thinking = this.config.llm.provider === 'deepseek' && request.deepseekThinking !== undefined;
    if (this.config.llm.provider === 'deepseek') {
      body.thinking = { type: thinking ? 'enabled' : 'disabled' };
      if (thinking) body.reasoning_effort = request.deepseekThinking;
    }
    if (request.temperature !== undefined && !thinking) body.temperature = request.temperature;

    let raw: unknown;
    try {
      raw = await postJson({
        url: `${this.config.llm.baseUrl}/chat/completions`,
        apiKey: this.config.llm.apiKey,
        body,
        timeoutMs: this.config.llm.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      // Some gateways and older models reject json_schema. Downgrade once, then let retry re-run.
      if (
        this.structuredOutputSupported &&
        error instanceof LlmHttpError &&
        error.status === 400 &&
        /response_format|json_schema|structured/i.test(error.message)
      ) {
        this.structuredOutputSupported = false;
        this.logger.warn('provider rejected json_schema; falling back to json_object mode');
        throw new LlmInvalidResponseError('Retrying without structured outputs', error);
      }
      throw error;
    }

    const envelope = ChatEnvelope.safeParse(raw);
    if (!envelope.success) {
      throw new LlmInvalidResponseError('LLM response envelope was not in the expected shape');
    }

    this.usage.requests++;
    this.usage.promptTokens += envelope.data.usage?.prompt_tokens ?? 0;
    this.usage.completionTokens += envelope.data.usage?.completion_tokens ?? 0;

    const choice = envelope.data.choices[0];
    if (choice?.message?.refusal) {
      throw new LlmInvalidResponseError(`Model refused the request: ${choice.message.refusal}`);
    }
    if (choice?.finish_reason === 'length') {
      throw new LlmInvalidResponseError(
        `Response truncated at ${request.maxOutputTokens} tokens; raise the stage token budget`,
      );
    }

    const content = choice?.message?.content ?? '';
    if (!content.trim()) throw new LlmInvalidResponseError('LLM returned empty content');

    const parsed = extractJsonObject(content);
    if (parsed === null) {
      throw new LlmInvalidResponseError('LLM content did not contain a JSON object');
    }

    const validated = request.schema.validator.safeParse(parsed);
    if (!validated.success) {
      throw new LlmInvalidResponseError(
        `LLM output failed ${request.schema.name} validation: ${validated.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .slice(0, 5)
          .join('; ')}`,
      );
    }

    return validated.data;
  }
}

/**
 * Recovers a JSON object from model output that may be wrapped in prose or a code fence.
 * Brace-matching is used instead of a greedy regex so trailing commentary cannot break parsing.
 */
export function extractJsonObject(content: string): unknown {
  const withoutFence = content.replace(/```(?:json)?\s*([\s\S]*?)```/i, '$1').trim();

  const direct = tryParse(withoutFence);
  if (direct !== null) return direct;

  const start = withoutFence.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < withoutFence.length; i++) {
    const char = withoutFence[i] as string;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return tryParse(withoutFence.slice(start, i + 1));
    }
  }

  return null;
}

function tryParse(text: string): unknown {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    // Arrays are `typeof 'object'` but never satisfy an object schema.
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
