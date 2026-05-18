/**
 * @file types.ts
 *
 * Core type definitions for the OpenAI Codex OAuth library.
 * These types define the contract for authentication, token management,
 * and configuration across all modules.
 */

/**
 * Type alias for the global fetch function signature.
 * Used to allow custom fetch implementations in various environments.
 */
export type FetchLike = typeof globalThis.fetch;

/**
 * OAuth credentials used to call the OpenAI Codex backend.
 * Treat these as password-equivalent secrets.
 */
export type OpenAIOAuthTokens = {
  /** Bearer token sent to the Codex backend. */
  accessToken: string;
  /** Refresh token used to obtain a new access token before expiry. */
  refreshToken?: string;
  /** Access-token expiry as epoch milliseconds. */
  expiresAt?: number;
  /** Optional OpenID token. Used to derive `accountId` when available. */
  idToken?: string;
  /** ChatGPT account id required by the Codex backend. */
  accountId?: string;
};

/** Async storage interface for loading and persisting OAuth credentials. */
export type TokenStore = {
  /** Load the latest known credentials. Return `undefined` when the user is not signed in. */
  load(): Promise<OpenAIOAuthTokens | undefined>;
  /** Persist new credentials after sign-in or refresh. */
  save(tokens: OpenAIOAuthTokens): Promise<void>;
};

/** In-progress OpenAI Codex device authorization flow. */
export type OpenAIDeviceFlow = {
  providerId: 'openai';
  /** URL the user should open to authorize the device flow. */
  url: string;
  /** User code to enter on the authorization page. */
  code: string;
  /** Human-readable instruction string for command-line or app UI. */
  instructions: string;
  /** Poll until authorization completes, exchange the grant, and return OAuth tokens. */
  complete(): Promise<OpenAIOAuthTokens>;
};

/** Options for starting OpenAI's Codex device OAuth flow. */
export type OpenAIDeviceFlowOptions = {
  /** Custom fetch implementation, useful for tests and non-standard runtimes. */
  fetch?: FetchLike;
  /** Clock override returning epoch milliseconds. */
  now?: () => number;
  /** Sleep override used between polling attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** OAuth client id. Defaults to the Codex client id. */
  clientId?: string;
  /** OAuth issuer. Defaults to `https://auth.openai.com`. */
  issuer?: string;
  /** Optional store that receives tokens after successful authorization. */
  tokenStore?: TokenStore;
};

/** Shared settings for Codex OAuth fetch, client, and AI SDK provider creation. */
export type OpenAIOAuthSettings = {
  /** Custom fetch implementation for both token refresh and Codex requests. */
  fetch?: FetchLike;
  /** Secure token storage used to load and save refreshed credentials. */
  tokenStore?: TokenStore;
  /** Inline tokens for scripts/tests. Prefer `tokenStore` for production apps. */
  tokens?: OpenAIOAuthTokens;
  /** OAuth client id. Defaults to the Codex client id. */
  clientId?: string;
  /** OAuth issuer. Defaults to `https://auth.openai.com`. */
  issuer?: string;
  /** Override token endpoint for refresh. */
  tokenUrl?: string;
  /** Codex backend base URL. Defaults to `https://chatgpt.com/backend-api/codex`. */
  baseURL?: string;
  /** Browser proxy base URL for Codex requests. Defaults to `/api/proxy/openai/codex` in browsers. Pass `false` to disable. */
  browserProxyBaseUrl?: string | false;
  /** Additional headers sent to the Codex backend before OAuth headers are applied. */
  headers?: Record<string, string>;
  /** Default `instructions` value for Responses requests that omit it. */
  instructions?: string;
  /** Default OpenAI Responses `store` value. Defaults to `false`. */
  store?: boolean;
  /** Upstream `originator` header. Pass `false` to omit it. */
  originator?: string | false;
  /** Refresh access tokens this many milliseconds before expiry. */
  refreshMarginMs?: number;
  /** Clock override returning epoch milliseconds. */
  now?: () => number;
  /** Called after a successful token refresh. */
  onTokens?: (tokens: OpenAIOAuthTokens) => void | Promise<void>;
};

/** Settings for the AI SDK provider factory. */
export type OpenAIOAuthProviderSettings = OpenAIOAuthSettings & {
  /** Provider name exposed to AI SDK telemetry and metadata. */
  name?: string;
};

/** Error class used for OAuth, token, and credential setup failures. */
export class OpenAIOAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpenAIOAuthError';
    this.code = code;
  }
}
