import { canonicalJson } from '../../contracts/index.js';

/** Scan raw JSON before JSON.parse loses duplicate (including escaped) property names. */
export function parseRequestJson(text: string): unknown {
  let at = 0;
  function whitespace() { while (/[\x20\t\r\n]/.test(text[at] ?? 'x')) at++; }
  function string(): string {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') at++;
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new SyntaxError('Invalid JSON');
  }
  function value(depth: number): void {
    if (depth > 128) throw new SyntaxError('Invalid JSON');
    whitespace();
    const char = text[at];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      at++; whitespace();
      const end = char === '{' ? '}' : ']';
      const keys = new Set<string>();
      if (text[at] === end) { at++; return; }
      while (at < text.length) {
        if (char === '{') {
          whitespace();
          if (text[at] !== '"') throw new SyntaxError('Invalid JSON');
          const key = string();
          if (keys.has(key)) throw new SyntaxError('Duplicate JSON key');
          keys.add(key); whitespace();
          if (text[at++] !== ':') throw new SyntaxError('Invalid JSON');
        }
        value(depth + 1); whitespace();
        if (text[at] === end) { at++; return; }
        if (text[at++] !== ',') throw new SyntaxError('Invalid JSON');
      }
      throw new SyntaxError('Invalid JSON');
    }
    const start = at;
    while (at < text.length && !/[\x20\t\r\n,\]}]/.test(text[at]!)) at++;
    if (at === start) throw new SyntaxError('Invalid JSON');
    JSON.parse(text.slice(start, at));
  }
  value(0); whitespace();
  if (at !== text.length) throw new SyntaxError('Invalid JSON');
  const parsed: unknown = JSON.parse(text);
  canonicalJson(parsed);
  return parsed;
}
