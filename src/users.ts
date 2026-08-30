import { Context, Messenger, ParseMode } from './interfaces';
import cache from './cache';
import * as llm from './addons/llm';
import * as db from './db';
import { strictEscape as esc, reply, sendMessage } from './middleware';
import { ISupportee } from './db';
import TelegramAddon from './addons/telegram';
import * as djvpn from './addons/djvpn';
import * as lk from './addons/lk/notify';
import { isLkUserId, shmUserIdFromLkUserId } from './addons/lk/ids';
import { staffChatExtra } from './topics';
import * as log from 'fancy-log'

const TIME_BETWEEN_CONFIRMATION_MESSAGES = 86400000; // 24 hours

/**
 * Generates a ticket message.
 *
 * @param ticket - Ticket object with a toString() method.
 * @param message - Message object containing text and sender info.
 * @param tag - Tag string.
 * @param anonymousUser - Whether the ticket is anonymous (default: true).
 * @param autoReplyInfo - Optional auto-reply info to append.
 * @returns The formatted ticket message.
 */
function formatMessageAsTicket(
  ticket: { toString: () => string },
  ctx: Context,
  autoReplyInfo?: any,
): string {
  const { config, userId } = cache;
  var name = `[${esc(ctx.message.from.first_name,)}](tg://user?id=${userId})`;
  if (
    config.anonymous_tickets ||
    config.staffchat_parse_mode === ParseMode.PLAINTEXT ||
    // Cabinet-only customers have no Telegram profile to link to - a tg:// link
    // built from their cabinet id just renders as a dead link for staff.
    isLkUserId(userId)
  ) {
    name = ctx.message.from.first_name;
  }
  return `${config.language.ticket} #T${ticket
    .toString()
    .padStart(6, '0')} ${config.language.from} ${name} ${config.language.language}: ${ctx.message.from.language_code} ${ctx.session.groupTag}\n\n${esc(
      ctx.message.text,
    )}\n\n${autoReplyInfo ? `*${autoReplyInfo}*` : ''}`;
}

/**
 * Creates a formatted auto-reply ticket message.
 *
 * @param msg - The auto-reply message content.
 * @param ctx - Bot context.
 * @returns The formatted auto-reply message.
 */
function createAutoReplyMessage(msg: string, ctx: Context): string {
  const { config } = cache;
  const senderName = ctx.message.from.first_name;
  return config.clean_replies
    ? msg
    : `${config.language.dear} ${esc(senderName)},\n\n${msg}\n\n${config.language.regards}\n${config.language.automatedReplyAuthor}\n\n*${config.language.automatedReply}*`;
}

/**
 * Checks the configured keyword auto-replies.
 *
 * The LLM does not run from here: it needs the ticket (its topic, its history,
 * the customer behind it), and at this point the ticket has not been resolved
 * yet. See assistantStep(), which runs once the message has reached staff.
 *
 * @param ctx - Bot context.
 * @returns True if an auto-reply was sent; otherwise, false.
 */
async function autoReply(ctx: Context): Promise<boolean> {
  const {
    config: { autoreply },
  } = cache;
  const messageText = ctx.message.text.toString();

  if (autoreply && autoreply.length > 0 && autoreply[0]?.question) {
    // Check common auto-reply questions
    for (const autoReplyItem of autoreply) {
      if (messageText.includes(autoReplyItem.question)) {
        reply(ctx, createAutoReplyMessage(autoReplyItem.answer, ctx));
        return true;
      }
    }
  }
  return false;
}

/**
 * Posts a note into the ticket's topic (or the staff chat, without topics).
 *
 * Plain text on purpose: the note quotes a model-written answer, and a stray
 * underscore in it would fail a MarkdownV2 send.
 *
 * @param ticket - Ticket the note belongs to.
 * @param text - Note text.
 */
async function noteToStaff(ticket: ISupportee, text: string): Promise<void> {
  const { config } = cache;
  await sendMessage(config.staffchat_id, config.staffchat_type, text, {
    ...(ticket.threadId ? { message_thread_id: ticket.threadId } : {}),
  }).catch((e) => log.error('Could not post the assistant note: ', e));
}

