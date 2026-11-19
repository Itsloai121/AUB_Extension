# Vendored code

`gpt-tokenizer.js` is a single-file build of the [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) npm package
(version 4.1.2, MIT licence, see `LICENSE-gpt-tokenizer.txt`) using its `o200k_base` encoding, which is the tokenizer
used by recent OpenAI models. It is only loaded on chatgpt.com pages.

It was built with esbuild from this entry file:

```js
import * as enc from 'gpt-tokenizer/encoding/o200k_base';
const PLAIN = { disallowedSpecial: new Set() };   // text like "<|endoftext|>" is counted as plain text
globalThis.__aubGptTok = { countTokens: (text) => enc.countTokens(text, PLAIN) };
```

```bash
npm install gpt-tokenizer esbuild
npx esbuild entry.js --bundle --minify --format=iife --legal-comments=none --outfile=gpt-tokenizer.js
```
