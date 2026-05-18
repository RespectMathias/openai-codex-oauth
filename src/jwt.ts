/**
 * @file jwt.ts
 *
 * JWT (JSON Web Token) parsing utilities for OpenAI OAuth.
 * These functions decode and extract claims from JWTs without
 * verifying signatures (since we trust the OAuth issuer).
 */

import type { OpenAIOAuthTokens } from './types';

/**
 * Decodes a Base64URL-encoded string to UTF-8 text.
 * Handles both browser (atob) and Node.js (Buffer) environments.
 */
function decodeBase64Url(value: string): string | undefined {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

    if (typeof globalThis.atob === 'function') {
      const binary = globalThis.atob(padded);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }

    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the JSON payload from a JWT without verifying the signature. */
export function parseJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (!token?.includes('.')) {
    return undefined;
  }

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }

  const payload = decodeBase64Url(parts[1]);
  if (!payload) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Derive the ChatGPT account id from OpenAI JWT claims when present. */
export function deriveAccountId(...tokens: Array<string | undefined>): string | undefined {
  for (const token of tokens) {
    const claims = parseJwtClaims(token);
    const auth = claims?.['https://api.openai.com/auth'];

    if (isRecord(auth) && typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id.length > 0) {
      return auth.chatgpt_account_id;
    }
  }

  return undefined;
}

/** Derive JWT expiry as epoch milliseconds from the `exp` claim. */
export function deriveExpiresAt(token: string | undefined): number | undefined {
  const claims = parseJwtClaims(token);
  return typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined;
}