/**
 * Runs the support assistant on a message that has just reached staff.
 *
 * A confident answer goes to the customer (and to the cabinet, and into the
 * topic so staff sees what was said); anything else is only a hint for the
 * operator - the ticket is in the topic either way, so nobody is left waiting
 * on a model that decided to stay quiet.
 *
 * @param ctx - Bot context of the incoming message.
 * @param ticket - The ticket it belongs to.
 */
async function assistantStep(ctx: Context, ticket: ISupportee): Promise<void> {
  if (!llm.isEnabled() || !ticket) return;
  const { config } = cache;
  const language: any = config.language;

  try {
    await llm.history.record(
      ticket.ticketId,
      'customer',
      ctx.message.text,
      ctx.message.from.first_name,
    );
    const answer = await llm.buildAnswer(ctx, ticket);
    if (!answer) return;

    if (!answer.confident) {
      const lines = [language.llmUnsure || '🤖 ИИ не ответил — нужен оператор.'];
      if (answer.reason) lines.push(answer.reason);
      if (answer.text) lines.push('', `${language.llmDraft || 'Черновик:'} ${answer.text}`);
      await noteToStaff(ticket, lines.join('\n'));
      return;
    }

    // To the customer. Escaped, because the model writes plain prose and the
    // customer-facing parse mode is MarkdownV2.
    let deliveredTelegram = false;
    try {
      await sendMessage(
        ctx.message.chat.id,
        ctx.messenger,
        createAutoReplyMessage(esc(answer.text), ctx),
      );
      deliveredTelegram = !isLkUserId(ticket.userid);
    } catch (e) {
      log.error('Could not deliver the assistant answer: ', e);
    }

    if (ticket.shmUserId) {
      await lk.notifyCabinet({
        ticket_id: ticket.ticketId,
        shm_user_id: ticket.shmUserId,
        direction: 'out',
        text: answer.text,
        author: language.automatedReplyAuthor,
        external_id: `${ticket.ticketId}:ai:${ctx.message.message_id}`,
        delivered_telegram: deliveredTelegram,
      });
    }

    await llm.history.record(ticket.ticketId, 'assistant', answer.text);
    await noteToStaff(
      ticket,
      `${language.llmAnswered || '🤖 ИИ ответил клиенту:'}\n\n${answer.text}`,
    );
  } catch (e) {
    log.error('Assistant step failed: ', e);
  }
}

/**
 * Mirrors a customer's message into the personal cabinet, so their cabinet
 * history is complete even for questions asked from Telegram.
 *
 * Skipped for messages that came from the cabinet in the first place - it has
 * already stored those itself.
 *
 * @param ticket - The ticket the message belongs to.
 * @param ctx - Bot context.
 */
async function mirrorIncoming(ticket: ISupportee, ctx: Context) {
  if (!ticket.shmUserId || (ctx as any).lkOrigin) return;
  await lk.notifyCabinet({
    ticket_id: ticket.ticketId,
    shm_user_id: ticket.shmUserId,
    direction: 'in',
    text: ctx.message.text,
    external_id: `${ticket.ticketId}:tg:${ctx.message.message_id}`,
  });
}

/**
 * Processes a ticket by sending confirmation and forwarding it to staff and group chats.
 *
 * @param ticket - The ticket retrieved from the database.
 * @param ctx - Bot context.
 * @param chatId - The chat id for sending confirmation.
 * @param autoReplyInfo - Optional auto-reply info.
 */
