/*
 * AI Usage Bar — shared.js
 * Loaded by content.js (on the chat pages) and popup.js (toolbar popup). Holds the data model, the
 * parsers for the undocumented site payloads, the window and estimate maths, formatters, and a tiny
 * DOM helper. Nothing in here touches chrome.* or the network.
 */
(() => {
  'use strict';
  const AUB = (globalThis.AUB = globalThis.AUB || {});
  const HOUR = 3600e3;

  AUB.SERVICES = {
    claude: { name: 'Claude', sessionMode: 'fixed' },
    chatgpt: { name: 'ChatGPT', sessionMode: 'rolling' },
  };
  AUB.WEEK_MS = 168 * HOUR;
  AUB.KEYS = {
    settings: 'aub:settings',
    state: (s) => 'aub:state:' + s,
    seen: (s) => 'aub:seen:' + s, // heartbeat from an open page: { t, hook, host }
    ui: (s) => 'aub:ui:' + s, // floating box: { x, y, expanded }
  };

  // ---- settings and state shape -------------------------------------------------------------------

  AUB.defaultSettings = () => ({
    enabled: { claude: true, chatgpt: true },
    showBar: true,
    barMode: 'auto', // 'auto' = under the chat box, floating if not found | 'inline' | 'floating'
    caps: { chatgpt: { session: null, week: null, windowHours: null } },
  });

  AUB.mergeSettings = (saved) => {
    const d = AUB.defaultSettings();
    const s = saved || {};
    return {
      enabled: Object.assign(d.enabled, s.enabled),
      showBar: s.showBar !== false,
      barMode: ['auto', 'inline', 'floating'].includes(s.barMode) ? s.barMode : 'auto',
      caps: { chatgpt: Object.assign(d.caps.chatgpt, s.caps && s.caps.chatgpt) },
    };
  };

  // events: [{ t, m: model slug, e: effort, i: input tokens, o: output tokens, a: 1 if tokens are exact }]
  // convs: conversation id -> { tokens, t } (running size of each chat, for counting the context re-read each turn)
  // learned: model label -> { session: [message counts at past limit hits], week: [...] }
  // featureCaps: { plan, caps: { feature: { cap, windows, lastReset } } } learned from ChatGPT's "N left" counters
  AUB.defaultState = () => ({ events: [], server: {}, last: null, seen: null, convs: {}, learned: {}, featureCaps: null, orgId: null, updatedAt: 0 });

  // Length of the "session" window. Claude's is fixed at 5 h. ChatGPT's is not published, so it is a setting:
  // empty means 5 h on the free plan and 3 h otherwise.
  AUB.sessionHours = (service, settings, plan) => {
    if (service === 'claude') return 5;
    const c = settings && settings.caps && settings.caps.chatgpt;
    if (c && c.windowHours > 0) return c.windowHours;
    return /free/i.test(plan || '') ? 5 : 3;
  };

  // A learned cap is the highest message count seen at the last three limit hits.
  AUB.learnedCap = (entry, kind) => {
    const a = entry && entry[kind];
    return a && a.length ? Math.max(...a.slice(-3)) : null;
  };

  // ---- helpers ------------------------------------------------------------------------------------

  const toMs = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };
  const clampPct = (n) => Math.max(0, Math.min(100, Number(n)));
  const titleCase = (s) => String(s).replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const FAMILY_LABELS = { omelette: 'Claude Design' };

  AUB.titleCase = titleCase;

  AUB.modelFamily = (slug) => {
    const m = /(opus|sonnet|haiku|fable|mythos)/i.exec(slug || '');
    return m ? m[1].toLowerCase() : null;
  };

  AUB.prettyModel = (slug) => {
    if (!slug) return 'Unknown model';
    const s = String(slug);
    let m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?=-|$))?/i.exec(s);
    if (m) return titleCase(m[1]) + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
    m = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/i.exec(s);
    if (m) return titleCase(m[3]) + ' ' + m[1] + (m[2] ? '.' + m[2] : '');
    if (/^gpt/i.test(s)) {
      return s
        .replace(/^gpt/i, 'GPT')
        .replace(/(\d)-(\d)(?!\d)/g, '$1.$2')
        .replace(/-([a-z]+)/gi, (_, w) => ' ' + w[0].toUpperCase() + w.slice(1));
    }
    return s;
  };

  // ---- parsers for the site payloads --------------------------------------------------------------

  // GET /api/organizations/{org}/usage  ->  five_hour, seven_day, seven_day_<model>, extra_usage
  AUB.parseClaudeUsage = (j) => {
    const out = { session: null, week: null, models: {}, extra: null };
    if (!j || typeof j !== 'object') return out;
    const win = (o) => (o && typeof o === 'object' && typeof o.utilization === 'number'
      ? { pct: clampPct(o.utilization), resetsAt: toMs(o.resets_at) }
      : null);
    out.session = win(j.five_hour);
    out.week = win(j.seven_day);
    for (const [k, v] of Object.entries(j)) {
      const m = /^seven_day_(.+)$/.exec(k);
      if (!m || m[1] === 'oauth_apps') continue;
      const w = win(v);
      if (w) out.models[m[1]] = Object.assign(w, { label: FAMILY_LABELS[m[1]] || titleCase(m[1]) });
    }
    const x = j.extra_usage;
    if (x && typeof x === 'object' && x.is_enabled) {
      out.extra = { pct: typeof x.utilization === 'number' ? clampPct(x.utilization) : null };
    }
    return out;
  };

  // POST /backend-api/conversation/init  ->  limits_progress: [{ feature_name, remaining, reset_after }]
  AUB.parseChatGPTInit = (j) => {
    const limits = (j && Array.isArray(j.limits_progress) ? j.limits_progress : [])
      .filter((l) => l && typeof l === 'object')
      .map((l) => ({
        name: l.feature_name || l.name || 'limit',
        remaining: typeof l.remaining === 'number' ? l.remaining : null,
        resetsAt: toMs(l.reset_after),
      }));
    const blocked = (j && Array.isArray(j.blocked_features) ? j.blocked_features : [])
      .map((b) => (b && (b.name || b.feature_name)) || (typeof b === 'string' ? b : null))
      .filter(Boolean);
    return { limits, blocked };
  };

  // 429 bodies: ChatGPT { detail: { clears_in } }, Claude { error: { message: '<json with resetsAt>' } }
  AUB.parseLimitError = (service, bodyText, now = Date.now()) => {
    let resetsAt = null;
    let message = '';
    try {
      const j = JSON.parse(bodyText);
      if (service === 'chatgpt') {
        const d = j.detail;
        if (d && typeof d === 'object') {
          if (d.clears_in != null && !Number.isNaN(Number(d.clears_in))) resetsAt = now + Number(d.clears_in) * 1000;
          message = d.message || '';
        } else if (typeof d === 'string') message = d;
      } else {
        const em = j.error && j.error.message;
        let inner = null;
        if (typeof em === 'string') { try { inner = JSON.parse(em); } catch (_) { /* plain text */ } }
        if (inner && inner.resetsAt) resetsAt = toMs(inner.resetsAt);
        message = (inner && inner.type) || em || '';
      }
    } catch (_) { /* not JSON */ }
    return { resetsAt, message: String(message).slice(0, 200) };
  };

  // ---- window and estimate maths ------------------------------------------------------------------

  // Messages/tokens used so far in a window, divided by the share of the limit that window reports,
  // gives a rough size for the whole limit. Needs >= 3% so tiny percentages don't blow it up.
  const calib = (used, pct) => (pct != null && pct >= 3 && used > 0
    ? Math.max(0, Math.round(used / (pct / 100) - used))
    : null);

  function pickWindow(sw, len, mode, evs, now) {
    if (sw && sw.resetsAt && sw.resetsAt > now) {
      return { start: sw.resetsAt - len, end: sw.resetsAt, pct: sw.pct, source: 'server' };
    }
    const expired = !!(sw && sw.resetsAt && sw.resetsAt <= now);
    const carry = sw && sw.resetsAt == null ? sw.pct : null;
    const floor = expired ? sw.resetsAt : 0;
    const pool = expired ? evs.filter((e) => e.t >= floor) : evs;
    if (mode === 'fixed') {
      let start = null;
      for (const e of pool) if (start === null || e.t >= start + len) start = e.t;
      if (start !== null && now < start + len) return { start, end: start + len, pct: carry, source: 'local' };
      return { start: now, end: null, pct: expired ? 0 : carry, source: 'idle' };
    }
    const from = Math.max(now - len, floor);
    const first = pool.find((e) => e.t >= from);
    return { start: from, end: first ? first.t + len : null, pct: expired ? 0 : carry, source: 'local' };
  }

  function aggregate(evs, from) {
    const a = { messages: 0, inTok: 0, outTok: 0, models: {} };
    for (const e of evs) {
      if (e.t < from) continue;
      const effort = e.e || 'default';
      const label = AUB.prettyModel(e.m);
      const tk = (e.i || 0) + (e.o || 0);
      a.messages++;
      a.inTok += e.i || 0;
      a.outTok += e.o || 0;
      const m = (a.models[label] = a.models[label] || { label, family: AUB.modelFamily(e.m), messages: 0, tokens: 0, efforts: {} });
      const f = (m.efforts[effort] = m.efforts[effort] || { messages: 0, tokens: 0 });
      m.messages++; m.tokens += tk; f.messages++; f.tokens += tk;
    }
    return a;
  }

  function windowView(w, a, cap, alt) {
    const tokens = a.inTok + a.outTok;
    let pct = w.pct;
    let pctSource = pct != null ? 'server' : null;
    let note = null;
    if (pct == null && cap > 0) {
      pct = Math.min(100, (a.messages / cap) * 100);
      pctSource = 'cap';
    } else if (pct == null && alt) {
      pct = alt.pct;
      pctSource = 'learned';
      note = alt.label;
    }
    let msgsLeft = null;
    let msgsLeftEst = false;
    if (pctSource === 'cap') msgsLeft = Math.max(0, cap - a.messages);
    else if (pctSource === 'learned') { msgsLeft = Math.max(0, alt.cap - alt.messages); msgsLeftEst = true; }
    else if (pctSource === 'server') { msgsLeft = calib(a.messages, pct); msgsLeftEst = true; }
    return {
      pct,
      pctSource,
      note,
      resetsAt: w.end,
      messages: a.messages,
      tokens,
      inTok: a.inTok,
      outTok: a.outTok,
      msgsLeft,
      msgsLeftEst,
      tokLeft: pctSource === 'server' ? calib(tokens, pct) : null,
    };
  }

  const pctOf = (used, cap) => (cap > 0 ? Math.min(100, (used / cap) * 100) : null);

  /** Turns stored state into everything the bar and the popup draw. */
  AUB.compute = (service, st, settings, now = Date.now()) => {
    const cfg = AUB.SERVICES[service];
    const state = st || AUB.defaultState();
    const srv = state.server || {};
    const evs = (state.events || []).slice().sort((x, y) => x.t - y.t);
    const caps = (settings && settings.caps && settings.caps[service]) || {};
    const hours = AUB.sessionHours(service, settings, srv.plan);
    const len = hours * HOUR;

    const sw = pickWindow(srv.session, len, cfg.sessionMode, evs, now);
    const ww = pickWindow(srv.week, AUB.WEEK_MS, 'rolling', evs, now);
    const sAgg = aggregate(evs, sw.start);
    const wAgg = aggregate(evs, ww.start);

    const famWeek = {};
    for (const m of Object.values(wAgg.models)) {
      if (!m.family) continue;
      const f = (famWeek[m.family] = famWeek[m.family] || { messages: 0, tokens: 0 });
      f.messages += m.messages;
      f.tokens += m.tokens;
    }

    const models = [];
    const seen = new Set();
    for (const label of new Set([...Object.keys(sAgg.models), ...Object.keys(wAgg.models)])) {
      const s = sAgg.models[label];
      const w = wAgg.models[label];
      const family = (s || w).family;
      if (family) seen.add(family);
      const sm = family && srv.models ? srv.models[family] : null;
      const fw = family ? famWeek[family] : null;
      const efforts = new Set([...(s ? Object.keys(s.efforts) : []), ...(w ? Object.keys(w.efforts) : [])]);
      const none = { messages: 0, tokens: 0 };
      models.push({
        label,
        family,
        session: { messages: s ? s.messages : 0, tokens: s ? s.tokens : 0 },
        week: { messages: w ? w.messages : 0, tokens: w ? w.tokens : 0 },
        weekPct: sm ? sm.pct : null,
        weekResetsAt: sm ? sm.resetsAt : null,
        msgsLeft: sm && fw ? calib(fw.messages, sm.pct) : null,
        tokLeft: sm && fw ? calib(fw.tokens, sm.pct) : null,
        efforts: [...efforts]
          .map((k) => ({ effort: k, session: (s && s.efforts[k]) || none, week: (w && w.efforts[k]) || none }))
          .sort((x, y) => y.week.tokens - x.week.tokens),
      });
    }
    for (const [fam, sm] of Object.entries(srv.models || {})) {
      if (seen.has(fam)) continue;
      models.push({
        label: sm.label || titleCase(fam),
        family: fam,
        session: { messages: 0, tokens: 0 },
        week: { messages: 0, tokens: 0 },
        weekPct: sm.pct,
        weekResetsAt: sm.resetsAt,
        msgsLeft: null,
        tokLeft: null,
        efforts: [],
      });
    }
    models.sort((x, y) => (y.week.tokens - x.week.tokens) || ((y.weekPct || 0) - (x.weekPct || 0)));

    // ChatGPT: message caps learned from limit hits, per model.
    const learned = [];
    let altS = null;
    let altW = null;
    if (service === 'chatgpt') {
      const book = state.learned || {};
      for (const m of models) {
        const entry = book[m.label];
        m.sessionCap = AUB.learnedCap(entry, 'session');
        m.weekCap = AUB.learnedCap(entry, 'week');
        m.sessionCapPct = pctOf(m.session.messages, m.sessionCap);
        m.weekCapPct = pctOf(m.week.messages, m.weekCap);
      }
      const best = (kind) => {
        const c = models.filter((m) => m[kind + 'Cap']).sort((x, y) => y[kind + 'CapPct'] - x[kind + 'CapPct'])[0];
        const w = kind === 'session' ? 'session' : 'week';
        return c ? { label: c.label, cap: c[kind + 'Cap'], pct: c[kind + 'CapPct'], messages: c[w].messages } : null;
      };
      altS = best('session');
      altW = best('week');
      for (const [label, entry] of Object.entries(book)) {
        learned.push({
          label,
          session: AUB.learnedCap(entry, 'session'),
          sessionHits: (entry.session || []).length,
          week: AUB.learnedCap(entry, 'week'),
          weekHits: (entry.week || []).length,
        });
      }
    }

    const sView = windowView(sw, sAgg, caps.session, altS);
    const wView = windowView(ww, wAgg, caps.week, altW);
    // ChatGPT does not publish window boundaries, so a locally guessed reset time would only mislead.
    if (service === 'chatgpt') { sView.resetsAt = null; wView.resetsAt = null; }

    // ChatGPT: one list of "how full is each limit", from the best source available for each.
    const meters = [];
    if (service === 'chatgpt') {
      const fc = (state.featureCaps && state.featureCaps.caps) || {};
      for (const l of srv.limits || []) {
        if (l.remaining == null) continue;
        const c = fc[l.name];
        const ended = !!(l.resetsAt && l.resetsAt <= now);
        const cap = c ? Math.max(c.cap, l.remaining) : null;
        const left = ended && cap ? cap : l.remaining;
        // A counter only goes down inside a window, so a cap seen in just one window may already be part-used.
        // Show a percentage only once the cap has been seen in two different windows.
        const learning = !(c && c.windows >= 2);
        meters.push({
          kind: 'feature',
          label: titleCase(l.name),
          left,
          cap: learning ? null : cap,
          pct: learning ? null : clampPct(((cap - left) / cap) * 100),
          resetsAt: ended ? null : l.resetsAt,
          approx: true,
          learning,
        });
      }
      for (const m of models) {
        if (m.sessionCap) meters.push({ kind: 'model', label: m.label + ', ' + hours + 'h', left: Math.max(0, m.sessionCap - m.session.messages), cap: m.sessionCap, pct: m.sessionCapPct, resetsAt: null, approx: true });
        if (m.weekCap) meters.push({ kind: 'model', label: m.label + ', week', left: Math.max(0, m.weekCap - m.week.messages), cap: m.weekCap, pct: m.weekCapPct, resetsAt: null, approx: true });
      }
      if (caps.session > 0) meters.push({ kind: 'typed', label: 'Your session cap', left: Math.max(0, caps.session - sAgg.messages), cap: caps.session, pct: pctOf(sAgg.messages, caps.session), resetsAt: null, approx: false });
      if (caps.week > 0) meters.push({ kind: 'typed', label: 'Your week cap', left: Math.max(0, caps.week - wAgg.messages), cap: caps.week, pct: pctOf(wAgg.messages, caps.week), resetsAt: null, approx: false });
      meters.sort((x, y) => (y.pct == null ? -1 : y.pct) - (x.pct == null ? -1 : x.pct));
    }

    return {
      service,
      name: cfg.name,
      plan: srv.plan || null,
      fetchedAt: srv.fetchedAt || null,
      sessionHours: hours,
      session: sView,
      week: wView,
      models,
      meters,
      learned,
      limits: srv.limits || [],
      blockedUntil: srv.blockedUntil && srv.blockedUntil > now ? srv.blockedUntil : null,
      extra: srv.extra || null,
      current: state.last || null,
      seen: state.seen || null,
      pollOk: srv.lastPollOk,
      lastMessageAt: evs.length ? evs[evs.length - 1].t : null,
      hasData: !!(evs.length || srv.fetchedAt),
    };
  };

  // ---- formatters ---------------------------------------------------------------------------------

  AUB.fmtNum = (n) => {
    if (n == null || Number.isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return Math.round(n / 1e3) + 'k';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  };

  AUB.fmtPct = (p) => (p == null ? '—' : (p < 10 && p % 1 ? p.toFixed(1) : String(Math.round(p))) + '%');

  AUB.fmtDur = (ms) => {
    if (ms == null) return '—';
    if (ms <= 0) return 'now';
    const m = Math.round(ms / 60000);
    if (m < 1) return '<1m';
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + (m % 60) + 'm';
    return m + 'm';
  };

  AUB.resetText = (ms) => (ms <= 0 ? 'resets now' : 'resets in ' + AUB.fmtDur(ms));

  AUB.fmtWhen = (ts, now = Date.now()) => {
    if (!ts) return '';
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date(now).toDateString();
    return d.toLocaleString([], sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  };

  AUB.fmtAgo = (ts, now = Date.now()) => {
    if (!ts) return '';
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    return AUB.fmtDur(now - ts) + ' ago';
  };

  // Live countdown with seconds, for things that tick every second.
  AUB.fmtLive = (ms) => {
    if (ms == null) return '—';
    if (ms <= 0) return 'now';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const p = (n) => String(n).padStart(2, '0');
    if (d) return d + 'd ' + hh + 'h ' + p(m) + 'm';
    if (hh) return hh + 'h ' + p(m) + 'm ' + p(s % 60) + 's';
    return m + 'm ' + p(s % 60) + 's';
  };

  // Text for a live element. kind: 'reset' (resets in 1h 02m 03s), 'dur' (1h 02m 03s), 'ago' (5s ago).
  AUB.timeText = (kind, ts, now = Date.now()) => {
    if (kind === 'ago') return AUB.fmtAgo(ts, now);
    if (ts - now <= 0) return kind === 'reset' ? 'resetting' : 'now';
    return (kind === 'reset' ? 'resets in ' : '') + AUB.fmtLive(ts - now);
  };

  // Redraws every live element under root. Returns true if any countdown has just run out.
  AUB.tickTimes = (root, now = Date.now()) => {
    let ended = false;
    for (const el of root.querySelectorAll('[data-aub-t]')) {
      const kind = el.getAttribute('data-aub-k');
      const ts = Number(el.getAttribute('data-aub-t'));
      const text = AUB.timeText(kind, ts, now);
      if (el.textContent !== text) el.textContent = text;
      if (kind !== 'ago' && ts - now <= 0) ended = true;
    }
    return ended;
  };

  // Is the extension healthy? ok = green, warn = a problem to look at (yellow), off = switched off (red).
  AUB.health = (vm, enabled, now = Date.now()) => {
    const site = vm.service === 'claude' ? 'claude.ai' : 'chatgpt.com';
    if (!enabled) return { level: 'off', text: 'Tracking is off.' };
    const seen = vm.seen;
    if (!seen) return { level: 'warn', text: 'Not seen on any page yet. Open or refresh a ' + site + ' tab.' };
    if (!seen.hook) return { level: 'warn', text: 'Page found, but the network hook is not running. Reload the extension, then refresh the tab.' };
    if (now - seen.t > 150000) return { level: 'warn', text: 'No open ' + site + ' tab seen for ' + AUB.fmtDur(now - seen.t) + '. Open one to keep numbers fresh.' };
    if (vm.service === 'claude') {
      if (vm.pollOk === false) return { level: 'warn', text: 'Could not read Claude usage. Check that you are logged in, then press refresh.' };
      if (vm.fetchedAt && now - vm.fetchedAt > 10 * 60e3) return { level: 'warn', text: 'Claude numbers are ' + AUB.fmtDur(now - vm.fetchedAt) + ' old. Press refresh.' };
    }
    return { level: 'ok', text: 'Connected.' };
  };

  AUB.level = (p) => (p == null ? 'none' : p >= 85 ? 'hot' : p >= 60 ? 'warn' : 'ok');

  // ---- tiny DOM helpers (no innerHTML anywhere) ---------------------------------------------------

  AUB.h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };

  // A measuring-tape gauge: a track with a tick every 10% and a fill coloured by how full it is.
  AUB.tape = (pct, extra) => {
    const fill = AUB.h('i', { class: 'aub-fill ' + AUB.level(pct) });
    if (pct != null) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    return AUB.h('div', {
      class: 'aub-tape' + (extra ? ' ' + extra : ''),
      role: 'meter',
      'aria-valuemin': pct == null ? null : 0,
      'aria-valuemax': pct == null ? null : 100,
      'aria-valuenow': pct == null ? null : Math.round(pct),
    }, fill);
  };

  // A live element: its text is redrawn every second by AUB.tickTimes.
  AUB.timeEl = (kind, ts, cls) => AUB.h('span', { class: cls, 'data-aub-t': ts, 'data-aub-k': kind }, AUB.timeText(kind, ts));
})();
