/**
 * @file device-flow.ts
 *
 * Implements the OAuth 2.0 Device Authorization Grant flow for OpenAI Codex.
 * This flow is designed for CLI tools and headless applications where
 * the user authorizes on a separate device with a browser.
 *
 * The flow:
 * 1. Client requests a device code from the authorization server
 * 2. User visits the authorization URL and enters the displayed code
 * 3. Client polls for authorization completion
 * 4. On success, client exchanges the authorization grant for tokens
 */

import { deriveAccountId, deriveExpiresAt } from './jwt';
import type { FetchLike, OpenAIDeviceFlow, OpenAIDeviceFlowOptions, OpenAIOAuthTokens } from './types';
import { OpenAIOAuthError } from './types';

/** Default OAuth client ID for Codex/ChatGPT. */
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Default OAuth issuer/authorization server URL. */
const DEFAULT_ISSUER = 'https://auth.openai.com';
/** Additional wait time added to the poll interval to avoid race conditions. */
const POLL_BUFFER_MS = 3000;

/**
 * Resolves the fetch function to use for OAuth requests.
 */
function pickFetch(customFetch?: FetchLike): FetchLike {
  if (typeof customFetch === 'function') {
    return customFetch;
  }

  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }

  throw new OpenAIOAuthError('fetch_required', 'A fetch implementation is required for OpenAI OAuth.');
}

/**
 * Start OpenAI's Codex device OAuth flow.
 *
 * The returned flow contains a URL and user code for authorization. Call
 * `flow.complete()` after showing those values to poll for authorization and
 * exchange the grant for OAuth tokens.
 */
export async function startOpenAIDeviceFlow(options: OpenAIDeviceFlowOptions = {}): Promise<OpenAIDeviceFlow> {
  const fetch = pickFetch(options.fetch);
  const issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/$/, '');
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const codeResponse = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_id: clientId }),
  });

  if (!codeResponse.ok) {
    throw new OpenAIOAuthError('auth_failed', 'Failed to initiate OpenAI authorization.');
  }

  const device = (await codeResponse.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: string | number;
  };

  if (!device.device_auth_id || !device.user_code) {
    throw new OpenAIOAuthError('auth_failed', 'OpenAI authorization response did not include a device code.');
  }

  const intervalSeconds = typeof device.interval === 'number' ? device.interval : parseInt(device.interval ?? '5', 10);
  const intervalMs = Math.max(Number.isFinite(intervalSeconds) ? intervalSeconds : 5, 1) * 1000;

  return {
    providerId: 'openai',
    url: `${issuer}/codex/device`,
    code: device.user_code,
    instructions: `Enter code: ${device.user_code}`,
    async complete() {
      while (true) {
        const poll = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            device_auth_id: device.device_auth_id,
            user_code: device.user_code,
          }),
        });

        if (poll.ok) {
          const grant = (await poll.json()) as {
            authorization_code?: string;
            code_verifier?: string;
          };

          if (!grant.authorization_code || !grant.code_verifier) {
            throw new OpenAIOAuthError('auth_failed', 'OpenAI authorization grant was incomplete.');
          }

          const tokens = await exchangeAuthorizationCode({
            fetch,
            issuer,
            clientId,
            authorizationCode: grant.authorization_code,
            codeVerifier: grant.code_verifier,
            now,
          });

          await options.tokenStore?.save(tokens);
          return tokens;
        }

        if (poll.status !== 403 && poll.status !== 404) {
          throw new OpenAIOAuthError('auth_failed', 'OpenAI OAuth authorization failed.');
        }

        await sleep(intervalMs + POLL_BUFFER_MS);
      }
    },
  };
}

async function exchangeAuthorizationCode({
  fetch,
  issuer,
  clientId,
  authorizationCode,
  codeVerifier,
  now,
}: {
  fetch: FetchLike;
  issuer: string;
  clientId: string;
  authorizationCode: string;
  codeVerifier: string;
  now: () => number;
}): Promise<OpenAIOAuthTokens> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: `${issuer}/deviceauth/callback`,
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    throw new OpenAIOAuthError('auth_failed', 'OpenAI token exchange failed.');
  }

  const token = (await response.json()) as {
    refresh_token?: string;
    access_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!token.access_token) {
    throw new OpenAIOAuthError('auth_failed', 'OpenAI token exchange did not return an access token.');
  }

  return {
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    idToken: token.id_token,
    expiresAt: now() + (token.expires_in ?? 3600) * 1000,
    accountId: deriveAccountId(token.id_token, token.access_token),
  };
}

/**
 * Refresh OpenAI OAuth credentials with a refresh token.
 *
 * Returns `undefined` when refresh is not possible or the server rejects the
 * refresh request. Callers should treat expired credentials as unusable when
 * this returns `undefined`.
 */
export async function refreshOpenAITokens({
  tokens,
  fetch,
  clientId = DEFAULT_CLIENT_ID,
  issuer = DEFAULT_ISSUER,
  tokenUrl,
  now = () => Date.now(),
}: {
  tokens: OpenAIOAuthTokens;
  fetch: FetchLike;
  clientId?: string;
  issuer?: string;
  tokenUrl?: string;
  now?: () => number;
}): Promise<OpenAIOAuthTokens | undefined> {
  if (!tokens.refreshToken) {
    return undefined;
  }

  const resolvedIssuer = issuer.replace(/\/$/, '');
  const response = await fetch(tokenUrl ?? `${resolvedIssuer}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: clientId,
      scope: 'openid profile email offline_access',
    }).toString(),
  });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token) {
    return undefined;
  }

  const next: OpenAIOAuthTokens = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? tokens.refreshToken,
    idToken: payload.id_token ?? tokens.idToken,
    expiresAt: now() + (payload.expires_in ?? 3600) * 1000,
  };
  next.accountId = deriveAccountId(next.idToken, next.accessToken) ?? tokens.accountId;

  return next;
}

export { DEFAULT_CLIENT_ID, DEFAULT_ISSUER };