async function processTicket(
  ticket: ISupportee,
  ctx: Context,
  chatId: string,
  autoReplyInfo?: string,
) {
  const { config } = cache;
  // Send confirmation if applicable
  if (
    !autoReplyInfo &&
    config.autoreply_confirmation &&
    (ctx.session.lastContactDate === undefined ||
      ctx.session.lastContactDate < Date.now() - TIME_BETWEEN_CONFIRMATION_MESSAGES)
  ) {
    ctx.session.lastContactDate = Date.now();
    const confirmationMsg =
      config.language.confirmationMessage +
      '\n' +
      (config.show_user_ticket
        ? `${config.language.ticket} #T${ticket.ticketId.toString().padStart(6, '0')}`
        : '');
    sendMessage(chatId, ticket.messenger, confirmationMsg);
  }

  // Send ticket message to staff chat, into this ticket's topic when enabled
  const messageId = await sendMessage(
    config.staffchat_id,
    config.staffchat_type,
    formatMessageAsTicket(
      ticket.ticketId,
      ctx,
      autoReplyInfo,
    ),
    await staffChatExtra(ticket, ctx),
  );
  db.addIdAndName(ticket.ticketId, messageId, ctx.message.from.first_name);
  await mirrorIncoming(ticket, ctx);

  // If group flag is set and not the admin chat, forward to group chat
  if (ctx.session.group && ctx.session.group !== config.staffchat_id) {
    const groupOptions = config.allow_private
      ? {
        parse_mode: 'none',
        reply_markup: {
          html: '',
          inline_keyboard: [
            [
              {
                text: config.language.replyPrivate,
                callback_data:
                  ctx.from.id +
                  '---' +
                  ctx.message.from.first_name +
                  '---' +
                  ctx.session.groupCategory +
                  '---' +
                  ticket.ticketId,
              },
            ],
          ],
        },
      }
      : { parse_mode: config.parse_mode };

    sendMessage(
      ctx.session.group,
      ticket.messenger,
      formatMessageAsTicket(
        ticket.ticketId,
        ctx,
        autoReplyInfo,
      ),
      groupOptions,
    );
  }
};

/**
 * Handles ticket processing with spam protection.
 *
 * @param ctx - Bot context.
 * @param chat - Chat object containing an id.
 */
async function chat(ctx: Context, chat: { id: string }) {
  const { config } = cache;
  cache.userId = ctx.message.from.id;
  const isAutoReply = await autoReply(ctx);
  if (isAutoReply && !config.show_auto_replied) return;
  /** Message rejected as spam: neither staff nor the assistant sees it. */
  let spammed = false;
  const autoReplyInfo = isAutoReply ? config.language.automatedReplySent : undefined;

  // Ensure the user's ticket is tracked
  if (cache.ticketIDs[cache.userId] === undefined) {
    cache.ticketIDs.push(cache.userId);
  }
  cache.ticketStatus[cache.userId] = true;

  // If no ticket has been sent yet, fetch from DB and set up spam timer
  if (cache.ticketSent[cache.userId] === undefined) {
    const ticket = await db.getTicketByUserId(chat.id, ctx.session.groupCategory);
    if (!ticket) {
      log.error(`No ticket found for user ${cache.userId}, dropping message.`);
      return;
    }
    await processTicket(ticket, ctx, chat.id, autoReplyInfo);

    // Prevent multiple notifications for a period defined by spam_time
    setTimeout(() => {
      cache.ticketSent[cache.userId] = undefined;
    }, config.spam_time);
    cache.ticketSent[cache.userId] = 0;
  } else if (cache.ticketSent[cache.userId] < config.spam_cant_msg) {
    cache.ticketSent[cache.userId]++;
    const ticket = await db.getTicketByUserId(cache.userId, ctx.session.groupCategory);
    if (!ticket) {
      log.error(`No ticket found for user ${cache.userId}, dropping message.`);
      return;
    }
    sendMessage(
      config.staffchat_id,
      config.staffchat_type,
      formatMessageAsTicket(
        ticket.ticketId,
        ctx,
        autoReplyInfo,
      ),
      await staffChatExtra(ticket, ctx),
    );
    await mirrorIncoming(ticket, ctx);
    if (ctx.session.group && ctx.session.group !== config.staffchat_id) {
      sendMessage(
        ctx.session.group,
        ticket.messenger,
        formatMessageAsTicket(
          ticket.ticketId,
          ctx,
          autoReplyInfo,
        ),
      );
    }
  } else if (cache.ticketSent[cache.userId] === config.spam_cant_msg) {
    cache.ticketSent[cache.userId]++;
    spammed = true;
    sendMessage(chat.id, ctx.messenger, config.language.blockedSpam);
  } else {
    // Past the limit the message is dropped without a word to anyone; the
    // assistant must not answer what staff never saw either.
    spammed = true;
  }

  // Log the ticket message for debugging
  const ticket = await db.getTicketByUserId(cache.userId, ctx.session.groupCategory)
  if (ticket) {
    log.info(
      formatMessageAsTicket(
        ticket.ticketId,
        ctx,
        autoReplyInfo,
      ),
    );
    // Last, and only once the message is with staff: the assistant answers on
    // top of a ticket that already exists, never instead of one.
    if (!isAutoReply && !spammed) {
      await assistantStep(ctx, ticket);
    }
  }
}

export { chat };
