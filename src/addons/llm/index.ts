/**
 * The support assistant.
 *
 * It answers a customer only when the answer follows from the knowledge base or
 * from that customer's own account data - everything else is handed to a human,
 * with a one-line note in the ticket's topic saying why. That gate is the whole
 * point: a VPN support bot that confidently invents prices, refund rules or
 * router settings costs more than one that stays quiet.
 *
 * It also steps aside while a human is in the conversation (see `handoff`), and
 * can be switched off per ticket with /ai off.
 */
import cache from '../../cache';
import type { Context } from '../../interfaces';
import type { ISupportee } from '../../db';
import * as djvpn from '../djvpn';
import { isLkUserId, shmUserIdFromLkUserId } from '../lk/ids';
import { ChatMessage, getProvider } from './provider';
import * as knowledge from './knowledge';
import * as history from './history';
import * as log from 'fancy-log';

export { history, knowledge };

const DEFAULT_HISTORY_MESSAGES = 20;
const DEFAULT_HANDOFF_MINUTES = 180;
const DEFAULT_MAX_ANSWER_CHARS = 900;
const DEFAULT_KNOWLEDGE_BUDGET = 12000;
const CARD_TTL_MS = 5 * 60 * 1000;

/** Customer cards cost several HTTP calls; one per ticket per few minutes is
 * plenty for a conversation. */
const cardCache = new Map<number, { at: number; card: string | null }>();

export interface AiAnswer {
  /** The answer itself, or an operator-facing draft when not confident. */
  text: string;
  /** Whether it may be sent to the customer. */
  confident: boolean;
  /** One line for the operator: what the customer needs. */
  reason: string;
}

function conf() {
  return cache.config as any;
}

/** Whether the assistant is configured and switched on. */
export function isEnabled(): boolean {
  return conf().use_llm === true && getProvider() !== null && knowledge.isConfigured();
}

/**
 * Whether a human is currently handling this ticket.
 *
 * A staff answer silences the assistant for a while, so it cannot talk over an
 * operator mid-conversation; the window is short enough that a customer coming
 * back next week is served automatically again.
 *
 * @param ticket - The ticket to check.
 * @returns True while the assistant should stay quiet.
 */
export function inHandoff(ticket: ISupportee): boolean {
  const minutes = Number(conf().llm_handoff_minutes ?? DEFAULT_HANDOFF_MINUTES);
  const last = (ticket as any).lastStaffReplyAt;
  if (!minutes || !last) return false;
  return Date.now() - new Date(last).getTime() < minutes * 60 * 1000;
}

/**
 * The customer's own account data, as shown on the staff card.
 *
 * @param ticket - Ticket whose author to look up.
 * @returns Card text, or null when the lookup is off or failed.
 */
async function customerCard(ticket: ISupportee): Promise<string | null> {
  const cached = cardCache.get(ticket.ticketId);
  if (cached && Date.now() - cached.at < CARD_TTL_MS) return cached.card;

  const userid = ticket.userid;
  const card = await djvpn.getCustomerCard(
    isLkUserId(userid)
      ? { shmUserId: ticket.shmUserId ?? shmUserIdFromLkUserId(userid) }
      : { telegramId: userid, shmUserId: ticket.shmUserId },
  );
  cardCache.set(ticket.ticketId, { at: Date.now(), card });
  return card;
}

