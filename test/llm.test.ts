/**
 * The support assistant: what it is allowed to say, and when it stays quiet.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const config: any = {
  use_llm: true,
  llm_api_key: 'test-key',
  llm_knowledge_dir: '',
  llm_knowledge_file: '/nonexistent/knowledge.md',
  llm_knowledge: '',
  llm_handoff_minutes: 180,
  llm_max_answer_chars: 900,
  owner_id: '1',
  djvpn: { enabled: false },
};

jest.mock('../src/cache', () => ({ __esModule: true, default: { config } }));
jest.mock('fancy-log', () => ({ info: jest.fn(), error: jest.fn() }));

const mockChat = jest.fn();
jest.mock('../src/addons/llm/provider', () => ({
  __esModule: true,
  getProvider: () => ({ name: 'test', chat: mockChat }),
}));

// Ticket memory lives in mongo; there is no mongo in a unit test.
jest.mock('../src/addons/llm/history', () => ({
  __esModule: true,
  record: jest.fn(async () => undefined),
  recent: jest.fn(async () => []),
  clear: jest.fn(async () => undefined),
}));

import * as llm from '../src/addons/llm';
import * as knowledge from '../src/addons/llm/knowledge';

/** A knowledge base on disk, wired into the config for one test. */
function withKnowledge(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-'));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  config.llm_knowledge_dir = dir;
  knowledge.reset();
  return dir;
}

const ticket: any = {
  ticketId: 7,
  userid: '123',
  shmUserId: null,
  threadId: 10,
  llmOff: false,
  lastStaffReplyAt: null,
};

const ctx: any = {
  messenger: 'telegram',
  message: { text: 'Как подключить Happ на Android?', message_id: 5, chat: { id: '123' }, from: { id: '123', first_name: 'Иван' } },
  session: {},
};

describe('parseVerdict', () => {
  it('reads a plain JSON verdict', () => {
    const v = llm.parseVerdict('{"confident": true, "answer": "Импортируйте подписку", "reason": ""}');
    expect(v).toEqual({ confident: true, text: 'Импортируйте подписку', reason: '' });
  });

  it('reads a verdict wrapped in prose and code fences', () => {
    const raw = 'Вот ответ:\n```json\n{"confident": false, "answer": "черновик", "reason": "нужен возврат"}\n```\n';
    expect(llm.parseVerdict(raw)).toEqual({ confident: false, text: 'черновик', reason: 'нужен возврат' });
  });

  it('treats a stringified "false" as not confident', () => {
    expect(llm.parseVerdict('{"confident": "false", "answer": "текст"}').confident).toBe(false);
  });

  it('never reports confidence without an answer', () => {
    expect(llm.parseVerdict('{"confident": true, "answer": "", "reason": "нужен оператор"}').confident)
      .toBe(false);
  });

  it('clamps a long answer', () => {
    config.llm_max_answer_chars = 20;
    expect(llm.parseVerdict(`{"confident": true, "answer": "${'я'.repeat(100)}"}`).text).toHaveLength(20);
    config.llm_max_answer_chars = 900;
  });

  it('returns null when there is no JSON at all', () => {
    expect(llm.parseVerdict('извините, не понял')).toBeNull();
  });
});

describe('knowledge', () => {
  afterEach(() => {
    config.llm_knowledge_dir = '';
    knowledge.reset();
  });

  it('splits a document on headings and keeps the heading trail', () => {
    const sections = knowledge.splitSections('faq.md', '# Тарифы\nвступление\n\n## Продление\nтекст');
    expect(sections.map((s) => s.title)).toEqual(['faq.md > Тарифы', 'faq.md > Тарифы > Продление']);
    expect(sections[1].text).toBe('текст');
  });

  it('sends the whole base when it fits the budget', () => {
    withKnowledge({ 'faq.md': '# Оплата\nоплата картой\n\n# Android\nустановите Happ' });
    const text = knowledge.relevant('что угодно', 12000);
    expect(text).toContain('оплата картой');
    expect(text).toContain('установите Happ');
  });

  it('keeps only related sections when the base is too big', () => {
    withKnowledge({
      'faq.md':
        '# Оплата\n' + 'подробности оплаты картой. '.repeat(60) +
        '\n\n# Android\n' + 'установите приложение Happ из Google Play. '.repeat(60),
    });
    const text = knowledge.relevant('Как установить Happ на Android?', 1200);
    expect(text).toContain('Google Play');
    expect(text).not.toContain('подробности оплаты');
    expect(text.length).toBeLessThanOrEqual(1200);
  });

  it('falls back to the opening sections when nothing matches', () => {
    withKnowledge({
      'faq.md': '# Начало\n' + 'общие сведения о сервисе. '.repeat(60) +
        '\n\n# Прочее\n' + 'редкие вопросы. '.repeat(60),
    });
    const text = knowledge.relevant('ЫЫЫ', 900);
    expect(text).toContain('общие сведения');
  });

  it('reloads after the file changes', () => {
    const dir = withKnowledge({ 'faq.md': '# Один\nпервый текст' });
    expect(knowledge.relevant('один')).toContain('первый текст');
    fs.writeFileSync(path.join(dir, 'faq.md'), '# Один\nвторой текст');
    // mtime granularity: make the change unmistakable.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, 'faq.md'), future, future);
    expect(knowledge.relevant('один')).toContain('второй текст');
  });
});

