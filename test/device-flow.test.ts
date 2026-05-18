import { describe, expect, test, vi } from 'vitest';
import { refreshOpenAITokens, startOpenAIDeviceFlow } from '../src/device-flow';
import { createMemoryTokenStore } from '../src/memory-token-store';
import { createJwt } from './helpers';

describe('OpenAI device flow', () => {
  test('completes device flow and stores OAuth credentials', async () => {
    const idToken = createJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123',
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ device_auth_id: 'device-id', user_code: 'OPENAI-CODE', interval: '1' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorization_code: 'auth-code', code_verifier: 'verifier' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', id_token: idToken, expires_in: 3600 }),
          { status: 200 },
        ),
      );
    const store = createMemoryTokenStore();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const flow = await startOpenAIDeviceFlow({ fetch, sleep, now: () => 1_000, tokenStore: store });
    expect(flow.url).toBe('https://auth.openai.com/codex/device');
    expect(flow.code).toBe('OPENAI-CODE');

    const tokens = await flow.complete();
    expect(tokens).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 3_601_000,
      accountId: 'acct_123',
    });
    await expect(store.load()).resolves.toMatchObject(tokens);
    expect(sleep).toHaveBeenCalledWith(4000);
  });

  test('refreshes tokens with refresh_token grant', async () => {
    const idToken = createJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_456',
      },
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: idToken, expires_in: 10 }), {
        status: 200,
      }),
    );

    const tokens = await refreshOpenAITokens({
      fetch,
      now: () => 5_000,
      tokens: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        accountId: 'acct_old',
      },
    });

    expect(tokens).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: 15_000,
      accountId: 'acct_456',
    });
    const [, init] = fetch.mock.calls[0];
    expect(String(init?.body)).toContain('grant_type=refresh_token');
    expect(String(init?.body)).toContain('refresh_token=old-refresh');
  });
});
