/**
 * @file stream-to-generate.ts
 *
 * Provides utilities for converting streaming language model results
 * into non-streaming results. This is useful when the underlying provider
 * only supports streaming but the application needs synchronous generation.
 *
 * The AI SDK v3 provider interface requires both doGenerate and doStream,
 * but some backends (like Codex) only implement streaming. This module
 * bridges that gap by consuming the stream and assembling a complete result.
 */

import type {
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from '@ai-sdk/provider';

/** Creates an empty usage object with all fields undefined. */
const emptyUsage = (): LanguageModelV3Usage => ({
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
});

/**
 * Merges two provider metadata objects, with right values taking precedence
 * over left values when both are defined.
 */
function mergeProviderMetadata(
  left: SharedV3ProviderMetadata | undefined,
  right: SharedV3ProviderMetadata | undefined,
): SharedV3ProviderMetadata | undefined {
  if (left == null) return right;
  if (right == null) return left;

  const merged: SharedV3ProviderMetadata = { ...left };
  for (const [provider, value] of Object.entries(right)) {
    const existing = merged[provider];
    merged[provider] = existing == null ? value : { ...existing, ...value };
  }

  return merged;
}

/** Collect a LanguageModel stream result into a non-streaming generate result. */
export async function collectStreamGenerateResult(
  streamResult: LanguageModelV3StreamResult,
): Promise<LanguageModelV3GenerateResult> {
  const reader = streamResult.stream.getReader();
  const content: LanguageModelV3Content[] = [];
  const warnings: SharedV3Warning[] = [];
  const activeTextById = new Map<string, Extract<LanguageModelV3Content, { type: 'text' }>>();
  const activeReasoningById = new Map<string, Extract<LanguageModelV3Content, { type: 'reasoning' }>>();

  let finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined };
  let usage: LanguageModelV3Usage = emptyUsage();
  let providerMetadata: SharedV3ProviderMetadata | undefined;
  let responseMetadata: LanguageModelV3GenerateResult['response'];

  try {
    while (true) {
      const { value: part, done } = await reader.read();
      if (done) {
        break;
      }

      switch (part.type) {
        case 'stream-start':
          warnings.push(...part.warnings);
          break;
        case 'response-metadata':
          responseMetadata = {
            id: part.id,
            timestamp: part.timestamp,
            modelId: part.modelId,
          };
          break;
        case 'text-start': {
          const textPart: Extract<LanguageModelV3Content, { type: 'text' }> = {
            type: 'text',
            text: '',
            providerMetadata: part.providerMetadata,
          };
          content.push(textPart);
          activeTextById.set(part.id, textPart);
          break;
        }
        case 'text-delta': {
          const existing = activeTextById.get(part.id);
          if (existing) {
            existing.text += part.delta;
            existing.providerMetadata = mergeProviderMetadata(existing.providerMetadata, part.providerMetadata);
          } else {
            const textPart: Extract<LanguageModelV3Content, { type: 'text' }> = {
              type: 'text',
              text: part.delta,
              providerMetadata: part.providerMetadata,
            };
            content.push(textPart);
            activeTextById.set(part.id, textPart);
          }
          break;
        }
        case 'text-end': {
          const existing = activeTextById.get(part.id);
          if (existing) {
            existing.providerMetadata = mergeProviderMetadata(existing.providerMetadata, part.providerMetadata);
            activeTextById.delete(part.id);
          }
          break;
        }
        case 'reasoning-start': {
          const reasoningPart: Extract<LanguageModelV3Content, { type: 'reasoning' }> = {
            type: 'reasoning',
            text: '',
            providerMetadata: part.providerMetadata,
          };
          content.push(reasoningPart);
          activeReasoningById.set(part.id, reasoningPart);
          break;
        }
        case 'reasoning-delta': {
          const existing = activeReasoningById.get(part.id);
          if (existing) {
            existing.text += part.delta;
            existing.providerMetadata = mergeProviderMetadata(existing.providerMetadata, part.providerMetadata);
          } else {
            const reasoningPart: Extract<LanguageModelV3Content, { type: 'reasoning' }> = {
              type: 'reasoning',
              text: part.delta,
              providerMetadata: part.providerMetadata,
            };
            content.push(reasoningPart);
            activeReasoningById.set(part.id, reasoningPart);
          }
          break;
        }
        case 'reasoning-end': {
          const existing = activeReasoningById.get(part.id);
          if (existing) {
            existing.providerMetadata = mergeProviderMetadata(existing.providerMetadata, part.providerMetadata);
            activeReasoningById.delete(part.id);
          }
          break;
        }
        case 'tool-call':
        case 'tool-result':
        case 'tool-approval-request':
        case 'file':
        case 'source':
          content.push(part);
          break;
        case 'finish':
          finishReason = part.finishReason;
          usage = part.usage;
          providerMetadata = part.providerMetadata;
          break;
        case 'error':
          throw part.error instanceof Error ? part.error : new Error('Streaming request failed.', { cause: part.error });
        case 'tool-input-start':
        case 'tool-input-delta':
        case 'tool-input-end':
        case 'raw':
          break;
        default:
          part satisfies never;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    content,
    finishReason,
    usage,
    providerMetadata,
    request: streamResult.request,
    response: responseMetadata == null && streamResult.response?.headers == null
      ? undefined
      : {
          ...(responseMetadata ?? {}),
          ...(streamResult.response?.headers == null ? {} : { headers: streamResult.response.headers }),
        },
    warnings,
  };
}

/** Language model wrapper that implements `doGenerate` by consuming `doStream`. */
export class StreamOnlyLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: LanguageModelV3['supportedUrls'];

  constructor(private readonly inner: LanguageModelV3) {
    this.provider = inner.provider;
    this.modelId = inner.modelId;
    this.supportedUrls = inner.supportedUrls;
  }

  async doGenerate(options: Parameters<LanguageModelV3['doGenerate']>[0]): Promise<LanguageModelV3GenerateResult> {
    return collectStreamGenerateResult(await this.inner.doStream(options));
  }

  doStream(options: Parameters<LanguageModelV3['doStream']>[0]) {
    return this.inner.doStream(options);
  }
}
