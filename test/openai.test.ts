/**
 * The chat-completions client: how it is built, and what it actually sends.
 */
const config: any = {
  llm_api_key: 'test-key',
  llm_base_url: 'https://gateway.example/v1',
  llm_model: 'claude-opus-4.8',
  llm_max_tokens: 600,
  llm_timeout_ms: 1000,
};

jest.mock('../src/cache', () => ({ __esModule: true, default: { config } }));
jest.mock('fancy-log', () => ({ info: jest.fn(), error: jest.fn() }));

/** Constructor options of every client built, in order. */
const built: any[] = [];
/** Request bodies the fake endpoint received, in order. */
const sent: any[] = [];
/** What the fake endpoint answers next. */
let reply: () => Promise<any>;

jest.mock('openai', () => ({
  __esModule: true,
  default: class {
    chat: any;
    constructor(options: any) {
      built.push(options);
      this.chat = {
        completions: {
          create: (body: any) => {
            sent.push(body);
            return reply();
          },
        },
      };
    }
  },
}));

import { OpenAiProvider, mergeSystemMessages } from '../src/addons/llm/openai';

const completion = (text: string) => async () => ({ choices: [{ message: { content: text } }] });

describe('OpenAiProvider', () => {
  beforeEach(() => {
    built.length = 0;
    sent.length = 0;
    config.llm_api_key = 'test-key';
    reply = completion('ответ');
  });

  it('is not built without a key, nor from the sample placeholder', () => {
    config.llm_api_key = '';
    expect(OpenAiProvider.create()).toBeNull();
    config.llm_api_key = 'API_KEY';
    expect(OpenAiProvider.create()).toBeNull();
  });

  it('points the client at the configured endpoint', async () => {
    await OpenAiProvider.create().chat([{ role: 'user', content: 'привет' }]);
    expect(built[0]).toMatchObject({
      apiKey: 'test-key',
      baseURL: 'https://gateway.example/v1',
      timeout: 1000,
    });
    expect(sent[0]).toMatchObject({ model: 'claude-opus-4.8', max_tokens: 600, temperature: 0.1 });
  });

  it('sends the rules, the knowledge and the customer card as one leading system message', async () => {
    await OpenAiProvider.create().chat([
      { role: 'system', content: 'правила' },
      { role: 'system', content: 'база знаний' },
      { role: 'user', content: 'привет' },
      { role: 'system', content: 'данные клиента' },
    ]);
    expect(sent[0].messages).toEqual([
      { role: 'system', content: 'правила\n\nбаза знаний\n\nданные клиента' },
      { role: 'user', content: 'привет' },
    ]);
  });

  it('leaves a conversation without system messages alone', () => {
    const messages: any[] = [{ role: 'user', content: 'привет' }];
    expect(mergeSystemMessages(messages)).toEqual(messages);
  });

  it('returns the answer text', async () => {
    expect(await OpenAiProvider.create().chat([{ role: 'user', content: 'привет' }])).toBe('ответ');
  });

  it('rejects an empty completion', async () => {
    reply = completion('   ');
    await expect(
      OpenAiProvider.create().chat([{ role: 'user', content: 'привет' }]),
    ).rejects.toThrow(/empty completion/);
  });

  it('lets the endpoint error through, so the assistant just stays quiet', async () => {
    reply = async () => {
      throw new Error('429 rate limited');
    };
    await expect(
      OpenAiProvider.create().chat([{ role: 'user', content: 'привет' }]),
    ).rejects.toThrow(/429/);
  });
});
