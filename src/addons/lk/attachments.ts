/**
 * Attachments on the cabinet bridge.
 *
 * Screenshots are how a support conversation usually gets to the point, so a
 * file has to cross the bridge in both directions: what a customer uploads in
 * the cabinet widget lands in the ticket's forum topic, and what is sent in
 * Telegram (by the customer or by staff) is mirrored into the cabinet history.
 *
 * Files travel as base64 inside the JSON body. Multipart would save a third of
 * the bytes, but at a handful of screenshots a day that is not worth another
 * dependency on either side of the bridge.
 */
import TelegramAddon from '../telegram';
import { notifyCabinet, notifyCabinetFile } from './notify';
import * as log from 'fancy-log';

/**
 * Hard cap for a file crossing the bridge, matching `SUPPORT_MAX_UPLOAD_MB` in
 * the cabinet. Bigger files stay in Telegram and are announced in the cabinet
 * as a line of text.
 */
export const MAX_CABINET_FILE_BYTES = 10 * 1024 * 1024;

/** What we know about a file sitting in Telegram. */
export interface TelegramFileRef {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * How the file should be sent to Telegram: photos render inline in the chat,
 * everything else is a document. GIF and SVG go as documents on purpose -
 * Telegram turns the first into a muted animation and refuses the second.
 *
 * @param mime - Content type.
 * @param name - File name.
 */
export function kindFor(mime: string, name: string): 'photo' | 'document' {
  const type = (mime || '').toLowerCase();
  const inlineImage =
    type === 'image/jpeg' || type === 'image/png' || type === 'image/webp';
  if (inlineImage) return 'photo';
  if (!type && /\.(jpe?g|png|webp)$/i.test(name || '')) return 'photo';
  return 'document';
}

/**
 * Pulls the file out of a Telegram message.
 *
 * @param message - Telegram message.
 * @param type - Handler type: 'photo', 'document' or 'video'.
 * @returns The file reference, or null when the message carries no file.
 */
export function fileRefFromMessage(message: any, type: string): TelegramFileRef | null {
  if (!message) return null;
  if (type === 'photo') {
    // Telegram sends every rendered size; the last one is the original.
    const sizes = message.photo || [];
    const best = sizes[sizes.length - 1];
    if (!best) return null;
    return {
      fileId: best.file_id,
      name: `screenshot-${message.message_id || Date.now()}.jpg`,
      mime: 'image/jpeg',
      size: best.file_size || 0,
    };
  }
  if (type === 'document' && message.document) {
    const doc = message.document;
    return {
      fileId: doc.file_id,
      name: doc.file_name || `file-${message.message_id || Date.now()}`,
      mime: doc.mime_type || 'application/octet-stream',
      size: doc.file_size || 0,
    };
  }
  if (type === 'video' && message.video) {
    const video = message.video;
    return {
      fileId: video.file_id,
      name: video.file_name || `video-${message.message_id || Date.now()}.mp4`,
      mime: video.mime_type || 'video/mp4',
      size: video.file_size || 0,
    };
  }
  return null;
}

/** Human-readable size for the "too big for the cabinet" note. */
function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/**
 * Mirrors a Telegram file into the cabinet.
 *
 * Best-effort, like every webhook here: a failure costs the cabinet copy of the
 * file, never the Telegram conversation. A file too large to carry is announced
 * as a line of text instead, so the customer at least knows it exists.
 *
 * @param opts.ticketId - Ticket the file belongs to.
 * @param opts.shmUserId - Cabinet customer, or null when the ticket has none.
 * @param opts.ref - The file in Telegram.
 * @param opts.caption - Caption written next to the file.
 * @param opts.direction - 'in' from the customer, 'out' from staff.
 * @param opts.externalId - Idempotency key, unique per Telegram message.
 * @param opts.author - Staff name shown in the cabinet.
 * @param opts.deliveredTelegram - Whether the customer already got it in Telegram.
 * @returns Whether the file itself reached the cabinet.
 */
export async function mirrorTelegramFile(opts: {
  ticketId: number;
  shmUserId: number | null;
  ref: TelegramFileRef;
  caption: string;
  direction: 'in' | 'out';
  externalId: string;
  author?: string;
  deliveredTelegram?: boolean;
}): Promise<boolean> {
  const { ticketId, shmUserId, ref, caption, direction, externalId } = opts;
  if (!shmUserId) return false;

  const base = {
    ticket_id: ticketId,
    shm_user_id: shmUserId,
    direction,
    text: caption || '',
    author: opts.author,
    external_id: externalId,
    delivered_telegram: opts.deliveredTelegram,
  };

  if (ref.size && ref.size > MAX_CABINET_FILE_BYTES) {
    await notifyCabinet({
      ...base,
      text: `📎 ${ref.name} (${humanSize(ref.size)}) — файл слишком большой для кабинета, он есть в Telegram.${
        caption ? `\n${caption}` : ''
      }`,
    });
    return false;
  }

  let data: Buffer | null = null;
  try {
    data = await TelegramAddon.getInstance().fetchFile(ref.fileId);
  } catch (e) {
    log.error('lk: could not download a Telegram file:', e);
  }
  if (!data) {
    await notifyCabinet({
      ...base,
      text: `📎 ${ref.name} — файл не удалось перенести в кабинет, он есть в Telegram.${
        caption ? `\n${caption}` : ''
      }`,
    });
    return false;
  }

  return notifyCabinetFile({
    ...base,
    file: {
      name: ref.name,
      mime: ref.mime,
      size: data.length,
      data_b64: data.toString('base64'),
      tg_file_id: ref.fileId,
    },
  });
}
