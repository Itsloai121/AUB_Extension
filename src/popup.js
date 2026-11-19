/*
 * AI Usage Bar — popup.js
 * Reads the numbers content.js keeps in chrome.storage.local and draws one card per service.
 * The switch on each card turns tracking (and the bar) on or off for that site.
 */
(() => {
  'use strict';
  const AUB = globalThis.AUB;
  const h = AUB.h;
  const ORDER = ['chatgpt', 'claude'];

  let settings = AUB.mergeSettings();
  const states = { claude: AUB.defaultState(), chatgpt: AUB.defaultState() };
  let confirming = null;
  let confirmTimer = null;

  // ---- storage ------------------------------------------------------------------------------------

  async function loadAll() {
    const keys = [AUB.KEYS.settings, ...ORDER.map(AUB.KEYS.state), ...ORDER.map(AUB.KEYS.seen)];
    const got = await chrome.storage.local.get(keys);
    settings = AUB.mergeSettings(got[AUB.KEYS.settings]);
    for (const s of ORDER) {
      states[s] = Object.assign(AUB.defaultState(), got[AUB.KEYS.state(s)] || {});
      states[s].seen = got[AUB.KEYS.seen(s)] || null;
    }
  }

  const saveSettings = () => chrome.storage.local.set({ [AUB.KEYS.settings]: settings });

  async function resetCounters(service) {
    const key = AUB.KEYS.state(service);
    const got = await chrome.storage.local.get(key);
    const st = Object.assign(AUB.defaultState(), got[key] || {});
    st.events = [];
    st.last = null;
    await chrome.storage.local.set({ [key]: st });
  }

  async function forgetLearned(service) {
    const key = AUB.KEYS.state(service);
    const got = await chrome.storage.local.get(key);
    const st = Object.assign(AUB.defaultState(), got[key] || {});
    st.learned = {};
    st.featureCaps = null;
    await chrome.storage.local.set({ [key]: st });
  }

  // ---- rendering ----------------------------------------------------------------------------------

  const tokenText = (v) => '≈ ' + AUB.fmtNum(v.tokens) + ' used';

  function cell(main, sub) {
    return h('td', null, h('div', { class: 'main' }, main), sub ? h('div', { class: 'sub' }, sub) : null);
  }

  function usageCell(v) {
    return h('td', null,
      h('div', { class: 'big ' + AUB.level(v.pct) }, (v.pctSource === 'learned' ? '≈ ' : '') + AUB.fmtPct(v.pct)),
      AUB.tape(v.pct),
      v.pct == null ? h('div', { class: 'sub' }, 'no limit data yet') : null,
      v.pctSource === 'cap' ? h('div', { class: 'sub' }, 'from your cap') : null,
      v.pctSource === 'learned' ? h('div', { class: 'sub' }, 'learned cap, ' + v.note) : null);
  }

  function resetCell(v, now) {
    if (!v.resetsAt) return cell('—', 'no active window');
    return cell(AUB.timeEl('dur', v.resetsAt), AUB.fmtWhen(v.resetsAt, now));
  }

  function leftText(left, est) {
    return left == null ? '—' : (est ? '≈ ' : '') + left + ' left';
  }

  function statsTable(vm, now) {
    const s = vm.session;
    const w = vm.week;
    return h('table', null,
      h('thead', null, h('tr', null, h('th'), h('th', { scope: 'col' }, 'Session'), h('th', { scope: 'col' }, 'Week'))),
      h('tbody', null,
        h('tr', null, h('th', { scope: 'row' }, 'Usage'), usageCell(s), usageCell(w)),
        vm.service === 'chatgpt' ? null : h('tr', null, h('th', { scope: 'row' }, 'Resets in'), resetCell(s, now), resetCell(w, now)),
        h('tr', null, h('th', { scope: 'row' }, 'Messages'),
          cell(s.messages + ' sent', leftText(s.msgsLeft, s.msgsLeftEst)),
          cell(w.messages + ' sent', leftText(w.msgsLeft, w.msgsLeftEst))),
        h('tr', null, h('th', { scope: 'row' }, 'Tokens'),
          cell(tokenText(s), s.tokLeft == null ? '—' : '≈ ' + AUB.fmtNum(s.tokLeft) + ' left'),
          cell(tokenText(w), w.tokLeft == null ? '—' : '≈ ' + AUB.fmtNum(w.tokLeft) + ' left'))));
  }

  function sessionNote(vm) {
    return vm.service === 'chatgpt'
      ? 'Session means the last ' + vm.sessionHours + ' hours (change it in Settings). ChatGPT does not publish when a window resets, so no reset time is guessed here.'
      : 'Tokens include the chat history the model re-reads on every turn.';
  }

  const msgs = (n) => n + (n === 1 ? ' msg' : ' msgs');

  function effortLabel(e) { return e === 'default' ? 'Default' : AUB.titleCase(e); }

  function modelBlock(m, now) {
    const est = [];
    if (m.msgsLeft != null) est.push('≈ ' + m.msgsLeft + ' messages left this week');
    if (m.tokLeft != null) est.push('≈ ' + AUB.fmtNum(m.tokLeft) + ' tokens left this week');
    return h('div', { class: 'model' },
      h('div', { class: 'model-head' },
        h('strong', null, m.label),
        h('span', { class: 'sub' }, m.weekPct == null
          ? 'no weekly figure from Claude'
          : ['Week ' + AUB.fmtPct(m.weekPct) + (m.weekResetsAt ? ', ' : ''), m.weekResetsAt ? AUB.timeEl('reset', m.weekResetsAt) : null])),
      AUB.tape(m.weekPct),
      m.efforts.length ? h('table', null,
        h('thead', null, h('tr', null, h('th'), h('th', { scope: 'col' }, 'Session'), h('th', { scope: 'col' }, 'Week'))),
        h('tbody', null, m.efforts.map((e) => h('tr', null,
          h('th', { scope: 'row' }, effortLabel(e.effort)),
          h('td', null, msgs(e.session.messages) + ', ≈ ' + AUB.fmtNum(e.session.tokens)),
          h('td', null, msgs(e.week.messages) + ', ≈ ' + AUB.fmtNum(e.week.tokens)))))) : null,
      est.length ? h('div', { class: 'est' }, est.join(', ')) : null);
  }

  function meterRow(m, now) {
    const parts = [
      m.left != null ? m.left + ' left' + (m.cap ? ' of ' + (m.approx ? '≈ ' : '') + m.cap : '') : null,
      m.resetsAt ? AUB.timeEl('reset', m.resetsAt) : null,
      m.learning ? 'learning the cap, a percentage appears after it has been seen in two windows' : null,
    ].filter(Boolean);
    const detail = parts.flatMap((p, i) => (i ? [', ', p] : [p]));
    return h('div', { class: 'meter' },
      h('div', { class: 'meter-head' },
        h('span', null, m.label),
        h('span', { class: 'meter-pct ' + AUB.level(m.pct) }, m.pct == null ? '—' : (m.approx ? '≈ ' : '') + AUB.fmtPct(m.pct))),
      AUB.tape(m.pct),
      h('div', { class: 'sub' }, detail));
  }

  function metersBlock(vm, now) {
    if (!vm.meters.length) return null;
    return h('div', null, h('div', { class: 'section-title' }, 'Limits and caps'), vm.meters.map((m) => meterRow(m, now)));
  }

  function learnedBlock(vm) {
    return h('div', null,
      h('div', { class: 'section-title' }, 'Caps learned from limit hits'),
      vm.learned.length
        ? vm.learned.map((l) => h('div', { class: 'limit-row' },
          h('span', null, l.label),
          h('span', { class: 'sub' }, [
            l.session ? l.session + ' per ' + vm.sessionHours + 'h (' + l.sessionHits + ' hit' + (l.sessionHits === 1 ? '' : 's') + ')' : null,
            l.week ? l.week + ' per week (' + l.weekHits + ' hit' + (l.weekHits === 1 ? '' : 's') + ')' : null,
          ].filter(Boolean).join(', '))))
        : h('p', { class: 'note' }, 'None yet. When ChatGPT stops a message or drops you to a mini model because you hit a limit, the tool records how many messages you had sent and uses that as the cap.'),
      vm.learned.length ? h('button', { type: 'button', class: 'link-btn', onclick: () => forgetLearned(vm.service) }, 'Forget learned caps') : null);
  }

  function statusLine(vm, now) {
    const health = AUB.health(vm, true, now);
    const level = health.level === 'ok' ? 'ok' : 'warn';
    const line = level === 'ok'
      ? h('p', { class: 'status ok' }, 'Connected, last seen ', AUB.timeEl('ago', vm.seen.t), '. ',
        vm.lastMessageAt ? ['Last message counted ', AUB.timeEl('ago', vm.lastMessageAt), '.'] : 'No message counted yet.')
      : h('p', { class: 'status warn' }, health.text);
    const last = vm.current;
    const lost = vm.seen && vm.seen.hook && last && typeof last.outChars === 'number' && last.outChars === 0 && last.t === vm.lastMessageAt;
    if (!lost) return line;
    return h('div', null,
      line,
      h('p', { class: 'status warn' }, 'The last reply was not captured (' + (last.streamLines || 0) + ' stream lines read), so its output tokens count as 0. If this keeps happening the reply format may have changed. See "Finding problems" in the README.'));
  }

  function card(vm, now) {
    const on = !!settings.enabled[vm.service];
    const health = AUB.health(vm, on, now);
    const body = [];
    if (on) {
      body.push(statusLine(vm, now));
      if (vm.blockedUntil) body.push(h('p', { class: 'alert' }, 'Limit reached, ', AUB.timeEl('reset', vm.blockedUntil)));
      if (!vm.hasData) {
        body.push(h('p', { class: 'empty' }, vm.service === 'claude'
          ? 'No data yet. Open claude.ai and send a message.'
          : 'No data yet. Open chatgpt.com and send a message.'));
      }
      body.push(statsTable(vm, now));
      body.push(h('p', { class: 'note' }, sessionNote(vm)));
      if (vm.extra && vm.extra.pct != null) body.push(h('p', { class: 'note' }, 'Extra usage: ' + AUB.fmtPct(vm.extra.pct) + ' of your monthly limit'));
      if (vm.service === 'claude') {
        body.push(h('div', { class: 'section-title' }, 'By model and effort'));
        if (vm.models.length) body.push(...vm.models.map((m) => modelBlock(m, now)));
        else body.push(h('p', { class: 'empty' }, 'Models appear after your first message.'));
      } else {
        const mt = metersBlock(vm, now);
        if (mt) body.push(mt);
        body.push(learnedBlock(vm));
      }
      body.push(h('div', { class: 'foot' },
        h('span', null, vm.fetchedAt ? ['Site numbers updated ', AUB.timeEl('ago', vm.fetchedAt)] : 'No site numbers yet'),
        h('button', {
          type: 'button',
          class: 'link-btn' + (confirming === vm.service ? ' danger' : ''),
          onclick: async () => {
            if (confirming !== vm.service) {
              confirming = vm.service;
              clearTimeout(confirmTimer);
              confirmTimer = setTimeout(() => { confirming = null; render(); }, 4000);
              render();
              return;
            }
            confirming = null;
            await resetCounters(vm.service);
          },
        }, confirming === vm.service ? 'Click again to clear' : 'Reset local counts')));
    }
    return h('section', { class: 'card' + (on ? '' : ' off'), 'data-service': vm.service },
      h('div', { class: 'card-head' },
        h('span', { class: 'dot ' + health.level, title: health.text }),
        h('div', { class: 'titles' },
          h('strong', null, vm.name),
          vm.plan ? h('span', { class: 'plan' }, vm.plan) : null,
          !on ? h('div', { class: 'state' }, 'Tracking is off') : null),
        h('label', { class: 'switch', title: (on ? 'Turn off ' : 'Turn on ') + vm.name + ' tracking' },
          h('input', {
            type: 'checkbox',
            'aria-label': vm.name + ' tracking',
            checked: on,
            onchange: async (ev) => {
              settings.enabled[vm.service] = ev.target.checked;
              await saveSettings();
              render();
            },
          }),
          h('span', { class: 'slider' }))),
      h('div', { class: 'body' }, body));
  }

  function render() {
    const now = Date.now();
    const list = document.getElementById('list');
    list.replaceChildren(...ORDER.map((s) => card(AUB.compute(s, states[s], settings, now), now)));
    syncInputs();
  }

  // ---- settings inputs ----------------------------------------------------------------------------

  function syncInputs() {
    const bar = document.getElementById('showBar');
    const s = document.getElementById('capSession');
    const w = document.getElementById('capWeek');
    const hrs = document.getElementById('capWindow');
    bar.checked = settings.showBar;
    document.getElementById('barMode').value = settings.barMode;
    if (document.activeElement !== hrs) hrs.value = settings.caps.chatgpt.windowHours ?? '';
    if (document.activeElement !== s) s.value = settings.caps.chatgpt.session ?? '';
    if (document.activeElement !== w) w.value = settings.caps.chatgpt.week ?? '';
  }

  function bindInputs() {
    document.getElementById('showBar').addEventListener('change', async (ev) => {
      settings.showBar = ev.target.checked;
      await saveSettings();
    });
    document.getElementById('barMode').addEventListener('change', async (ev) => {
      settings.barMode = ev.target.value;
      await saveSettings();
    });
    document.getElementById('resetPos').addEventListener('click', () => {
      chrome.storage.local.remove(ORDER.map(AUB.KEYS.ui));
    });
    const cap = (id, field) => document.getElementById(id).addEventListener('change', async (ev) => {
      const n = parseInt(ev.target.value, 10);
      settings.caps.chatgpt[field] = Number.isFinite(n) && n > 0 ? n : null;
      await saveSettings();
    });
    cap('capSession', 'session');
    cap('capWeek', 'week');
    cap('capWindow', 'windowHours');

    const btn = document.getElementById('refresh');
    btn.addEventListener('click', async () => {
      btn.classList.add('spin');
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id != null) await chrome.tabs.sendMessage(tab.id, { type: 'aub-refresh' });
      } catch (_) { /* the active tab is not Claude or ChatGPT */ }
      setTimeout(() => btn.classList.remove('spin'), 600);
    });
  }

  // ---- boot ---------------------------------------------------------------------------------------

  chrome.storage.onChanged.addListener(async (_changes, area) => {
    if (area !== 'local') return;
    await loadAll();
    render();
  });

  (async () => {
    bindInputs();
    await loadAll();
    render();
    setInterval(render, 15000);
    setInterval(() => AUB.tickTimes(document), 1000);
  })();
})();
