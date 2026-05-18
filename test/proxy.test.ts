import { describe, expect, test, vi } from 'vitest';
import { createOpenAIOAuthProxy } from '../src/proxy';

describe('OpenAI Codex proxy handlers', () => {
  test('proxies responses requests to the Codex backend', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const proxy = createOpenAIOAuthProxy({ fetch });

    const response = await proxy.responses(
      new Request('http://localhost/api/proxy/openai/codex/responses', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-access-token',
          'ChatGPT-Account-Id': 'acct_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'gpt-5.3-codex', max_output_tokens: 100 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('{"ok":true}');
    expect(fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/responses',
      expect.objectContaining({ method: 'POST' }),
    );
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    expect(headers.get('chatgpt-account-id')).toBe('acct_123');
    expect(headers.get('originator')).toBe('openai-codex-oauth');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      model: 'gpt-5.3-codex',
      instructions: '',
      store: false,
    });
  });
});
