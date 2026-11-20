// Lasso: playlist duration panel (merged from "Playlist Duration for YouTube" 1.2.0)
// Runs in the page's MAIN world so it can read YouTube's own data
// (exact seconds per video) and falls back to the on-screen timestamps.
(() => {
  if (window.__ypdLoaded) return;
  window.__ypdLoaded = true;

  const PANEL_ID = 'ypd-panel';
  let loadingAll = false;
  const badAnchors = new WeakSet(); // placements where the panel ended up hidden

  // True if the panel has real size and no ancestor is clipping it.
  function isShown(panel) {
    const r = panel.getBoundingClientRect();
    if (r.width < 180 || r.height < 60) return false;
    for (let a = panel.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const ar = a.getBoundingClientRect();
        if (r.left < ar.left - 1 || r.right > ar.right + 1 || r.top < ar.top - 1 || r.bottom > ar.bottom + 1) return false;
      }
    }
    return true;
  }

  // ---------- helpers ----------
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const firstVisible = (sel) => [...document.querySelectorAll(sel)].find(visible) || null;

  function parseClock(text) {
    const m = (text || '').match(/\b(\d+):(\d{2})(?::(\d{2}))?\b/);
    if (!m) return 0;
    return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  }

  function itemSeconds(el) {
    const d = el.data || el.__data?.data;
    const fromData = parseInt(d?.lengthSeconds, 10);
    if (fromData > 0) return fromData;
    const fromDataText = parseClock(d?.lengthText?.simpleText);
    if (fromDataText > 0) return fromDataText;
    const badge = el.querySelector(
      'ytd-thumbnail-overlay-time-status-renderer, badge-shape, .yt-badge-shape__text, .badge-shape-wiz__text'
    );
    return parseClock(badge?.textContent);
  }

  function parseCount(str) {
    const m = (str || '').match(/([\d][\d,.  ]*)\s*videos?\b/i);
    if (!m) return null;
    const n = parseInt(m[1].replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtClock(s) {
    return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }
  function fmtDays(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    return `${pl(d, 'day')} ${pl(h, 'hr')} ${pl(m, 'min')}`;
  }

  // ---------- find the playlist on the page ----------
  function getContext() {
    const path = location.pathname;
    const hasList = new URLSearchParams(location.search).has('list');

    if (path === '/playlist' && hasList) {
      // Be lenient about the page wrapper: YouTube has several playlist layouts.
      const browse =
        firstVisible('ytd-browse[page-subtype="playlist"]') || firstVisible('ytd-browse') || document;
      const items = [...browse.querySelectorAll('ytd-playlist-video-renderer')].filter(visible);
      const list =
        [...browse.querySelectorAll('ytd-playlist-video-list-renderer')].find(visible) ||
        (items[0] && items[0].parentElement);
      if (!list) return null;
      const hasMore = !!list.querySelector('ytd-continuation-item-renderer');

      let total = null;
      try {
        const d = browse.data || {};
        total = parseCount(JSON.stringify([d.header, d.sidebar]));
      } catch (e) {}
      if (total == null) {
        const header = [
          ...browse.querySelectorAll(
            'ytd-playlist-header-renderer, yt-page-header-renderer, ytd-playlist-sidebar-renderer'
          ),
        ].find(visible);
        total = parseCount(header?.innerText);
      }

      // Candidate spots, best first. Any spot where the panel turns out to be
      // hidden or clipped is remembered in badAnchors and skipped next time.
      const spots = [
        ['ytd-playlist-header-renderer .metadata-wrapper', 'append'],
        ['ytd-playlist-header-renderer .immersive-header-content', 'append'],
        ['yt-page-header-renderer yt-flexible-actions-view-model', 'after'],
        ['yt-page-header-renderer yt-content-metadata-view-model', 'after'],
        ['yt-page-header-renderer yt-description-preview-view-model', 'after'],
        ['yt-page-header-renderer yt-page-header-view-model', 'append'],
        ['yt-page-header-renderer', 'append'],
        ['ytd-playlist-sidebar-primary-info-renderer', 'append'],
      ];
      let anchor = null, anchorMode = 'append';
      for (const [sel, mode] of spots) {
        const found = [...browse.querySelectorAll(sel)].find((n) => visible(n) && !badAnchors.has(n));
        if (found) { anchor = found; anchorMode = mode; break; }
      }

      return { kind: 'page', items, hasMore, total, anchor, anchorMode, list };
    }

    if (path === '/watch' && hasList) {
      const panel = firstVisible('ytd-watch-flexy ytd-playlist-panel-renderer');
      if (!panel) return null;
      const items = [...panel.querySelectorAll('ytd-playlist-panel-video-renderer')];
      if (!items.length) return null;
      const total = parseInt(panel.data?.totalVideos, 10) || null;
      return { kind: 'watch', items, hasMore: false, total, anchor: badAnchors.has(panel) ? null : panel, anchorMode: 'before' };
    }
    return null;
  }

  // ---------- panel ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function row(parent, label, value, valueCls) {
    const r = el('div', 'ypd-row');
    r.append(el('span', 'ypd-label', label), el('span', 'ypd-value' + (valueCls ? ' ' + valueCls : ''), value));
    parent.append(r);
  }

  function isLightBehind(node) {
    // Light text needed on dark/immersive headers; dark text on light theme sidebars.
    if (node.closest('ytd-playlist-header-renderer, yt-page-header-renderer')) return false;
    return !document.documentElement.hasAttribute('dark');
  }

  let lastSig = '';
  function render() {
    const ctx = getContext();
    let panel = document.getElementById(PANEL_ID);
    const off = document.documentElement.getAttribute('data-lasso-duration') === 'off'; // Lasso option
    if (!ctx || off) { panel?.remove(); lastSig = ''; return; }

    let seconds = 0, counted = 0;
    for (const it of ctx.items) {
      const s = itemSeconds(it);
      if (s > 0) { seconds += s; counted++; }
    }
    const loaded = ctx.items.length;
    const noDuration = loaded - counted;
    const total = Math.max(ctx.total ?? loaded, loaded);
    const notLoaded = ctx.hasMore || ctx.kind === 'watch' ? total - loaded : 0;
    const uncounted = noDuration + notLoaded;

    if (!panel) panel = el('div');
    panel.id = PANEL_ID;

    // placement
    const floating = !ctx.anchor;
    if (floating) {
      if (panel.parentNode !== document.body) document.body.append(panel);
    } else if (ctx.anchorMode === 'before') {
      if (panel.nextElementSibling !== ctx.anchor) ctx.anchor.before(panel);
    } else if (ctx.anchorMode === 'after') {
      if (panel.previousElementSibling !== ctx.anchor) ctx.anchor.after(panel);
    } else if (panel.parentNode !== ctx.anchor) {
      ctx.anchor.append(panel);
    }
    panel.className = 'ms-root' + (floating ? ' ypd-floating' : '') + (!floating && isLightBehind(panel) ? ' ypd-light' : '');

    const sig = [seconds, counted, uncounted, notLoaded, noDuration, ctx.hasMore, loadingAll, ctx.kind].join('|');
    if (sig === lastSig && panel.childElementCount) return;
    lastSig = sig;

    panel.replaceChildren();
    panel.append(el('div', 'ypd-title', 'Playlist duration'));
    row(panel, 'Total (h:mm:ss)', fmtClock(seconds), 'ypd-good');
    row(panel, 'Total hours', (seconds / 3600).toFixed(1) + ' hrs');
    row(panel, 'Days + hours', fmtDays(seconds));
    panel.append(el('div', 'ypd-sep'));
    row(panel, 'Videos counted', String(counted), 'ypd-good');
    row(panel, 'Videos not counted', String(uncounted), uncounted ? 'ypd-warn' : '');

    const notes = [];
    if (notLoaded > 0) notes.push(`${notLoaded} not loaded yet`);
    if (noDuration > 0) notes.push(`${noDuration} with no length (private, deleted, live or upcoming)`);
    if (notes.length) panel.append(el('div', 'ypd-note', notes.join(' · ')));

    if (ctx.kind === 'page' && (ctx.hasMore || loadingAll)) {
      const btn = el('button', '', loadingAll ? `Loading… (${loaded} so far)` : 'Load all videos');
      btn.disabled = loadingAll;
      btn.addEventListener('click', loadAll);
      panel.append(btn);
    } else if (ctx.kind === 'watch' && notLoaded > 0) {
      panel.append(el('div', 'ypd-note', 'Open the full playlist page to count every video.'));
    }
  }

  // Render, then make sure the panel is really visible where it was put.
  // If not, rule that spot out and try the next one; the last resort floats
  // at the bottom left, which is always visible.
  function renderChecked() {
    for (let tries = 0; tries < 10; tries++) {
      render();
      const panel = document.getElementById(PANEL_ID);
      if (!panel || panel.classList.contains('ypd-floating') || isShown(panel)) return;
      const ctx = getContext();
      if (!ctx || !ctx.anchor) return;
      badAnchors.add(ctx.anchor);
      lastSig = '';
    }
  }

  // YouTube only loads 100 videos at a time; scroll the "load more" spinner
  // into view repeatedly until the whole playlist is in the page.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function loadAll() {
    if (loadingAll) return;
    loadingAll = true;
    const startY = window.scrollY;
    let stalls = 0, lastCount = -1;
    try {
      while (stalls < 12) {
        const ctx = getContext();
        if (!ctx || ctx.kind !== 'page') break;
        const more = ctx.list.querySelector('ytd-continuation-item-renderer');
        if (!more) break;
        more.scrollIntoView({ block: 'center' });
        if (ctx.items.length === lastCount) stalls++; else { stalls = 0; lastCount = ctx.items.length; }
        render();
        await sleep(600);
      }
    } finally {
      loadingAll = false;
      window.scrollTo(0, startY);
      render();
    }
  }

  // ---------- keep it up to date ----------
  const safeRender = () => { try { renderChecked(); } catch (e) { console.debug('[lasso:playlist-duration]', e); } };
  ['yt-navigate-finish', 'yt-page-data-updated', 'lasso-options'].forEach((ev) => document.addEventListener(ev, safeRender));
  setInterval(safeRender, 1500);
  safeRender();
})();
