/**
 * @file index.ts
 *
 * Node.js-specific exports for the OpenAI Codex OAuth library.
 * Provides file-based token storage for desktop CLI applications.
 */

export { createCodexAuthFileStore, resolveAuthFileCandidates } from './auth-file-store';
export type { CodexAuthFileStoreOptions } from './auth-file-store';
