/**
 * Short-term conversation memory per ticket.
 *
 * The bot's ticket collection stores no messages at all - staff read them in
 * the forum topic - so the LLM would otherwise answer every message as if it
 * were the first one it had ever seen. Entries expire on their own (TTL index),
 * because this is context for a live conversation, not an archive: the cabinet
 * and the staff chat keep the real history.
 */
import mongoose from 'mongoose';
import cache from '../../cache';
import * as log from 'fancy-log';

export type Role = 'customer' | 'staff' | 'assistant';

export interface ILlmMessage extends mongoose.Document {
  ticketId: number;
  role: Role;
  author: string | null;
  text: string;
  at: Date;
}

const DEFAULT_TTL_DAYS = 14;

const ttlSeconds =
  (Number((cache.config as any).llm_history_days) || DEFAULT_TTL_DAYS) * 24 * 60 * 60;

const schema = new mongoose.Schema<ILlmMessage>({
  ticketId: { type: Number, required: true },
  role: { type: String, required: true },
  author: { type: String, required: false, default: null },
  text: { type: String, required: true },
  at: { type: Date, required: true, default: () => new Date(), expires: ttlSeconds },
});
schema.index({ ticketId: 1, at: 1 });

const collectionName = `llm_history_${cache.config.owner_id}`;
const LlmMessage = mongoose.model<ILlmMessage>(collectionName, schema);

/** Nothing here is worth failing a ticket over. */
function swallow(what: string) {
  return (e: unknown) => {
    log.error(`llm: could not ${what}:`, e);
    return null;
  };
}

/**
 * Appends one message to a ticket's memory.
 *
 * @param ticketId - Ticket the message belongs to.
 * @param role - Who wrote it.
 * @param text - Message text (empty texts are ignored).
 * @param author - Display name, when there is one.
 */
export async function record(
  ticketId: number,
  role: Role,
  text: string,
  author: string | null = null,
): Promise<void> {
  const body = (text || '').toString().trim();
  if (!ticketId || !body) return;
  await LlmMessage.create({ ticketId, role, author, text: body.slice(0, 4000), at: new Date() })
    .catch(swallow('record a message'));
}

/**
 * Reads a ticket's most recent messages, oldest first.
 *
 * @param ticketId - Ticket to read.
 * @param limit - How many messages to return.
 * @returns Messages in chronological order.
 */
export async function recent(ticketId: number, limit: number): Promise<ILlmMessage[]> {
  if (!ticketId || limit <= 0) return [];
  const rows = await LlmMessage.find({ ticketId })
    .sort({ at: -1 })
    .limit(limit)
    .exec()
    .catch(swallow('read the history'));
  return rows ? rows.reverse() : [];
}

/**
 * Forgets a ticket's memory.
 *
 * @param ticketId - Ticket to clear.
 */
export async function clear(ticketId: number): Promise<void> {
  if (!ticketId) return;
  await LlmMessage.deleteMany({ ticketId }).exec().catch(swallow('clear the history'));
}
