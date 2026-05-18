/**
 * @file memory-token-store.ts
 *
 * In-memory token storage implementation.
 * Useful for testing and short-lived processes that don't need
 * persistent token storage.
 */

import type { OpenAIOAuthTokens, TokenStore } from './types';

/**
 * Create an in-memory token store.
 *
 * This is useful for tests and short-lived scripts. It does not persist tokens
 * across process restarts.
 */
export function createMemoryTokenStore(initial?: OpenAIOAuthTokens): TokenStore {
  let current = initial;

  return {
    async load() {
      return current;
    },
    async save(tokens) {
      current = tokens;
    },
  };
}