describe('buildAnswer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    llm.resetCache();
    withKnowledge({ 'faq.md': '# Android\nустановите Happ из Google Play' });
    ticket.llmOff = false;
    ticket.lastStaffReplyAt = null;
    config.use_llm = true;
  });

  it('answers from the knowledge base', async () => {
    mockChat.mockResolvedValue('{"confident": true, "answer": "Установите Happ из Google Play.", "reason": ""}');
    const answer = await llm.buildAnswer(ctx, ticket);
    expect(answer).toEqual({ confident: true, text: 'Установите Happ из Google Play.', reason: '' });
    const messages = mockChat.mock.calls[0][0];
    expect(messages[0].content).toContain('ТОЛЬКО тем, что прямо написано');
    expect(messages[1].content).toContain('Google Play');
  });

  it('stays quiet while an operator is handling the ticket', async () => {
    ticket.lastStaffReplyAt = new Date();
    expect(await llm.buildAnswer(ctx, ticket)).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('answers again once the handoff window has passed', async () => {
    ticket.lastStaffReplyAt = new Date(Date.now() - 4 * 60 * 60 * 1000);
    mockChat.mockResolvedValue('{"confident": true, "answer": "ответ"}');
    expect(await llm.buildAnswer(ctx, ticket)).not.toBeNull();
  });

  it('stays quiet when staff switched it off for the ticket', async () => {
    ticket.llmOff = true;
    expect(await llm.buildAnswer(ctx, ticket)).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('stays quiet when the provider fails', async () => {
    mockChat.mockRejectedValue(new Error('llm: 429 rate limited'));
    expect(await llm.buildAnswer(ctx, ticket)).toBeNull();
  });

  it('stays quiet when the model answers with something unparseable', async () => {
    mockChat.mockResolvedValue('я не знаю');
    expect(await llm.buildAnswer(ctx, ticket)).toBeNull();
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('asks the model named by the answer lane', async () => {
    config.llm_models = { answer: 'claude-opus-5' };
    mockChat.mockResolvedValue('{"confident": true, "answer": "ответ"}');
    await llm.buildAnswer(ctx, ticket);
    expect(mockChat.mock.calls[0][1]).toBe('claude-opus-5');
    delete config.llm_models;
  });

  it('retries once on the escalate lane when the answer is unreadable', async () => {
    config.llm_models = { answer: 'claude-opus-5', escalate: 'claude-fable-5' };
    mockChat
      .mockResolvedValueOnce('я не знаю')
      .mockResolvedValueOnce('{"confident": true, "answer": "со второй попытки"}');
    const answer = await llm.buildAnswer(ctx, ticket);
    expect(answer.text).toBe('со второй попытки');
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[1][1]).toBe('claude-fable-5');
    delete config.llm_models;
  });

  it('gives up when the escalate lane answers with noise too', async () => {
    config.llm_models = { answer: 'claude-opus-5', escalate: 'claude-fable-5' };
    mockChat.mockResolvedValue('тоже не знаю');
    expect(await llm.buildAnswer(ctx, ticket)).toBeNull();
    expect(mockChat).toHaveBeenCalledTimes(2);
    delete config.llm_models;
  });

  it('does not spend the escalate lane on a failing endpoint', async () => {
    config.llm_models = { answer: 'claude-opus-5', escalate: 'claude-fable-5' };
    mockChat.mockRejectedValue(new Error('llm: 429 rate limited'));
    expect(await llm.buildAnswer(ctx, ticket)).toBeNull();
    expect(mockChat).toHaveBeenCalledTimes(1);
    delete config.llm_models;
  });

  it('is disabled without knowledge, key or the config switch', async () => {
    config.use_llm = false;
    expect(llm.isEnabled()).toBe(false);
    config.use_llm = true;
    expect(llm.isEnabled()).toBe(true);
    config.llm_knowledge_dir = '';
    knowledge.reset();
    expect(llm.isEnabled()).toBe(false);
  });
});
