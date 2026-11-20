(() => {
  'use strict';
  if (window.__ytmsLoaded || window.top !== window) return;
  window.__ytmsLoaded = true;

  // ------------------------------------------------------------------ config
  const STORE_KEY = 'ytms-state-v1';
  const SUPPORT_URL = 'https://ko-fi.com/K7O62AUP2Z';
  const BATCH_SIZE = 20; // videos per request
  const BATCH_DELAY_MS = 350;
  const TILE_SEL = [
    'ytd-rich-item-renderer',
    'ytd-rich-grid-media',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-reel-item-renderer',
    'ytm-shorts-lockup-view-model-v2',
    'ytm-shorts-lockup-view-model',
    'yt-lockup-view-model',
  ].join(',');
  const LINK_SEL = 'a[href*="/watch?v="], a[href*="/shorts/"]';
  const TITLE_SEL = [
    '#video-title',
    '.yt-lockup-metadata-view-model__title',
    '.yt-lockup-metadata-view-model-wiz__title',
    '.shortsLockupViewModelHostMetadataTitle',
    'h3 a',
    'h3',
  ].join(',');

  // ------------------------------------------------------------------- state
  const state = {
    active: false,
    items: [], // [{id, title}] in selection order
    playlists: [], // [{id, title}]
    target: '', // playlist id, '__new' or '__url'
  };
  let lastClickedId = null;
  let busy = false;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (Array.isArray(s.items)) state.items = s.items.filter((i) => i && i.id);
      if (Array.isArray(s.playlists)) state.playlists = s.playlists;
      if (typeof s.target === 'string') state.target = s.target;
      state.active = !!s.active;
    } catch (_) {}
  }
  function save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          active: state.active,
          items: state.items,
          playlists: state.playlists,
          target: state.target,
        })
      );
    } catch (_) {}
  }

  // ------------------------------------------------------------ tile helpers
  function tileFor(el) {
    if (!el || !el.closest) return null;
    let tile = el.closest(TILE_SEL);
    if (!tile) return null;
    for (;;) {
      const outer = tile.parentElement && tile.parentElement.closest(TILE_SEL);
      if (!outer) return tile;
      tile = outer;
    }
  }

  function videoIdOf(tile) {
    // Skip playlist / mix cards: they link to a video but aren't one.
    if (
      !tile.matches('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer') &&
      tile.querySelector('yt-collection-thumbnail-view-model, ytd-playlist-thumbnail')
    ) {
      return null;
    }
    const a = tile.querySelector(LINK_SEL);
    if (!a) return null;
    try {
      const u = new URL(a.href, location.origin);
      let id = null;
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    } catch (_) {
      return null;
    }
  }

  function titleOf(tile, id) {
    const t = tile.querySelector(TITLE_SEL);
    const text = t && (t.getAttribute('title') || t.textContent || '').trim();
    return text || id;
  }

  const DUR_SEL = [
    'ytd-thumbnail-overlay-time-status-renderer',
    '.yt-badge-shape__text',
    '.badge-shape-wiz__text',
    'badge-shape',
    '#time-status',
  ].join(',');
  const DUR_RE = /(?:^|[^\d:])((?:\d{1,3}:)?\d{1,2}:\d{2})(?![\d:])/;

  // Length in seconds read from the thumbnail's time badge, or null if not shown.
  function durationOf(tile) {
    const d = tile.data || (tile.__data && tile.__data.data);
    const exact = d && parseInt(d.lengthSeconds, 10);
    if (exact > 0) return exact;
    const texts = [...tile.querySelectorAll(DUR_SEL)].map((el) => el.textContent || '');
    const a = tile.querySelector(LINK_SEL);
    if (a) texts.push(a.textContent || '');
    for (const t of texts) {
      const m = t.match(DUR_RE);
      if (m) return m[1].split(':').reduce((acc, n) => acc * 60 + Number(n), 0);
    }
    return null;
  }

  function fmtDuration(sec) {
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
  }

  function fmtDaysHours(sec) {
    const hours = Math.round(sec / 3600);
    const d = Math.floor(hours / 24);
    const hr = hours % 24;
    return `${d} day${d === 1 ? '' : 's'} ${hr} hour${hr === 1 ? '' : 's'}`;
  }

  const makeItem = (tile, id) => ({ id, title: titleOf(tile, id), dur: durationOf(tile) });

  function allTiles() {
    const out = [];
    document.querySelectorAll(TILE_SEL).forEach((tile) => {
      if (tile.parentElement && tile.parentElement.closest(TILE_SEL)) return; // nested
      const id = videoIdOf(tile);
      if (id) out.push({ tile, id });
    });
    return out;
  }

  // ---------------------------------------------------------------- marking
  let markTimer = null;
  function scheduleMark() {
    if (markTimer) return;
    markTimer = setTimeout(() => {
      markTimer = null;
      mark();
    }, 200);
  }

  function mark() {
    document.documentElement.classList.toggle('ytms-active', state.active);
    if (root && !root.isConnected) document.body.appendChild(root);
    placeTopBtn();
    const order = new Map(state.items.map((it, i) => [it.id, String(i + 1)]));
    const live = new Set();
    let filled = false;
    if (state.active) {
      for (const { tile, id } of allTiles()) {
        live.add(tile);
        if (order.has(id)) {
          const it = state.items[order.get(id) - 1];
          if (it.dur == null) {
            const d = durationOf(tile);
            if (d != null) {
              it.dur = d;
              filled = true;
            }
          }
        }
        if (!tile.hasAttribute('data-ytms-tile')) tile.setAttribute('data-ytms-tile', '');
        const n = order.get(id);
        if (n) {
          if (tile.getAttribute('data-ytms-order') !== n) tile.setAttribute('data-ytms-order', n);
        } else if (tile.hasAttribute('data-ytms-order')) {
          tile.removeAttribute('data-ytms-order');
        }
      }
    }
    document.querySelectorAll('[data-ytms-tile]').forEach((el) => {
      if (!live.has(el)) {
        el.removeAttribute('data-ytms-tile');
        el.removeAttribute('data-ytms-order');
      }
    });
    if (filled) {
      save();
      renderList();
    }
  }

  // -------------------------------------------------------------- selection
  const indexOfId = (id) => state.items.findIndex((i) => i.id === id);

  function changed() {
    save();
    mark();
    renderList();
  }

  function toggle(tile, id) {
    const i = indexOfId(id);
    if (i >= 0) state.items.splice(i, 1);
    else state.items.push(makeItem(tile, id));
    lastClickedId = id;
    changed();
  }

  function selectRange(toId) {
    const tiles = allTiles().filter((t) => t.tile.offsetParent !== null);
    const a = tiles.findIndex((t) => t.id === lastClickedId);
    const b = tiles.findIndex((t) => t.id === toId);
    if (a < 0 || b < 0) return false;
    const step = a <= b ? 1 : -1;
    for (let i = a; i !== b + step; i += step) {
      const { tile, id } = tiles[i];
      if (indexOfId(id) < 0) state.items.push(makeItem(tile, id));
    }
    lastClickedId = toId;
    changed();
    return true;
  }

  function selectAllVisible() {
    for (const { tile, id } of allTiles()) {
      if (tile.offsetParent === null) continue;
      if (indexOfId(id) < 0) state.items.push(makeItem(tile, id));
    }
    changed();
  }

  // Visible videos whose title contains the text (case-insensitive), in page order.
  function matchingTiles(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allTiles().filter(
      ({ tile }) => tile.offsetParent !== null && titleOf(tile, '').toLowerCase().includes(q)
    );
  }

  function syncFilterBtn() {
    const q = filterInput.value.trim();
    const n = q ? matchingTiles(q).length : 0;
    filterBtn.textContent = q ? `Select ${n} match${n === 1 ? '' : 'es'}` : 'Select matches';
  }

  function selectByTitle() {
    if (busy) return;
    const q = filterInput.value.trim();
    if (!q) return setStatus('Type part of a title to filter by.', 'err');
    const matches = matchingTiles(q);
    let added = 0;
    for (const { tile, id } of matches) {
      if (indexOfId(id) < 0) {
        state.items.push(makeItem(tile, id));
        added++;
      }
    }
    changed();
    syncFilterBtn();
    setStatus(
      matches.length
        ? `Selected ${added} video${added === 1 ? '' : 's'} with "${q}" in the title` +
            (matches.length - added ? ` (${matches.length - added} already selected).` : '.')
        : `No videos on this page have "${q}" in the title.`,
      matches.length ? 'ok' : 'err'
    );
  }

  function onClick(e) {
    if (!state.active || e.button !== 0 || e.ctrlKey || e.metaKey) return;
    if ((root && root.contains(e.target)) || (topBtn && topBtn.contains(e.target))) return;
    const tile = tileFor(e.target);
    if (!tile) return;
    const id = videoIdOf(tile);
    if (!id) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (busy) return;
    if (e.shiftKey && lastClickedId && selectRange(id)) return;
    toggle(tile, id);
  }

  function onMouseDown(e) {
    // stop shift-click from selecting page text
    if (state.active && e.shiftKey && tileFor(e.target)) e.preventDefault();
  }

  // -------------------------------------------------------------- YouTube API
  const cfg = (k) => {
    const y = window.ytcfg;
    if (!y) return undefined;
    if (typeof y.get === 'function') return y.get(k);
    return y.data_ ? y.data_[k] : undefined;
  };

  function cookie(name) {
    const m = document.cookie.match(
      new RegExp('(?:^|; )' + name.replace(/[-.]/g, '\\$&') + '=([^;]*)')
    );
    return m ? m[1] : null;
  }

  async function sha1(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function sessionIds() {
    let user = cfg('USER_SESSION_ID') || null;
    let delegated = cfg('DELEGATED_SESSION_ID') || null;
    const ds = cfg('DATASYNC_ID');
    if (ds) {
      const [first, second] = String(ds).split('||');
      if (second) {
        delegated = delegated || first;
        user = user || second;
      } else {
        user = user || first;
      }
    }
    return { user, delegated };
  }

  async function authHeader(userSessionId) {
    const origin = location.origin;
    const ts = Math.floor(Date.now() / 1000);
    const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
    if (!sapisid) return null;
    const sids = [
      ['SAPISIDHASH', sapisid],
      ['SAPISID1PHASH', cookie('__Secure-1PAPISID')],
      ['SAPISID3PHASH', cookie('__Secure-3PAPISID')],
    ];
    const parts = [];
    for (const [scheme, sid] of sids) {
      if (!sid) continue;
      const hashInput = (userSessionId ? [userSessionId] : []).concat([ts, sid, origin]).join(' ');
      const hash = await sha1(hashInput);
      parts.push(`${scheme} ${ts}_${hash}${userSessionId ? '_u' : ''}`);
    }
    return parts.join(' ');
  }

  async function yt(endpoint, body) {
    const context = cfg('INNERTUBE_CONTEXT');
    if (!context) throw new Error('YouTube page config not found — reload the page.');
    const { user, delegated } = sessionIds();
    const auth = await authHeader(user);
    if (!auth) throw new Error('Not signed in to YouTube.');
    const headers = {
      'Content-Type': 'application/json',
      Authorization: auth,
      'X-Origin': location.origin,
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
      'X-Youtube-Bootstrap-Logged-In': 'true',
    };
    if (delegated) headers['X-Goog-PageId'] = delegated;
    if (cfg('INNERTUBE_CONTEXT_CLIENT_NAME'))
      headers['X-Youtube-Client-Name'] = String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME'));
    if (cfg('INNERTUBE_CONTEXT_CLIENT_VERSION'))
      headers['X-Youtube-Client-Version'] = String(cfg('INNERTUBE_CONTEXT_CLIENT_VERSION'));
    if (cfg('VISITOR_DATA')) headers['X-Goog-Visitor-Id'] = String(cfg('VISITOR_DATA'));

    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ context, ...body }),
    });
    let json = null;
    try {
      json = await res.json();
    } catch (_) {}
    if (!res.ok) {
      const msg = json && json.error && json.error.message;
      throw new Error(msg || `YouTube returned HTTP ${res.status}`);
    }
    return json || {};
  }

  const textOf = (t) =>
    typeof t === 'string'
      ? t
      : t && (t.simpleText || t.content || (t.runs && t.runs.map((r) => r.text).join(''))) || '';

  async function fetchPlaylists() {
    const seed = state.items[0] ? state.items[0].id : 'jNQXAC9IVRw';
    const json = await yt('playlist/get_add_to_playlist', {
      videoIds: [seed],
      excludeWatchLater: false,
    });
    const found = new Map();
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (typeof o.playlistId === 'string' && o.title) {
        const title = textOf(o.title);
        if (title && !found.has(o.playlistId)) found.set(o.playlistId, title);
      }
      Object.values(o).forEach(walk);
    })(json);
    return [...found].map(([id, title]) => ({ id, title }));
  }

  async function createPlaylist(title, privacyStatus) {
    const json = await yt('playlist/create', { title, privacyStatus, videoIds: [] });
    if (!json.playlistId) throw new Error('YouTube did not return a new playlist id.');
    return json.playlistId;
  }

  const ACTIONS = {
    add: (id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id }),
    // removes every copy of the video from the playlist
    remove: (id) => ({ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: id }),
  };

  async function editBatch(mode, playlistId, ids) {
    const json = await yt('browse/edit_playlist', {
      playlistId,
      actions: ids.map(ACTIONS[mode]),
    });
    if (json.status !== 'STATUS_SUCCEEDED') throw new Error('status ' + (json.status || 'unknown'));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Adds (or removes) in order. Returns the list of items that failed.
  async function editVideos(mode, playlistId, items, onProgress) {
    const failed = [];
    let done = 0;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const chunk = items.slice(i, i + BATCH_SIZE);
      try {
        await editBatch(mode, playlistId, chunk.map((v) => v.id));
      } catch (_) {
        // One bad video fails the whole batch: retry one at a time, in order.
        for (const v of chunk) {
          try {
            await editBatch(mode, playlistId, [v.id]);
          } catch (err) {
            failed.push(v);
          }
          await sleep(150);
        }
      }
      done += chunk.length;
      onProgress(done, items.length);
      if (i + BATCH_SIZE < items.length) await sleep(BATCH_DELAY_MS);
    }
    return failed;
  }

  // --------------------------------------------------------------------- UI
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function svgIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const set = (el, attrs) => Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    set(svg, {
      width: 24,
      height: 24,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    });
    const corners = [
      'M3 7 V5 A3 3 0 0 1 6 2 H8',
      'M16 2 H18 A3 3 0 0 1 21 5 V7',
      'M21 13 V15 A3 3 0 0 1 18 18 H16',
      'M3 13 V15 A3 3 0 0 0 6 18 H8 C10.5 18 9.5 22 13 22', // corner runs off into the rope tail
    ];
    for (const d of corners) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    const play = document.createElementNS(NS, 'path');
    set(play, { d: 'M10.2 6.9 L15.6 10 L10.2 13.1 Z', fill: 'currentColor', 'stroke-width': 1.5 });
    svg.append(play);
    return svg;
  }

  function funnelIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const attrs = {
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2.2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    };
    Object.entries(attrs).forEach(([k, v]) => svg.setAttribute(k, v));
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M3 5 H21 L14 13 V19 L10 21 V13 Z');
    svg.append(p);
    return svg;
  }

  // Keep the activate button in YouTube's top bar; float it only if there is no top bar.
  function placeTopBtn() {
    if (!topBtn) return;
    const end = document.querySelector('ytd-masthead #end');
    if (end) {
      if (topBtn.parentElement !== end) end.prepend(topBtn);
    } else if (!topBtn.isConnected && root) {
      root.prepend(topBtn);
    }
  }

  let root, topBtn, topCount, filterInput, filterBtn, filterRow, filterToggle, panel, countEl, listEl, selectEl, newRow, newName, newPrivacy;
  let urlRow, urlInput, addBtn, removeBtn, totalEl, statusEl, barEl, barFill;

  function buildUI() {
    topCount = h('span', { class: 'ytms-topcount' });
    topBtn = h(
      'button',
      {
        class: 'ms-root ytms-topbtn',
        type: 'button',
        'aria-label': 'Lasso: select multiple videos',
        onclick: () => {
          if (!busy) setActive(!state.active);
        },
      },
      svgIcon(),
      topCount
    );
    filterInput = h('input', {
      type: 'text',
      placeholder: 'Title contains…',
      oninput: syncFilterBtn,
      onkeydown: (e) => {
        if (e.key === 'Enter') selectByTitle();
      },
    });
    filterBtn = h('button', { onclick: selectByTitle }, 'Select matches');
    filterRow = h('div', { class: 'ytms-row', style: 'display:none' }, filterInput, filterBtn);
    filterToggle = h(
      'button',
      {
        class: 'ytms-iconbtn',
        title: 'Select videos by title',
        'aria-expanded': 'false',
        onclick: () => {
          const open = filterRow.style.display === 'none';
          filterRow.style.display = open ? '' : 'none';
          filterToggle.classList.toggle('ytms-on', open);
          filterToggle.setAttribute('aria-expanded', String(open));
          if (open) {
            syncFilterBtn();
            filterInput.focus();
          }
        },
      },
      funnelIcon(),
      'Filter'
    );

    countEl = h('div', { class: 'ytms-title' });
    listEl = h('div', { class: 'ytms-list' });
    selectEl = h('select', {
      title: 'Target playlist',
      onchange: () => {
        state.target = selectEl.value;
        save();
        syncTargetRows();
      },
    });
    newName = h('input', { type: 'text', placeholder: 'New playlist name', maxlength: '150' });
    newPrivacy = h(
      'select',
      { style: 'flex:0 0 96px' },
      h('option', { value: 'PRIVATE' }, 'Private'),
      h('option', { value: 'UNLISTED' }, 'Unlisted'),
      h('option', { value: 'PUBLIC' }, 'Public')
    );
    newRow = h('div', { class: 'ytms-row' }, newName, newPrivacy);
    urlInput = h('input', { type: 'text', placeholder: 'Paste playlist link or ID' });
    urlRow = h('div', { class: 'ytms-row' }, urlInput);
    addBtn = h('button', { class: 'ytms-primary', style: 'flex:1', onclick: () => runJob('add') });
    removeBtn = h('button', { class: 'ytms-danger', style: 'flex:1', onclick: () => runJob('remove') });
    totalEl = h('div', { class: 'ytms-total' });
    statusEl = h('div', { class: 'ytms-status' });
    barFill = h('div');
    barEl = h('div', { class: 'ytms-bar', style: 'display:none' }, barFill);

    panel = h(
      'div',
      { class: 'ytms-panel' },
      h(
        'div',
        { class: 'ytms-row' },
        countEl,
        h('button', { title: 'Stop selecting (Esc)', onclick: () => setActive(false) }, 'Done')
      ),
      totalEl,
      h(
        'div',
        { class: 'ytms-hint' },
        'Click videos to select in order. Shift-click selects a range. Ctrl-click opens normally.'
      ),
      h(
        'div',
        { class: 'ytms-row' },
        h('button', { onclick: selectAllVisible }, 'Select all on page'),
        filterToggle
      ),
      filterRow,
      listEl,
      h(
        'div',
        { class: 'ytms-row' },
        selectEl,
        h('button', { title: 'Reload my playlists', onclick: () => refreshPlaylists(true) }, '⟳')
      ),
      newRow,
      urlRow,
      h('div', { class: 'ytms-row' }, addBtn),
      h(
        'div',
        { class: 'ytms-row' },
        removeBtn,
        h('button', { title: 'Clear the selection', onclick: clearSelection }, 'Clear')
      ),
      barEl,
      statusEl,
      h(
        'a',
        {
          class: 'ytms-support',
          href: SUPPORT_URL,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: 'Opens Ko-fi in a new tab',
        },
        h('span', { class: 'ytms-heart', 'aria-hidden': 'true' }, '♥'),
        'Support this project'
      )
    );

    root = h('div', { id: 'ytms-root', class: 'ms-root' }, panel);
    // keep YouTube's keyboard shortcuts from firing while typing in the panel
    for (const ev of ['keydown', 'keyup', 'keypress']) {
      root.addEventListener(ev, (e) => e.stopPropagation());
    }
    document.body.appendChild(root);
  }

  function clearSelection() {
    if (busy) return;
    state.items = [];
    lastClickedId = null;
    changed();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // clipboard API unavailable or blocked: fall back to a hidden field
      const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
      ta.value = text;
      root.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_e) {}
      ta.remove();
      return ok;
    }
  }

  function renderList() {
    const n = state.items.length;
    topCount.textContent = n ? (n > 999 ? '999+' : String(n)) : '';
    countEl.textContent = `${n} selected`;
    addBtn.textContent = n ? `Add ${n} video${n === 1 ? '' : 's'} to playlist` : 'Add to playlist';
    addBtn.disabled = busy || n === 0;
    removeBtn.textContent = n ? `Remove ${n} from playlist` : 'Remove from playlist';
    removeBtn.disabled = busy || n === 0;
    const known = state.items.filter((it) => it.dur != null);
    const total = known.reduce((acc, it) => acc + it.dur, 0);
    const unknown = n - known.length;
    totalEl.textContent = !n
      ? ''
      : `Total length: ${fmtDuration(total)}` +
        (unknown ? ` (+ ${unknown} with unknown length)` : '') +
        (total ? `\n= ${fmtDaysHours(total)}` : '');

    const keepScroll = listEl.scrollTop;
    const atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 4;
    listEl.textContent = '';
    if (!n) {
      listEl.append(h('div', { class: 'ytms-empty' }, 'Nothing selected yet.'));
      return;
    }
    const move = (i, d) => {
      if (busy) return;
      const j = i + d;
      if (j < 0 || j >= state.items.length) return;
      [state.items[i], state.items[j]] = [state.items[j], state.items[i]];
      changed();
    };
    state.items.forEach((it, i) => {
      listEl.append(
        h(
          'div',
          { class: 'ytms-item' },
          h('span', { class: 'ytms-num' }, i + 1),
          h('span', { class: 'ytms-name', title: it.title }, it.title),
          h('span', { class: 'ytms-dur' }, it.dur != null ? fmtDuration(it.dur) : ''),
          h('button', { title: 'Move up', onclick: () => move(i, -1) }, '▲'),
          h('button', { title: 'Move down', onclick: () => move(i, 1) }, '▼'),
          h(
            'button',
            {
              title: 'Remove',
              onclick: () => {
                if (busy) return;
                state.items.splice(i, 1);
                changed();
              },
            },
            '✕'
          )
        )
      );
    });
    listEl.scrollTop = atBottom ? listEl.scrollHeight : keepScroll;
  }

  function renderPlaylists() {
    selectEl.textContent = '';
    for (const p of state.playlists) selectEl.append(h('option', { value: p.id }, p.title));
    selectEl.append(
      h('option', { value: '__new' }, '＋ New playlist…'),
      h('option', { value: '__url' }, 'Paste playlist link…')
    );
    const values = [...selectEl.options].map((o) => o.value);
    if (!values.includes(state.target)) state.target = values[0];
    selectEl.value = state.target;
    syncTargetRows();
  }

  function syncTargetRows() {
    newRow.style.display = state.target === '__new' ? '' : 'none';
    urlRow.style.display = state.target === '__url' ? '' : 'none';
  }

  function setStatus(msg, kind) {
    statusEl.className = 'ytms-status' + (kind ? ' ytms-' + kind : '');
    statusEl.textContent = '';
    if (msg) statusEl.append(msg.nodeType ? msg : document.createTextNode(msg));
  }

  let playlistsLoaded = false;
  async function refreshPlaylists(force) {
    if (playlistsLoaded && !force) return;
    playlistsLoaded = true;
    try {
      if (force) setStatus('Loading your playlists…');
      const lists = await fetchPlaylists();
      if (lists.length) {
        state.playlists = lists;
        save();
        renderPlaylists();
        if (force) setStatus(`Loaded ${lists.length} playlists.`, 'ok');
      } else if (force) {
        setStatus('No playlists found. Use "New playlist" or paste a playlist link.', 'err');
      }
    } catch (err) {
      if (force) setStatus('Could not load playlists: ' + err.message, 'err');
    }
  }

  function setActive(on) {
    state.active = on;
    topBtn.classList.toggle('ytms-on', on);
    topBtn.setAttribute('aria-pressed', String(on));
    topBtn.title = on ? 'Exit Lasso' : 'Lasso: select multiple videos';
    root.classList.toggle('ytms-open', on);
    panel.style.display = on ? '' : 'none';
    save();
    mark();
    if (on) refreshPlaylists(false);
  }

  function setBusy(b) {
    busy = b;
    for (const el of panel.querySelectorAll('button, select, input')) el.disabled = b;
    if (!b) renderList();
  }

  async function runJob(mode) {
    if (busy || !state.items.length) return;
    const removing = mode === 'remove';
    let playlistId = state.target;
    let playlistTitle = (state.playlists.find((p) => p.id === playlistId) || {}).title || 'playlist';
    const newTitle = newName.value.trim();
    if (playlistId === '__url') {
      const raw = urlInput.value.trim();
      const m = raw.match(/[?&]list=([\w-]+)/) || raw.match(/^([\w-]{2,})$/);
      if (!m) return setStatus('That does not look like a playlist link or ID.', 'err');
      playlistId = m[1];
    } else if (playlistId === '__new') {
      if (removing) return setStatus('Choose the playlist to remove the videos from.', 'err');
      if (!newTitle) return setStatus('Enter a name for the new playlist.', 'err');
    }

    const items = state.items.slice();
    const count = `${items.length} video${items.length === 1 ? '' : 's'}`;
    if (
      removing &&
      !window.confirm(`Remove ${count} from "${playlistTitle}"?\n\nThis cannot be undone.`)
    ) {
      return;
    }
    const verb = removing ? 'Removing' : 'Adding';
    setBusy(true);
    barEl.style.display = '';
    barFill.style.width = '0';
    try {
      if (playlistId === '__new') {
        setStatus('Creating playlist…');
        playlistId = await createPlaylist(newTitle, newPrivacy.value);
        playlistTitle = newTitle;
        state.playlists.unshift({ id: playlistId, title: newTitle });
        state.target = playlistId;
        newName.value = '';
        renderPlaylists();
      }
      setStatus(`${verb} 0 / ${items.length}…`);
      const failed = await editVideos(mode, playlistId, items, (done, total) => {
        barFill.style.width = (100 * done) / total + '%';
        setStatus(`${verb} ${done} / ${total}…`);
      });
      const ok = items.length - failed.length;
      state.items = failed; // keep failures selected so they can be retried
      lastClickedId = null;
      save();
      mark();
      const playlistUrl = location.origin + '/playlist?list=' + encodeURIComponent(playlistId);
      const copyBtn = h(
        'button',
        {
          class: 'ytms-mini',
          onclick: async () => {
            const ok = await copyText(playlistUrl);
            copyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
            setTimeout(() => (copyBtn.textContent = 'Copy link'), 1500);
          },
        },
        'Copy link'
      );
      const done = removing ? 'Removed' : 'Added';
      const prep = removing ? 'from' : 'to';
      const msg = h(
        'span',
        null,
        failed.length
          ? `${done} ${ok} of ${items.length} ${prep} "${playlistTitle}". ${failed.length} failed and are still selected.`
          : `${done} ${ok} video${ok === 1 ? '' : 's'} ${prep} "${playlistTitle}".`,
        removing && ok ? ' Reload the page to see the change.' : null,
        h(
          'span',
          { class: 'ytms-links' },
          copyBtn,
          h('a', { class: 'ytms-mini', href: playlistUrl, target: '_blank' }, 'Open playlist')
        )
      );
      setStatus(msg, failed.length ? 'err' : 'ok');
    } catch (err) {
      setStatus('Failed: ' + err.message, 'err');
    } finally {
      barEl.style.display = 'none';
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------- init
  function init() {
    load();
    buildUI();
    renderPlaylists();
    renderList();
    setActive(state.active);

    window.addEventListener('click', onClick, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && state.active && !busy && !root.contains(e.target)) setActive(false);
      },
      true
    );
    new MutationObserver(scheduleMark).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('yt-navigate-finish', scheduleMark);
    window.addEventListener('storage', (e) => {
      if (e.key !== STORE_KEY || busy) return; // keep tabs in sync
      load();
      renderPlaylists();
      renderList();
      setActive(state.active);
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
