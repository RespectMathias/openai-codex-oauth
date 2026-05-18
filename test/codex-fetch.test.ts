import { describe, expect, test, vi } from 'vitest';
import { createCodexOAuthFetch, normalizeCodexResponsesBody } from '../src/codex-fetch';
import { createJwt } from './helpers';

describe('Codex OAuth fetch', () => {
  test('routes browser responses requests through the local proxy', async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost:8081' } };
    const upstreamFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const oauthFetch = createCodexOAuthFetch({
      fetch: upstreamFetch,
      tokens: {
        accessToken: 'oauth-access-token',
        accountId: 'acct_123',
      },
    });

    try {
      await oauthFetch('/v1/responses?foo=bar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.3-codex' }),
      });
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(upstreamFetch.mock.calls[0][0]).toBe('http://localhost:8081/api/proxy/openai/codex/responses?foo=bar');
    const headers = new Headers(upstreamFetch.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    expect(headers.get('chatgpt-account-id')).toBe('acct_123');
  });

  test('normalizes responses request and injects OAuth headers', async () => {
    const upstreamFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const oauthFetch = createCodexOAuthFetch({
      fetch: upstreamFetch,
      tokens: {
        accessToken: 'oauth-access-token',
        accountId: 'acct_123',
      },
      instructions: 'default instructions',
    });

    await oauthFetch('https://example.test/v1/responses?foo=bar', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ignored',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_output_tokens: 100,
      }),
    });

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses?foo=bar');

    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    expect(headers.get('chatgpt-account-id')).toBe('acct_123');
    expect(headers.get('openai-beta')).toBe('responses=experimental');
    expect(headers.get('originator')).toBe('openai-codex-oauth');

    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'gpt-5.3-codex',
      instructions: 'default instructions',
      store: false,
    });
    expect(body.max_output_tokens).toBeUndefined();
  });

  test('refreshes expired tokens before upstream request', async () => {
    const now = 1_700_000_000_000;
    const expiredAccess = createJwt({ exp: Math.floor((now - 1_000) / 1000) });
    const idToken = createJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_refreshed',
      },
    });
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', id_token: idToken }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const oauthFetch = createCodexOAuthFetch({
      fetch: upstreamFetch,
      now: () => now,
      tokens: {
        accessToken: expiredAccess,
        refreshToken: 'refresh-token',
        accountId: 'acct_old',
      },
    });

    await oauthFetch('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4' }),
    });

    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://auth.openai.com/oauth/token');
    const headers = new Headers(upstreamFetch.mock.calls[1][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer fresh-access');
    expect(headers.get('chatgpt-account-id')).toBe('acct_refreshed');
  });

  test('normalizes Codex responses bodies', () => {
    expect(normalizeCodexResponsesBody({ model: 'gpt-5.4', max_output_tokens: 1 })).toEqual({
      model: 'gpt-5.4',
      instructions: '',
      store: false,
    });
  });
});
