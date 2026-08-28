/**
 * Ticket ids for customers who write from the DJVPN personal cabinet.
 *
 * A customer with a linked Telegram account keeps their Telegram id as the
 * ticket's userid, so a question asked in the cabinet lands in the very same
 * ticket (and forum topic) as their Telegram conversation. Only customers
 * without Telegram - the ones registered by e-mail - get a cabinet-only id.
 *
 * Kept in its own module without imports: middleware needs these helpers, and
 * the bridge itself pulls in middleware transitively.
 */
const LK_PREFIX = 'lk_';

/**
 * Ticket userid for a cabinet customer who has no Telegram account.
 *
 * @param shmUserId - SHM user id.
 */
export function lkUserId(shmUserId: number | string): string {
  return `${LK_PREFIX}${shmUserId}`;
}

/**
 * True for cabinet-only ticket userids - these cannot be delivered to Telegram.
 *
 * @param userid - Ticket userid.
 */
export function isLkUserId(userid: string | number): boolean {
  return typeof userid === 'string' && userid.startsWith(LK_PREFIX);
}

/**
 * SHM user id behind a cabinet-only userid, or null for anything else.
 *
 * @param userid - Ticket userid.
 */
export function shmUserIdFromLkUserId(userid: string): number | null {
  if (!isLkUserId(userid)) return null;
  const id = parseInt(userid.slice(LK_PREFIX.length), 10);
  return isNaN(id) ? null : id;
}
