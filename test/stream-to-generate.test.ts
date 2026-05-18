import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, test } from 'vitest';
import { collectStreamGenerateResult } from '../src/stream-to-generate';

describe('stream-to-generate', () => {
  test('collects text deltas into a generate result', async () => {
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'response-metadata', id: 'resp_1', modelId: 'gpt-5.4' });
        controller.enqueue({ type: 'text-start', id: 'text_1' });
        controller.enqueue({ type: 'text-delta', id: 'text_1', delta: 'hel' });
        controller.enqueue({ type: 'text-delta', id: 'text_1', delta: 'lo' });
        controller.enqueue({ type: 'text-end', id: 'text_1' });
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        controller.close();
      },
    });

    const result = await collectStreamGenerateResult({ stream });

    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'stop' });
    expect(result.response?.id).toBe('resp_1');
  });
});
