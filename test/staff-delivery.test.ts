// An operator's answer that reached nobody must not look sent. A password with a
// "[" in it (ticket #46) was rejected by Telegram while staff read "ушёл в ЛК",
// although the ticket had no cabinet at all, and the ticket was closed anyway.
const mockSendMessage = jest.fn();
const mockNotifyCabinet = jest.fn();
const mockCloseForumTopic = jest.fn();
const db = {
  getTicketByThreadId: jest.fn(),
  getTicketById: jest.fn(),
  add: jest.fn(),
  setTopicClosed: jest.fn(),
  setStaffReplyAt: jest.fn(),
};
const mockRecord = jest.fn();

jest.mock('../src/middleware', () => ({
  sendMessage: mockSendMessage,
  reply: jest.fn(),
  strictEscape: (s: string) => s.replace(/([[_*`])/g, '\\$1'),
}));
jest.mock('../src/db', () => db);
jest.mock('../src/addons/llm', () => ({ history: { record: mockRecord } }));
jest.mock('../src/addons/lk/notify', () => ({ notifyCabinet: mockNotifyCabinet }));
jest.mock('../src/addons/telegram', () => ({
  __esModule: true,
  default: { getInstance: () => ({ closeForumTopic: mockCloseForumTopic }) },
}));
jest.mock('fancy-log', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/cache', () => ({
  config: {
    staffchat_id: '-100',
    staffchat_type: 'telegram',
    parse_mode: 'Markdown',
    auto_close_tickets: true,
    staff_forum_topics: true,
    language: { dear: 'Здравствуйте', regards: 'С уважением,', msg_sent: 'Отправлено' },
  },
  ticketIDs: {},
  ticketStatus: {},
  ticketSent: {},
}));

import { chat } from '../src/staff';

const ticket = (extra = {}) => ({
  ticketId: 46, userid: '515509085', messenger: 'telegram', name: 'Лиля', threadId: 625, shmUserId: null, ...extra,
});

const ctx = (text = 'a[b_c'): any => ({
  message: { message_id: 7, message_thread_id: 625, text, from: { id: 1, first_name: 'Op' } },
  chat: { id: -100, type: 'supergroup' },
  messenger: 'telegram',
  session: { admin: true, groupCategory: null },
});

const parseError = Object.assign(new Error('x'), { description: "Bad Request: can't parse entities: boom" });
const blocked = Object.assign(new Error('x'), { description: 'Forbidden: bot was blocked by the user' });
const toCustomer = () => mockSendMessage.mock.calls.filter((c) => c[0] === '515509085');
const toStaff = () => mockSendMessage.mock.calls.filter((c) => c[0] === -100);

describe('staff.chat delivery', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockSendMessage.mockResolvedValue('1');
    mockNotifyCabinet.mockResolvedValue(false);
    db.getTicketByThreadId.mockResolvedValue(ticket());
  });

  it('escapes markup and closes the ticket on a normal send', async () => {
    await chat(ctx());
    expect(toCustomer()).toHaveLength(1);
    expect(toCustomer()[0][2]).toContain('a\\[b\\_c');
    expect(db.add).toHaveBeenCalledWith(46, 'closed', null, 'telegram');
  });

  it('resends raw text without parse_mode when Telegram rejects the markup', async () => {
    mockSendMessage.mockRejectedValueOnce(parseError);
    await chat(ctx());
    expect(toCustomer()).toHaveLength(2);
    expect(toCustomer()[1][2]).toContain('a[b_c');
    expect(toCustomer()[1][3].parse_mode).toBeUndefined();
    expect(db.add).toHaveBeenCalledWith(46, 'closed', null, 'telegram');
  });

  it('warns staff and keeps the ticket open when nothing was delivered', async () => {
    mockSendMessage.mockImplementation(async (id: any) => {
      if (id === '515509085') throw blocked;
      return '1';
    });
    await chat(ctx());
    expect(toCustomer()).toHaveLength(1); // not a markup problem: no resend
    const notice = toStaff()[0];
    expect(notice[2]).toContain('НЕ доставлен');
    expect(notice[2]).toContain('blocked');
    expect(notice[2]).not.toContain('ЛК');
    expect(notice[3]).toEqual({ message_thread_id: 625 });
    expect(db.add).not.toHaveBeenCalled();
    expect(mockCloseForumTopic).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('says "ушёл в ЛК" only when the cabinet really stored the answer', async () => {
    db.getTicketByThreadId.mockResolvedValue(ticket({ shmUserId: 5 }));
    mockNotifyCabinet.mockResolvedValue(true);
    mockSendMessage.mockImplementation(async (id: any) => {
      if (id === '515509085') throw blocked;
      return '1';
    });
    await chat(ctx());
    expect(toStaff()[0][2]).toContain('ушёл в ЛК');
    expect(db.add).toHaveBeenCalled();
  });

  it('treats a failed cabinet webhook as undelivered', async () => {
    db.getTicketByThreadId.mockResolvedValue(ticket({ shmUserId: 5 }));
    mockSendMessage.mockImplementation(async (id: any) => {
      if (id === '515509085') throw blocked;
      return '1';
    });
    await chat(ctx());
    expect(toStaff()[0][2]).toContain('НЕ доставлен');
    expect(db.add).not.toHaveBeenCalled();
  });
});
