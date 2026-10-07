import * as db from './db';
import cache from './cache';
import * as middleware from './middleware';
import { Context } from './interfaces';
import { ISupportee } from './db';
import * as llm from './addons/llm';
import TelegramAddon from './addons/telegram';
import { isLkUserId } from './addons/lk/ids';
import * as log from 'fancy-log'

/**
 * Extracts ticket ID from the reply text.
 *
 * @param replyText - The text to extract the ticket ID from.
 * @returns The ticket ID as a string or undefined if not found.
 */
const extractTicketId = (replyText: string): string | undefined => {
  const match = replyText.match(new RegExp(`#T(.*) ${cache.config.language.from}`));
  return match ? match[1] : undefined;
};

/**
 * Finds the ticket a staff command is about: the forum topic it was sent in,
 * otherwise the ticket message it replies to.
 *
 * @param ctx - The bot context.
 * @returns The ticket, or null when the command names no ticket.
 */
async function staffCommandTicket(ctx: Context): Promise<ISupportee | null> {
  const threadId = (ctx.message as any)?.message_thread_id;
  if (cache.config.staff_forum_topics && threadId) {
    const ticket = await db.getTicketByThreadId(threadId);
    if (ticket) return ticket;
  }
  const reply = ctx.message?.reply_to_message;
  const replyText = reply?.text || reply?.caption;
  const ticketId = replyText ? extractTicketId(replyText) : undefined;
  if (!ticketId) return null;
  return db.getTicketById(parseInt(ticketId), ctx.session.groupCategory);
}

/**
 * Replies to a staff command in the topic it was sent from.
 *
 * @param ctx - The bot context.
 * @param text - The answer.
 */
function staffAnswer(ctx: Context, text: string) {
  const threadId = (ctx.message as any)?.message_thread_id;
  return middleware.sendMessage(ctx.chat.id, cache.config.staffchat_type, text, {
    ...(threadId ? { message_thread_id: threadId } : {}),
  });
}

/**
 * Turns the support assistant on or off for one ticket.
 *
 * Works where staff already work: inside the ticket's forum topic, or as a
 * reply to one of its messages. `/ai` alone reports the current state.
 *
 * @param ctx - The bot context.
 */
const aiCommand = async (ctx: Context): Promise<void> => {
  if (!ctx.session.admin) return;
  const language: any = cache.config.language;
  const answer = (text: string) => staffAnswer(ctx, text);

  const ticket = await staffCommandTicket(ctx);
  if (!ticket) {
    await answer(language.llmNoTicket || 'Команда работает в теме тикета или ответом на его сообщение.');
    return;
  }

  const argument = (ctx.message.text || '').toString().split(/\s+/)[1]?.toLowerCase();
  if (argument === 'off' || argument === 'on') {
    const off = argument === 'off';
    await db.setLlmOff(ticket.ticketId, off);
    await answer(off
      ? (language.llmTurnedOff || '🤖 ИИ отключён для этого тикета.')
      : (language.llmTurnedOn || '🤖 ИИ включён для этого тикета.'));
    return;
  }

  const state = !llm.isEnabled()
    ? (language.llmGloballyOff || '🤖 ИИ выключен в настройках бота.')
    : (ticket as any).llmOff
      ? (language.llmTurnedOff || '🤖 ИИ отключён для этого тикета.')
      : llm.inHandoff(ticket)
        ? (language.llmInHandoff || '🤖 Тикет ведёт оператор — ИИ временно молчит.')
        : (language.llmTurnedOn || '🤖 ИИ включён для этого тикета.');
  await answer(`${state}\n/ai on · /ai off`);
};

/**
 * Display help text depending on whether the user is an admin.
 *
 * @param ctx - The bot context.
 */
const helpCommand = (ctx: Context): void => {
  const { language, parse_mode } = cache.config;
  const text = ctx.session.admin ? language.helpCommandStaffText : language.helpCommandText;
  middleware.reply(ctx, text, { parse_mode });
};

/**
 * Close all open tickets.
 *
 * @param ctx - The bot context.
 */
const clearCommand = (ctx: Context): void => {
  if (!ctx.session.admin) return;
  db.closeAll();
  // Reset the ticket arrays
  cache.ticketIDs.length = 0;
  cache.ticketStatus.length = 0;
  cache.ticketSent.length = 0;
  middleware.reply(ctx, 'All tickets closed.');
};

/**
 * Display open tickets.
 *
 * @param ctx - The bot context.
 */
