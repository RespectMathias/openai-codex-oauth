/**
 * @file codex-fetch.ts
 *
 * Core module that provides the fetch wrapper for authenticated Codex requests.
 * This is the main entry point for making OAuth-authenticated requests to
 * the OpenAI Codex backend.
 *
 * Key features:
 * - Automatic token management and refresh before expiry
 * - Request/response normalization for Codex API compatibility
 * - Browser proxy URL resolution for cross-origin requests
 * - Account ID derivation from JWT claims
 */

import { refreshOpenAITokens } from './device-flow';
import { deriveAccountId, deriveExpiresAt } from './jwt';
import { createMemoryTokenStore } from './memory-token-store';
import type { FetchLike, OpenAIOAuthSettings, OpenAIOAuthTokens, TokenStore } from './types';
import { OpenAIOAuthError } from './types';

/** Default OpenAI Codex backend base URL. */
export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
/** Default proxy base path when running in a browser environment. */
const DEFAULT_BROWSER_PROXY_BASE_URL = '/api/proxy/openai/codex';
/** Default time (5 minutes) before expiry to trigger token refresh. */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Default empty instructions value for Responses API requests. */
const DEFAULT_INSTRUCTIONS = '';
/** Default originator header value identifying this library. */
const DEFAULT_ORIGINATOR = 'openai-codex-oauth';

/**
 * Parsed request components used internally for request transformation.
 */
type RequestParts = {
  url: string;
  method?: string;
  headers: Headers;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
};

/**
 * Resolves the fetch function to use for OAuth and Codex requests.
 * Prefers a custom fetch if provided, falls back to globalThis.fetch.
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

/** Removes trailing slash from a URL string for consistent handling. */
function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

/** Resolves the base URL for Codex requests, defaulting to the official endpoint. */
function resolveBaseURL(baseURL?: string): string {
  return withoutTrailingSlash(baseURL ?? DEFAULT_CODEX_BASE_URL);
}

/**
 * Creates a token store based on provided settings.
 * Prefers explicit tokenStore, then inline tokens, then throws an error.
 */
function createStore(settings: OpenAIOAuthSettings): TokenStore {
  if (settings.tokenStore) {
    return settings.tokenStore;
  }

  if (settings.tokens) {
    return createMemoryTokenStore(settings.tokens);
  }

  throw new OpenAIOAuthError(
    'tokens_required',
    'OpenAI OAuth tokens are required. Pass `tokens`, `tokenStore`, or use `createCodexAuthFileStore` from `@tolksyn/openai-oauth/node`.',
  );
}

/**
 * Determines whether a token needs refresh based on expiry time.
 * Considers the marginMs parameter to refresh proactively before actual expiry.
 */
function needsRefresh(tokens: OpenAIOAuthTokens, now: number, marginMs: number): boolean {
  const expiresAt = tokens.expiresAt ?? deriveExpiresAt(tokens.accessToken);
  if (!tokens.accessToken) {
    return true;
  }

  if (expiresAt == null || expiresAt <= 0) {
    return false;
  }

  return expiresAt <= now + marginMs;
}

/**
 * Checks if a token has already expired based on current time.
 */
function hasExpired(tokens: OpenAIOAuthTokens, now: number): boolean {
  const expiresAt = tokens.expiresAt ?? deriveExpiresAt(tokens.accessToken);
  return expiresAt != null && expiresAt > 0 && expiresAt <= now;
}

/**
 * Manages OAuth token lifecycle including loading, caching, refresh, and validation.
 * Uses a promise coalescing pattern to handle concurrent token requests efficiently.
 */
class TokenManager {
  /** Promise for an in-flight token refresh to coalesce concurrent requests. */
  private inflight?: Promise<OpenAIOAuthTokens>;
  /** Cached current tokens to avoid redundant store loads. */
  private current?: OpenAIOAuthTokens;

  constructor(
    private readonly settings: OpenAIOAuthSettings,
    private readonly store: TokenStore,
    private readonly fetch: FetchLike,
  ) {}

  /**
   * Gets valid OAuth tokens, triggering refresh if needed.
   * Coalesces concurrent requests to avoid duplicate refresh calls.
   */
  async get(): Promise<OpenAIOAuthTokens> {
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.loadFresh()
      .then((tokens) => {
        this.current = tokens;
        this.inflight = undefined;
        return tokens;
      })
      .catch((error) => {
        this.inflight = undefined;
        throw error;
      });

    return this.inflight;
  }

