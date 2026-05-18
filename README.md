# openai-codex-oauth

OpenAI Codex OAuth provider and token helpers for the Vercel AI SDK.

This package lets local apps use a user's OpenAI Codex OAuth session with AI SDK functions such as `generateText` and `streamText`. It is intended for personal/local applications that already own the user's token storage boundary.

It is unofficial and is not affiliated with, endorsed by, or sponsored by OpenAI.

## Install

```bash
npm install openai-codex-oauth ai @ai-sdk/openai @ai-sdk/provider
```

## Quick Start

```ts
import { generateText } from 'ai';
import { createOpenAIOAuth } from 'openai-codex-oauth';

const openai = createOpenAIOAuth({
  tokens: {
    accessToken: process.env.OPENAI_OAUTH_ACCESS_TOKEN!,
    refreshToken: process.env.OPENAI_OAUTH_REFRESH_TOKEN!,
    accountId: process.env.OPENAI_OAUTH_ACCOUNT_ID!,
  },
});

const result = await generateText({
  model: openai('gpt-5.3-codex'),
  prompt: 'Reply with exactly: hello',
});

console.log(result.text);
```

## Sign In With Device OAuth

```ts
import { startOpenAIDeviceFlow } from 'openai-codex-oauth';

const flow = await startOpenAIDeviceFlow();

console.log(`Open ${flow.url}`);
console.log(`Enter code ${flow.code}`);

const tokens = await flow.complete();
```

`flow.complete()` polls until the user authorizes the code, exchanges the authorization grant for OAuth tokens, and returns:

```ts
type OpenAIOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
  accountId?: string;
};
```

Persist these tokens in secure storage. They are account credentials.

## Token Store

For real apps, prefer a `TokenStore` over hard-coded env values. The provider loads tokens lazily, refreshes them when they are near expiry, then saves refreshed tokens back through the same store.

```ts
import { createOpenAIOAuth, type TokenStore } from 'openai-codex-oauth';

const tokenStore: TokenStore = {
  async load() {
    const raw = await secureStore.get('openai-codex-oauth');
    return raw ? JSON.parse(raw) : undefined;
  },
  async save(tokens) {
    await secureStore.set('openai-codex-oauth', JSON.stringify(tokens));
  },
};

const openai = createOpenAIOAuth({ tokenStore });
```

## Local Codex Auth File

For Node apps that already have Codex auth from `codex login` or `npx @openai/codex login`:

```ts
import { createOpenAIOAuth } from 'openai-codex-oauth';
import { createCodexAuthFileStore } from 'openai-codex-oauth/node';

const openai = createOpenAIOAuth({
  tokenStore: createCodexAuthFileStore(),
});
```

The Node helper searches:

- `$CHATGPT_LOCAL_HOME/auth.json`
- `$CODEX_HOME/auth.json`
- `~/.chatgpt-local/auth.json`
- `~/.codex/auth.json`

When refreshed tokens are written, the helper writes the auth file with mode `0600` where supported by the OS.

## Streaming

```ts
import { streamText } from 'ai';
import { createOpenAIOAuth } from 'openai-codex-oauth';

const openai = createOpenAIOAuth({ tokenStore });

const result = streamText({
  model: openai('gpt-5.4'),
  prompt: 'Write one sentence about the moon.',
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

## Browser/Web Proxy Handler

Browsers should not call the ChatGPT Codex backend directly because those requests can fail CORS and expose account tokens to cross-origin infrastructure. In browser runtimes, `createCodexOAuthFetch` automatically routes Codex API calls through `/api/proxy/openai/codex` unless `browserProxyBaseUrl: false` is set.

Create a server/API route with the framework-agnostic proxy helper:

```ts
import { createOpenAIOAuthProxy } from 'openai-codex-oauth/proxy';

const proxy = createOpenAIOAuthProxy();

export const responses = proxy.responses;
```

The proxy expects browser requests to send `Authorization: Bearer <token>` and `ChatGPT-Account-Id`. It forwards to the Codex backend server-side and returns `Cache-Control: no-store` responses.

## Credential Safety

OAuth tokens are password-equivalent for the connected OpenAI account.

- Do store tokens in OS keychain storage, encrypted app storage, or a trusted server-side secret store.
- Do not store tokens in browser `localStorage`, plaintext app config, Git, logs, analytics, crash reports, or build output.
- Do not expose this provider from a shared hosted API unless each user has isolated storage and authorization.
- Do not pool, proxy, or redistribute tokens across users.
- Use `tokenStore` in production so refreshes are persisted and stale access tokens are replaced.
- Pass `tokens` directly only for short-lived scripts, tests, or already-secured server runtime secrets.

The package does not phone home, does not persist tokens unless you provide a `TokenStore`, and does not log tokens. The Node auth-file helper writes refreshed tokens only to the local Codex auth file it loaded or the explicit path you pass.

## API

### `createOpenAIOAuth(settings)`

Creates an AI SDK provider. The provider is callable:

```ts
const model = openai('gpt-5.3-codex');
```

Important settings:

- `tokens`: in-memory OAuth credentials for scripts/tests.
- `tokenStore`: async credential store used for loading and saving refreshed tokens.
- `fetch`: custom fetch implementation.
- `baseURL`: Codex upstream base URL. Defaults to `https://chatgpt.com/backend-api/codex`.
- `browserProxyBaseUrl`: browser proxy base URL. Defaults to `/api/proxy/openai/codex`; pass `false` to disable browser proxy routing.
- `clientId`, `issuer`, `tokenUrl`: OAuth endpoint overrides.
- `headers`: additional upstream headers.
- `instructions`: default `instructions` field for `/responses` bodies.
- `store`: default OpenAI Responses `store` value. Defaults to `false`.
- `originator`: upstream `originator` header. Pass `false` to omit.
- `onTokens`: callback invoked after a successful refresh.

### `startOpenAIDeviceFlow(options)`

Starts OpenAI's Codex device flow at `https://auth.openai.com/codex/device` and returns `{ url, code, instructions, complete }`.

### `createCodexOAuthFetch(settings)`

Creates a `fetch` implementation that rewrites AI SDK `/v1/responses` requests to the Codex backend and injects OAuth headers.

In browsers, it routes through `browserProxyBaseUrl` by default to avoid direct Codex CORS failures.

### `createOpenAIOAuthProxy(options)`

Creates framework-agnostic server handlers for browser-safe Codex API proxying. Import from `openai-codex-oauth/proxy`.

### `createCodexAuthFileStore(options)`

Node-only helper exported from `openai-codex-oauth/node`. Loads and saves Codex-compatible `auth.json` token files.

## Behavior

- Uses OpenAI's device authorization endpoints for Codex OAuth.
- Derives `accountId` from the JWT claim `https://api.openai.com/auth.chatgpt_account_id` when available.
- Requires `accountId` before making Codex requests.
- Refreshes tokens before expiry when a `refreshToken` is available.
- Sends requests to `https://chatgpt.com/backend-api/codex/responses` by default.
- Injects `Authorization`, `ChatGPT-Account-Id`, `OpenAI-Beta`, and `originator` headers.
- Normalizes Responses payloads by defaulting `store` to `false` and removing `max_output_tokens` for Codex compatibility.
- Implements non-streaming generation by collecting stream output because the Codex endpoint is stream-first.

## Attribution

Some OAuth/Codex integration behavior was originally informed by OpenCode. See `NOTICE`.

## Limitations

- This is an unofficial integration over Codex/ChatGPT backend behavior, which can change.
- Embedding and image model factories intentionally throw `NoSuchModelError` for now.
- The package does not provide a multi-user auth service. You own user isolation and secure storage.
