/**
 * Bridge between the DJVPN personal cabinet (lk.djvpn.ru) and this bot.
 *
 * Inbound: the cabinet backend POSTs a customer's message here, and it walks
 * the exact same path as a Telegram message - same ticket, same forum topic,
 * same customer card. Staff cannot tell the difference beyond a source tag.
 *
 * Outbound: every staff answer (and every Telegram-side message of a ticket the
 * cabinet knows about) is pushed to the cabinet so the customer sees one
 * coherent conversation there, whichever side it was written from.
 *
 * The server is meant to be reachable only over the internal docker network -
 * do not publish its port. The shared secret is the second line of defence.
 */
import express from 'express';
import crypto from 'crypto';
import cache from '../../cache';
import * as db from '../../db';
import { ticketHandler } from '../../text';
import TelegramAddon from '../telegram';
import { Context, Messenger, SessionData } from '../../interfaces';
import { lkUserId } from './ids';
import { config as conf, isEnabled } from './notify';
import { MAX_CABINET_FILE_BYTES, kindFor } from './attachments';
import { staffChatExtra } from '../../topics';
import * as log from 'fancy-log';

const DEDUPE_TTL_MS = 10 * 60 * 1000;

/** client_msg_id -> when it was accepted, so retries do not double-post. */
const seenMessages = new Map<string, { at: number; ticketId: number }>();

/**
 * Ticket handling runs through module-level state (`cache.userId`,
 * `cache.ticketSent`), so two messages processed concurrently can interleave and
 * mix up whose ticket is whose. Cabinet traffic is tiny, so we simply handle one
 * at a time instead of rewriting the upstream bookkeeping.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

interface LkMessageBody {
  shm_user_id: number;
  telegram_id?: number | string | null;
  name?: string;
  text: string;
  client_msg_id: string;
}

interface LkAttachmentBody {
  shm_user_id: number;
  telegram_id?: number | string | null;
  name?: string;
  /** Text the customer wrote next to the file. Optional. */
  caption?: string;
  client_msg_id: string;
  file: {
    name: string;
    mime: string;
    size?: number;
    /** File contents, base64. */
    data_b64: string;
  };
}

/** Telegram truncates captions at 1024 characters. */
const MAX_CAPTION = 1000;

/** Constant-time secret comparison - a plain === leaks length and prefix. */
function secretOk(given: string | undefined): boolean {
  const expected: string = conf().secret || '';
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sweepSeen() {
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [key, value] of seenMessages) {
    if (value.at < cutoff) seenMessages.delete(key);
  }
}

/**
 * Builds a per-request context for one cabinet message.
 *
 * Deliberately NOT a shared singleton: the upstream web addon reuses one
 * `fakectx` for every visitor, and since ticket handling is async, a second
 * visitor overwrites the first one's message mid-flight and it ends up in a
 * stranger's ticket.
 *
 * @param userid - Ticket userid (Telegram id, or lk_<shm user id>).
 * @param name - Customer's display name.
 * @param text - Message text.
 */
function buildContext(userid: string, name: string, text: string): Context {
  const from = {
    id: userid,
    is_bot: false as const,
    first_name: name,
    username: '',
    language_code: 'ru',
  };
  const chat = { id: userid, first_name: name, username: '', type: 'private' };

  return {
    update_id: 0,
    messenger: Messenger.TELEGRAM,
    // Marks the message as already known to the cabinet, so it is not mirrored
    // straight back to it (see users.mirrorIncoming).
    lkOrigin: true,
    message: {
      web_msg: false,
      message_id: 0,
      from,
      chat,
      date: Math.floor(Date.now() / 1000),
      text,
      reply_to_message: { from: { is_bot: false }, text: '', caption: '' },
      external_reply: { message_id: 0 },
      getFile: () => {},
      caption: '',
    },
    chat,
    session: {
      admin: false,
      mode: null,
      modeData: {} as any,
      // Suppresses the "thanks for contacting us" auto-reply: the customer is
      // looking at the cabinet widget, which confirms the send itself, and a
      // duplicate landing in their Telegram would only confuse them.
      lastContactDate: Date.now(),
      groupCategory: null,
      groupTag: '· из ЛК',
      group: '',
      groupAdmin: {} as any,
      getSessionKey: () => null,
    } as SessionData,
    callbackQuery: { data: '', from: { id: '' }, id: '' },
    from: { username: '', id: userid },
    inlineQuery: () => {},
    answerCbQuery: () => {},
    reply: () => {},
    getChat: () => {},
    getFile: () => {},
  } as Context;
}

/** Resolves the ticket for a cabinet customer, creating it when needed. */
async function ensureTicket(userid: string, shmUserId: number) {
  let ticket = await db.getTicketByUserId(userid, null);
  if (!ticket) {
    await db.add(userid, 'open', null, Messenger.TELEGRAM);
    ticket = await db.getTicketByUserId(userid, null);
  } else if (ticket.status !== 'open') {
    // auto_close_tickets closes a ticket after every answer, so a returning
    // customer would otherwise keep writing into a 'closed' one - invisible to
    // /open and misreported to the cabinet. ticketHandler() does the same for
    // messages arriving over Telegram.
    await db.add(userid, 'open', null, Messenger.TELEGRAM);
    ticket.status = 'open';
  }
  if (!ticket) return null;
  // Remember who this is on the cabinet side: from now on staff answers to this
  // ticket are mirrored there, even the ones written from Telegram.
  if (ticket.shmUserId !== shmUserId) {
    await db.setShmUserId(ticket.ticketId, shmUserId);
    ticket.shmUserId = shmUserId;
  }
  return ticket;
}

