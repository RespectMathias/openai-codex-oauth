/**
 * @file provider.ts
 *
 * Vercel AI SDK provider implementation for OpenAI Codex OAuth.
 * This module creates a provider that can be used with the AI SDK's
 * generateText, streamText, and other AI functions.
 *
 * The provider wraps the Codex OAuth fetch implementation and adapts it
 * to the AI SDK provider interface.
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModelV3, ImageModelV3, LanguageModelV3, ProviderV3 } from '@ai-sdk/provider';
import { NoSuchModelError } from '@ai-sdk/provider';
import { createCodexOAuthFetch, DEFAULT_CODEX_BASE_URL } from './codex-fetch';
import { StreamOnlyLanguageModel } from './stream-to-generate';
import type { OpenAIOAuthProviderSettings } from './types';

/** Model ID type for Codex OAuth models. */
export type OpenAIOAuthModelId = string;

/**
 * AI SDK provider interface for OpenAI Codex OAuth-backed language models.
 * Provides language model, embedding model, and image model factories.
 */
export interface OpenAIOAuthProvider extends ProviderV3 {
  (modelId: OpenAIOAuthModelId): LanguageModelV3;
  languageModel(modelId: OpenAIOAuthModelId): LanguageModelV3;
  responses(modelId: OpenAIOAuthModelId): LanguageModelV3;
  embeddingModel(modelId: string): EmbeddingModelV3;
  imageModel(modelId: string): ImageModelV3;
}

/**
 * Create a Vercel AI SDK provider that sends Responses API calls through the
 * OpenAI Codex OAuth backend.
 */
export function createOpenAIOAuth(settings: OpenAIOAuthProviderSettings = {}): OpenAIOAuthProvider {
  const providerName = settings.name ?? 'openai-oauth';
  const oauthFetch = createCodexOAuthFetch(settings);
  const openai = createOpenAI({
    apiKey: 'oauth',
    baseURL: settings.baseURL ?? DEFAULT_CODEX_BASE_URL,
    name: providerName,
    fetch: oauthFetch,
  });

  const createLanguageModel = (modelId: OpenAIOAuthModelId) => new StreamOnlyLanguageModel(openai.responses(modelId as never));
  const provider = (modelId: OpenAIOAuthModelId) => createLanguageModel(modelId);

  provider.specificationVersion = 'v3' as const;
  provider.languageModel = createLanguageModel;
  provider.responses = createLanguageModel;
  provider.embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };
  provider.imageModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
  };

  return provider as OpenAIOAuthProvider;
}
