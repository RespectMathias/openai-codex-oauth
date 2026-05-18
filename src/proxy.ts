/**
 * @file proxy.ts
 *
 * Server-side request handlers for proxying OpenAI Codex OAuth requests.
 * This module provides framework-agnostic handlers that can be used in
 * various server environments (Node.js, Deno, Cloudflare Workers, etc.)
 * to enable browser clients to make authenticated Codex requests.
 *
 * The proxy validates OAuth credentials (Authorization header and account ID),
 * rewrites requests to the Codex backend, and passes through responses.
 */

import { DEFAULT_CODEX_BASE_URL, normalizeCodexResponsesBody } from './codex-fetch';
import type { FetchLike, OpenAIOAuthSettings } from './types';

export type OpenAIOAuthProxyOptions = Pick<OpenAIOAuthSettings, 'instructions' | 'originator' | 'store'> & {
  fetch?: FetchLike;
  baseURL?: string;
};

/**
 * Resolves the fetch function to use for upstream requests.
 * Prefers a custom fetch if provided, falls back to globalThis.fetch,
 * and throws if neither is available.
 */
function pickFetch(customFetch?: FetchLike): FetchLike {
  if (typeof customFetch === 'function') return customFetch;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  throw new Error('A fetch implementation is required for OpenAI Codex proxy handlers.');
}

/**
 * Creates a Response with no-store cache control header.
 * Used for error responses to prevent caching.
 */
function noStoreText(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Extracts and optionally normalizes the request body.
 * For JSON bodies, normalizes Codex-specific fields like instructions and store.
 */
async function requestBody(request: Request, options: OpenAIOAuthProxyOptions): Promise<string> {
  const text = await request.text();
  if (!text.trim()) return text;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return text;
    return JSON.stringify(normalizeCodexResponsesBody(parsed as Record<string, unknown>, options));
  } catch {
    return text;
  }
}

/** Create framework-agnostic server handlers for browser-safe Codex OAuth proxying. */
export function createOpenAIOAuthProxy(options: OpenAIOAuthProxyOptions = {}) {
  const fetch = pickFetch(options.fetch);
  const baseURL = (options.baseURL ?? DEFAULT_CODEX_BASE_URL).replace(/\/$/, '');

  return {
    async responses(request: Request): Promise<Response> {
      const authorization = request.headers.get('authorization') ?? '';
      const accountId = request.headers.get('chatgpt-account-id') ?? '';
      if (!authorization.trim() || !accountId.trim()) {
        return noStoreText('Missing OpenAI OAuth credentials.', 401);
      }

      const upstream = await fetch(`${baseURL}/responses${new URL(request.url).search}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
          'ChatGPT-Account-Id': accountId,
          'OpenAI-Beta': 'responses=experimental',
          ...(options.originator === false ? {} : { originator: options.originator ?? 'openai-codex-oauth' }),
        },
        body: await requestBody(request, options),
      });

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
          'Cache-Control': upstream.headers.get('Cache-Control') ?? 'no-store',
        },
      });
    },
  };
}