const openCommand = (ctx: Context): void => {
  if (!ctx.session.admin) return;
  const groups: string[] = [];
  const { categories, language } = cache.config;

  if (categories && categories.length > 0) {
    categories.forEach(category => {
      if (!category.subgroups) {
        if (category.group_id == ctx.chat.id) groups.push(category.name);
      } else {
        category.subgroups.forEach((sub: { group_id: any; name: string }) => {
          if (sub.group_id == ctx.chat.id) groups.push(sub.name);
        });
      }
    });
  }

  db.open((userList: any[]) => {
    let openTickets = '';
    userList.forEach(ticket => {
      if (ticket.userid != null) {
        let ticketInfo = '';
        const uidStr = ticket.userid.toString();
        if (uidStr.includes('WEB')) {
          ticketInfo = '(web)';
        } else if (uidStr.includes('SIGNAL')) {
          ticketInfo = '(signal)';
        }
        openTickets += `#T${ticket.id.toString().padStart(6, '0')} ${ticketInfo}\n`;
      }
    });
    middleware.reply(ctx, `*${language.openTickets}\n\n* ${openTickets}`);
  }, groups);
};

/**
 * Close a specific ticket.
 *
 * Works inside the ticket's forum topic (no reply needed) or as a reply to one
 * of its messages. Closes the topic too; it reopens when the customer writes.
 *
 * @param ctx - The bot context.
 */
const closeCommand = async (ctx: Context): Promise<void> => {
  if (!ctx.session.admin) return;
  const language: any = cache.config.language;

  const ticket = await staffCommandTicket(ctx);
  if (!ticket) {
    await staffAnswer(ctx, language.closeNoTicket || 'Команда работает в теме тикета или ответом на его сообщение.');
    return;
  }

  const paddedTicket = ticket.ticketId.toString().padStart(6, '0');
  const closedText = `${language.ticket} #T${paddedTicket} ${language.closed}`;
  await db.add(ticket.userid, 'closed', ticket.category, ticket.messenger);
  delete cache.ticketIDs[ticket.userid];
  delete cache.ticketStatus[ticket.userid];
  delete cache.ticketStatus[ticket.ticketId];
  delete cache.ticketSent[ticket.userid];
  delete cache.ticketSent[ticket.ticketId];
  await staffAnswer(ctx, closedText);

  // Cabinet-only customers never started this bot, so there is no chat to tell.
  if (!isLkUserId(ticket.userid) && !ticket.userid.includes('WEB')) {
    try {
      await middleware.sendMessage(
        ticket.userid,
        ticket.messenger,
        `${closedText}\n\n${language.ticketClosed}`,
      );
    } catch (e) {
      log.error('Could not tell the customer the ticket is closed: ', e);
    }
  }

  if (ticket.threadId && cache.config.staff_forum_topics) {
    await TelegramAddon.getInstance().closeForumTopic(cache.config.staffchat_id, ticket.threadId);
    await db.setTopicClosed(ticket.ticketId, true);
  }
};

/**
 * Ban a user based on a ticket.
 *
 * @param ctx - The bot context.
 */
const banCommand = (ctx: Context): void => {
  if (!ctx.session.admin) return;
  const replyText = ctx.message.reply_to_message.text;
  if (!replyText) return;
  const ticketId = extractTicketId(replyText);
  if (!ticketId) return;
  db.getByTicketId(ticketId, (ticket: { userid: any; id: { toString: () => string } }) => {
    db.add(ticket.userid, 'banned', '', ctx.messenger);
    middleware.sendMessage(
      ctx.chat.id,
      ctx.messenger,
      `${cache.config.language.usr_with_ticket} #T${ticketId.toString().padStart(6, '0')} ${cache.config.language.banned}`
    );
  });
};

/**
 * Reopen a closed ticket.
 *
 * @param ctx - The bot context.
 */
const reopenCommand = (ctx: Context): void => {
  if (!ctx.session.admin) return;
  const replyText = ctx.message.reply_to_message.text;
  if (!replyText) return;
  const ticketId = extractTicketId(replyText);
  if (!ticketId) return;
  db.getByTicketId(ticketId, (ticket: { userid: any; id: { toString: () => string } }) => {
    db.reopen(ticket.userid, '', ctx.messenger);
    middleware.sendMessage(
      ctx.chat.id,
      ctx.messenger,
      `${cache.config.language.usr_with_ticket} #T${ticket.id.toString().padStart(6, '0')} ${cache.config.language.ticketReopened}`
    );
  });
};

/**
 * Unban a user based on a ticket.
 *
 * @param ctx - The bot context.
 */
const unbanCommand = (ctx: Context): void => {
  if (!ctx.session.admin) return;
  const replyText = ctx.message.reply_to_message.text;
  if (!replyText) return;
  const ticketId = extractTicketId(replyText);
  if (!ticketId) return;
  db.getByTicketId(ticketId, (ticket: { userid: any; id: { toString: () => string } }) => {
    db.add(ticket.userid, 'closed', '', ctx.messenger);
    middleware.sendMessage(
      ctx.chat.id,
      ctx.messenger,
      `${cache.config.language.usr_with_ticket} #T${ticket.id.toString().padStart(6, '0')} unbanned`
    );
  });
};

export {
  aiCommand,
  banCommand,
  openCommand,
  closeCommand,
  unbanCommand,
  clearCommand,
  reopenCommand,
  helpCommand,
};
