import cache from './cache';
import * as middleware from './middleware';
import * as db from './db';
import TelegramAddon from './addons/telegram';
import { Context } from './interfaces';
import { ISupportee } from './db';
import * as log from 'fancy-log'

/**
 * Generates a ticket message.
 *
 * @param name - The name to include in the message.
 * @param message - The message object.
 * @returns The formatted ticket message.
 */
function ticketMsg(
  name: string,
  message: { text: any; from: { first_name: any } },
): string {
  const esc = middleware.strictEscape;
  const { config } = cache;
  if (config.clean_replies) {
    return esc(message.text);
  }
  if (config.anonymous_replies) {
    return `${config.language.dear} ${esc(name)},\n\n${esc(message.text)}\n\n${config.language.regards}\n${config.language.regardsGroup}`;
  }
  return `${config.language.dear} ${esc(name)},\n\n${esc(message.text)}\n\n${config.language.regards}\n${esc(message.from.first_name)}`;
}

/**
 * Sends a private reply to a user.
 *
 * @param ctx - The bot context.
 * @param msg - The message object (defaults to ctx.message if empty).
 */
function privateReply(ctx: Context, msg: any = {}) {
  if (Object.keys(msg).length === 0) {
    msg = ctx.message;
  }

  const { session, messenger, from, message, chat } = ctx;
  const { modeData } = session;
  middleware.sendMessage(
    modeData.userid,
    messenger,
    ticketMsg(`${modeData.name}`, msg),
    {
      parse_mode: cache.config.parse_mode,
      reply_markup: {
        html: '',
        inline_keyboard: [
          [
            cache.config.direct_reply
              ? {
                text: cache.config.language.replyPrivate,
                url: `https://t.me/${from.username}`,
              }
              : {
                text: cache.config.language.replyPrivate,
                callback_data: `${from.id}---${message.from.first_name}---${modeData.category}---${modeData.ticketid}`,
              },
          ],
        ],
      },
    },
  );
  // Send confirmation message
  middleware.sendMessage(chat.id, messenger, cache.config.language.msg_sent, {});
}

/**
 * Extracts the ticket ID from the reply text.
 *
 * @param replyText - The text from which to extract the ticket ID.
 * @returns The extracted ticket ID or null if not found.
 */
function extractTicketId(replyText: string, ctx: Context): string | null {
  const { language } = cache.config;
  let match = replyText.match(new RegExp(`#T(.*) ${language.from}`));
  if (!match) {
    match = replyText.match(new RegExp(`#T(.*)\n${language.from}`));
  }
  return match ? match[1].trim() : null;
}

/**
 * Extracts the name from the reply text.
 *
 * @param replyText - The text from which to extract the name.
 * @returns The extracted name or null if not found.
 */
function extractName(replyText: string): string | null {
  const { language } = cache.config;
  const match = replyText.match(new RegExp(`${language.from} (.*) ${language.language}`));
  return match ? match[1].trim() : null;
}

/**
 * Handles staff chat replies to tickets.
 *
 * @param ctx - The bot context.
 */
async function chat(ctx: Context) {
  if (!ctx.session.admin) {
    return;
  }

  var ticket;
  var ticketId;

  // In a forum staff chat the topic itself identifies the ticket, so staff can
  // just write in the topic instead of replying to a specific message.
  const threadId = (ctx.message as any)?.message_thread_id;
  if (cache.config.staff_forum_topics && threadId) {
    ticket = await db.getTicketByThreadId(threadId);
    if (ticket) {
      ticketId = ticket.ticketId;
    }
  }

  const replyMsg = ctx.message?.reply_to_message;
  const replyText = replyMsg?.text || replyMsg?.caption;

  if (!ticket) {
    if (!replyMsg) return;

    const replyMessageId = ctx.message.external_reply?.message_id;
    if (!replyText && !replyMessageId) return;

    if (replyMessageId) {
      ticket = await db.getTicketByInternalId(replyMessageId);
      if (ticket) {
        ticketId = ticket.ticketId;
      }
    } else {
      ticketId = parseInt(await extractTicketId(replyText, ctx));

      if (!ticketId) return;
      ticket = await db.getTicketById(ticketId, ctx.session.groupCategory);
    }
  }

  if (!ticket) {
    middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }
  var name;
  if (ticket.name) {
    name = ticket.name;
  } else if (replyText) {
    name = extractName(replyText);
  }
  if (!name) {
    middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }

  // Mark ticket as no longer active
  cache.ticketStatus[ticketId] = false;

  // Reply to web users differently
  if (ticket.userid.includes('WEB')) {
    try {
      const socketId = ticket.userid.split('WEB')[1];
      cache.io.to(socketId).emit('chat_staff', ticketMsg(name, ctx.message));
    } catch (e) {
      middleware.sendMessage(
        ctx.chat.id,
        ticket.messenger,
        `Web chat already closed.`,
      );
      log.error(e);
    }
  } else {
    middleware.sendMessage(ticket.userid, ticket.messenger, ticketMsg(name, ctx.message));
  }
  const esc = middleware.strictEscape;
  middleware.sendMessage(
    ctx.chat.id,
    cache.config.staffchat_type,
    `${cache.config.language.msg_sent} ${esc(name)}`,
    {
      parse_mode: cache.config.parse_mode,
      ...(ticket.threadId ? { message_thread_id: ticket.threadId } : {}),
    },
  );
  log.info(`Answer: ${ticketMsg(name, ctx.message)}`);
  cache.ticketSent[ticketId] = null;

  // Auto-close the ticket if enabled
  if (cache.config.auto_close_tickets) {
      await db.add(ticketId, 'closed', null, ticket.messenger);
      // Keep the topic list readable: a closed ticket gets a closed topic. It is
      // reopened automatically if the user writes again.
      if (ticket.threadId && cache.config.staff_forum_topics) {
        await TelegramAddon.getInstance().closeForumTopic(
          cache.config.staffchat_id,
          ticket.threadId,
        );
      }
  }
}

export { privateReply, chat, ticketMsg };