  /**
   * Loads fresh tokens, optionally refreshing if expired or near expiry.
   * Derives account ID from JWT claims if not explicitly provided.
   */
  private async loadFresh(): Promise<OpenAIOAuthTokens> {
    let tokens = this.current ?? (await this.store.load());
    if (!tokens?.accessToken) {
      throw new OpenAIOAuthError('auth_failed', 'OpenAI OAuth access token is missing.');
    }

    const now = this.settings.now?.() ?? Date.now();
    const refreshMarginMs = this.settings.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;

    if (needsRefresh(tokens, now, refreshMarginMs)) {
      const refreshed = await refreshOpenAITokens({
        tokens,
        fetch: this.fetch,
        clientId: this.settings.clientId,
        issuer: this.settings.issuer,
        tokenUrl: this.settings.tokenUrl,
        now: this.settings.now,
      });

      if (refreshed) {
        tokens = refreshed;
        await this.store.save(tokens);
        await this.settings.onTokens?.(tokens);
      } else if (hasExpired(tokens, now)) {
        throw new OpenAIOAuthError('auth_failed', 'OpenAI OAuth access token expired and refresh failed.');
      }
    }

    const accountId = tokens.accountId ?? deriveAccountId(tokens.idToken, tokens.accessToken);
    if (!accountId) {
      throw new OpenAIOAuthError(
        'account_id_missing',
        'OpenAI OAuth account id is missing. Store `accountId` with the tokens or include an id_token with the ChatGPT account claim.',
      );
    }

    return {
      ...tokens,
      accountId,
    };
  }
}

/**
 * Resolves a target URL relative to the Codex base URL.
 * Handles path rewriting from `/v1/responses` to Codex backend paths.
 */
function resolveTargetUrl(input: string, baseURL: string): string {
  const base = new URL(baseURL);
  const parsed = /^https?:\/\//.test(input) ? new URL(input) : new URL(input, 'https://codex.invalid');
  let pathname = parsed.pathname;
  const basePath = withoutTrailingSlash(base.pathname);

  if (pathname === basePath) {
    pathname = '/';
  } else if (basePath && pathname.startsWith(`${basePath}/`)) {
    pathname = pathname.slice(basePath.length);
  }

  if (pathname === '/v1') {
    pathname = '/';
  } else if (pathname.startsWith('/v1/')) {
    pathname = pathname.slice(3);
  }

  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  return `${base.origin}${basePath}${pathname}${parsed.search}`;
}

/**
 * Detects the browser's origin from window.location if available.
 * Returns undefined in non-browser environments.
 */
function browserOrigin(): string | undefined {
  const maybeWindow = (globalThis as { window?: { location?: { origin?: string } } }).window;
  return typeof maybeWindow?.location?.origin === 'string' ? maybeWindow.location.origin.replace(/\/$/, '') : undefined;
}

/**
 * Resolves a proxy URL for browser environments to handle cross-origin requests.
 * When running in a browser, direct Codex requests may fail CORS, so we proxy
 * through a local path that forwards to the Codex backend.
 */
function resolveBrowserProxyUrl(target: URL, baseURL: string, settings: OpenAIOAuthSettings): string | undefined {
  const origin = browserOrigin();
  if (!origin || settings.browserProxyBaseUrl === false) {
    return undefined;
  }

  const proxyBase = settings.browserProxyBaseUrl ?? DEFAULT_BROWSER_PROXY_BASE_URL;
  const absoluteProxyBase = /^https?:\/\//.test(proxyBase) ? proxyBase.replace(/\/$/, '') : `${origin}${proxyBase.startsWith('/') ? '' : '/'}${proxyBase}`.replace(/\/$/, '');
  const upstreamBasePath = withoutTrailingSlash(new URL(baseURL).pathname);
  let pathname = target.pathname;

  if (upstreamBasePath && pathname.startsWith(`${upstreamBasePath}/`)) {
    pathname = pathname.slice(upstreamBasePath.length);
  }

  return `${absoluteProxyBase}${pathname}${target.search}`;
}

/**
 * Parses a fetch input (Request or URL string) into structured request parts.
 * Handles merging of Request defaults with optional init overrides.
 */
