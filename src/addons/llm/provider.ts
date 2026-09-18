/**
 * The chat-completion provider behind one interface.
 *
 * One implementation today (an OpenAI-compatible endpoint); the seam exists so
 * a second one can be added without touching the assistant itself.
 */
import { OpenAiProvider } from './openai';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  readonly name: string;
  /**
   * Returns the model's reply text, or throws.
   *
   * `model` overrides the configured one, so the caller can route a single
   * request to another lane (see `router.ts`) without a second client.
   */
  chat(messages: ChatMessage[], model?: string): Promise<string>;
}

/**
 * Builds the configured provider.
 *
 * The client is built on demand rather than at import time: an unconfigured key
 * should leave the bot running with the assistant simply switched off, not
 * crash it.
 *
 * @returns The provider, or null when it is not usable.
 */
export function getProvider(): LlmProvider | null {
  return OpenAiProvider.create();
}
