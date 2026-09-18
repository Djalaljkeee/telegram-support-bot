/**
 * Which model each lane resolves to, and what the escalate lane refuses to be.
 */
const config: any = {};

jest.mock('../src/cache', () => ({ __esModule: true, default: { config } }));

import { modelFor, DEFAULT_MODEL } from '../src/addons/llm/router';

describe('modelFor', () => {
  beforeEach(() => {
    for (const key of Object.keys(config)) delete config[key];
  });

  it('falls back to the default when nothing is configured', () => {
    expect(modelFor('answer')).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('claude-opus-5');
  });

  it('uses llm_model when no lane is set', () => {
    config.llm_model = 'claude-sonnet-5';
    expect(modelFor('answer')).toBe('claude-sonnet-5');
  });

  it('lets a lane override llm_model', () => {
    config.llm_model = 'claude-sonnet-5';
    config.llm_models = { answer: 'claude-opus-5' };
    expect(modelFor('answer')).toBe('claude-opus-5');
  });

  it('ignores blank and non-string lane values', () => {
    config.llm_model = 'claude-sonnet-5';
    config.llm_models = { answer: '  ', escalate: 42 };
    expect(modelFor('answer')).toBe('claude-sonnet-5');
    expect(modelFor('escalate')).toBeNull();
  });

  it('keeps escalate off unless it is configured', () => {
    config.llm_model = 'claude-opus-5';
    expect(modelFor('escalate')).toBeNull();
  });

  it('returns the escalate model when it differs from answer', () => {
    config.llm_models = { answer: 'claude-opus-5', escalate: 'claude-fable-5' };
    expect(modelFor('escalate')).toBe('claude-fable-5');
  });

  it('refuses an escalate lane that repeats the answer model', () => {
    config.llm_models = { answer: 'claude-opus-5', escalate: 'claude-opus-5' };
    expect(modelFor('escalate')).toBeNull();
  });

  it('refuses an escalate lane that repeats an inherited llm_model', () => {
    config.llm_model = 'claude-opus-5';
    config.llm_models = { escalate: 'claude-opus-5' };
    expect(modelFor('escalate')).toBeNull();
  });
});
