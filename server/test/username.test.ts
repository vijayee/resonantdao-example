import { sanitizeUsername } from '../../shared/src/username';

describe('sanitizeUsername', () => {
  it('strips invisible character classes and trims whitespace', () => {
    // Cc: literal DEL (the remote-terminal Backspace bug), carriage return.
    expect(sanitizeUsername('vic\x7ftor')).toBe('victor');
    expect(sanitizeUsername('victor\r')).toBe('victor');
    // Cf: zero-width space, zero-width joiner, soft hyphen, BOM.
    expect(sanitizeUsername('victor​')).toBe('victor');
    expect(sanitizeUsername('vic‍tor')).toBe('victor');
    expect(sanitizeUsername('vic­tor')).toBe('victor');
    expect(sanitizeUsername('vic﻿tor')).toBe('victor');
    // Variation selectors and supplement (F6 family).
    expect(sanitizeUsername('victor️\u{E0100}')).toBe('victor');
    // Plain trimming.
    expect(sanitizeUsername('  victor  ')).toBe('victor');
  });

  it('leaves ordinary names and interior spaces untouched', () => {
    expect(sanitizeUsername('victor')).toBe('victor');
    expect(sanitizeUsername('a_b-C9x')).toBe('a_b-C9x');
    // Interior spaces survive sanitization; the register charset check
    // rejects them loudly — this function must not guess.
    expect(sanitizeUsername('vic tor')).toBe('vic tor');
  });

  it('reduces a fully-invisible name to empty (callers reject empties)', () => {
    expect(sanitizeUsername('​\x7f️')).toBe('');
  });
});