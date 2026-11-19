/*
 * AI Usage Bar — interceptor.js (runs in the page's MAIN world at document_start)
 *
 * Watches fetch() calls made by claude.ai / chatgpt.com and forwards what it sees to content.js with
 * window.postMessage. It never changes a request or a response: every body is read from a clone.
 *
 * Debug: run  localStorage.setItem('aub-debug', '1')  in the page console to log a redacted view of
 * each outgoing chat request (field names only), which is how you find the "effort" field if it moves.
 */
(() => {
  'use strict';
  if (window.__aubInterceptor) return;
  window.__aubInterceptor = true;
  // content.js (other world) reads this attribute to confirm the hook is running on the page.
  try { document.documentElement.setAttribute('data-aub-hook', '1'); } catch (_) { /* ignore */ }

  const SRC = 'ai-usage-bar';
  const service = /(^|\.)claude\.ai$/.test(location.hostname) ? 'claude' : 'chatgpt';
  const origFetch = window.fetch;
  if (typeof origFetch !== 'function') return;

  const debug = () => {
    try { return localStorage.getItem('aub-debug') === '1'; } catch (_) { return false; }
  };
  const post = (type, data) => {
    try {
      window.postMessage(Object.assign({ source: SRC, service, type }, data), location.origin);
    } catch (_) { /* never break the page */ }
  };

  // These paths are undocumented and can change. Everything that depends on them lives in this table.
  const ROUTES = {
    claude: {
      send: /^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/(?:retry_)?completion$/,
      info: /^\/api\/organizations\/[^/]+\/usage$/,
      history: /^\/api\/organizations\/[^/]+\/chat_conversations\/([0-9a-f-]{36})$/i,
      org: /^\/api\/organizations\/([0-9a-f-]{36})(?:\/|$)/i,
    },
    chatgpt: {
      send: /^\/backend-api\/(?:f\/)?conversation$/,
      info: /^\/backend-api\/(?:conversation\/init|accounts\/check\/[^/]+)$/,
      history: /^\/backend-api\/conversation\/([0-9a-f-]{36})$/i,
      org: null,
    },
  }[service];

  let lastOrg = null;

  function classify(urlStr, method) {
    let path;
    try { path = new URL(urlStr, location.href).pathname; } catch (_) { return null; }
    if (debug() && /^\/(?:api|backend-api)\//.test(path)) console.info('[AUB] fetch', method, path);
    if (ROUTES.org) {
      const m = ROUTES.org.exec(path);
      if (m && m[1] !== lastOrg) { lastOrg = m[1]; post('org', { orgId: lastOrg }); }
    }
    if (method === 'POST') {
      const m = ROUTES.send.exec(path);
      if (m) return { kind: 'send', conv: m[1] || null };
    }
    if (method === 'GET') {
      const h = ROUTES.history.exec(path);
      if (h) return { kind: 'history', conv: h[1] };
    }
    if (ROUTES.info.test(path)) return { kind: 'info', path };
    return null;
  }

  // ---- request inspection -------------------------------------------------------------------------

  const EFFORT_KEY = /effort|thinking|reasoning|paprika/i;
  const NOT_EFFORT = /^(thinking_?(text|content|blocks?)|reasoning_content)$/i;

  function scanEffort(obj, depth, out) {
    if (!obj || typeof obj !== 'object' || depth > 2) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (EFFORT_KEY.test(k) && !NOT_EFFORT.test(k)) {
        if (v == null || v === false) continue;
        if (typeof v === 'object') {
          const inner = v.effort || v.level || v.type || v.mode;
          if (inner != null) out.push([k, String(inner)]);
          continue;
        }
        out.push([k, String(v)]);
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        scanEffort(v, depth + 1, out);
      }
    }
    return out;
  }

  function pickEffort(body) {
    const pairs = scanEffort(body, 0, []);
    if (!pairs.length) return 'default';
    const [, v] = pairs.find(([k]) => /effort/i.test(k)) || pairs[0];
    if (/^(none|off|disabled|false|null)$/i.test(v)) return 'off';
    if (/^(true|enabled)$/i.test(v)) return 'thinking';
    return v.toLowerCase().slice(0, 24);
  }

  function redact(v, depth) {
    if (typeof v === 'string') return v.length > 12 ? `<string ${v.length}>` : v;
    if (Array.isArray(v)) return depth > 3 ? `<array ${v.length}>` : v.slice(0, 3).map((x) => redact(x, depth + 1));
    if (v && typeof v === 'object') {
      if (depth > 3) return '<object>';
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = redact(x, depth + 1);
      return o;
    }
    return v;
  }

  function summarizeRequest(raw, conv) {
    let body = null;
    try { body = JSON.parse(raw); } catch (_) { /* not JSON */ }
    const texts = [];
    let model = null;
    let effort = 'default';
    if (body && typeof body === 'object') {
      if (typeof body.model === 'string') model = body.model;
      if (service === 'claude') {
        if (typeof body.prompt === 'string') texts.push(body.prompt);
        for (const a of Array.isArray(body.attachments) ? body.attachments : []) {
          if (a && typeof a.extracted_content === 'string') texts.push(a.extracted_content);
        }
      } else {
        for (const m of Array.isArray(body.messages) ? body.messages : []) {
          const parts = m && m.content && m.content.parts;
          if (!Array.isArray(parts)) continue;
          for (const p of parts) if (typeof p === 'string') texts.push(p);
        }
        conv = body.conversation_id || conv;
      }
      effort = pickEffort(body);
      if (debug()) console.info('[AUB] request fields', redact(body, 0), '-> model', model, 'effort', effort);
    }
    return { model, effort, text: texts.join('\n'), conv };
  }

  // ---- response streams ---------------------------------------------------------------------------

  async function consumeStream(res, onData) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('data:')) onData(line.slice(5).trim());
      }
    }
    buf += dec.decode();
    if (buf.startsWith('data:')) onData(buf.slice(5).trim());
  }

  function claudeEvent(s, data) {
    if (!data || data === '[DONE]') return;
    let e;
    try { e = JSON.parse(data); } catch (_) { return; }
    if (!e || typeof e !== 'object') return;
    s.events++;
    switch (e.type) {
      case 'message_start': {
        const m = e.message || {};
        if (m.model) s.model = m.model;
        if (m.usage && m.usage.input_tokens > 0) s.realIn = m.usage.input_tokens;
        break;
      }
      case 'content_block_delta': {
        const d = e.delta || {};
        if (typeof d.text === 'string') s.out.push(d.text);
        else if (typeof d.thinking === 'string') s.out.push(d.thinking);
        break;
      }
      case 'completion':
        if (typeof e.completion === 'string') s.out.push(e.completion);
        if (e.model) s.model = e.model;
        break;
      case 'message_delta':
        if (e.usage && e.usage.output_tokens > 0) s.realOut = e.usage.output_tokens;
        break;
      case 'message_limit':
        // Used only as a "usage just changed" signal; content.js re-reads /usage for the real numbers.
        post('limit', { status: e.message_limit && e.message_limit.type });
        break;
      default:
    }
  }

  function chatgptEvent(s, data) {
    if (!data || data === '[DONE]') return;
    if (data.includes('"model_slug"')) {
      const m = /"model_slug"\s*:\s*"([^"]+)"/.exec(data);
      if (m && m[1] !== 'auto') s.model = m[1];
    }
    if (!s.conv && data.includes('"conversation_id"')) {
      const c = /"conversation_id"\s*:\s*"([0-9a-f-]{36})"/.exec(data);
      if (c) s.conv = c[1];
    }
    let e;
    try { e = JSON.parse(data); } catch (_) { return; }
    // Some lines are bare strings ("v1") or null; only objects carry reply text.
    if (!e || typeof e !== 'object') return;
    s.events++;
    // A bare string is "append to the current text". An op can append, or replace the whole text.
    const apply = (op) => {
      if (!op || typeof op.v !== 'string') return;
      if (op.o === 'replace') {
        // the value is the complete text so far, so it must replace what was streamed, not be added to it
        if (/parts|text|summary/.test(op.p || '')) { s.out = [op.v]; s.snapshot = ''; }
      } else if (!op.p || /parts|text|thoughts|summary|content/.test(op.p)) {
        s.out.push(op.v);
      }
    };
    if (typeof e.v === 'string') apply({ p: e.p, o: e.o, v: e.v });
    else if (Array.isArray(e.v)) e.v.forEach(apply);

    // A whole assistant message can sit at the top, under "v", or inside a patch array. Keep the longest seen.
    const t = assistantText(e, 0);
    if (t.length > s.snapshot.length) s.snapshot = t;
  }

  // Finds an assistant message with text parts anywhere in an event (a few levels deep) and returns its text.
  function assistantText(node, depth) {
    if (!node || typeof node !== 'object' || depth > 4) return '';
    if (Array.isArray(node)) {
      let best = '';
      for (const x of node) { const t = assistantText(x, depth + 1); if (t.length > best.length) best = t; }
      return best;
    }
    const m = node.message;
    if (m && m.author && m.author.role === 'assistant' && m.content && Array.isArray(m.content.parts)) {
      return m.content.parts.filter((p) => typeof p === 'string').join('');
    }
    let best = '';
    for (const k of ['v', 'message']) {
      if (node[k] && typeof node[k] === 'object') { const t = assistantText(node[k], depth + 1); if (t.length > best.length) best = t; }
    }
    return best;
  }

  function handleSend(res, info, rawBody) {
    const req = summarizeRequest(rawBody, info.conv);
    if (!res.ok) {
      res.clone().text()
        .then((t) => post('send-error', { status: res.status, body: String(t).slice(0, 4000), model: req.model, conv: req.conv }))
        .catch(() => {});
      return;
    }
    const s = { model: req.model, conv: req.conv, out: [], snapshot: '', realIn: 0, realOut: 0, events: 0, lines: 0 };
    const t0 = Date.now();
    const onData = (d) => {
      s.lines++;
      if (debug() && s.lines <= 8) {
        let shape = d;
        try { shape = redact(JSON.parse(d), 0); } catch (_) { shape = redact(d, 0); }
        console.info('[AUB] reply stream line', s.lines, shape);
      }
      return service === 'claude' ? claudeEvent(s, d) : chatgptEvent(s, d);
    };
    const finish = () => {
      const streamed = s.out.join('');
      const outText = streamed.length >= s.snapshot.length ? streamed : s.snapshot;
      if (debug()) console.info('[AUB] reply captured:', outText.length, 'characters from', s.lines, 'stream lines,', s.events, 'parsed events; model', s.model || req.model);
      post('message', {
        t: t0,
        model: s.model || req.model,
        requestedModel: req.model,
        effort: req.effort,
        conv: s.conv || req.conv,
        inText: req.text,
        outText,
        realIn: s.realIn,
        realOut: s.realOut,
        streamLines: s.lines,
      });
    };
    if (!res.body) { finish(); return; }
    consumeStream(res.clone(), onData).catch(() => {}).then(finish);
  }

  // Whole-conversation text (the page loads it when you open an old chat), so content.js can count the
  // context the model re-reads on every turn. Only the active branch is followed.
  const HISTORY_CHAR_LIMIT = 3000000;

  function chainTexts(j) {
    const texts = [];
    let chars = 0;
    const add = (t) => {
      if (typeof t !== 'string' || !t) return true;
      if (chars + t.length > HISTORY_CHAR_LIMIT) return false;
      chars += t.length;
      texts.push(t);
      return true;
    };
    if (service === 'claude') {
      const msgs = Array.isArray(j.chat_messages) ? j.chat_messages : [];
      const byId = new Map(msgs.map((m) => [m && m.uuid, m]));
      let chain = [];
      let cur = byId.get(j.current_leaf_message_uuid);
      for (let guard = 0; cur && guard <= msgs.length; guard++) { chain.push(cur); cur = byId.get(cur.parent_message_uuid); }
      if (!chain.length) chain = msgs.slice().reverse();
      for (const m of chain.reverse()) {
        if (!m) continue;
        let t = typeof m.text === 'string' ? m.text : '';
        if (!t && Array.isArray(m.content)) t = m.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
        if (!add(t)) break;
        for (const a of Array.isArray(m.attachments) ? m.attachments : []) if (!add(a && a.extracted_content)) break;
      }
    } else {
      const mapping = j.mapping && typeof j.mapping === 'object' ? j.mapping : {};
      const ids = Object.keys(mapping);
      let cur = mapping[j.current_node];
      const parts = [];
      for (let guard = 0; cur && guard <= ids.length; guard++) {
        const p = cur.message && cur.message.content && cur.message.content.parts;
        if (Array.isArray(p)) parts.push(p.filter((x) => typeof x === 'string').join('\n'));
        cur = mapping[cur.parent];
      }
      for (const t of parts.reverse()) if (!add(t)) break;
    }
    return texts;
  }

  function handleHistory(res, info) {
    if (!res.ok) return;
    res.clone().json().then((j) => {
      if (!j || typeof j !== 'object') return;
      post('history', { conv: info.conv, texts: chainTexts(j) });
    }).catch(() => {});
  }

  function handleInfo(res, info) {
    if (!res.ok) return;
    res.clone().text().then((t) => {
      let j;
      try { j = JSON.parse(t); } catch (_) { return; }
      let json = j;
      if (service === 'chatgpt') {
        if (/accounts\/check/.test(info.path)) {
          const acc = (j && j.accounts) || {};
          const a = acc.default || Object.values(acc)[0] || {};
          json = { plan: (a.entitlement && a.entitlement.subscription_plan) || null };
        } else {
          json = { limits_progress: j.limits_progress, blocked_features: j.blocked_features, model_limits: j.model_limits };
        }
      }
      post('info', { path: info.path, json });
    }).catch(() => {});
  }

  // ---- the hook -----------------------------------------------------------------------------------

  window.fetch = function aubFetch(input, init) {
    let info = null;
    let bodyP = Promise.resolve(null);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      info = classify(url, method);
      if (info && info.kind === 'send') {
        if (init && typeof init.body === 'string') bodyP = Promise.resolve(init.body);
        else if (typeof Request !== 'undefined' && input instanceof Request) bodyP = input.clone().text().catch(() => null);
      }
    } catch (_) { info = null; }

    const p = origFetch.apply(this, arguments);
    if (info) {
      p.then((res) => {
        if (info.kind === 'send') return bodyP.then((raw) => handleSend(res, info, raw));
        if (info.kind === 'history') return handleHistory(res, info);
        return handleInfo(res, info);
      }).catch(() => {});
    }
    return p;
  };
})();