async function handleMessage(req: express.Request, res: express.Response) {
  const body = req.body as LkMessageBody;
  if (!body || !body.text || !body.shm_user_id || !body.client_msg_id) {
    return res.status(400).json({ error: 'shm_user_id, text and client_msg_id are required' });
  }
  const text = String(body.text).slice(0, 4000);

  sweepSeen();
  const seen = seenMessages.get(body.client_msg_id);
  if (seen) {
    return res.json({ ok: true, ticket_id: seen.ticketId, duplicate: true });
  }

  const userid = body.telegram_id
    ? String(body.telegram_id)
    : lkUserId(body.shm_user_id);

  const banned = await new Promise<boolean>((resolve) => {
    db.checkBan(userid, Messenger.TELEGRAM, (ticket: any) => resolve(!!ticket));
  });
  if (banned) {
    return res.status(403).json({ error: 'banned' });
  }

  const ticket = await ensureTicket(userid, Number(body.shm_user_id));
  if (!ticket) {
    return res.status(500).json({ error: 'could not create ticket' });
  }

  const ctx = buildContext(userid, body.name || `Клиент #${body.shm_user_id}`, text);
  await serialize(() => ticketHandler(TelegramAddon.getInstance(), ctx));

  seenMessages.set(body.client_msg_id, { at: Date.now(), ticketId: ticket.ticketId });
  return res.json({ ok: true, ticket_id: ticket.ticketId });
}

/**
 * Serves one file uploaded in the cabinet widget: it goes into the ticket's
 * forum topic, next to everything the customer wrote in Telegram.
 *
 * The file arrives base64-encoded in the JSON body - see ./attachments for why.
 */
async function handleAttachment(req: express.Request, res: express.Response) {
  const body = req.body as LkAttachmentBody;
  const file = body?.file;
  if (!body || !body.shm_user_id || !body.client_msg_id || !file || !file.data_b64) {
    return res
      .status(400)
      .json({ error: 'shm_user_id, client_msg_id and file.data_b64 are required' });
  }

  const data = Buffer.from(file.data_b64, 'base64');
  if (!data.length) return res.status(400).json({ error: 'empty file' });
  if (data.length > MAX_CABINET_FILE_BYTES) {
    return res.status(413).json({ error: 'file too large' });
  }

  sweepSeen();
  const seen = seenMessages.get(body.client_msg_id);
  if (seen) {
    return res.json({ ok: true, ticket_id: seen.ticketId, duplicate: true });
  }

  const userid = body.telegram_id
    ? String(body.telegram_id)
    : lkUserId(body.shm_user_id);

  const banned = await new Promise<boolean>((resolve) => {
    db.checkBan(userid, Messenger.TELEGRAM, (ticket: any) => resolve(!!ticket));
  });
  if (banned) {
    return res.status(403).json({ error: 'banned' });
  }

  const name = body.name || `Клиент #${body.shm_user_id}`;
  const ticket = await ensureTicket(userid, Number(body.shm_user_id));
  if (!ticket) {
    return res.status(500).json({ error: 'could not create ticket' });
  }

  const caption = String(body.caption || '').slice(0, MAX_CAPTION);
  const { config: cfg } = cache;
  const fileName = String(file.name || 'file').slice(0, 128);
  const header =
    `${cfg.language.ticket} #T${ticket.ticketId.toString().padStart(6, '0')} ` +
    `${cfg.language.from} ${name} · из ЛК`;

  const messageId = await serialize(async () => {
    // The topic (and the customer card in it) is created here on first contact,
    // exactly as it would be for a text message.
    const extra = await staffChatExtra(ticket, buildContext(userid, name, caption));
    return TelegramAddon.getInstance().sendMedia(
      cfg.staffchat_id,
      kindFor(file.mime, fileName),
      TelegramAddon.getInstance().inputFile(data, fileName),
      {
        // No parse_mode on purpose: the caption carries a raw file name and raw
        // customer text, and a single stray underscore would fail the send.
        caption: `${header}\n\n${caption}`.slice(0, MAX_CAPTION),
        ...(extra.message_thread_id ? { message_thread_id: extra.message_thread_id } : {}),
      },
    );
  });

  // Staff answer to this file by replying to it, so it needs to be findable.
  db.addIdAndName(ticket.ticketId, messageId, name);
  seenMessages.set(body.client_msg_id, { at: Date.now(), ticketId: ticket.ticketId });
  return res.json({ ok: true, ticket_id: ticket.ticketId });
}

/** Starts the bridge server. No-op unless `lk_bridge.enabled` is set. */
export function init(): void {
  const c = conf();
  if (!isEnabled()) return;
  if (!c.secret) {
    log.error('lk: lk_bridge.secret is not set, bridge disabled');
    return;
  }

  const app = express();

  app.get('/lk/health', (_req, res) => res.json({ ok: true }));

  app.post('/lk/message', express.json({ limit: '64kb' }), (req, res) => {
    if (!secretOk(req.header('x-bridge-secret'))) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    handleMessage(req, res).catch((e) => {
      log.error('lk: message handling failed:', e);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  });

  // Base64 inflates a 10 MB file to ~13.4 MB, plus the envelope around it.
  app.post('/lk/attachment', express.json({ limit: '20mb' }), (req, res) => {
    if (!secretOk(req.header('x-bridge-secret'))) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    handleAttachment(req, res).catch((e) => {
      log.error('lk: attachment handling failed:', e);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  });

  const port = c.port || 8081;
  app.listen(port, () => log.info(`LK bridge listening on ${port}`));
}
