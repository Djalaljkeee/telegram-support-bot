// /close sent in a customer's forum topic must close that ticket and its topic.
// Upstream /close required a reply to a bot message carrying "#T… From:", so in
// a topic it returned silently; and it told the closing message to whichever
// customer came last in the open-ticket list.
const mockSendMessage = jest.fn().mockResolvedValue('1');
const mockCloseForumTopic = jest.fn();
const db = {
  getTicketByThreadId: jest.fn(),
  getTicketById: jest.fn(),
  add: jest.fn(),
  setTopicClosed: jest.fn(),
};

jest.mock('../src/middleware', () => ({ sendMessage: mockSendMessage, reply: jest.fn() }));
jest.mock('../src/db', () => db);
jest.mock('../src/addons/llm', () => ({}));
jest.mock('../src/addons/telegram', () => ({
  __esModule: true,
  default: { getInstance: () => ({ closeForumTopic: mockCloseForumTopic }) },
}));
jest.mock('fancy-log', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/cache', () => ({
  config: {
    staffchat_id: '-100',
    staffchat_type: 'telegram',
    staff_forum_topics: true,
    language: {
      from: 'от', ticket: 'Тикет', closed: 'закрыт', ticketClosed: 'Ваш тикет закрыт.',
    },
  },
  ticketIDs: {},
  ticketStatus: {},
  ticketSent: {},
}));

import { closeCommand } from '../src/commands';

const customerTicket = {
  ticketId: 8, userid: '129061106', messenger: 'telegram', category: null,
  name: 'Daniil', threadId: 88,
};

const staffCtx = (message: any): any => ({
  message: { message_id: 300, text: '/close', from: { id: 345522691 }, ...message },
  chat: { id: -100, type: 'supergroup' },
  messenger: 'telegram',
  session: { admin: true, groupCategory: null },
});

describe('closeCommand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.getTicketByThreadId.mockResolvedValue(null);
    db.getTicketById.mockResolvedValue(null);
  });

  it('closes the ticket of the topic it is sent in, without a reply', async () => {
    db.getTicketByThreadId.mockResolvedValue(customerTicket);
    // Telegram sets reply_to_message to the topic's service message.
    await closeCommand(staffCtx({
      message_thread_id: 88,
      reply_to_message: { message_id: 88, from: { is_bot: true }, forum_topic_created: {} },
    }));
    expect(db.add).toHaveBeenCalledWith('129061106', 'closed', null, 'telegram');
    expect(mockSendMessage).toHaveBeenCalledWith(
      -100, 'telegram', 'Тикет #T000008 закрыт', { message_thread_id: 88 });
    expect(mockSendMessage).toHaveBeenCalledWith(
      '129061106', 'telegram', 'Тикет #T000008 закрыт\n\nВаш тикет закрыт.');
    expect(mockCloseForumTopic).toHaveBeenCalledWith('-100', 88);
    expect(db.setTopicClosed).toHaveBeenCalledWith(8, true);
  });

  it('closes by a reply to a ticket message outside a topic', async () => {
    db.getTicketById.mockResolvedValue({ ...customerTicket, threadId: undefined });
    await closeCommand(staffCtx({
      reply_to_message: { from: { is_bot: true }, text: 'Тикет #T000008 от Daniil' },
    }));
    expect(db.getTicketById).toHaveBeenCalledWith(8, null);
    expect(db.add).toHaveBeenCalledWith('129061106', 'closed', null, 'telegram');
    expect(mockCloseForumTopic).not.toHaveBeenCalled();
  });

  it('does not message cabinet-only customers in Telegram', async () => {
    db.getTicketByThreadId.mockResolvedValue({ ...customerTicket, userid: 'lk_1539' });
    await closeCommand(staffCtx({ message_thread_id: 88 }));
    expect(db.add).toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0]).toBe(-100);
  });

  it('says so instead of staying silent when no ticket is named', async () => {
    await closeCommand(staffCtx({}));
    expect(db.add).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      -100, 'telegram', expect.stringContaining('в теме тикета'), {});
  });

  it('ignores non-staff', async () => {
    const ctx = staffCtx({ message_thread_id: 88 });
    ctx.session.admin = false;
    await closeCommand(ctx);
    expect(db.getTicketByThreadId).not.toHaveBeenCalled();
  });
});
