/**
 * Outbound half of the cabinet bridge: mirrors ticket messages into the DJVPN
 * personal cabinet so the customer sees one coherent conversation there,
 * whichever side it was written from.
 *
 * Separate from `./index` on purpose: ticket handling (`users.ts`, `staff.ts`)
 * needs this, while the inbound server needs `text.ts` - keeping them in one
 * module would close an import cycle.
 */
import cache from '../../cache';
import * as log from 'fancy-log';

const WEBHOOK_TIMEOUT_MS = 8000;
const WEBHOOK_ATTEMPTS = 2;
/** Files are base64 in the body, so give them a longer write window. */
const FILE_TIMEOUT_MS = 30000;

export interface CabinetMessage {
  ticket_id: number;
  shm_user_id: number;
  direction: 'in' | 'out';
  text: string;
  author?: string;
  external_id: string;
  /** For staff answers: did the customer already get it in Telegram? */
  delivered_telegram?: boolean;
}

/** One attachment, carried inline - the bridge speaks JSON in both directions. */
export interface CabinetFile {
  name: string;
  mime: string;
  size: number;
  data_b64: string;
  /** Telegram file id, so staff can be re-sent the same file without a re-upload. */
  tg_file_id?: string;
}

export interface CabinetFileMessage extends CabinetMessage {
  file: CabinetFile;
}

export function config(): any {
  return (cache.config as any).lk_bridge || {};
}

export function isEnabled(): boolean {
  return config().enabled === true;
}

/**
 * Cabinet endpoint for mirrored files. Derived from `webhook_url` so an existing
 * config keeps working; `webhook_file_url` overrides it.
 */
export function fileWebhookUrl(): string {
  const c = config();
  if (c.webhook_file_url) return c.webhook_file_url;
  return c.webhook_url ? `${c.webhook_url}-file` : '';
}

/**
 * POSTs one payload to the cabinet with a couple of retries.
 *
 * @param url - Cabinet endpoint.
 * @param payload - JSON body.
 * @param timeoutMs - Per-attempt timeout.
 * @returns Whether the cabinet accepted it.
 */
async function post(url: string, payload: unknown, timeoutMs: number): Promise<boolean> {
  const c = config();
  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bridge-secret': c.secret || '',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (res.ok) return true;
      log.error(`lk: webhook rejected with ${res.status}`);
    } catch (e) {
      log.error(`lk: webhook attempt ${attempt} failed:`, e);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < WEBHOOK_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return false;
}

/**
 * Pushes one message to the cabinet. Best-effort with a couple of retries: a
 * customer with Telegram also gets staff answers there, so a lost webhook
 * degrades the cabinet history rather than losing the answer outright.
 *
 * @param payload - Message to mirror into the cabinet.
 */
export async function notifyCabinet(payload: CabinetMessage): Promise<void> {
  const c = config();
  if (!isEnabled() || !c.webhook_url || !payload.shm_user_id) return;
  await post(c.webhook_url, payload, WEBHOOK_TIMEOUT_MS);
}

/**
 * Pushes one message with an attachment to the cabinet.
 *
 * @param payload - Message and file to mirror into the cabinet.
 * @returns Whether the cabinet stored it - the caller may want to warn staff.
 */
export async function notifyCabinetFile(payload: CabinetFileMessage): Promise<boolean> {
  const url = fileWebhookUrl();
  if (!isEnabled() || !url || !payload.shm_user_id) return false;
  return post(url, payload, FILE_TIMEOUT_MS);
}
