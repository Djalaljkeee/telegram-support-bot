/**
 * DJVPN-specific enrichment: pulls what a support ticket's author actually has,
 * from SHM billing and the Remnawave panel. Both over HTTP - no database access.
 *
 * Chain: telegram id -> SHM user with login '@<telegram id>' -> that user's
 * services -> Remnawave account `us_<user_service_id>`.
 *
 * Everything here is best-effort: any failure degrades to a shorter card (or
 * none at all) and never blocks the ticket from reaching the staff chat.
 */
import cache from '../../cache';
import * as log from 'fancy-log';

const NODE_CACHE_TTL_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 8000;
const MAX_SERVICES = 3;

let nodeNames: { at: number; map: Record<string, string> } = { at: 0, map: {} };

interface ShmUser {
  user_id: number;
  login: string;
  full_name: string | null;
  balance: number;
  block: number;
  created: string;
  last_login: string | null;
}

interface ShmService {
  user_service_id: number;
  name: string | null;
  status: string;
  expire: string | null;
}

function conf() {
  return (cache.config as any).djvpn || {};
}

export function isEnabled(): boolean {
  return conf().enabled === true;
}

/** Formats bytes as GB/TB, the way support actually talks about traffic. */
function humanBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 ГБ';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} ТБ`;
  if (gb >= 10) return `${gb.toFixed(0)} ГБ`;
  return `${gb.toFixed(2)} ГБ`;
}

