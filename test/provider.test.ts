import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, test, vi } from 'vitest';

import { createOpenAIOAuth } from '../src/provider';

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({
    responses: vi.fn(() => ({ provider: 'openai-oauth.responses' })),
  })),
}));

describe('createOpenAIOAuth', () => {
  test('passes a placeholder api key so the OpenAI SDK does not require OPENAI_API_KEY', () => {
    createOpenAIOAuth({
      tokens: {
        accessToken: 'access-token',
        accountId: 'account-id',
      },
    });

    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'oauth',
    }));
  });
});