const SYSTEM_RULES = `Ты — оператор поддержки VPN-сервиса DJ VPN. Отвечай по-русски, на «вы», коротко (до 5 предложений), по делу, без приветствий и без подписи.

Отвечай ТОЛЬКО тем, что прямо написано в базе знаний ниже или в данных клиента. Ничего не додумывай: ни цен, ни сроков, ни ссылок, ни настроек, которых там нет. Данные клиента принадлежат ему самому — можно назвать его тариф, дату окончания и статус, но не пересылай карточку целиком и не упоминай внутренние идентификаторы.

Верни ТОЛЬКО JSON-объект, без пояснений вокруг:
{"confident": true|false, "answer": "текст для клиента", "reason": "одна строка для оператора"}

confident=true — только если ответ полностью следует из базы знаний или данных клиента и действительно закрывает вопрос.

confident=false — если данных не хватает, вопрос требует действий или проверки на нашей стороне (возврат, перерасчёт, спорное списание, смена тарифа, промокод, блокировка, жалоба, проверка маршрута или сервера, настройка роутера под модель), если речь о деньгах или персональных данных, если клиент раздражён или просит человека. В этом случае в answer положи черновик для оператора, а в reason — что от оператора требуется.`;

/**
 * Turns stored history into chat messages.
 *
 * @param rows - History rows, oldest first.
 * @returns Messages for the provider.
 */
function historyMessages(rows: history.ILlmMessage[]): ChatMessage[] {
  return rows.map((row) => {
    if (row.role === 'customer') return { role: 'user' as const, content: row.text };
    const who = row.role === 'staff' ? 'Оператор' : 'Бот';
    return { role: 'assistant' as const, content: `${who}: ${row.text}` };
  });
}

/**
 * Reads the model's JSON verdict, tolerating the usual noise around it.
 *
 * @param raw - Raw completion text.
 * @returns The parsed answer, or null when it is unusable.
 */
export function parseVerdict(raw: string): AiAnswer | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let data: any;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const text = (data.answer ?? '').toString().trim();
  const reason = (data.reason ?? '').toString().trim();
  // A string "false" is truthy, and models do send one.
  const confident = data.confident === true || data.confident === 'true';
  if (!text && !reason) return null;
  const max = Number(conf().llm_max_answer_chars) || DEFAULT_MAX_ANSWER_CHARS;
  return { text: text.slice(0, max), confident: confident && text.length > 0, reason };
}

/**
 * Produces an answer for the customer's latest message.
 *
 * The caller decides what to do with it: a confident answer is sent to the
 * customer, anything else is a hint for the operator.
 *
 * @param ctx - Bot context of the incoming message.
 * @param ticket - The ticket it belongs to.
 * @returns The verdict, or null when the assistant has nothing to say.
 */
export async function buildAnswer(ctx: Context, ticket: ISupportee): Promise<AiAnswer | null> {
  if (!isEnabled() || !ticket) return null;
  if ((ticket as any).llmOff) return null;
  if (inHandoff(ticket)) return null;

  const question = (ctx.message?.text || '').toString().trim();
  if (!question) return null;

  const provider = getProvider();
  if (!provider) return null;

  try {
    const [card, rows] = await Promise.all([
      customerCard(ticket),
      history.recent(
        ticket.ticketId,
        Number(conf().llm_history_messages) || DEFAULT_HISTORY_MESSAGES,
      ),
    ]);

    const budget = Number(conf().llm_knowledge_chars) || DEFAULT_KNOWLEDGE_BUDGET;
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_RULES },
      { role: 'system', content: `База знаний:\n\n${knowledge.relevant(question, budget)}` },
    ];
    if (card) {
      messages.push({ role: 'system', content: `Данные этого клиента:\n\n${card}` });
    }
    // The current message is already the last history row (users.ts records it
    // before asking), so history alone carries the conversation.
    messages.push(...historyMessages(rows));
    if (!rows.length || rows[rows.length - 1].text !== question) {
      messages.push({ role: 'user', content: question });
    }

    const raw = await provider.chat(messages);
    const verdict = parseVerdict(raw);
    if (!verdict) {
      log.error(`llm: unusable completion: ${raw.slice(0, 200)}`);
      return null;
    }
    return verdict;
  } catch (e) {
    log.error('llm: could not build an answer:', e);
    return null;
  }
}

/** Drops cached customer cards. Used by tests. */
export function resetCache(): void {
  cardCache.clear();
}
