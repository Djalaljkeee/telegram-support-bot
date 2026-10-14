jest.mock('../src/cache', () => ({ config: { parse_mode: 'Markdown' } }));

import cache from '../src/cache';
import { strictEscape, linkLabel } from '../src/middleware';

describe('strictEscape', () => {
  afterEach(() => {
    cache.config.parse_mode = 'Markdown';
  });

  it('escapes legacy Markdown so a lone underscore cannot break the message', () => {
    // Ticket #18: "Nik_333" plus "@Dj_VPN_bot" left an unclosed italic and
    // Telegram rejected the whole reply.
    expect(strictEscape('Nik_333 *bold* `code` [link]')).toBe(
      'Nik\\_333 \\*bold\\* \\`code\\` \\[link]',
    );
  });

  it('escapes MarkdownV2', () => {
    cache.config.parse_mode = 'MarkdownV2';
    expect(strictEscape('lk.djvpn.ru (a_b)!')).toBe('lk\\.djvpn\\.ru \\(a\\_b\\)\\!');
  });
});

describe('linkLabel', () => {
  afterEach(() => {
    cache.config.parse_mode = 'Markdown';
  });

  it('keeps a legacy Markdown label raw, minus the brackets', () => {
    expect(linkLabel('Nik_333 [x]')).toBe('Nik_333 x');
  });

  it('escapes a MarkdownV2 label', () => {
    cache.config.parse_mode = 'MarkdownV2';
    expect(linkLabel('Nik_333')).toBe('Nik\\_333');
  });
});
