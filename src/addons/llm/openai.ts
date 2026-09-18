/**
 * The chat-completions client: any OpenAI-compatible endpoint.
 *
 * "OpenAI-compatible" rather than "OpenAI" on purpose - DJVPN talks to a
 * gateway that serves Claude models behind the OpenAI wire format, so the host
 * and the model name are config, not code.
 */
import OpenAI from 'openai';
import cache from '../../cache';
import { ChatMessage, LlmProvider } from './provider';
import { modelFor } from './router';
import * as log from 'fancy-log';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_TOKENS = 600;

function conf() {
  return cache.config as any;
}

/**
 * Folds every system message into a single leading one.
 *
 * The caller builds the rules, the knowledge base and the customer card as
 * three separate system messages. Anthropic-backed endpoints take exactly one
 * system block, and a stable leading prefix is also what prompt caching keys
 * on, so they travel merged.
 *
 * @param messages - Conversation as the caller built it.
 * @returns The same conversation, with one system message at the front.
 */
export function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages.filter((m) => m.role !== 'system');
  return system.length ? [{ role: 'system', content: system.join('\n\n') }, ...rest] : rest;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';

  private constructor(private readonly client: OpenAI) {}

  /**
   * Builds the provider, or returns null when no API key is set.
   *
   * @returns A usable provider, or null.
   */
  static create(): OpenAiProvider | null {
    const apiKey = (conf().llm_api_key || process.env.LLM_API_KEY || '').toString().trim();
    if (!apiKey || apiKey === 'API_KEY') {
      log.error('llm: llm_api_key is not set, the assistant stays off');
      return null;
    }
    return new OpenAiProvider(
      new OpenAI({
        apiKey,
        baseURL: (conf().llm_base_url || '').toString().trim() || undefined,
        timeout: Number(conf().llm_timeout_ms) || DEFAULT_TIMEOUT_MS,
      }),
    );
  }

  /**
   * Sends one completion request.
   *
   * @param messages - Conversation to complete.
   * @param model - Model to use; defaults to the `answer` lane.
   * @returns The assistant's text.
   */
  async chat(messages: ChatMessage[], model?: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: model || modelFor('answer'),
      // Support answers should be reproducible, not creative.
      temperature: 0.1,
      max_tokens: Number(conf().llm_max_tokens) || DEFAULT_MAX_TOKENS,
      messages: mergeSystemMessages(messages),
    });
    const text = response.choices[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('llm: empty completion');
    }
    return text;
  }
}
