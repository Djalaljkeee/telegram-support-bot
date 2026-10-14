import cache from './cache';
import { isLkUserId } from './addons/lk/ids';
import SignalAddon from './addons/signal';
import { Context, Messenger } from './interfaces';
import TelegramAddon from './addons/telegram';

/**
 * Escapes special characters for MarkdownV2, HTML, or Markdown formats.
 *
 * @param str - The string to escape.
 * @returns The escaped string.
 */
const strictEscape = (str: string): string => {
  const { parse_mode } = cache.config;
  switch (parse_mode) {
    case 'MarkdownV2':
      // Escape all special MarkdownV2 characters
      return str.replace(/([[\]()_*~`>#+\-=\|{}.!\\])/g, '\\$1');
    case 'HTML':
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'); // Escape single quotes
    case 'Markdown':
      // Legacy Markdown: only _ * ` [ are special, and a backslash escapes
      // them. (This used to be '\$1', which JS reads as plain '$1' - a no-op,
      // so a lone underscore in a name made Telegram reject the whole message.)
      return str.replace(/([[_*`])/g, '\\$1');
    default:
      return str.toString();
  }
};

/**
 * Escapes text that goes inside the [label](url) of a link.
 *
 * Legacy Markdown has no escapes inside an entity - a backslash there would be
 * shown as is - so for it only the brackets that would end the label are
 * dropped. The other modes escape as usual.
 *
 * @param str - The link label.
 * @returns The label, safe to put between [ and ].
 */
const linkLabel = (str: string): string =>
  cache.config.parse_mode === 'Markdown'
    ? str.replace(/[[\]]/g, '')
    : strictEscape(str);

/**
 * Sends a message through the appropriate messenger addon.
 *
 * @param id - The target identifier.
 * @param messenger - The messenger type.
 * @param msg - The message text.
 * @param extra - Extra options (default includes the configured parse mode).
 */
async function sendMessage (
  id: string | number,
  messenger: string,
  msg: string,
  extra: any = { parse_mode: cache.config.parse_mode }
): Promise<string | null> {
  const messengerType = messenger as Messenger;
  // Cabinet-only customers have no Telegram chat to deliver to - their copy
  // travels through the cabinet webhook instead (see addons/lk/notify).
  if (isLkUserId(id)) return null;

  // Remove extra spaces
  const cleanedMsg = msg.replace(/ {2,}/g, ' ');
  
  switch (messengerType) {  
    case Messenger.TELEGRAM:
      return await TelegramAddon.getInstance().sendMessage(id, cleanedMsg, extra);
    case Messenger.SIGNAL:
      return await SignalAddon.getInstance().sendMessage(id, cleanedMsg, extra);
    case Messenger.WEB: {
      const socketId = id.toString().split('WEB')[1];
      cache.io.to(socketId).emit('chat_staff', cleanedMsg);
      return null;
    }
    default:
      throw new Error('Invalid messenger type');
  }
};

/**
 * Replies to a message within the given context.
 *
 * @param ctx - The message context.
 * @param msgText - The reply text.
 * @param extra - Extra options (default includes the configured parse mode).
 */
const reply = (
  ctx: Context,
  msgText: string,
  extra: any = { parse_mode: cache.config.parse_mode }
): void => {
  sendMessage(ctx.message.chat.id, ctx.messenger, msgText, extra);
};

export { strictEscape, linkLabel, sendMessage, reply };
