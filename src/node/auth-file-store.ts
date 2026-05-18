/**
 * @file auth-file-store.ts
 *
 * Node.js-specific token store implementation that reads and writes
 * Codex-compatible auth.json files. This is the recommended storage
 * for desktop CLI applications using Codex.
 *
 * The store looks for auth files in multiple standard locations:
 * - $CHATGPT_LOCAL_HOME/auth.json
 * - $CODEX_HOME/auth.json
 * - ~/.chatgpt-local/auth.json
 * - ~/.codex/auth.json
 *
 * When writing, it prefers the environment variable locations or
 * defaults to ~/.codex/auth.json with mode 0600 for security.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveAccountId, deriveExpiresAt } from '../jwt';
import type { OpenAIOAuthTokens, TokenStore } from '../types';

/** Standard filename for Codex/ChatGPT local auth files. */
const AUTH_FILENAME = 'auth.json';

/**
 * Shape of the auth.json file stored by Codex/ChatGPT local.
 */
type StoredAuthFile = {
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
};

export type CodexAuthFileStoreOptions = {
  /** Explicit auth file path. When omitted, common Codex auth locations are searched. */
  authFilePath?: string;
};

/** Returns unique values from an array by converting to a Set and back. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Returns candidate paths to search for auth.json files.
 * If authFilePath is explicitly provided, returns just that path.
 * Otherwise returns all standard candidate paths based on environment variables.
 */
export function resolveAuthFileCandidates(authFilePath?: string): string[] {
  if (authFilePath) {
    return [authFilePath];
  }

  const chatgptHome = process.env.CHATGPT_LOCAL_HOME;
  const codexHome = process.env.CODEX_HOME;

  return unique(
    [
      chatgptHome ? path.join(chatgptHome, AUTH_FILENAME) : undefined,
      codexHome ? path.join(codexHome, AUTH_FILENAME) : undefined,
      path.join(os.homedir(), '.chatgpt-local', AUTH_FILENAME),
      path.join(os.homedir(), '.codex', AUTH_FILENAME),
    ].filter((value): value is string => Boolean(value)),
  );
}

/**
 * Resolves the path where auth tokens should be written.
 * Prefers explicit path, then environment variables, then defaults to ~/.codex/auth.json
 */
function resolveWritePath(authFilePath?: string): string {
  if (authFilePath) {
    return authFilePath;
  }

  if (process.env.CHATGPT_LOCAL_HOME) {
    return path.join(process.env.CHATGPT_LOCAL_HOME, AUTH_FILENAME);
  }

  if (process.env.CODEX_HOME) {
    return path.join(process.env.CODEX_HOME, AUTH_FILENAME);
  }

  return path.join(os.homedir(), '.codex', AUTH_FILENAME);
}

/**
 * Attempts to read and parse an auth.json file from the list of candidates.
 * Returns the first successfully parsed file's path and data.
 */
async function readAuthFile(candidates: string[]): Promise<{ filePath?: string; data?: StoredAuthFile }> {
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as StoredAuthFile;
      return { filePath: candidate, data: parsed };
    } catch {
    }
  }

  return {};
}

/**
 * Converts stored auth file format to OpenAIOAuthTokens format.
 * Derives account ID and expiry from JWT claims if not explicitly stored.
 */
function toTokens(data: StoredAuthFile | undefined): OpenAIOAuthTokens | undefined {
  const accessToken = data?.tokens?.access_token;
  if (!accessToken) {
    return undefined;
  }

  const idToken = data?.tokens?.id_token;
  return {
    accessToken,
    refreshToken: data?.tokens?.refresh_token,
    idToken,
    accountId: data?.tokens?.account_id ?? deriveAccountId(idToken, accessToken),
    expiresAt: deriveExpiresAt(accessToken),
  };
}

/**
 * Writes auth data to a file, creating parent directories if needed.
 * Sets file mode to 0600 (owner read/write only) for security.
 */
async function writeAuthFile(filePath: string, data: StoredAuthFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Create a Node token store backed by Codex-compatible `auth.json` files.
 *
 * The store reads existing Codex/ChatGPT local auth files and writes refreshed
 * tokens back with file mode `0600` where supported by the OS.
 */
export function createCodexAuthFileStore(options: CodexAuthFileStoreOptions = {}): TokenStore {
  let sourcePath: string | undefined;
  let lastData: StoredAuthFile = {};

  return {
    async load() {
      const result = await readAuthFile(resolveAuthFileCandidates(options.authFilePath));
      sourcePath = result.filePath;
      lastData = result.data ?? {};
      return toTokens(result.data);
    },
    async save(tokens) {
      const filePath = sourcePath ?? resolveWritePath(options.authFilePath);
      const data: StoredAuthFile = {
        ...lastData,
        tokens: {
          ...(lastData.tokens ?? {}),
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          id_token: tokens.idToken,
          account_id: tokens.accountId,
        },
        last_refresh: new Date().toISOString(),
      };

      await writeAuthFile(filePath, data);
      sourcePath = filePath;
      lastData = data;
    },
  };
}
