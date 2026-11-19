/*
 * AI Usage Bar — content.js (isolated world)
 *  1. receives what interceptor.js saw (messages sent, usage payloads, limit errors)
 *  2. keeps a per-service event log + the latest server numbers in chrome.storage.local
 *  3. on claude.ai, re-reads /api/organizations/{org}/usage after each message and every 90 s
 *  4. draws the usage box: a slim row under the chat box, or a small draggable floating box
 * The popup only reads this storage (and writes the on/off switches), so both stay in sync.
 */
(() => {
  'use strict';
  const AUB = globalThis.AUB;
  if (!AUB || !globalThis.chrome || !chrome.storage) return;
  const h = AUB.h;

  const SRC = 'ai-usage-bar';
  const service = /(^|\.)claude\.ai$/.test(location.hostname) ? 'claude' : 'chatgpt';
  const KEY = AUB.KEYS.state(service);
  const SEEN_KEY = AUB.KEYS.seen(service);
  const UI_KEY = AUB.KEYS.ui(service);

  // The chat sites change their markup often. If the bar lands in the wrong spot, edit these selectors.
  const CONFIG = {
    anchors: {
      claude: ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]'],
      chatgpt: ['form[data-type="unified-composer"]', '#prompt-textarea'],
    },
    pollMs: 90 * 1000,
    renderMs: 30 * 1000,
    heartbeatMs: 30 * 1000,
    graceMs: 3000, // how long to look for the chat box before floating the box instead
    keepMs: 8 * 24 * 3600e3,
    maxEvents: 4000,
  };

  const startedAt = Date.now();
  let settings = AUB.defaultSettings();
  let state = AUB.defaultState();
  let bar = null;
  let orgId = null;
  let pollBusy = false;
  let pollTimer = null;
  let pollOk = null;
  let ui = { x: null, y: null, expanded: false }; // floating box: position and open/closed
  let dragging = false;
  let lastExpiry = 0;

  const enabled = () => !!settings.enabled[service];

  // ---- storage ------------------------------------------------------------------------------------

  function prune(s) {
    const cutoff = Date.now() - CONFIG.keepMs;
    s.events = s.events.filter((e) => e.t >= cutoff).slice(-CONFIG.maxEvents);
    s.convs = Object.fromEntries(Object.entries(s.convs || {})
      .filter(([, c]) => c && c.t >= cutoff)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, 100));
  }

  // Read-modify-write, one at a time. The promise chain serializes writes inside this tab; the Web Lock
  // does the same across tabs of the same site, so concurrent events never overwrite each other.
  let writeChain = Promise.resolve();
  function mutate(fn) {
    const run = async () => {
      const got = await chrome.storage.local.get(KEY);
      const cur = Object.assign(AUB.defaultState(), got[KEY] || {});
      cur.server = cur.server || {};
      fn(cur);
      prune(cur);
      cur.updatedAt = Date.now();
      await chrome.storage.local.set({ [KEY]: cur });
      state = cur;
      render();
    };
    const locked = () => (navigator.locks ? navigator.locks.request('aub-state-' + service, run) : run());
    const p = writeChain.then(locked, locked);
    writeChain = p.catch(() => {});
    return p.catch((e) => console.debug('[AUB] storage error', e));
  }

  // ---- events from the interceptor ----------------------------------------------------------------

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.source !== SRC || d.service !== service) return;
    if (!enabled()) return;
    switch (d.type) {
      case 'org': if (typeof d.orgId === 'string') orgId = d.orgId; break;
      case 'message': recordMessage(d); break;
      case 'info': recordInfo(d); break;
      case 'history': recordHistory(d); break;
      case 'limit': schedulePoll(1500); break;
      case 'send-error': recordSendError(d); break;
      default:
    }
  });

  // The whole chat so far, as the page loaded it. The model re-reads all of it on every turn, so its size is
  // what makes later messages in a long chat cost more than the first one.
  function recordHistory(d) {
    if (typeof d.conv !== 'string' || !Array.isArray(d.texts)) return;
    let tokens = 0;
    for (const t of d.texts) tokens += AUB.estimateTokens(t, service);
    mutate((s) => { s.convs[d.conv] = { tokens, t: Date.now() }; });
  }

  // Remember how many messages a model allowed before the limit hit. Counts only messages served by that model
  // inside the window; the highest of the last three hits is used as the cap (see AUB.learnedCap).
  function learnCap(s, requested, kind, t) {
    const sessionMs = AUB.sessionHours(service, settings, s.server.plan) * 3600e3;
    const from = t - (kind === 'week' ? AUB.WEEK_MS : sessionMs);
    const inWin = s.events.filter((e) => e.t >= from && e.t < t);
    let label = null;
    for (let i = inWin.length - 1; i >= 0 && !label; i--) if (inWin[i].m === requested) label = AUB.prettyModel(inWin[i].m);
    for (let i = inWin.length - 1; i >= 0 && !label; i--) if (inWin[i].m && !/mini/i.test(inWin[i].m)) label = AUB.prettyModel(inWin[i].m);
    if (!label) return;
    const count = inWin.filter((e) => AUB.prettyModel(e.m) === label).length;
    if (count < 1) return;
    const entry = (s.learned[label] = s.learned[label] || {});
    if (entry.lastAt && t - entry.lastAt < 10 * 60e3) return; // repeated clicks on the same limit are one hit
    const list = (entry[kind] = entry[kind] || []);
    list.push(count);
    if (list.length > 5) list.shift();
    entry.lastAt = t;
  }

  // ChatGPT quietly switches to a "mini" model when you pass a message cap. If a specific model was requested
  // and a mini one answered, that is a limit hit. ("Auto" mode is skipped: the router may pick mini by choice.)
  function detectFallback(s, d, served, t) {
    const asked = d.requestedModel;
    if (!served || !asked || asked === 'auto' || !/mini/i.test(served) || /mini/i.test(asked)) return;
    learnCap(s, asked, 'session', t);
  }

  function recordMessage(d) {
    const real = d.realIn > 0 || d.realOut > 0;
    const promptTok = AUB.estimateTokens(d.inText, service);
    const outTok = d.realOut > 0 ? d.realOut : AUB.estimateTokens(d.outText, service);
    const model = typeof d.model === 'string' ? d.model : (state.last && state.last.model) || null;
    const effort = typeof d.effort === 'string' ? d.effort : 'default';
    const conv = typeof d.conv === 'string' ? d.conv : null;
    const t = Number(d.t) || Date.now();
    const inChars = typeof d.inText === 'string' ? d.inText.length : 0;
    const outChars = typeof d.outText === 'string' ? d.outText.length : 0;
    mutate((s) => {
      // input = everything the model reads this turn: the chat so far (if known) plus your new message
      const prior = conv && s.convs[conv] ? s.convs[conv].tokens : 0;
      const inTok = d.realIn > 0 ? d.realIn : prior + promptTok;
      if (service === 'chatgpt') detectFallback(s, d, model, t);
      s.events.push({ t, m: model, e: effort, i: inTok, o: outTok, a: real ? 1 : 0 });
      if (conv) s.convs[conv] = { tokens: inTok + outTok, t };
      s.last = { model, effort, t, inChars, outChars, streamLines: Number(d.streamLines) || 0 };
    });
    if (service === 'claude') schedulePoll(4000);
  }

  // From ChatGPT's "N left" counters: the biggest "left" value ever seen for a feature is its cap, because a
  // counter can only go down inside a window. It is only trusted once seen in two different windows.
  function updateFeatureCaps(s, limits) {
    const fc = s.featureCaps && s.featureCaps.caps ? s.featureCaps : { plan: s.server.plan || null, caps: {} };
    for (const l of limits) {
      if (l.remaining == null) continue;
      const c = fc.caps[l.name] || { cap: 0, windows: 0, lastReset: null };
      if (c.lastReset == null || Math.abs((l.resetsAt || 0) - c.lastReset) > 120000) {
        c.windows += 1;
        c.lastReset = l.resetsAt || c.lastReset;
      }
      c.cap = Math.max(c.cap, l.remaining);
      fc.caps[l.name] = c;
    }
    s.featureCaps = fc;
  }

  function recordInfo(d) {
    if (service === 'claude') {
      if (/\/usage$/.test(d.path)) applyClaudeUsage(d.json);
      return;
    }
    if (/conversation\/init$/.test(d.path)) {
      const p = AUB.parseChatGPTInit(d.json);
      mutate((s) => {
        Object.assign(s.server, p, { fetchedAt: Date.now() });
        updateFeatureCaps(s, p.limits);
      });
    } else if (d.json && d.json.plan) {
      const plan = AUB.titleCase(String(d.json.plan).replace(/^chatgpt/i, ''));
      mutate((s) => {
        // a different plan has different caps, so anything learned under the old one is dropped
        if (s.server.plan && s.server.plan !== plan) { s.learned = {}; s.featureCaps = null; }
        s.server.plan = plan;
      });
    }
  }

  function recordSendError(d) {
    if (d.status !== 429) return;
    const info = AUB.parseLimitError(service, d.body || '');
    const now = Date.now();
    mutate((s) => {
      if (info.resetsAt) s.server.blockedUntil = info.resetsAt;
      // Only a hit that clears in more than 5 minutes is a message cap, not a short "slow down" rate limit.
      if (service === 'chatgpt' && info.resetsAt && info.resetsAt - now > 5 * 60e3) {
        learnCap(s, d.model, /week/i.test(info.message) ? 'week' : 'session', now);
      }
    });
    if (service === 'claude') schedulePoll(1000);
  }

  function applyClaudeUsage(j) {
    const u = AUB.parseClaudeUsage(j);
    pollOk = true;
    return mutate((s) => {
      Object.assign(s.server, { session: u.session, week: u.week, models: u.models, extra: u.extra, fetchedAt: Date.now(), lastPollOk: true });
    });
  }

  // Remembered so the status dot can turn yellow when Claude's usage cannot be read.
  function pollFailed() {
    if (pollOk !== false) {
      pollOk = false;
      mutate((s) => { s.server.lastPollOk = false; });
    }
    return false;
  }

  // ---- Claude: active polling of the same endpoint the Settings > Usage page uses -----------------

  const cookieOrg = () => {
    const m = /(?:^|;\s*)lastActiveOrg=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  };

  function planFromTier(tier) {
    const t = String(tier || '').toLowerCase();
    if (/max.*20x/.test(t)) return 'Max 20x';
    if (/max.*5x/.test(t)) return 'Max 5x';
    if (/max/.test(t)) return 'Max';
    if (/pro/.test(t)) return 'Pro';
    if (/team/.test(t)) return 'Team';
    if (/enterprise/.test(t)) return 'Enterprise';
    return null;
  }

  async function discoverOrg() {
    const r = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const orgs = await r.json();
    if (!Array.isArray(orgs) || !orgs.length) return null;
    const org = orgs.find((o) => o && o.uuid === cookieOrg()) || orgs.find((o) => o && (o.capabilities || []).includes('chat')) || orgs[0];
    const plan = planFromTier(org.rate_limit_tier);
    if (plan) mutate((s) => { s.server.plan = plan; });
    return org.uuid || null;
  }

  async function pollNow() {
    if (service !== 'claude' || !enabled() || pollBusy) return false;
    pollBusy = true;
    try {
      const org = orgId || cookieOrg() || (await discoverOrg());
      if (!org) return pollFailed();
      orgId = org;
      const r = await fetch('/api/organizations/' + org + '/usage', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!r.ok) { if (r.status === 403 || r.status === 404) orgId = null; return pollFailed(); }
      await applyClaudeUsage(await r.json());
      return true;
    } catch (e) {
      console.debug('[AUB] usage poll failed', e);
      return pollFailed();
    } finally {
      pollBusy = false;
    }
  }

  function schedulePoll(ms) {
    if (service !== 'claude') return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollNow, ms);
  }

  // ---- the bar ------------------------------------------------------------------------------------
  // Two looks. "inline": a slim row right under the chat box. "floating": a small box you can drag anywhere and
  // fold up, used when the chat box cannot be found or when you choose it in the popup. Both stay inside the
  // page's free space instead of covering the input.

  const hookOk = () => document.documentElement.getAttribute('data-aub-hook') === '1';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  function findAnchor() {
    for (const sel of CONFIG.anchors[service]) {
      const el = document.querySelector(sel);
      if (el) return el.closest('form') || el.closest('fieldset') || el;
    }
    // Generic fallback: the largest visible text box in the lower part of the window.
    let best = null;
    let area = 0;
    for (const el of document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 20 || r.top < window.innerHeight * 0.3) continue;
      if (r.width * r.height > area) { best = el; area = r.width * r.height; }
    }
    return best ? (best.closest('form') || best.closest('fieldset') || best.parentElement) : null;
  }

  function detectTheme() {
    const root = document.documentElement;
    const mode = (root.getAttribute('data-mode') || root.getAttribute('data-theme') || '').toLowerCase();
    if (root.classList.contains('dark') || mode === 'dark') return 'dark';
    if (root.classList.contains('light') || mode === 'light') return 'light';
    const m = (getComputedStyle(document.body || root).backgroundColor || '').match(/[\d.]+/g);
    if (m && m.length >= 3 && !(m.length >= 4 && Number(m[3]) === 0)) {
      return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] < 140 ? 'dark' : 'light';
    }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function seg(label, v) {
    return h('span', { class: 'aub-seg' },
      h('span', { class: 'aub-lbl' }, label),
      AUB.tape(v.pct),
      h('span', { class: 'aub-val ' + AUB.level(v.pct) }, AUB.fmtPct(v.pct)),
      v.resetsAt ? AUB.timeEl('reset', v.resetsAt, 'aub-sub') : null);
  }

  // One "how full is this limit" gauge, used for ChatGPT limits (reported counters, learned and typed caps).
  function meterSeg(m) {
    return h('span', { class: 'aub-seg' },
      h('span', { class: 'aub-lbl' }, m.label),
      AUB.tape(m.pct),
      h('span', { class: 'aub-val ' + AUB.level(m.pct) }, (m.approx ? '≈ ' : '') + AUB.fmtPct(m.pct)),
      m.left != null ? h('span', { class: 'aub-sub' }, m.left + ' left') : null,
      m.resetsAt ? AUB.timeEl('reset', m.resetsAt, 'aub-sub') : null);
  }

  function chips(vm, now) {
    const out = [];
    if (vm.blockedUntil) out.push(h('span', { class: 'aub-chip hot' }, 'Limit reached, ', AUB.timeEl('reset', vm.blockedUntil)));
    if (service === 'claude' && vm.current) {
      const label = AUB.prettyModel(vm.current.model);
      const m = vm.models.find((x) => x.label === label);
      const text = [label, vm.current.effort && vm.current.effort !== 'default' ? vm.current.effort + ' effort' : null,
        m && m.weekPct != null ? 'week ' + AUB.fmtPct(m.weekPct) : null].filter(Boolean).join(', ');
      out.push(h('span', { class: 'aub-chip' }, text));
    }
    const left = vm.session.msgsLeft;
    if (left != null) out.push(h('span', { class: 'aub-chip' }, (vm.session.msgsLeftEst ? '≈ ' : '') + left + ' messages left'));
    if (vm.session.tokLeft != null) out.push(h('span', { class: 'aub-chip' }, '≈ ' + AUB.fmtNum(vm.session.tokLeft) + ' tokens left'));
    const lim = vm.limits.filter((l) => l.remaining != null).sort((a, b) => a.remaining - b.remaining)[0];
    if (lim && !vm.meters.some((m) => m.pct != null)) out.push(h('span', { class: 'aub-chip' }, AUB.titleCase(lim.name) + ': ' + lim.remaining + ' left'));
    return out;
  }

  function tooltip(vm, now) {
    if (service === 'chatgpt') {
      const rows = vm.meters.slice(0, 5).map((m) => m.label + ': ' + AUB.fmtPct(m.pct) + ' used'
        + (m.left != null ? ', ' + m.left + ' left' : '') + (m.resetsAt ? ', ' + AUB.resetText(m.resetsAt - now) : ''));
      rows.push('Counted here: ' + vm.session.messages + ' messages in the last ' + vm.sessionHours + 'h, '
        + vm.week.messages + ' this week, about ' + AUB.fmtNum(vm.week.tokens) + ' tokens this week');
      rows.push('Open the extension popup for the full breakdown.');
      return rows.join('\n');
    }
    const line = (label, v) => label + ': ' + AUB.fmtPct(v.pct) + ' used'
      + (v.resetsAt ? ', ' + AUB.resetText(v.resetsAt - now) + ' (' + AUB.fmtWhen(v.resetsAt, now) + ')' : '')
      + '; ' + v.messages + ' messages and about ' + AUB.fmtNum(v.tokens) + ' tokens counted here';
    return [line('Session', vm.session), line('Week', vm.week), 'Open the extension popup for the full breakdown.'].join('\n');
  }

  // Green = working, yellow = something needs a look (hover it for what), red = switched off (popup only).
  const dot = (health) => h('span', { class: 'aub-dot ' + health.level, title: health.text });
  const nameBlock = (vm, health) => h('span', { class: 'aub-name' }, dot(health), vm.name,
    vm.plan ? h('span', { class: 'aub-plan' }, vm.plan) : null);

  // What the folded-up floating box shows: the fullest meter and how long until it resets.
  function summary(vm) {
    if (!vm.hasData) return h('span', { class: 'aub-sub' }, 'waiting…');
    const s = vm.session;
    const top = service === 'chatgpt' ? vm.meters.find((m) => m.pct != null) : null;
    const pct = top ? top.pct : s.pct;
    const parts = [];
    if (pct != null) parts.push(h('span', { class: 'aub-val ' + AUB.level(pct) }, (top && top.approx ? '≈ ' : '') + AUB.fmtPct(pct)));
    else parts.push(h('span', { class: 'aub-val' }, s.messages + ' sent'));
    const ends = s.resetsAt || (top && top.resetsAt) || null;
    if (ends) parts.push(AUB.timeEl('dur', ends, 'aub-sub'));
    return h('span', { class: 'aub-summary' }, parts);
  }

  function content(vm, now) {
    if (!vm.hasData) {
      return [h('span', { class: 'aub-sub' }, service === 'claude' ? 'Reading usage…' : 'Waiting for data. Send a message or open a new chat.')];
    }
    if (service === 'chatgpt') {
      const top = vm.meters.filter((m) => m.pct != null).slice(0, 2);
      const gauges = top.length
        ? top.map((m) => meterSeg(m))
        : [h('span', { class: 'aub-sub' }, vm.session.messages + ' sent in the last ' + vm.sessionHours + 'h')];
      return [...gauges, ...chips(vm, now)];
    }
    return [seg('Session', vm.session), seg('Week', vm.week), ...chips(vm, now)];
  }

  function buildBar(vm, health, mode) {
    const now = Date.now();
    const body = content(vm, now);
    let kids;
    if (mode === 'inline') {
      kids = [nameBlock(vm, health), ...body];
    } else {
      const open = ui.expanded;
      kids = [
        h('div', { class: 'aub-head' },
          nameBlock(vm, health),
          open ? null : summary(vm),
          h('button', { type: 'button', class: 'aub-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-label': open ? 'Fold up the usage box' : 'Open the usage box' },
            h('span', { class: 'aub-chev' }))),
        open ? h('div', { class: 'aub-body' }, body) : null,
      ];
    }
    return { kids: kids.filter(Boolean), title: tooltip(vm, now) + '\n' + health.text };
  }

  // ---- floating box: drag, fold, remember position ----

  const saveUi = () => Promise.resolve(chrome.storage.local.set({ [UI_KEY]: ui })).catch(() => {});

  function applyPos() {
    if (ui.x != null && ui.y != null) {
      Object.assign(bar.style, { left: ui.x + 'px', top: ui.y + 'px', right: 'auto', bottom: 'auto' });
    } else {
      Object.assign(bar.style, { left: '', top: '', right: '', bottom: '' });
    }
  }

  function toggleOpen() {
    ui.expanded = !ui.expanded;
    saveUi();
    render();
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !bar.classList.contains('aub-floating')) return;
    const head = e.target.closest('.aub-head');
    if (!head || e.target.closest('.aub-toggle')) return;
    const r = bar.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    let moved = false;
    try { head.setPointerCapture(e.pointerId); } catch (_) { /* not supported */ }
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      dragging = true;
      ui.x = clamp(ev.clientX - dx, 4, Math.max(4, window.innerWidth - r.width - 4));
      ui.y = clamp(ev.clientY - dy, 4, Math.max(4, window.innerHeight - r.height - 4));
      applyPos();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      dragging = false;
      if (moved) saveUi(); else toggleOpen();
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  }

  function makeBar() {
    const el = h('div', { id: 'aub-bar', role: 'status' });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('click', (e) => { if (e.target.closest('.aub-toggle')) toggleOpen(); });
    return el;
  }

  function chooseMode() {
    const m = settings.barMode;
    if (m === 'floating') return { mode: 'floating', anchor: null };
    const anchor = findAnchor();
    if (anchor) return { mode: 'inline', anchor };
    if (m === 'inline') return null;
    return Date.now() - startedAt > CONFIG.graceMs && document.body ? { mode: 'floating', anchor: null } : null;
  }

  function render() {
    try {
      if (dragging) return undefined;
      if (!enabled() || !settings.showBar) return removeBar();
      const chosen = chooseMode();
      if (!chosen) return removeBar();
      const vm = AUB.compute(service, state, settings);
      vm.seen = { t: Date.now(), hook: hookOk() }; // this page is, by definition, running the extension
      const health = AUB.health(vm, true);
      const { kids, title } = buildBar(vm, health, chosen.mode);
      if (!bar) bar = makeBar();
      bar.className = 'aub-' + chosen.mode + (chosen.mode === 'floating' && ui.expanded ? ' aub-open' : '');
      bar.dataset.theme = detectTheme();
      bar.dataset.service = service;
      bar.dataset.health = health.level;
      bar.title = title;
      bar.replaceChildren(...kids);
      if (chosen.mode === 'floating') {
        if (bar.parentElement !== document.body) document.body.append(bar);
        applyPos();
      } else {
        bar.removeAttribute('style');
        if (!bar.isConnected || bar.previousElementSibling !== chosen.anchor) chosen.anchor.insertAdjacentElement('afterend', bar);
      }
    } catch (e) {
      console.debug('[AUB] render failed', e);
    }
    return undefined;
  }

  function removeBar() {
    if (bar && bar.isConnected) bar.remove();
  }

  // Once a second: redraw every live countdown. When one runs out, refresh the numbers.
  function tick() {
    if (document.hidden || !bar || !bar.isConnected) return;
    if (AUB.tickTimes(bar) && Date.now() - lastExpiry > 20000) {
      lastExpiry = Date.now();
      schedulePoll(1500);
      render();
    }
  }

  // Tells the popup this page is running the extension and whether the network hook attached. Kept under its own
  // storage key so it does not rewrite the whole event log every 30 seconds.
  function heartbeat() {
    if (!enabled()) return;
    try {
      Promise.resolve(chrome.storage.local.set({ [SEEN_KEY]: { t: Date.now(), hook: hookOk(), host: location.hostname } })).catch(() => {});
    } catch (_) { /* extension was reloaded */ }
  }

  // ---- wiring -------------------------------------------------------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[AUB.KEYS.settings]) {
      const wasOn = enabled();
      settings = AUB.mergeSettings(changes[AUB.KEYS.settings].newValue);
      if (enabled() && !wasOn) schedulePoll(500);
    }
    if (changes[KEY]) state = Object.assign(AUB.defaultState(), changes[KEY].newValue || {});
    if (changes[UI_KEY]) ui = Object.assign({ x: null, y: null, expanded: false }, changes[UI_KEY].newValue || {});
    render();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'aub-refresh') {
      pollNow().then((ok) => reply({ ok, passive: service !== 'claude' }));
      return true;
    }
    return false;
  });

  let moQueued = false;
  function watchDom() {
    new MutationObserver(() => {
      if (moQueued) return;
      moQueued = true;
      setTimeout(() => {
        moQueued = false;
        if (!enabled() || !settings.showBar) return;
        if (settings.barMode === 'floating') { if (!bar || !bar.isConnected) render(); return; }
        const a = findAnchor();
        if (a ? (!bar || !bar.isConnected || bar.previousElementSibling !== a) : (!bar || !bar.isConnected)) render();
      }, 400);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  (async () => {
    try {
      const got = await chrome.storage.local.get([AUB.KEYS.settings, KEY, UI_KEY]);
      settings = AUB.mergeSettings(got[AUB.KEYS.settings]);
      state = Object.assign(AUB.defaultState(), got[KEY] || {});
      ui = Object.assign({ x: null, y: null, expanded: false }, got[UI_KEY] || {});
    } catch (_) { return; }
    watchDom();
    render();
    setTimeout(render, 3200);
    setTimeout(heartbeat, 1800);
    setInterval(heartbeat, CONFIG.heartbeatMs);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });
    setInterval(render, CONFIG.renderMs);
    setInterval(tick, 1000);
    window.addEventListener('resize', () => {
      if (ui.x == null || !bar || !bar.classList.contains('aub-floating')) return;
      const r = bar.getBoundingClientRect();
      ui.x = clamp(ui.x, 4, Math.max(4, window.innerWidth - r.width - 4));
      ui.y = clamp(ui.y, 4, Math.max(4, window.innerHeight - r.height - 4));
      applyPos();
    });
    if (service === 'claude') {
      schedulePoll(1500);
      setInterval(() => { if (!document.hidden) pollNow(); }, CONFIG.pollMs);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(500); });
    }
  })();
})();
