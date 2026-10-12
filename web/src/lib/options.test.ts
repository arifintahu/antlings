import { describe, expect, it } from 'vitest';
import { prettyModel } from './options.js';

describe('prettyModel', () => {
  it('shortens Claude model ids', () => {
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(prettyModel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
  });
  it('leaves aliases and unknown ids alone', () => {
    expect(prettyModel('haiku')).toBe('haiku');
    expect(prettyModel('something-else')).toBe('something-else');
    expect(prettyModel('')).toBe('');
  });
});
