// The assistant's answer must only be reported to staff as delivered when the
// customer actually got it (ticket #18: Telegram rejected the Markdown, staff
// was told "the assistant answered", and nobody replied for two weeks).
const mockSendMessage = jest.fn();
const mockRecord = jest.fn();
const mockBuildAnswer = jest.fn();
const mockNotifyCabinet = jest.fn();

jest.mock('../src/middleware', () => ({
  sendMessage: mockSendMessage,
  reply: jest.fn(),
  strictEscape: jest.fn((str) => str),
  linkLabel: jest.fn((str) => str),
}));

jest.mock('../src/db', () => ({
  add: jest.fn(),
  getTicketByUserId: jest.fn(),
  addIdAndName: jest.fn(),
}));

jest.mock('../src/cache', () => ({
  config: {
    language: {
      ticket: 'Ticket',
      dear: 'Dear',
      regards: 'Regards',
      automatedReply: 'Automated reply',
      automatedReplyAuthor: 'Bot',
    },
    autoreply: [],
    use_llm: true,
    show_auto_replied: true,
    spam_cant_msg: 3,
    spam_time: 5000,
    staffchat_id: 'staff123',
    staffchat_type: 'telegram',
    parse_mode: 'Markdown',
  },
  userId: '',
  ticketIDs: [],
  ticketStatus: {},
  ticketSent: [],
}));

jest.mock('../src/addons/llm', () => ({
  isEnabled: jest.fn(() => true),
  inHandoff: jest.fn(() => false),
  buildAnswer: mockBuildAnswer,
  history: { record: mockRecord, recent: jest.fn(async () => []) },
}));

jest.mock('../src/addons/lk/notify', () => ({
  notifyCabinet: mockNotifyCabinet,
}));

jest.mock('../src/topics', () => ({
  staffChatExtra: jest.fn(async () => ({})),
}));

jest.mock('fancy-log', () => ({ info: jest.fn(), error: jest.fn() }));

import * as users from '../src/users';
import * as db from '../src/db';
import cache from '../src/cache';

const ANSWER = 'Оплатить можно через @Dj_VPN_bot.';

function ctx(): any {
  return {
    message: {
      text: 'Как оплатить?',
      from: { id: '5053991263', first_name: 'Nik_333', language_code: 'ru' },
      chat: { id: '5053991263', type: 'private' },
      message_id: 7,
    },
    messenger: 'telegram',
    session: { groupCategory: null, groupTag: '', group: '' },
  };
}

function staffNotes(): string[] {
  return mockSendMessage.mock.calls
    .filter(([id, , text]) => id === 'staff123' && !String(text).includes('#T'))
    .map(([, , text]) => String(text));
}

describe('assistant answer delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cache.ticketIDs = [];
    cache.ticketStatus = {};
    cache.ticketSent = [];
    // Past the first message: chat() only forwards to staff, then the assistant runs.
    (cache.ticketSent as any)['5053991263'] = 1;
    mockBuildAnswer.mockResolvedValue({ text: ANSWER, confident: true, reason: '' });
  });

  function ticket(extra: object = {}) {
    (db.getTicketByUserId as jest.Mock).mockResolvedValue({
      ticketId: 18,
      userid: '5053991263',
      messenger: 'telegram',
      threadId: 213,
      ...extra,
    });
  }

  it('reports an answer that reached the customer', async () => {
    ticket();
    mockSendMessage.mockResolvedValue('ok');

    await users.chat(ctx(), { id: '5053991263' });

    expect(mockRecord).toHaveBeenCalledWith(18, 'assistant', ANSWER);
    expect(staffNotes()).toEqual([expect.stringContaining('ИИ ответил клиенту')]);
  });

  it('hands a rejected answer to the operator instead of claiming it was sent', async () => {
    ticket();
    mockSendMessage.mockImplementation(async (id: string) => {
      if (id === '5053991263') {
        throw { description: "Bad Request: can't parse entities" };
      }
      return 'ok';
    });

    await users.chat(ctx(), { id: '5053991263' });

    expect(mockRecord).not.toHaveBeenCalledWith(18, 'assistant', expect.anything());
    const notes = staffNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('НЕ доставлен');
    expect(notes[0]).toContain("can't parse entities");
    expect(notes[0]).toContain(ANSWER);
    expect(notes[0]).not.toContain('ИИ ответил клиенту');
  });

  it('says the answer went to the cabinet only when Telegram rejected it', async () => {
    ticket({ shmUserId: 42 });
    mockSendMessage.mockImplementation(async (id: string) => {
      if (id === '5053991263') throw new Error('Forbidden: bot was blocked by the user');
      return 'ok';
    });

    await users.chat(ctx(), { id: '5053991263' });

    expect(mockNotifyCabinet).toHaveBeenCalledWith(
      expect.objectContaining({ ticket_id: 18, delivered_telegram: false }),
    );
    expect(mockRecord).toHaveBeenCalledWith(18, 'assistant', ANSWER);
    const notes = staffNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('только в ЛК');
    expect(notes[0]).toContain('bot was blocked');
  });
});
