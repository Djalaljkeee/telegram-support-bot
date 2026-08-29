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

export function config(): any {
  return (cache.config as any).lk_bridge || {};
}

export function isEnabled(): boolean {
  return config().enabled === true;
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

  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(c.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bridge-secret': c.secret || '',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (res.ok) return;
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
}
