// A file posted by staff into a customer's forum topic must go to that
// customer - not to the operator's own ticket (resolved from message.from.id).
const mockSendMessage = jest.fn();
const mockReply = jest.fn();
const mockSendMedia = jest.fn().mockResolvedValue('555');
const db = {
  getTicketByUserId: jest.fn(),
  getTicketByThreadId: jest.fn(),
  getTicketByInternalId: jest.fn(),
  getTicketById: jest.fn(),
  add: jest.fn(),
  addIdAndName: jest.fn(),
};

jest.mock('../src/middleware', () => ({ sendMessage: mockSendMessage, reply: mockReply }));
jest.mock('../src/db', () => db);
jest.mock('../src/topics', () => ({ staffChatExtra: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/addons/lk/attachments', () => ({
  fileRefFromMessage: jest.fn().mockReturnValue(null),
  mirrorTelegramFile: jest.fn(),
}));
jest.mock('../src/cache', () => ({
  config: {
    staffchat_id: '-100',
    staffchat_type: 'telegram',
    staff_forum_topics: true,
    autoreply_confirmation: true,
    language: {
      from: 'From:', language: 'Language:', ticket: 'Ticket',
      ticketClosedError: 'closed', textFirst: 'text first', file_sent: 'File sent to',
      confirmationMessage: 'ok',
    },
    spam_time: 60000,
    spam_cant_msg: 5,
  },
  ticketSent: {},
  userId: '',
}));

import { fileHandler } from '../src/files';

const OPERATOR = 345522691;
const customerTicket = {
  id: 'x', ticketId: 14, userid: '2032913405', messenger: 'telegram',
  name: 'София', threadId: 139, shmUserId: null,
};
const operatorTicket = { ...customerTicket, ticketId: 1, userid: String(OPERATOR), threadId: 13 };

const staffCtx = (message: any): any => ({
  message: {
    message_id: 200,
    from: { id: OPERATOR, first_name: 'Djalal' },
    photo: [{ file_id: 'f' }],
    ...message,
  },
  chat: { id: -100, type: 'supergroup' },
  from: { id: OPERATOR, username: 'op' },
  messenger: 'telegram',
  session: { admin: true, modeData: {}, groupCategory: null, group: '' },
  getFile: jest.fn().mockResolvedValue({ file_id: 'f' }),
});

describe('fileHandler: staff answers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.getTicketByUserId.mockResolvedValue(operatorTicket);
    db.getTicketByThreadId.mockResolvedValue(null);
    db.getTicketByInternalId.mockResolvedValue(null);
    db.getTicketById.mockResolvedValue(null);
  });

  it('sends a file posted in a topic to that topic\'s customer', async () => {
    db.getTicketByThreadId.mockResolvedValue(customerTicket);
    // Telegram sets reply_to_message to the topic's service message.
    await fileHandler('photo', { sendMedia: mockSendMedia } as any, staffCtx({
      message_thread_id: 139,
      reply_to_message: { message_id: 139, forum_topic_created: {} },
    }));
    expect(mockSendMedia).toHaveBeenCalledWith('2032913405', 'photo', 'f', expect.anything());
    expect(db.getTicketByUserId).not.toHaveBeenCalled();
    expect(db.add).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      -100, 'telegram', 'File sent to София', { message_thread_id: 139 });
  });

  it('resolves a reply to a ticket message outside topics', async () => {
    db.getTicketByInternalId.mockResolvedValue(customerTicket);
    await fileHandler('photo', { sendMedia: mockSendMedia } as any, staffCtx({
      reply_to_message: { message_id: 141, text: 'Ticket #T000014 From: София Language: ru' },
    }));
    expect(db.getTicketByInternalId).toHaveBeenCalledWith(141);
    expect(mockSendMedia).toHaveBeenCalledWith('2032913405', 'photo', 'f', expect.anything());
  });

  it('refuses a file that answers no ticket instead of sending it to the operator', async () => {
    await fileHandler('photo', { sendMedia: mockSendMedia } as any, staffCtx({}));
    expect(mockSendMedia).not.toHaveBeenCalled();
    expect(mockReply).toHaveBeenCalledWith(expect.anything(), 'closed');
  });
});
