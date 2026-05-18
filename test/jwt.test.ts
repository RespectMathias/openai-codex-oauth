import { describe, expect, test } from 'vitest';
import { deriveAccountId, deriveExpiresAt, parseJwtClaims } from '../src/jwt';
import { createJwt } from './helpers';

describe('jwt helpers', () => {
  test('parses claims and derives account id', () => {
    const token = createJwt({
      exp: 1_700_000_000,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123',
      },
    });

    expect(parseJwtClaims(token)?.exp).toBe(1_700_000_000);
    expect(deriveExpiresAt(token)).toBe(1_700_000_000_000);
    expect(deriveAccountId(token)).toBe('acct_123');
  });

  test('returns undefined for invalid tokens', () => {
    expect(parseJwtClaims('not-a-jwt')).toBeUndefined();
    expect(deriveAccountId('not-a-jwt')).toBeUndefined();
    expect(deriveExpiresAt('not-a-jwt')).toBeUndefined();
  });
});
