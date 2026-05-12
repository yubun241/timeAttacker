/* ============================================================
   TIME ATTACKER  (Ver.1.0 / 藤井工藝)
   GPS time-attack PWA with map-based line drawing
   ============================================================ */

(() => {
  'use strict';

  // ============================================================
  // CONSTANTS
  // ============================================================
  const STORAGE_KEY = 'mirage.courses.v2';
  const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const DEFAULT_CENTER = [35.6812, 139.7671];
  const R_EARTH = 6378137;
  const G_RANGE = 2.0;             // G-ball max scale
  const SPEED_WINDOW_S = 30.0;     // speed graph window
  const RECORD_LIMIT = 50000;      // CSV row cap (~14h @ 1Hz)

  // Default per-course tunables (overrideable via detail modal)
  const DEFAULT_COOLDOWN_S = 5.0;
  const DEFAULT_ACC_M = 30;        // 0 = disabled
  const DEFAULT_DIRFILTER = false;

  // ============================================================
  // GEO HELPERS
  // ============================================================
  function toLocal(lat, lon, lat0, lon0) {
    const dLat = (lat - lat0) * Math.PI / 180;
    const dLon = (lon - lon0) * Math.PI / 180;
    return {
      x: dLon * Math.cos(lat0 * Math.PI / 180) * R_EARTH,
      y: dLat * R_EARTH
    };
  }

  function segmentIntersect(p1, p2, a, b) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = b.x - a.x,   d2y = b.y - a.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((a.x - p1.x) * d2y - (a.y - p1.y) * d2x) / denom;
    const u = ((a.x - p1.x) * d1y - (a.y - p1.y) * d1x) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return { t, side: Math.sign(denom) };
    }
    return null;
  }

  function detectCrossing(prevFix, currFix, lineA, lineB) {
    if (!prevFix || !currFix) return null;
    const p1 = toLocal(prevFix.lat, prevFix.lon, lineA[0], lineA[1]);
    const p2 = toLocal(currFix.lat, currFix.lon, lineA[0], lineA[1]);
    const a  = { x: 0, y: 0 };
    const b  = toLocal(lineB[0], lineB[1], lineA[0], lineA[1]);
    const r  = segmentIntersect(p1, p2, a, b);
    if (!r) return null;
    return {
      t: prevFix.t + (currFix.t - prevFix.t) * r.t,
      side: r.side
    };
  }

  /** Distance between two GPS points in meters (haversine, simplified for short distances). */
  function distM(lat1, lon1, lat2, lon2) {
    const p = toLocal(lat2, lon2, lat1, lon1);
    return Math.sqrt(p.x * p.x + p.y * p.y);
  }

  // ============================================================
  // FORMAT HELPERS
  // ============================================================
  function formatTime(ms) {
    if (ms == null || !isFinite(ms)) return '--:--.---';
    const sign = ms < 0 ? '-' : '';
    ms = Math.abs(ms);
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const ms3 = Math.floor(ms % 1000);
    return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms3).padStart(3, '0')}`;
  }

  function formatTimeShort(ms) {
    if (ms == null || !isFinite(ms)) return '--:--.--';
    const sign = ms < 0 ? '-' : '';
    ms = Math.abs(ms);
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  function formatDelta(ms) {
    if (ms == null || !isFinite(ms)) return '--';
    const sign = ms >= 0 ? '+' : '−';
    return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}`;
  }

  /**
   * Parse MMSS.CC numeric input → ms
   * Accepts:
   *   "0520.10" → 05:20.10  (MMSS.CC with dot)
   *   "052010"  → 05:20.10  (6-digit MMSSCC)
   *   "0520"    → 05:20.00  (4-digit MMSS)
   */
  function parseTargetTime(raw) {
    if (!raw || !raw.trim()) return null;
    const s = raw.trim();
    let mm, ss, cc;
    if (s.includes('.')) {
      const dot = s.indexOf('.');
      const ip  = s.slice(0, dot).replace(/\D/g, '').padStart(4, '0').slice(-4);
      const fp  = s.slice(dot + 1).replace(/\D/g, '').padEnd(2, '0').slice(0, 2);
      mm = parseInt(ip.slice(0, 2), 10);
      ss = parseInt(ip.slice(2, 4), 10);
      cc = parseInt(fp, 10);
    } else {
      const d = s.replace(/\D/g, '');
      if (d.length >= 6) {
        const e = d.padStart(6, '0').slice(-6);
        mm = parseInt(e.slice(0, 2), 10);
        ss = parseInt(e.slice(2, 4), 10);
        cc = parseInt(e.slice(4, 6), 10);
      } else {
        const e = d.padStart(4, '0').slice(-4);
        mm = parseInt(e.slice(0, 2), 10);
        ss = parseInt(e.slice(2, 4), 10);
        cc = 0;
      }
    }
    if (isNaN(mm) || isNaN(ss) || isNaN(cc)) return null;
    if (ss >= 60 || cc >= 100) return null;
    return mm * 60000 + ss * 1000 + cc * 10;
  }

  /** Format ms → "MM:SS.CC" for display */
  function formatNumericDisplay(ms) {
    if (ms == null || !isFinite(ms)) return '';
    const mm = Math.floor(ms / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    const cc = Math.floor((ms % 1000) / 10);
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
  }

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // ============================================================
  // STORAGE
  // ============================================================
  function loadCourses() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      // Migrate fields with defaults
      arr.forEach(c => {
        if (c.duration == null) c.duration = 0;
        if (c.cooldownS == null) c.cooldownS = DEFAULT_COOLDOWN_S;
        if (c.accLimitM == null) c.accLimitM = DEFAULT_ACC_M;
        if (c.dirFilter == null) c.dirFilter = DEFAULT_DIRFILTER;
        c.sections = c.sections || [];
      });
      return arr;
    } catch (e) {
      console.error('Load failed', e);
      return [];
    }
  }

  function saveCourses() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.courses));
    } catch (e) {
      console.error('Save failed', e);
      toast('保存失敗: ストレージエラー');
    }
  }

  // ============================================================
  // STATE
  // ============================================================
  const state = {
    view: 'home',
    courses: loadCourses(),
    activeCourseId: null,

    // Edit
    editMap: null,
    editLineLayers: { start: null, finish: null, sections: [] },
    editMode: null,
    editPendingPoint: null,
    editPendingMarker: null,
    editLocateMarker: null,
    locateWatchId: null,

    // Drive
    driveActive: false,                // session armed
    driveStartT: null,                 // session start (for FINISH countdown)
    lapStartT: null,                   // current lap start
    lapStarted: false,                 // start line crossed
    lapNumber: 0,
    lastLapMs: null,
    currentLapSplits: [],              // [{ idx, t, splitMs }]
    sectionStartT: null,               // start of current section (for live target Δ)
    currentSectorIdx: 0,
    gateCooldown: {},                  // gateKey → last trigger time
    gateValidSide: {},                 // gateKey → first valid side (direction filter)

    // GPS
    watchId: null,
    prevFix: null,
    currentSpeedMS: -1,

    // Sensors
    motionEnabled: false,
    g_calib: { x: 0, z: 0 },
    g_raw: { x: 0, y: 0, z: 0 },
    g_smooth: { x: 0, z: 0 },   // EMA-filtered values for stable display
    g_lat: 0, g_lon: 0,

    // CSV record buffer
    csvRows: [],

    // Wake lock
    wakeLock: null,

    // Render loop
    rafId: null,

    // Widgets
    gball: null,
    speedGraph: null,
  };

  // ============================================================
  // SCREEN ROUTING
  // ============================================================
  function showScreen(name) {
    state.view = name;
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    document.getElementById(`screen-${name}`).classList.add('active');
  }

  function getActiveCourse() {
    return state.courses.find(c => c.id === state.activeCourseId) || null;
  }

  // ============================================================
  // HOME
  // ============================================================
  function renderHome() {
    const list = document.getElementById('course-list');
    list.innerHTML = '';
    if (state.courses.length === 0) {
      list.innerHTML = `<div class="empty-state">コースがまだありません<br>「新規コースを作成」から始めましょう</div>`;
      return;
    }
    state.courses.forEach(c => {
      const card = document.createElement('div');
      card.className = 'course-card';
      const best = c.bestLap ? formatTime(c.bestLap.totalMs) : '--:--.---';
      const bestCls = c.bestLap ? '' : 'none';
      const sectionCount = (c.sections || []).length;
      const hasLines = c.startLine && (c.type === 'circuit' || c.finishLine);
      card.innerHTML = `
        <div>
          <div class="name">${escapeHtml(c.name || '(無名コース)')}</div>
          <div class="meta">${c.type === 'circuit' ? '周回' : 'P2P'} · ${sectionCount} セクション ${hasLines ? '' : '· 未完成'}</div>
        </div>
        <div class="right">
          <div class="best ${bestCls}">${best}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        state.activeCourseId = c.id;
        openEdit();
      });
      list.appendChild(card);
    });
  }

  document.getElementById('btn-new-course').addEventListener('click', () => {
    const c = {
      id: uid(),
      name: '新規コース',
      type: 'circuit',
      duration: 0,
      cooldownS: DEFAULT_COOLDOWN_S,
      accLimitM: DEFAULT_ACC_M,
      dirFilter: DEFAULT_DIRFILTER,
      startLine: null,
      finishLine: null,
      sections: [],
      bestLap: null,
      createdAt: Date.now(),
    };
    state.courses.push(c);
    saveCourses();
    state.activeCourseId = c.id;
    openEdit();
  });

  // ============================================================
  // EDIT
  // ============================================================
  function openEdit() {
    showScreen('edit');
    const c = getActiveCourse();
    if (!c) return;

    document.getElementById('course-name').value = c.name || '';
    document.getElementById('circuit-toggle').checked = (c.type === 'circuit');

    if (state.editMap) { state.editMap.remove(); state.editMap = null; }
    setTimeout(initEditMap, 50);
  }

  function initEditMap() {
    const c = getActiveCourse();
    if (!c) return;
    let center = DEFAULT_CENTER;
    let zoom = 14;
    if (c.startLine) { center = midpoint(c.startLine); zoom = 17; }

    state.editMap = L.map('map-edit', { zoomControl: true, attributionControl: true }).setView(center, zoom);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(state.editMap);

    if (!c.startLine && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        if (state.editMap && !c.startLine) {
          state.editMap.setView([pos.coords.latitude, pos.coords.longitude], 17);
        }
      }, () => {}, { enableHighAccuracy: true, timeout: 5000 });
    }

    redrawEditLines();
    state.editMap.on('click', onEditMapClick);
  }

  function midpoint(line) {
    return [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  }

  function redrawEditLines() {
    const map = state.editMap;
    const c = getActiveCourse();
    if (!map || !c) return;

    if (state.editLineLayers.start)  { map.removeLayer(state.editLineLayers.start);  state.editLineLayers.start  = null; }
    if (state.editLineLayers.finish) { map.removeLayer(state.editLineLayers.finish); state.editLineLayers.finish = null; }
    state.editLineLayers.sections.forEach(l => map.removeLayer(l));
    state.editLineLayers.sections = [];

    if (c.startLine) {
      state.editLineLayers.start = drawLine(map, c.startLine, '#ffb000', c.type === 'circuit' ? 'S/F' : 'START');
    }
    if (c.type !== 'circuit' && c.finishLine) {
      state.editLineLayers.finish = drawLine(map, c.finishLine, '#f85149', 'FINISH');
    }
    (c.sections || []).forEach((s, i) => {
      state.editLineLayers.sections.push(drawLine(map, s.line, '#4fc3f7', s.name || `S${i + 1}`));
    });
  }

  function drawLine(map, line, color, label) {
    const polyline = L.polyline(line, { color, weight: 5, opacity: 0.9 });
    const m1 = L.circleMarker(line[0], { radius: 4, color, fillColor: color, fillOpacity: 1, weight: 0 });
    const m2 = L.circleMarker(line[1], { radius: 4, color, fillColor: color, fillOpacity: 1, weight: 0 });
    const labelMarker = L.marker(midpoint(line), {
      icon: L.divIcon({
        className: 'line-label',
        html: `<div style="
          background: ${color}; color: #1a1300;
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 700; font-size: 10px; letter-spacing: 0.1em;
          padding: 2px 6px; border-radius: 2px;
          white-space: nowrap;
          transform: translate(-50%, -50%);">${label}</div>`,
        iconSize: [0, 0]
      })
    });
    return L.layerGroup([polyline, m1, m2, labelMarker]).addTo(map);
  }

  function onEditMapClick(ev) {
    if (!state.editMode) { toast('上のボタンから線の種類を選択'); return; }
    const c = getActiveCourse();
    if (!c) return;

    const latlng = [ev.latlng.lat, ev.latlng.lng];

    if (!state.editPendingPoint) {
      state.editPendingPoint = latlng;
      state.editPendingMarker = L.circleMarker(latlng, {
        radius: 6, color: '#ffb000', fillColor: '#ffb000', fillOpacity: 0.5, weight: 2
      }).addTo(state.editMap);
      setStatus('2点目をマップ上でタップ', 'warn');
    } else {
      const line = [state.editPendingPoint, latlng];
      if (state.editPendingMarker) {
        state.editMap.removeLayer(state.editPendingMarker);
        state.editPendingMarker = null;
      }
      state.editPendingPoint = null;

      if (state.editMode === 'start')  c.startLine = line;
      else if (state.editMode === 'finish') c.finishLine = line;
      else if (state.editMode === 'section') {
        c.sections = c.sections || [];
        c.sections.push({
          id: uid(),
          name: `S${c.sections.length + 1}`,
          line,
          targetMs: null
        });
      }
      // Reset best when topology changes
      c.bestLap = null;
      saveCourses();
      redrawEditLines();
      setEditMode(null);
      setStatus('線を保存しました', 'ok');
    }
  }

  function setEditMode(mode) {
    state.editMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (state.editPendingMarker) {
      state.editMap.removeLayer(state.editPendingMarker);
      state.editPendingMarker = null;
    }
    state.editPendingPoint = null;
    if (mode) {
      const labels = { start: 'スタート線', finish: 'フィニッシュ線', section: 'セクション線' };
      setStatus(`${labels[mode]}: 1点目をマップ上でタップ`, 'warn');
    } else {
      setStatus('上のボタンから線の種類を選択', '');
    }
  }

  function setStatus(text, cls) {
    const el = document.getElementById('edit-status');
    el.textContent = text;
    el.classList.remove('warn', 'ok');
    if (cls) el.classList.add(cls);
  }

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.mode;
      setEditMode(state.editMode === m ? null : m);
    });
  });

  document.getElementById('course-name').addEventListener('change', e => {
    const c = getActiveCourse();
    if (c) { c.name = e.target.value.trim() || '無名コース'; saveCourses(); }
  });

  document.getElementById('circuit-toggle').addEventListener('change', e => {
    const c = getActiveCourse();
    if (!c) return;
    c.type = e.target.checked ? 'circuit' : 'ptp';
    if (c.type === 'circuit') c.finishLine = null;
    c.bestLap = null;
    saveCourses();
    redrawEditLines();
  });

  document.getElementById('btn-clear-section').addEventListener('click', () => {
    const c = getActiveCourse();
    if (!c) return;
    if (!confirm('全セクション線を削除しますか？')) return;
    c.sections = [];
    c.bestLap = null;
    saveCourses();
    redrawEditLines();
    toast('セクション線を消去');
  });

  document.querySelector('[data-action="back-home"]').addEventListener('click', () => {
    showScreen('home');
    renderHome();
  });

  document.querySelector('[data-action="delete-course"]').addEventListener('click', () => {
    if (!confirm('このコースを削除しますか？')) return;
    state.courses = state.courses.filter(c => c.id !== state.activeCourseId);
    state.activeCourseId = null;
    saveCourses();
    showScreen('home');
    renderHome();
  });

  // Locate me on edit map
  document.querySelector('[data-action="locate-me"]').addEventListener('click', () => {
    if (!state.editMap || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      state.editMap.setView(ll, 18);
      if (state.editLocateMarker) state.editMap.removeLayer(state.editLocateMarker);
      state.editLocateMarker = L.circleMarker(ll, {
        radius: 8, color: '#4fc3f7', fillColor: '#4fc3f7', fillOpacity: 0.5, weight: 2
      }).addTo(state.editMap);
      toast(`現在地 ±${pos.coords.accuracy.toFixed(0)}m`);
    }, err => toast('位置取得失敗: ' + err.message), { enableHighAccuracy: true, timeout: 8000 });
  });

  document.getElementById('btn-start-drive').addEventListener('click', () => {
    const c = getActiveCourse();
    if (!c) return;
    if (!c.startLine) { toast('スタート線が未定義です'); return; }
    if (c.type === 'ptp' && !c.finishLine) { toast('フィニッシュ線が未定義です'); return; }
    openDrive();
  });

  // ============================================================
  // DETAIL MODAL
  // Cancel button: just close (no save)
  // Save button:   write settings, then close
  // ============================================================
  document.querySelector('[data-action="edit-settings"]').addEventListener('click', openDetailModal);
  document.querySelector('[data-action="close-detail"]').addEventListener('click', closeDetailModalNoSave);
  document.getElementById('modal-detail').addEventListener('click', e => {
    if (e.target.id === 'modal-detail') closeDetailModalNoSave();
  });
  document.getElementById('btn-save-detail').addEventListener('click', saveDetailAndClose);

  function openDetailModal() {
    const c = getActiveCourse();
    if (!c) return;
    document.getElementById('cfg-duration').value = c.duration ? Math.round(c.duration / 60) : '';
    document.getElementById('cfg-cooldown').value = c.cooldownS;
    document.getElementById('cfg-acc').value      = c.accLimitM;
    document.getElementById('cfg-dirfilter').checked = !!c.dirFilter;
    renderSectionsEdit();
    document.getElementById('modal-detail').classList.add('show');
  }

  /** Cancel: close modal without saving. */
  function closeDetailModalNoSave() {
    document.getElementById('modal-detail').classList.remove('show');
  }

  /** Save: persist all field values then close. */
  function saveDetailAndClose() {
    const c = getActiveCourse();
    if (c) {
      const dur = parseInt(document.getElementById('cfg-duration').value, 10);
      c.duration  = isNaN(dur) ? 0 : dur * 60;
      const cd  = parseFloat(document.getElementById('cfg-cooldown').value);
      c.cooldownS = isNaN(cd)  ? DEFAULT_COOLDOWN_S : Math.max(0, cd);
      const acc = parseInt(document.getElementById('cfg-acc').value, 10);
      c.accLimitM = isNaN(acc) ? DEFAULT_ACC_M : Math.max(0, acc);
      c.dirFilter = document.getElementById('cfg-dirfilter').checked;
      saveCourses();
      toast('保存しました');
    }
    document.getElementById('modal-detail').classList.remove('show');
  }

  function renderSectionsEdit() {
    const c = getActiveCourse();
    const list = document.getElementById('sections-edit-list');
    if (!c || !c.sections || c.sections.length === 0) {
      list.innerHTML = '<div class="splits-empty">セクション線を描くと表示されます</div>';
      return;
    }
    list.innerHTML = '';
    c.sections.forEach((s, idx) => {
      const row = document.createElement('div');
      row.className = 'section-edit-row';
      const targetText = s.targetMs != null ? formatNumericDisplay(s.targetMs) : '';
      row.innerHTML = `
        <span class="name">${escapeHtml(s.name || `S${idx + 1}`)}</span>
        <input class="target" type="text" inputmode="numeric" placeholder="MMSS.CC" value="${targetText}" />
        <button class="del">削除</button>
      `;
      const inp = row.querySelector('input.target');
      inp.addEventListener('input', () => {
        if (!inp.value.trim()) { inp.classList.remove('valid', 'invalid'); return; }
        const ms = parseTargetTime(inp.value);
        inp.classList.toggle('valid',   ms != null);
        inp.classList.toggle('invalid', ms == null);
      });
      inp.addEventListener('blur', () => {
        if (!inp.value.trim()) {
          s.targetMs = null;
          inp.classList.remove('valid', 'invalid');
          return;
        }
        const ms = parseTargetTime(inp.value);
        if (ms != null) {
          s.targetMs = ms;
          inp.value = formatNumericDisplay(ms);
          inp.classList.add('valid');
          inp.classList.remove('invalid');
        } else {
          inp.classList.add('invalid');
        }
      });
      row.querySelector('.del').addEventListener('click', () => {
        const name = s.name || `S${idx + 1}`;
        if (!confirm(`「${name}」を削除しますか？`)) return;
        c.sections.splice(idx, 1);
        c.sections.forEach((sec, i) => { if (!sec.name || /^S\d+$/.test(sec.name)) sec.name = `S${i + 1}`; });
        c.bestLap = null;
        saveCourses();
        renderSectionsEdit();
        redrawEditLines();
        toast(`「${name}」を削除`);
      });
      list.appendChild(row);
    });
  }

  // ============================================================
  // DRIVE
  // ============================================================
  function openDrive() {
    showScreen('drive');
    const c = getActiveCourse();
    if (!c) return;

    document.getElementById('drive-course-name').textContent = c.name;
    setDriveState('準備中', '');
    resetDriveMetrics();
    renderSplitsGrid();

    // Init canvas widgets
    state.gball = new GBall(document.getElementById('gball-canvas'));
    state.speedGraph = new SpeedGraph(document.getElementById('speed-canvas'));

    // CSV buffer
    state.csvRows = [];

    // Big start button reset
    const btn = document.getElementById('btn-start-stop');
    btn.textContent = 'START';
    btn.className = 'big-action start';

    // iOS DeviceMotion permission prompt button
    const motionBtn = document.getElementById('btn-motion-perm');
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      motionBtn.style.display = '';
    } else {
      motionBtn.style.display = 'none';
      attachMotionListener();
    }
  }

  function resetDriveMetrics() {
    state.driveActive = false;
    state.driveStartT = null;
    state.lapStartT = null;
    state.lapStarted = false;
    state.lapNumber = 0;
    state.lastLapMs = null;
    state.currentLapSplits = [];
    state.sectionStartT = null;
    state.currentSectorIdx = 0;
    state.gateCooldown = {};
    state.gateValidSide = {};
    state.prevFix = null;
    state.currentSpeedMS = -1;

    document.getElementById('current-lap-time').textContent = '00:00.000';
    document.getElementById('finish-countdown').textContent = '--:--.--';
    document.getElementById('lap-count').textContent = '0';
    document.getElementById('last-lap-time').textContent = '--:--.---';
    document.getElementById('next-sector-value').textContent = '--:--.--';
    document.getElementById('next-sector-value').className = 'ns-value';
    document.getElementById('best-delta-display').classList.add('hidden');
    document.getElementById('now-sector-num').textContent = '1';

    const c = getActiveCourse();
    document.getElementById('best-lap-time').textContent =
      c?.bestLap ? formatTime(c.bestLap.totalMs) : '--:--.---';
  }

  function setDriveState(text, cls) {
    const el = document.getElementById('drive-state');
    el.textContent = text;
    el.classList.remove('armed', 'running', 'finished');
    if (cls) el.classList.add(cls);
  }

  // === START / STOP button ===
  document.getElementById('btn-start-stop').addEventListener('click', () => {
    if (!state.driveActive) {
      // START
      const c = getActiveCourse();
      if (!c) return;
      state.driveActive = true;
      state.driveStartT = Date.now();
      state.lapStarted = false;
      state.lapStartT = null;
      state.currentSectorIdx = 0;
      state.currentLapSplits = [];
      state.csvRows = [];

      // Calibrate G-ball at START (use smoothed values for stability)
      calibrateGBall();

      const btn = document.getElementById('btn-start-stop');
      btn.textContent = 'STOP';
      btn.className = 'big-action stop';

      setDriveState('スタート線通過待ち', 'armed');
      startGPS();
      requestWakeLock();
      startTimerLoop();
    } else {
      // STOP
      finishSession();
    }
  });

  // Exit drive screen entirely
  document.querySelector('[data-action="exit-drive"]').addEventListener('click', () => {
    if (state.driveActive) {
      if (!confirm('計測中です。終了しますか？')) return;
      finishSession();
    }
    stopGPS();
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    releaseWakeLock();
    detachMotionListener();
    showScreen('edit');
    if (state.editMap) setTimeout(() => state.editMap.invalidateSize(), 50);
  });

  function finishSession() {
    state.driveActive = false;
    state.lapStarted = false;
    setDriveState('完了', 'finished');
    stopGPS();
    releaseWakeLock();
    const btn = document.getElementById('btn-start-stop');
    btn.textContent = 'START';
    btn.className = 'big-action start';
  }

  // === GPS ===
  function startGPS() {
    if (!navigator.geolocation) {
      toast('このブラウザはGPSをサポートしていません');
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(
      onGPSUpdate,
      err => {
        toast('GPSエラー: ' + err.message);
        document.getElementById('gps-indicator').classList.remove('active');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  }

  function stopGPS() {
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    document.getElementById('gps-indicator').classList.remove('active');
  }

  function onGPSUpdate(pos) {
    const c = getActiveCourse();
    if (!c) return;

    const fix = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      acc: pos.coords.accuracy,
      speed: pos.coords.speed,        // m/s or null
      t: pos.timestamp || Date.now()
    };

    // GPS indicator
    const ind = document.getElementById('gps-indicator');
    ind.classList.add('active');
    document.getElementById('gps-acc').textContent = `±${fix.acc.toFixed(0)}m`;

    // Accuracy filter (0 = disabled)
    if (c.accLimitM > 0 && fix.acc > c.accLimitM) {
      // Skip detection but still update UI
      return;
    }

    // Speed update for graph
    if (fix.speed != null && fix.speed >= 0) {
      state.currentSpeedMS = fix.speed;
    } else if (state.prevFix) {
      // Fallback: position derivative
      const dt = (fix.t - state.prevFix.t) / 1000;
      if (dt > 0.05) {
        const d = distM(state.prevFix.lat, state.prevFix.lon, fix.lat, fix.lon);
        const v = d / dt;
        if (v < 110) state.currentSpeedMS = v; // sanity cap (~400 km/h)
      }
    }

    if (state.driveActive && state.speedGraph) {
      state.speedGraph.addPoint(fix.t / 1000, Math.max(0, state.currentSpeedMS) * 3.6);
    }

    // CSV recording
    if (state.driveActive && state.csvRows.length < RECORD_LIMIT) {
      const dt = new Date(fix.t);
      state.csvRows.push([
        dt.toISOString(),
        fix.lat.toFixed(7),
        fix.lon.toFixed(7),
        fix.acc.toFixed(1),
        (state.currentSpeedMS >= 0 ? (state.currentSpeedMS * 3.6).toFixed(1) : ''),
        state.lapNumber,
        state.currentSectorIdx + 1,
        state.g_lat.toFixed(3),
        state.g_lon.toFixed(3),
      ]);
    }

    // Crossing detection (only when active)
    if (state.driveActive && state.prevFix) {
      detectGateCrossings(c, fix);
    }

    state.prevFix = fix;
  }

  /**
   * Try crossing each relevant gate. Apply cooldown + direction filter
   * + per-lap once-only constraint for sections.
   */
  function detectGateCrossings(c, fix) {
    const cdSec = c.cooldownS;
    const dirFilter = c.dirFilter;

    // Helper to attempt one gate
    const tryGate = (lineA, lineB, key) => {
      const last = state.gateCooldown[key];
      if (last != null && (fix.t - last) / 1000 < cdSec) return null;
      const cross = detectCrossing(state.prevFix, fix, lineA, lineB);
      if (!cross) return null;
      if (dirFilter) {
        const valid = state.gateValidSide[key];
        if (valid == null) {
          state.gateValidSide[key] = cross.side;
        } else if (valid !== cross.side) {
          return null; // wrong direction
        }
      }
      state.gateCooldown[key] = fix.t;
      return cross;
    };

    // Sections (only between start crossing and lap end)
    if (state.lapStarted) {
      (c.sections || []).forEach((sec, idx) => {
        // Once per lap
        if (state.currentLapSplits.some(s => s.idx === idx)) return;
        const cross = tryGate(sec.line[0], sec.line[1], `sec_${idx}`);
        if (cross) {
          const splitMs = cross.t - state.lapStartT;
          state.currentLapSplits.push({ idx, t: cross.t, splitMs });
          state.sectionStartT = cross.t;
          state.currentSectorIdx = Math.min(idx + 1, (c.sections || []).length);
          renderSplitsGrid();

          const bestSplit = c.bestLap?.splits?.find(s => s.idx === idx);
          const dBest = bestSplit ? splitMs - bestSplit.splitMs : null;
          toast(`${sec.name} ${formatTime(splitMs)}${dBest != null ? '  ' + formatDelta(dBest) : ''}`);
        }
      });
    }

    // Start / finish
    if (c.type === 'circuit') {
      const cross = tryGate(c.startLine[0], c.startLine[1], 'sf');
      if (cross) handleStartFinishCross(cross.t, c);
    } else {
      if (!state.lapStarted) {
        const cross = tryGate(c.startLine[0], c.startLine[1], 'start');
        if (cross) handleStartCross(cross.t);
      } else {
        const cross = tryGate(c.finishLine[0], c.finishLine[1], 'finish');
        if (cross) handleFinishCross(cross.t, c);
      }
    }
  }

  function handleStartFinishCross(crossT, c) {
    if (!state.lapStarted) {
      // First crossing → start lap
      state.lapStarted = true;
      state.lapStartT = crossT;
      state.sectionStartT = crossT;
      state.currentLapSplits = [];
      state.currentSectorIdx = 0;
      setDriveState(`LAP ${state.lapNumber + 1}`, 'running');
      toast('▶ ラップ開始');
      document.getElementById('best-delta-display').classList.toggle('hidden', !c.bestLap);
    } else {
      const lapMs = crossT - state.lapStartT;
      finalizeLap(lapMs, c);
      // Start next lap
      state.lapStartT = crossT;
      state.sectionStartT = crossT;
      state.currentLapSplits = [];
      state.currentSectorIdx = 0;
      // Reset section gate state for new lap (allow re-crossing)
      Object.keys(state.gateCooldown).forEach(k => {
        if (k.startsWith('sec_')) delete state.gateCooldown[k];
      });
      // Reset speed graph for new lap
      if (state.speedGraph) state.speedGraph.reset();
      setDriveState(`LAP ${state.lapNumber + 1}`, 'running');
      document.getElementById('best-delta-display').classList.toggle('hidden', !c.bestLap);
    }
  }

  function handleStartCross(crossT) {
    state.lapStarted = true;
    state.lapStartT = crossT;
    state.sectionStartT = crossT;
    state.currentLapSplits = [];
    state.currentSectorIdx = 0;
    setDriveState('計測中', 'running');
    toast('▶ 計測開始');
    const c = getActiveCourse();
    document.getElementById('best-delta-display').classList.toggle('hidden', !c.bestLap);
  }

  function handleFinishCross(crossT, c) {
    const lapMs = crossT - state.lapStartT;
    finalizeLap(lapMs, c);
    state.lapStarted = false;
    state.lapStartT = null;
    state.driveActive = false;
    setDriveState('完了', 'finished');
    const btn = document.getElementById('btn-start-stop');
    btn.textContent = 'START';
    btn.className = 'big-action start';
    stopGPS();
    releaseWakeLock();
  }

  function finalizeLap(lapMs, c) {
    state.lapNumber += 1;
    state.lastLapMs = lapMs;
    document.getElementById('last-lap-time').textContent = formatTime(lapMs);
    document.getElementById('lap-count').textContent = String(state.lapNumber);

    const lapRecord = {
      totalMs: lapMs,
      splits: state.currentLapSplits.map(s => ({ idx: s.idx, splitMs: s.splitMs })),
      date: Date.now()
    };

    const isBest = !c.bestLap || lapMs < c.bestLap.totalMs;
    if (isBest) {
      c.bestLap = lapRecord;
      saveCourses();
      document.getElementById('best-lap-time').textContent = formatTime(lapMs);
      toast(`★ NEW BEST ${formatTime(lapMs)}`);
    } else {
      const d = lapMs - c.bestLap.totalMs;
      toast(`LAP ${state.lapNumber}: ${formatTime(lapMs)} (${formatDelta(d)})`);
    }
  }

  function renderSplitsGrid() {
    const c = getActiveCourse();
    const grid = document.getElementById('splits-grid');
    if (!c || !c.sections || c.sections.length === 0) {
      grid.innerHTML = '<div class="splits-empty">セクション未設定</div>';
      return;
    }
    grid.innerHTML = '';
    c.sections.forEach((sec, idx) => {
      const split = state.currentLapSplits.find(s => s.idx === idx);
      const bestSplit = c.bestLap?.splits?.find(s => s.idx === idx);
      const item = document.createElement('div');
      item.className = 'split-item';
      let timeText = '--:--.---';
      let deltaText = '';
      let deltaCls = '';
      if (split) {
        timeText = formatTime(split.splitMs);
        if (bestSplit) {
          const d = split.splitMs - bestSplit.splitMs;
          deltaText = formatDelta(d);
          deltaCls = d < 0 ? 'faster' : 'slower';
        }
      } else if (bestSplit) {
        timeText = formatTime(bestSplit.splitMs);
        item.style.opacity = '0.5';
      }
      if (idx === state.currentSectorIdx && state.lapStarted) item.classList.add('live');
      item.innerHTML = `
        <span class="sname">${escapeHtml(sec.name)}</span>
        <span class="stime">${timeText}</span>
        <span class="sdelta ${deltaCls}">${deltaText}</span>
      `;
      grid.appendChild(item);
    });
  }

  // ============================================================
  // TIMER LOOP — drives all live displays at ~60Hz
  // ============================================================
  function startTimerLoop() {
    function tick() {
      if (state.view !== 'drive') return;

      const now = Date.now();
      const c = getActiveCourse();

      // Lap timer
      if (state.lapStarted && state.lapStartT != null) {
        const elapsed = now - state.lapStartT;
        document.getElementById('current-lap-time').textContent = formatTime(elapsed);

        // toNextSector: target Δ for current section
        if (c && c.sections && state.currentSectorIdx < c.sections.length) {
          const sec = c.sections[state.currentSectorIdx];
          const sectionElapsed = now - (state.sectionStartT || state.lapStartT);
          const ns = document.getElementById('next-sector-value');
          if (sec.targetMs != null) {
            const d = sectionElapsed - sec.targetMs;
            ns.textContent = `${formatDelta(d)}  / ${sec.name}`;
            ns.className = 'ns-value ' + (d < 0 ? 'faster' : 'slower');
          } else {
            ns.textContent = `${formatTime(sectionElapsed)}  / ${sec.name}`;
            ns.className = 'ns-value';
          }
        } else {
          // Past last section or no sections
          document.getElementById('next-sector-value').textContent = formatTime(elapsed);
          document.getElementById('next-sector-value').className = 'ns-value';
        }

        // BEST Δ — predictive: use last completed split's delta
        if (c?.bestLap && state.currentLapSplits.length > 0) {
          const last = state.currentLapSplits[state.currentLapSplits.length - 1];
          const bestSplit = c.bestLap.splits?.find(s => s.idx === last.idx);
          const bdEl = document.getElementById('best-delta-display');
          const bdVal = document.getElementById('best-delta-value');
          if (bestSplit) {
            const d = last.splitMs - bestSplit.splitMs;
            bdVal.textContent = formatDelta(d);
            bdVal.className = 'bd-value ' + (d < 0 ? 'faster' : 'slower');
            bdEl.classList.remove('hidden');
          }
        }

        document.getElementById('now-sector-num').textContent =
          String(Math.min(state.currentSectorIdx + 1, (c?.sections?.length ?? 0) + 1));
      } else if (state.driveActive && c?.sections?.length > 0 && c.sections[0].targetMs != null) {
        // Pre-start: show first section target
        const ns = document.getElementById('next-sector-value');
        ns.textContent = `S1 目標 ${formatTime(c.sections[0].targetMs)}`;
        ns.className = 'ns-value';
      }

      // Session FINISH countdown
      if (state.driveActive && c?.duration > 0 && state.driveStartT != null) {
        const remaining = c.duration * 1000 - (now - state.driveStartT);
        document.getElementById('finish-countdown').textContent = formatTimeShort(Math.max(0, remaining));
        if (remaining <= 0) {
          // Auto-stop on duration
          finishSession();
          toast('⏱ セッション時間終了');
        }
      }

      // G-ball update from smoothed motion (calibrated to START position)
      try {
        if (state.gball) {
          const lat = state.g_smooth.x - state.g_calib.x;
          const lon = state.g_smooth.z - state.g_calib.z;
          state.g_lat = lat;
          state.g_lon = lon;
          state.gball.draw(lat, lon);
          const tg = Math.min(Math.sqrt(lat * lat + lon * lon), G_RANGE);
          document.getElementById('g-text').textContent = `${tg.toFixed(2)} G`;
        }
        if (state.speedGraph) state.speedGraph.draw();
      } catch (_) {
        // Skip bad render frame; do not stop RAF loop
      }

      state.rafId = requestAnimationFrame(tick);
    }
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(tick);
  }

  // ============================================================
  // G-BALL (Canvas widget)
  // ============================================================
  class GBall {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.canvas.width = r.width * dpr;
      this.canvas.height = r.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = r.width; this.h = r.height;
    }
    draw(lat_g, lon_g) {
      const ctx = this.ctx;
      const w = this.w, h = this.h;
      const cx = w / 2, cy = h / 2;
      const r = Math.min(w, h) / 2 - 12;
      const dot = 10;

      ctx.clearRect(0, 0, w, h);
      // Outer dim ring
      ctx.fillStyle = '#0a0a0a';
      ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.fill();
      // Outer ring
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      // 1G ring
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r / G_RANGE, 0, Math.PI * 2); ctx.stroke();
      // Cross hairs
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.stroke();
      // Labels
      ctx.fillStyle = '#555';
      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('F', cx, cy - r - 6);
      ctx.fillText('B', cx, cy + r + 6);
      ctx.fillText('L', cx - r - 8, cy);
      ctx.fillText('R', cx + r + 8, cy);

      // Dot position
      let bx = cx + (lat_g / G_RANGE) * r;
      let by = cy - (lon_g / G_RANGE) * r;
      const dx = bx - cx, dy = by - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r - dot) {
        const sc = (r - dot) / Math.max(d, 0.001);
        bx = cx + dx * sc; by = cy + dy * sc;
      }
      const tg = Math.min(Math.sqrt(lat_g * lat_g + lon_g * lon_g), G_RANGE);
      const iv = tg / G_RANGE;
      ctx.fillStyle = `rgb(${Math.round(255 * iv)}, ${Math.round(255 * Math.max(0, 1 - iv * 1.2))}, 0)`;
      ctx.beginPath(); ctx.arc(bx, by, dot, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ============================================================
  // SPEED GRAPH (Canvas, 30s scrolling)
  // ============================================================
  class SpeedGraph {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.data = [];          // [[ts_sec, kmh], ...]
      this.cur = 0;
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.canvas.width = r.width * dpr;
      this.canvas.height = r.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = r.width; this.h = r.height;
    }
    addPoint(ts, kmh) {
      this.cur = kmh;
      this.data.push([ts, kmh]);
      const cutoff = ts - SPEED_WINDOW_S - 2;
      while (this.data.length && this.data[0][0] < cutoff) this.data.shift();
    }
    reset() {
      this.data = [];
      this.cur = 0;
    }
    draw() {
      const ctx = this.ctx;
      const w = this.w, h = this.h;
      const PL = 32, PR = 6, PT = 6, PB = 18;
      const gw = w - PL - PR;
      const gh = h - PT - PB;
      const now = Date.now() / 1000;

      ctx.clearRect(0, 0, w, h);
      // BG
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(PL, PT, gw, gh);

      // Y scale
      const peak = this.data.reduce((m, [_, s]) => Math.max(m, s), 0);
      const yMax = Math.max(150, (Math.floor(peak / 50) + 1) * 50);

      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.fillStyle = '#555';
      ctx.textBaseline = 'middle';

      for (let v = 50; v <= yMax; v += 50) {
        const gy = PT + gh - (v / yMax) * gh;
        ctx.strokeStyle = '#2a2a2a';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PL, gy); ctx.lineTo(PL + gw, gy); ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillText(String(v), PL - 3, gy);
      }

      // Time gridlines
      ctx.fillStyle = '#444';
      for (let dt = 5; dt <= 30; dt += 5) {
        const gx = PL + gw - (dt / SPEED_WINDOW_S) * gw;
        ctx.strokeStyle = '#2a2a2a';
        ctx.beginPath(); ctx.moveTo(gx, PT); ctx.lineTo(gx, PT + gh); ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillText(`-${dt}s`, gx, PT + gh + 8);
      }

      ctx.strokeStyle = '#444';
      ctx.strokeRect(PL, PT, gw, gh);

      // Plot
      const pts = this.data.filter(([t, _]) => now - t <= SPEED_WINDOW_S + 0.1);
      if (pts.length >= 2) {
        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        pts.forEach(([t, s], i) => {
          let x = PL + gw - ((now - t) / SPEED_WINDOW_S) * gw;
          x = Math.max(PL, Math.min(PL + gw, x));
          let y = PT + gh - (s / yMax) * gh;
          y = Math.max(PT, Math.min(PT + gh, y));
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        // Latest dot
        const [lt, ls] = pts[pts.length - 1];
        let lx = PL + gw - ((now - lt) / SPEED_WINDOW_S) * gw;
        let ly = PT + gh - (ls / yMax) * gh;
        lx = Math.max(PL, Math.min(PL + gw, lx));
        ly = Math.max(PT, Math.min(PT + gh, ly));
        ctx.fillStyle = '#4fc3f7';
        ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
      }

      // Current value display
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px "IBM Plex Mono", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`${this.cur.toFixed(0)}`, PL + gw - 4, PT + 4);
      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.fillStyle = '#888';
      ctx.fillText('km/h', PL + gw - 4, PT + 24);
    }
  }

  // ============================================================
  // DEVICEMOTION
  // ----------------------------------------------------------------
  // Phone orientation assumption (per ユウぶん様 仕様):
  //   - Portrait, vertical, screen parallel to driver's face
  //   - Camera (top of phone) points up toward the sky
  //   - Screen faces driver (front camera toward driver)
  //
  // Device axes (W3C DeviceMotion convention):
  //   +X: phone right  → car right  (lateral)
  //   +Y: phone up     → world up   (gravity axis, mostly +9.81 m/s²)
  //   +Z: out of screen → toward driver → toward REAR of car (longitudinal)
  //
  // Display mapping (motion-direction convention):
  //   lat_g = +X / g    → ball moves right (R) on lateral right accel
  //   lon_g = −Z / g    → ball moves up (F) on forward accel
  //                       (Z is negated because car forward = phone −Z)
  //
  // EMA smoothing applied to suppress accelerometer noise.
  // α = 0.15 → ~7-sample (≈70 ms at 100 Hz) effective time constant.
  // ============================================================
  const G_SMOOTH_ALPHA = 0.15;
  let motionHandler = null;

  function attachMotionListener() {
    if (state.motionEnabled) return;
    motionHandler = (e) => {
      const ag = e.accelerationIncludingGravity;
      if (!ag) return;
      const x = (ag.x || 0) / 9.81;        // lateral raw (G)
      const y = (ag.y || 0) / 9.81;        // vertical raw (mostly gravity)
      const z = -(ag.z || 0) / 9.81;       // longitudinal raw (Z negated)
      state.g_raw.x = x;
      state.g_raw.y = y;
      state.g_raw.z = z;
      // EMA low-pass filter
      const a = G_SMOOTH_ALPHA;
      state.g_smooth.x = a * x + (1 - a) * state.g_smooth.x;
      state.g_smooth.z = a * z + (1 - a) * state.g_smooth.z;
    };
    window.addEventListener('devicemotion', motionHandler);
    state.motionEnabled = true;
  }

  function detachMotionListener() {
    if (motionHandler) {
      window.removeEventListener('devicemotion', motionHandler);
      motionHandler = null;
    }
    state.motionEnabled = false;
  }

  /**
   * Capture the current smoothed G reading as the zero-point.
   * Called automatically at START, and manually via the ZERO button.
   */
  function calibrateGBall() {
    state.g_calib.x = state.g_smooth.x;
    state.g_calib.z = state.g_smooth.z;
  }

  // Manual ZERO button (always available on drive screen)
  document.getElementById('btn-g-cal').addEventListener('click', () => {
    calibrateGBall();
    const btn = document.getElementById('btn-g-cal');
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 250);
    toast('G ゼロ点を補正しました');
  });

  document.getElementById('btn-motion-perm').addEventListener('click', async () => {
    try {
      const r = await DeviceMotionEvent.requestPermission();
      if (r === 'granted') {
        attachMotionListener();
        document.getElementById('btn-motion-perm').style.display = 'none';
        toast('センサー有効化');
      } else {
        toast('センサー許可が拒否されました');
      }
    } catch (e) {
      toast('センサー許可エラー');
    }
  });

  // ============================================================
  // WAKE LOCK
  // ============================================================
  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        state.wakeLock = await navigator.wakeLock.request('screen');
      } catch (e) {
        // Silently fail; not critical
      }
    }
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }
  }

  // ============================================================
  // CSV EXPORT
  // ============================================================
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    if (state.csvRows.length === 0) {
      toast('記録データなし');
      return;
    }
    const c = getActiveCourse();
    const header = ['ISO_TIME', 'LAT', 'LON', 'ACC_M', 'SPEED_KMH', 'LAP', 'SECTOR', 'G_LAT', 'G_LON'];
    const lines = [header.join(',')].concat(state.csvRows.map(r => r.join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dt = new Date();
    const stamp = dt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `mirage_${(c?.name || 'session').replace(/\s+/g, '_')}_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    toast(`CSV出力: ${state.csvRows.length}行`);
  });

  // ============================================================
  // TOAST
  // ============================================================
  let toastTimeout = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ============================================================
  // WARNING SCREEN (startup disclaimer)
  // Shown on every app launch. OK transitions to home.
  // ============================================================
  document.getElementById('btn-warning-ok').addEventListener('click', () => {
    showScreen('home');
    renderHome();
  });

  // ============================================================
  // INIT
  // ============================================================
  renderHome();
  // Warning screen is the active screen at boot (per HTML markup);
  // explicitly enforce in case of route restoration.
  showScreen('warning');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // Re-acquire wake lock on visibility return
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.driveActive) {
      requestWakeLock();
    }
  });

})();
