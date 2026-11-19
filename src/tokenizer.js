/*
 * AI Usage Bar — tokenizer.js
 *  - ChatGPT pages: exact token counts for visible text, using the vendored OpenAI o200k_base tokenizer
 *    (src/vendor/gpt-tokenizer.js, loaded before this file on chatgpt.com only).
 *  - Claude pages (and fallback): a script-aware heuristic, because Anthropic does not ship a tokenizer to the
 *    browser. Expect roughly +/-25% on ordinary prose.
 * Either way this only counts the text we can see. Hidden reasoning, system text and tools are not visible.
 */
(() => {
  'use strict';
  const AUB = (globalThis.AUB = globalThis.AUB || {});

  AUB.heuristicTokens = (text) => {
    let ascii = 0;
    let cjk = 0;
    let emoji = 0;
    let other = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c < 0x80) ascii++;
      else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
      else if (c >= 0x1f000) emoji++;
      else other++;
    }
    return Math.ceil(ascii / 4 + cjk + emoji * 2 + other / 2.2);
  };

  AUB.estimateTokens = (text, service) => {
    if (!text || typeof text !== 'string') return 0;
    const real = globalThis.__aubGptTok;
    if (service === 'chatgpt' && real && text.length < 500000) {
      try { return real.countTokens(text); } catch (_) { /* fall through to the heuristic */ }
    }
    return AUB.heuristicTokens(text);
  };

  AUB.hasExactTokenizer = (service) => service === 'chatgpt' && !!globalThis.__aubGptTok;
})();