function humanDate(d: string | null): string {
  if (!d) return '—';
  // SHM returns 'YYYY-MM-DD HH:MM:SS' (Moscow), the panel returns ISO-8601.
  const date = new Date(d.includes('T') ? d : d.replace(' ', 'T') + 'Z');
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** "через 26 дн." / "истекла 3 дн. назад" - the bit support reads first. */
function relativeDays(d: string | null): string {
  if (!d) return '';
  const date = new Date(d.includes('T') ? d : d.replace(' ', 'T') + 'Z');
  if (isNaN(date.getTime())) return '';
  const days = Math.round((date.getTime() - Date.now()) / 86400000);
  if (days > 0) return `через ${days} дн.`;
  if (days === 0) return 'сегодня';
  return `истекла ${Math.abs(days)} дн. назад`;
}

function humanAgo(iso: string | null): string {
  if (!iso) return 'не подключался';
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return 'не подключался';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'прямо сейчас';
  if (min < 60) return `${min} мин. назад`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ч. назад`;
  return `${Math.round(hours / 24)} дн. назад`;
}

async function httpJson(url: string, headers: Record<string, string>): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    log.error(`djvpn: request failed (${url.split('?')[0]}):`, e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls the SHM admin API. Its list endpoints filter through a JSON `filter`
 * query parameter - plain `?login=...` is silently ignored and returns
 * everything, which is a good way to leak another customer's data into a
 * ticket, so always go through here.
 *
 * @param path - API path below the SHM base url.
 * @param filter - Filter object, serialised into the `filter` parameter.
 * @returns The `data` array, or null on any failure.
 */
async function shm(path: string, filter: Record<string, any>): Promise<any[] | null> {
  const c = conf();
  if (!c.shm_url || !c.shm_login || !c.shm_password) return null;
  const auth = Buffer.from(`${c.shm_login}:${c.shm_password}`).toString('base64');
  const url = `${c.shm_url}${path}?filter=${encodeURIComponent(JSON.stringify(filter))}`;
  const body = await httpJson(url, { Authorization: `Basic ${auth}` });
  return body?.data ?? null;
}

async function panel(path: string): Promise<any | null> {
  const c = conf();
  if (!c.panel_url || !c.panel_token) return null;
  const body = await httpJson(`${c.panel_url}${path}`, {
    Authorization: `Bearer ${c.panel_token}`,
  });
  return body?.response ?? null;
}

/** uuid -> node name, so "last connected node" reads as a country, not a uuid. */
async function getNodeNames(): Promise<Record<string, string>> {
  if (Date.now() - nodeNames.at < NODE_CACHE_TTL_MS) return nodeNames.map;
  const res = await panel('/api/nodes');
  const nodes = Array.isArray(res) ? res : res?.nodes;
  if (!nodes) return nodeNames.map;
  const map: Record<string, string> = {};
  for (const n of nodes) map[n.uuid] = n.name;
  nodeNames = { at: Date.now(), map };
  return map;
}

/**
 * Builds the customer card for a ticket author.
 *
 * @param telegramId - Telegram user id of the ticket author.
 * @returns Plain-text card, or null when the lookup is off or broke down.
 */
export async function getCustomerCard(telegramId: string | number): Promise<string | null> {
  if (!isEnabled()) return null;
  try {
    const users = await shm('/shm/v1/admin/user', { login: `@${telegramId}` });
    if (users === null) {
      log.error('djvpn: SHM lookup unavailable');
      return null;
    }
    const user = users[0] as ShmUser | undefined;
    if (!user) {
      return `🔎 Клиент не найден в SHM по telegram id ${telegramId}\n` +
        '   (регистрация по e-mail или ещё не заводился)';
    }

    const lines: string[] = [];
    lines.push(`👤 ${user.full_name || '—'} · tg ${telegramId} · SHM #${user.user_id}`);
    lines.push(
      `💳 Баланс ${Number(user.balance).toFixed(2)} ₽ · ` +
      `${user.block ? '⛔ ЗАБЛОКИРОВАН' : 'не заблокирован'} · ` +
      `с ${humanDate(user.created)} · вход ${humanDate(user.last_login)}`,
    );

    // The pay list is newest-first but includes cancelled (0 ₽) attempts and
    // refunds (negative) - support cares about the last payment that landed.
    const pays = await shm('/shm/v1/admin/user/pay', { user_id: user.user_id });
    const lastPay = (pays || []).find((p: any) => Number(p.money) > 0);
    if (lastPay) {
      lines.push(
        `🧾 Последний платёж ${Number(lastPay.money).toFixed(2)} ₽ от ${humanDate(lastPay.date)}` +
        (lastPay.pay_system_id ? ` (${lastPay.pay_system_id})` : ''),
      );
    }

    const services = ((await shm('/shm/v1/admin/user/service', {
      user_id: user.user_id,
      status: 'ACTIVE',
    })) || []) as ShmService[];

    if (!services.length) {
      lines.push('📦 Активных услуг нет');
      return lines.join('\n');
    }

    const nodes = await getNodeNames();
    for (const svc of services.slice(0, MAX_SERVICES)) {
      lines.push('');
      lines.push(
        `📦 «${svc.name || 'услуга'}» · ${svc.status} · ` +
        `до ${humanDate(svc.expire)} (${relativeDays(svc.expire)})`,
      );

      const acc = await panel(`/api/users/by-username/us_${svc.user_service_id}`);
      const account = Array.isArray(acc) ? acc[0] : acc;
      if (!account) {
        lines.push(`   🔑 us_${svc.user_service_id} — в панели не найден`);
        continue;
      }

      const traffic = account.userTraffic || {};
      const used = humanBytes(traffic.usedTrafficBytes || 0);
      const limit = account.trafficLimitBytes
        ? ` из ${humanBytes(account.trafficLimitBytes)}`
        : ' (без лимита)';
      lines.push(`   🔑 ${account.username} · ${account.status} · до ${humanDate(account.expireAt)}`);
      lines.push(`   📊 Трафик ${used}${limit}`);
      const node = traffic.lastConnectedNodeUuid ? nodes[traffic.lastConnectedNodeUuid] : null;
      lines.push(
        `   🌐 Онлайн ${humanAgo(traffic.onlineAt || null)}` + (node ? ` · нода ${node}` : ''),
      );
      const squads = (account.activeInternalSquads || []).map((s: any) => s.name).join(', ');
      if (squads) lines.push(`   🗂 Сквады: ${squads}`);
      if (account.hwidDeviceLimit) lines.push(`   📱 Лимит устройств: ${account.hwidDeviceLimit}`);
      if (account.subscriptionUrl) lines.push(`   🔗 ${account.subscriptionUrl}`);
    }

    return lines.join('\n');
  } catch (e) {
    log.error('djvpn: customer card failed:', e);
    return null;
  }
}
