jest.mock('../src/addons/telegram', () => ({}));
jest.mock('../src/addons/lk/notify', () => ({}));
jest.mock('../src/addons/llm', () => ({}));
import { splitText, TELEGRAM_PART_LIMIT } from '../src/staff';

describe('splitText', () => {
  it('keeps a short answer whole', () => {
    expect(splitText('Привет')).toEqual(['Привет']);
  });

  it('cuts a long answer on paragraph breaks, every part under the limit', () => {
    const para = 'Строка инструкции. '.repeat(40).trim(); // ~760 chars
    const text = Array(8).fill(para).join('\n\n'); // ~6100 chars
    const parts = splitText(text);
    expect(parts.length).toBe(2);
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(TELEGRAM_PART_LIMIT));
    expect(parts.join('\n\n')).toBe(text);
  });

  it('falls back to spaces and then a hard cut', () => {
    const words = 'слово '.repeat(1000).trim();
    splitText(words, 100).forEach((p) => expect(p.length).toBeLessThanOrEqual(100));
    const solid = 'x'.repeat(250);
    expect(splitText(solid, 100)).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
  });

  it('never breaks an emoji in half', () => {
    const text = 'a'.repeat(99) + '😀' + 'b'.repeat(10);
    const parts = splitText(text, 100);
    expect(parts[0]).toBe('a'.repeat(99));
    expect(parts[1].startsWith('😀')).toBe(true);
  });
});