async function readRequestParts(input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]): Promise<RequestParts> {
  if (input instanceof Request) {
    const headers = new Headers(input.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    return {
      url: input.url,
      method: init?.method ?? input.method,
      headers,
      body: init?.body ?? (input.body == null ? undefined : await input.clone().text()),
      signal: init?.signal ?? input.signal,
    };
  }

  return {
    url: String(input),
    method: init?.method,
    headers: new Headers(init?.headers),
    body: init?.body,
    signal: init?.signal,
  };
}

/**
 * Attempts to decode a request body to a string for JSON parsing.
 * Supports string, Blob, and ArrayBuffer types; returns undefined for
 * types that cannot be meaningfully decoded (FormData, ReadableStream, etc.)
 */
async function decodeBody(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body == null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof URLSearchParams || body instanceof FormData || body instanceof ReadableStream) {
    return undefined;
  }

  if (body instanceof Blob) {
    return body.text();
  }

  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }

  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }

  return undefined;
}

/**
 * Normalize an OpenAI Responses request body for the Codex backend.
 *
 * Codex expects requests to be stateless by default, so `store` defaults to
 * `false`. Unsupported `max_output_tokens` is removed.
 */
export function normalizeCodexResponsesBody(
  body: Record<string, unknown>,
  options: Pick<OpenAIOAuthSettings, 'instructions' | 'store'> = {},
): Record<string, unknown> {
  const normalized = { ...body };

  if (typeof normalized.instructions !== 'string') {
    normalized.instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;
  }

  if (normalized.store === undefined) {
    normalized.store = options.store ?? false;
  }

  delete normalized.max_output_tokens;

  return normalized;
}

/**
 * Prepares the request body for Codex /responses endpoints.
 * Normalizes JSON bodies to ensure Codex-compatible request format.
 */
async function prepareBody(pathname: string, headers: Headers, body: BodyInit | null | undefined, settings: OpenAIOAuthSettings) {
  if (!pathname.endsWith('/responses')) {
    return body;
  }

  const contentType = headers.get('content-type');
  if (contentType && !contentType.includes('application/json')) {
    return body;
  }

  const bodyText = await decodeBody(body);
  if (typeof bodyText !== 'string') {
    return body;
  }

  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return body;
    }

    return JSON.stringify(normalizeCodexResponsesBody(parsed as Record<string, unknown>, settings));
  } catch {
    return body;
  }
}

/**
 * Create a fetch implementation that authenticates OpenAI Responses requests
 * with Codex OAuth credentials.
 *
 * The returned function rewrites `/v1/responses` requests to the Codex backend,
 * injects `Authorization` and `ChatGPT-Account-Id`, and refreshes credentials
 * before expiry when a refresh token is available.
 */
export function createCodexOAuthFetch(settings: OpenAIOAuthSettings = {}): FetchLike {
  const fetch = pickFetch(settings.fetch);
  const store = createStore(settings);
  const manager = new TokenManager(settings, store, fetch);
  const baseURL = resolveBaseURL(settings.baseURL);

  return async (input, init) => {
    const request = await readRequestParts(input, init);
    const targetUrl = resolveTargetUrl(request.url, baseURL);
    const target = new URL(targetUrl);
    const tokens = await manager.get();
    const headers = new Headers(settings.headers);

    request.headers.forEach((value, key) => headers.set(key, value));
    headers.delete('authorization');
    headers.delete('chatgpt-account-id');
    headers.delete('openai-beta');

    headers.set('Authorization', `Bearer ${tokens.accessToken}`);
    headers.set('ChatGPT-Account-Id', tokens.accountId!);
    headers.set('OpenAI-Beta', 'responses=experimental');

    if (settings.originator !== false && !headers.has('originator')) {
      headers.set('originator', settings.originator ?? DEFAULT_ORIGINATOR);
    }

    const body = await prepareBody(target.pathname, headers, request.body, settings);

    return fetch(resolveBrowserProxyUrl(target, baseURL, settings) ?? target.toString(), {
      method: request.method ?? init?.method,
      headers,
      body,
      signal: request.signal ?? undefined,
    });
  };
}

/** Create a small Codex client around `createCodexOAuthFetch`. */
export function createCodexOAuthClient(settings: OpenAIOAuthSettings = {}) {
  const baseURL = resolveBaseURL(settings.baseURL);
  const fetch = createCodexOAuthFetch(settings);

  return {
    baseURL,
    fetch,
    request: (path: string, init?: RequestInit) => fetch(resolveTargetUrl(path, baseURL), init),
  };
}
