/**
 * Per-ticket forum topics in the staff chat.
 *
 * Lives apart from `users.ts` so that the file handler can reach it without
 * dragging in the LLM addon (and its OpenAI client) through that module.
 */
import { Context, Messenger } from './interfaces';
import cache from './cache';
import * as db from './db';
import { sendMessage } from './middleware';
import { ISupportee } from './db';
import TelegramAddon from './addons/telegram';
import * as djvpn from './addons/djvpn';
import { isLkUserId, shmUserIdFromLkUserId } from './addons/lk/ids';

/**
 * Returns the send options that put a staff-chat message into this ticket's own
 * forum topic, creating that topic on first use. The DJVPN customer card is
 * posted once, right after the topic is created.
 *
 * Falls back to posting into the staff chat itself when topics are disabled,
 * the chat is not a forum, or the bot may not create topics there.
 *
 * @param ticket - The ticket being handled.
 * @param ctx - Bot context.
 * @returns Extra options for sendMessage().
 */
export async function staffChatExtra(ticket: ISupportee, ctx: Context): Promise<any> {
  const { config } = cache;
  const extra: any = { parse_mode: config.parse_mode };
  if (!config.staff_forum_topics || config.staffchat_type !== Messenger.TELEGRAM) {
    return extra;
  }

  if (ticket.threadId) {
    extra.message_thread_id = ticket.threadId;
    // The topic was closed when the last answer went out. The bot is an admin
    // and could post into it anyway, but a live conversation should not sit in a
    // topic the group shows as closed.
    if (ticket.topicClosed) {
      await TelegramAddon.getInstance().reopenForumTopic(config.staffchat_id, ticket.threadId);
      await db.setTopicClosed(ticket.ticketId, false);
      ticket.topicClosed = false;
    }
    return extra;
  }

  const topicName = `#T${ticket.ticketId.toString().padStart(6, '0')} · ${ctx.message.from.first_name}`;
  const threadId = await TelegramAddon.getInstance().createForumTopic(
    config.staffchat_id,
    topicName,
  );
  if (!threadId) return extra;

  await db.setThreadId(ticket.ticketId, threadId);
  ticket.threadId = threadId;
  extra.message_thread_id = threadId;

  // Customer card: plain text on purpose - names and URLs would otherwise have
  // to survive Markdown escaping for no benefit. Cabinet-only customers have no
  // Telegram id, so they are looked up by their SHM user id instead.
  const authorId = ctx.message.from.id;
  const card = await djvpn.getCustomerCard(
    isLkUserId(authorId)
      ? { shmUserId: shmUserIdFromLkUserId(authorId) }
      : { telegramId: authorId },
  );
  if (card) {
    await sendMessage(config.staffchat_id, config.staffchat_type, card, {
      message_thread_id: threadId,
    });
  }
  return extra;
}
