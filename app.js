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
  const SETTINGS_KEY = 'timeattacker.settings.v1';
  const SESSIONS_KEY = 'timeattacker.sessions.v1';
  const MAX_SESSIONS = 30;
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
  // SETTINGS (Phase 0: UI + 永続化のみ。Phase 1 で BLE 接続が読み取って利用)
  // ============================================================
  const DEFAULT_SETTINGS = {
    obdMode: 'double',          // 'single' | 'double'
    obdAutoReconnect: 'on',     // 'on' | 'off'
    pids: {
      rpm:      true,
      coolant:  true,
      oiltemp:  true,
      intake:   true,
      throttle: true,
    },
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      const s = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...s,
        pids: { ...DEFAULT_SETTINGS.pids, ...(s.pids || {}) },
      };
    } catch (_) {
      return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) {
      console.error('Settings save failed', e);
      toast('設定保存失敗');
    }
  }

  // ============================================================
  // SESSIONS / HISTORY (走行履歴の永続化)
  // ============================================================
  function loadSessions() {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function saveSessions(list) {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      console.error('Sessions save failed', e);
      // 容量オーバーの場合は古いセッションを削除して再試行
      if (e.name === 'QuotaExceededError' && list.length > 5) {
        list.splice(0, Math.max(1, Math.floor(list.length / 4)));
        try {
          localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
          toast('容量上限のため古い履歴を削除しました');
          return true;
        } catch (_) {}
      }
      toast('履歴保存失敗（容量オーバー）');
      return false;
    }
  }

  // 走行終了時に呼ばれる: 現状のセッションデータを履歴に保存
  function persistCurrentSession(course) {
    // データが何もないなら保存しない
    if (!state.csvRows || state.csvRows.length === 0) return;
    if (!state.sessionStartTime) return;

    const laps = (state.completedLaps || []).map(l => ({
      number:  l.number,
      totalMs: l.totalMs,
      splits:  l.splits || [],
      date:    l.date,
    }));

    // 最速ラップの index を計算
    let bestLapIdx = -1;
    if (laps.length > 0) {
      let bestMs = Infinity;
      laps.forEach((l, i) => { if (l.totalMs < bestMs) { bestMs = l.totalMs; bestLapIdx = i; } });
    }

    // OBD データが入っているか確認（最後の5カラムのいずれかに値があるか）
    const hasObdData = state.csvRows.some(r =>
      (r[9] !== '' && r[9] != null) ||
      (r[10] !== '' && r[10] != null) ||
      (r[11] !== '' && r[11] != null) ||
      (r[12] !== '' && r[12] != null) ||
      (r[13] !== '' && r[13] != null));

    const session = {
      id: 'sess_' + uid(),
      courseId:   course?.id || null,
      courseName: course?.name || '不明',
      courseType: course?.type || 'circuit',
      startTime:  state.sessionStartTime,
      endTime:    Date.now(),
      laps,
      bestLapIdx,
      hasObdData,
      // CSV と同じ順序のカラム定義
      columns: [
        'iso_time','lat','lon','acc','speed_kmh','lap','sector','g_lat','g_lon',
        'rpm','coolant','oilTemp','intake','throttle'
      ],
      rows: state.csvRows.slice(),  // shallow copy
    };

    const sessions = loadSessions();
    sessions.push(session);
    // 古いセッションを削除して上限を維持
    while (sessions.length > MAX_SESSIONS) sessions.shift();
    saveSessions(sessions);
  }

  function deleteSession(id) {
    const sessions = loadSessions().filter(s => s.id !== id);
    saveSessions(sessions);
  }

  // ============================================================
  // STATE
  // ============================================================
  const state = {
    view: 'home',
    courses: loadCourses(),
    activeCourseId: null,
    settings: loadSettings(),

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
    completedLaps: [],                 // セッション中に完走した全ラップの配列
    sessionStartTime: null,            // セッション開始 ms
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

    // ============================================================
    // OBD2 リアルタイム値（Phase 1 で BLE 接続が更新する）
    // 未接続時はすべて null。CSV / 分析機能はこれを読んで記録する
    // ============================================================
    obd: {
      rpm:      null,  // 回転数 [rpm]
      coolant:  null,  // 水温 [°C]
      oiltemp:  null,  // 油温 [°C]
      intake:   null,  // 吸気温 [°C]
      throttle: null,  // スロットル開度 [%]
      // BLE接続状態
      connected: false,
      lastUpdateMs: null,
      // BLE デバイスハンドル（Phase 1）
      device:     null,
      txChar:     null,
      rxChar:     null,
      deviceName: null,
      deviceId:   null,
      status:     'disconnected',  // 'disconnected' | 'scanning' | 'connecting' | 'discovering' | 'connected' | 'error'
    },

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
          <div class="meta">${c.type === 'circuit' ? '周回' : 'P2P'} · ${sectionCount} セクター線 ${hasLines ? '' : '· 未完成'}</div>
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
  // SETTINGS SCREEN
  // ============================================================
  function openSettings() {
    showScreen('settings');
    renderSettings();
  }

  // 設定値を画面に反映
  function renderSettings() {
    const s = state.settings;

    // Segmented toggles
    document.querySelectorAll('.seg-toggle').forEach(group => {
      const key = group.dataset.key;
      const currentVal = s[key];
      group.querySelectorAll('.seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === currentVal);
      });
    });

    // PID checkboxes
    document.getElementById('cb-pid-rpm').checked      = !!s.pids.rpm;
    document.getElementById('cb-pid-coolant').checked  = !!s.pids.coolant;
    document.getElementById('cb-pid-oiltemp').checked  = !!s.pids.oiltemp;
    document.getElementById('cb-pid-intake').checked   = !!s.pids.intake;
    document.getElementById('cb-pid-throttle').checked = !!s.pids.throttle;

    // BLE 状態を画面に反映
    if (typeof updateBleUI === 'function') updateBleUI();
  }

  // 現在のUIから設定オブジェクトを構築
  function collectSettings() {
    const s = JSON.parse(JSON.stringify(state.settings));

    document.querySelectorAll('.seg-toggle').forEach(group => {
      const key = group.dataset.key;
      const active = group.querySelector('.seg-btn.active');
      if (active) s[key] = active.dataset.value;
    });

    s.pids = {
      rpm:      document.getElementById('cb-pid-rpm').checked,
      coolant:  document.getElementById('cb-pid-coolant').checked,
      oiltemp:  document.getElementById('cb-pid-oiltemp').checked,
      intake:   document.getElementById('cb-pid-intake').checked,
      throttle: document.getElementById('cb-pid-throttle').checked,
    };
    return s;
  }

  // Settings: 開くボタン
  document.getElementById('btn-open-settings').addEventListener('click', openSettings);

  // Settings: 戻るボタン (収集せずに破棄して戻る)
  document.getElementById('btn-settings-back').addEventListener('click', () => {
    showScreen('home');
  });

  // Settings: セグメントトグル (Single/Double, ON/OFF) のクリック処理
  document.querySelectorAll('.seg-toggle').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      group.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Settings: 保存
  document.getElementById('btn-settings-save').addEventListener('click', () => {
    state.settings = collectSettings();
    saveSettings(state.settings);
    // 接続中なら PID リストを即時反映
    if (state.obd.connected && typeof recomputeActivePids === 'function') {
      recomputeActivePids();
    }
    toast('設定を保存しました');
    showScreen('home');
  });

  // ============================================================
  // BLE / OBD2 接続 (Phase 1: 接続のみ。PID 取得は Phase 2)
  // ============================================================
  // ELM327 互換アダプタが使う可能性のあるサービス UUID
  const ELM_SERVICES = [
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '000018f0-0000-1000-8000-00805f9b34fb',
    '0000ffe5-0000-1000-8000-00805f9b34fb',
  ];
  const BLE_DEVICE_KEY = 'timeattacker.ble.device.v1';

  function bleSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ATコマンド送信
  function bleSend(cmd) {
    if (!state.obd.txChar) return;
    state.obd.txChar.writeValueWithoutResponse(
      new TextEncoder().encode(cmd + '\r')
    ).catch(e => console.warn('[BLE SEND]', e));
  }

  // 接続状態の UI 更新（設定画面 + Drive 画面のインジケータ）
  function updateBleUI() {
    const status = state.obd.status;
    const connected = (status === 'connected');

    // 設定画面 — 状態インジケータ
    const ind = document.getElementById('ble-status-indicator');
    const txt = document.getElementById('ble-status-text');
    const name = document.getElementById('ble-device-name');
    if (ind && txt) {
      ind.classList.remove('connected', 'connecting', 'scanning', 'error');
      const statusMap = {
        disconnected: '未接続',
        scanning:     'スキャン中…',
        connecting:   '接続中…',
        discovering:  'サービス検出中…',
        connected:    '接続済み',
        error:        '接続失敗',
      };
      txt.textContent = statusMap[status] || status;
      if (status !== 'disconnected') ind.classList.add(status);
      if (name) name.textContent = connected && state.obd.deviceName ? state.obd.deviceName : '';
    }

    // 設定画面 — ボタン表示切替
    const scanBtn       = document.getElementById('btn-ble-scan');
    const reconnectBtn  = document.getElementById('btn-ble-reconnect');
    const disconnectBtn = document.getElementById('btn-ble-disconnect');
    if (scanBtn && reconnectBtn && disconnectBtn) {
      const saved = bleLoadDevice();
      const busy = (status === 'scanning' || status === 'connecting' || status === 'discovering');
      scanBtn.disabled = busy;
      scanBtn.textContent = busy ? '接続処理中…' : 'BLE スキャン & 接続';
      reconnectBtn.style.display = (!connected && !busy && saved) ? '' : 'none';
      disconnectBtn.style.display = connected ? '' : 'none';
    }

    // Drive 画面 — OBD インジケータ
    const obdInd = document.getElementById('obd-indicator');
    if (obdInd) {
      obdInd.classList.remove('connected', 'connecting');
      if (status === 'connected') obdInd.classList.add('connected');
      else if (status === 'scanning' || status === 'connecting' || status === 'discovering') {
        obdInd.classList.add('connecting');
      }
    }
  }

  function bleSetStatus(s) {
    state.obd.status = s;
    state.obd.connected = (s === 'connected');
    updateBleUI();
  }

  // デバイス記憶（次回起動でクイック再接続用）
  function bleSaveDevice(id, name) {
    try { localStorage.setItem(BLE_DEVICE_KEY, JSON.stringify({ id, name })); } catch (_) {}
  }
  function bleLoadDevice() {
    try { return JSON.parse(localStorage.getItem(BLE_DEVICE_KEY)); } catch (_) { return null; }
  }

  // 切断ハンドラ（GATT 切断時の状態クリア）
  function bleAddDisconnectHandler(device) {
    if (device._taDisconnectHandlerAdded) return;
    device._taDisconnectHandlerAdded = true;
    device.addEventListener('gattserverdisconnected', () => {
      console.log('[BLE] gattserverdisconnected');
      bleStopPolling();
      stopKeepAlive();
      stopWatchdog();
      state.obd.txChar = null;
      state.obd.rxChar = null;
      // OBD 値もクリア
      state.obd.rpm = null;
      state.obd.coolant = null;
      state.obd.oiltemp = null;
      state.obd.intake = null;
      state.obd.throttle = null;
      // 自動再接続が ON で、ユーザー意図でない切断（_reconnecting中でない）なら再接続を試みる
      if (state.settings.obdAutoReconnect === 'on' && !_reconnecting) {
        // 短いディレイの後 attemptReconnect を試行
        setTimeout(() => {
          if (!state.obd.connected) attemptReconnect();
        }, 1500);
      } else {
        bleSetStatus('disconnected');
        toast('OBD2 切断');
      }
    });
  }

  // ── スキャン & 接続 ─────────────────────────────────
  async function bleStartScan() {
    if (!navigator.bluetooth) {
      toast('このブラウザは Web Bluetooth 非対応です');
      return;
    }
    try {
      bleSetStatus('scanning');
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ELM_SERVICES,
      });
      state.obd.device = device;
      bleSaveDevice(device.id, device.name || 'Unknown');
      bleAddDisconnectHandler(device);

      bleSetStatus('connecting');
      const server = await device.gatt.connect();
      await bleInitAfterConnect(server, device);
    } catch (e) {
      console.error('[BLE scan]', e);
      bleSetStatus('disconnected');
      if (e.name === 'NotFoundError') {
        // ユーザーがキャンセル
      } else {
        toast('接続失敗: ' + (e.message || e.name));
      }
    }
  }

  // ── 前回のデバイスへ再接続 ──────────────────────────
  async function bleQuickReconnect() {
    const saved = bleLoadDevice();
    if (!saved) {
      toast('保存されたデバイスがありません');
      return;
    }
    if (!navigator.bluetooth?.getDevices) {
      toast('再接続非対応のブラウザです。スキャンしてください');
      return;
    }
    try {
      bleSetStatus('scanning');
      const devices = await navigator.bluetooth.getDevices();
      const device = devices.find(d => d.id === saved.id);
      if (!device) {
        bleSetStatus('disconnected');
        toast('デバイスが見つかりません。スキャンしてください');
        return;
      }
      state.obd.device = device;
      bleAddDisconnectHandler(device);
      bleSetStatus('connecting');
      const server = await device.gatt.connect();
      await bleInitAfterConnect(server, device);
    } catch (e) {
      console.error('[BLE quick]', e);
      bleSetStatus('disconnected');
      toast('再接続失敗: ' + (e.message || e.name));
    }
  }

  // ── 切断 ────────────────────────────────────────────
  function bleDisconnect() {
    // ユーザー意図の切断中は再接続させない（_reconnecting フラグを流用）
    _reconnecting = true;
    stopKeepAlive();
    stopWatchdog();
    bleStopPolling();
    if (state.obd.device?.gatt?.connected) {
      state.obd.device.gatt.disconnect();
    } else {
      bleSetStatus('disconnected');
    }
    // 200ms 後にフラグを戻す（gattserverdisconnected イベント処理後）
    setTimeout(() => { _reconnecting = false; }, 200);
  }

  // ── GATT サービス検出 + ELM327 初期化シーケンス ──────
  async function bleInitAfterConnect(server, device) {
    try {
      bleSetStatus('discovering');
      let txChar = null, rxChar = null;

      // ELM327 標準サービスを優先試行
      for (const svcUuid of ELM_SERVICES) {
        try {
          const svc = await server.getPrimaryService(svcUuid);
          const chars = await svc.getCharacteristics();
          for (const c of chars) {
            if ((c.properties.notify || c.properties.indicate) && !rxChar) rxChar = c;
            if ((c.properties.writeWithoutResponse || c.properties.write) && !txChar) txChar = c;
          }
          if (txChar && rxChar) break;
        } catch (_) { /* このサービスは無い、次へ */ }
      }

      // フォールバック: 全サービスから探索（標準BLEサービス除外）
      if (!txChar || !rxChar) {
        const STD = ['00001800', '00001801', '0000180a', '0000180f'];
        const services = await server.getPrimaryServices();
        for (const svc of services) {
          if (STD.some(s => svc.uuid.startsWith(s))) continue;
          try {
            const chars = await svc.getCharacteristics();
            for (const c of chars) {
              if ((c.properties.notify || c.properties.indicate) && !rxChar) rxChar = c;
              if ((c.properties.writeWithoutResponse || c.properties.write) && !txChar) txChar = c;
            }
            if (txChar && rxChar) break;
          } catch (_) {}
        }
      }

      if (!txChar || !rxChar) {
        bleSetStatus('error');
        toast('ELM327 互換のキャラクタリスティックが見つかりません');
        return;
      }

      state.obd.txChar = txChar;
      state.obd.rxChar = rxChar;
      state.obd.deviceName = device.name || 'Unknown';
      state.obd.deviceId   = device.id;

      // 通知受信 → PID 応答パースへ
      await rxChar.startNotifications();
      // 重複登録防止
      if (!rxChar._taListenerAttached) {
        rxChar.addEventListener('characteristicvaluechanged', bleOnData);
        rxChar._taListenerAttached = true;
      }

      // ELM327 初期化シーケンス
      await bleSleep(500);
      bleSend('ATZ'); await bleSleep(1600);
      for (const cmd of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATST FF', 'ATSP0']) {
        bleSend(cmd);
        await bleSleep(400);
      }

      bleSetStatus('connected');
      toast(`OBD2 接続: ${state.obd.deviceName}`);

      // ポーリング + 安定化機能を開始
      bleStartPolling();
      startKeepAlive();
      startWatchdog();
    } catch (e) {
      console.error('[BLE init]', e);
      bleSetStatus('error');
      toast('初期化失敗: ' + (e.message || e.name));
    }
  }

  // イベントバインド
  document.getElementById('btn-ble-scan').addEventListener('click', bleStartScan);
  document.getElementById('btn-ble-reconnect').addEventListener('click', bleQuickReconnect);
  document.getElementById('btn-ble-disconnect').addEventListener('click', bleDisconnect);

  // ============================================================
  // HISTORY (走行履歴一覧 + セッション詳細)
  // ============================================================
  let _currentSessionId = null;

  function openHistory() {
    showScreen('history');
    renderHistoryList();
  }

  function renderHistoryList() {
    const sessions = loadSessions().slice().sort((a, b) => b.startTime - a.startTime);
    const listEl = document.getElementById('history-list');
    const emptyEl = document.getElementById('history-empty');

    listEl.innerHTML = '';

    if (sessions.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    sessions.forEach(s => {
      const bestMs = (s.bestLapIdx >= 0 && s.laps[s.bestLapIdx])
        ? s.laps[s.bestLapIdx].totalMs : null;
      const dateStr = formatSessionDate(s.startTime);

      const item = document.createElement('div');
      item.className = 'history-item';
      item.dataset.sessionId = s.id;
      item.innerHTML = `
        <div class="history-item-top">
          <div class="history-item-name">${escapeHtml(s.courseName)}</div>
          <div class="history-item-date">${dateStr}</div>
        </div>
        <div class="history-item-stats">
          <span><span class="label">LAPS</span>${s.laps.length}</span>
          <span><span class="label">BEST</span><span class="best">${bestMs ? formatTime(bestMs) : '--'}</span></span>
          ${s.hasObdData ? '<span class="obd-flag">● OBD</span>' : ''}
        </div>`;
      item.addEventListener('click', () => openSessionDetail(s.id));
      listEl.appendChild(item);
    });
  }

  function formatSessionDate(ms) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================
  // SESSION ANALYSIS  (Phase 5b + 5c)
  // ============================================================

  // 利用可能なメトリック定義
  // columns 順: 0=iso_time 1=lat 2=lon 3=acc 4=speed_kmh 5=lap 6=sector 7=g_lat 8=g_lon
  //             9=rpm 10=coolant 11=oilTemp 12=intake 13=throttle
  const METRICS = [
    { key: 'speed',    label: 'SPEED',    col: 4,  unit: 'km/h', requiresObd: false, abs: false },
    { key: 'lat_g',    label: '横G',      col: 7,  unit: 'G',    requiresObd: false, abs: true  },
    { key: 'lon_g',    label: '前後G',    col: 8,  unit: 'G',    requiresObd: false, abs: true  },
    { key: 'rpm',      label: 'RPM',      col: 9,  unit: '',     requiresObd: true,  abs: false },
    { key: 'throttle', label: 'THROTTLE', col: 13, unit: '%',    requiresObd: true,  abs: false },
    { key: 'coolant',  label: '水温',     col: 10, unit: '°C',   requiresObd: true,  abs: false },
    { key: 'oilTemp',  label: '油温',     col: 11, unit: '°C',   requiresObd: true,  abs: false },
  ];

  // 複数ラップ重ね合わせ時のラップ色（高コントラスト）
  const LAP_COLORS = [
    '#ffb000', '#4fc3f7', '#3fb950', '#f85149', '#a371f7',
    '#ff8c00', '#00d4ff', '#22e54a', '#ff3d1a', '#bd93f9',
  ];

  // 分析画面のローカル状態
  const analysis = {
    sessionId:    null,
    metric:       'speed',     // 選択中のメトリック
    selectedLaps: [],          // 表示中ラップ番号の配列
    map:          null,
    layers:       [],          // 描画したレイヤー配列（クリア用）
  };

  function openSessionDetail(sessionId) {
    const sessions = loadSessions();
    const s = sessions.find(x => x.id === sessionId);
    if (!s) {
      toast('セッションが見つかりません');
      return;
    }
    _currentSessionId = sessionId;
    analysis.sessionId = sessionId;

    // サマリ
    document.getElementById('session-course-name').textContent = s.courseName || '--';
    document.getElementById('session-date').textContent = formatSessionDate(s.startTime);
    document.getElementById('session-lap-count').textContent = String(s.laps.length);

    const bestMs = (s.bestLapIdx >= 0 && s.laps[s.bestLapIdx])
      ? s.laps[s.bestLapIdx].totalMs : null;
    document.getElementById('session-best').textContent =
      bestMs ? formatTime(bestMs) : '--:--.---';

    const durSec = Math.round((s.endTime - s.startTime) / 1000);
    const hh = Math.floor(durSec / 3600);
    const mm = Math.floor((durSec % 3600) / 60);
    const ss = durSec % 60;
    document.getElementById('session-duration').textContent =
      hh > 0 ? `${hh}h${mm}m` : `${mm}m${String(ss).padStart(2, '0')}s`;

    const obdFlag = document.getElementById('session-obd-flag');
    obdFlag.querySelector('.summary-value').textContent = s.hasObdData ? '有' : '無';
    obdFlag.querySelector('.summary-value').style.color = s.hasObdData ? '#3fb950' : 'var(--fg-dim)';

    // 初期選択: ベストラップ単独
    analysis.selectedLaps = (s.bestLapIdx >= 0 && s.laps[s.bestLapIdx])
      ? [s.laps[s.bestLapIdx].number]
      : (s.laps.length > 0 ? [s.laps[0].number] : []);

    // OBD データ無いセッションでは初期メトリックを speed に強制
    if (!s.hasObdData && METRICS.find(m => m.key === analysis.metric)?.requiresObd) {
      analysis.metric = 'speed';
    }

    renderMetricChips(s);
    renderLapChips(s);
    renderSessionLapList(s);

    showScreen('session');
    // マップは画面表示後にサイズ計算する必要あり
    setTimeout(() => initSessionMap(s), 50);
  }

  // ── メトリック選択チップを描画 ───────────────────
  function renderMetricChips(s) {
    const wrap = document.getElementById('metric-chips');
    wrap.innerHTML = '';
    METRICS.forEach(m => {
      // OBD 無セッションでは OBD 系を非表示
      if (m.requiresObd && !s.hasObdData) return;
      const chip = document.createElement('button');
      chip.className = 'chip' + (m.key === analysis.metric ? ' active' : '');
      chip.textContent = m.label;
      chip.addEventListener('click', () => {
        analysis.metric = m.key;
        renderMetricChips(s);
        drawAnalysis(s);
      });
      wrap.appendChild(chip);
    });
  }

  // ── ラップ選択チップを描画 ───────────────────────
  function renderLapChips(s) {
    const wrap = document.getElementById('lap-chips');
    wrap.innerHTML = '';
    s.laps.forEach((lap, i) => {
      const isBest = (i === s.bestLapIdx);
      const isSelected = analysis.selectedLaps.includes(lap.number);
      const chip = document.createElement('button');
      chip.className = 'chip' +
        (isSelected ? ' active' : '') +
        (isBest ? ' lap-best' : '');
      chip.textContent = `L${lap.number}` + (isBest ? '★' : '');
      chip.addEventListener('click', () => {
        // 複数選択トグル
        const idx = analysis.selectedLaps.indexOf(lap.number);
        if (idx >= 0) analysis.selectedLaps.splice(idx, 1);
        else          analysis.selectedLaps.push(lap.number);
        // 必ず1つは選択
        if (analysis.selectedLaps.length === 0) analysis.selectedLaps.push(lap.number);
        renderLapChips(s);
        renderSessionLapList(s);
        drawAnalysis(s);
      });
      wrap.appendChild(chip);
    });
  }

  // ── 凡例（カラースケール）の更新 ───────────────────
  function updateLegend(min, max, unit) {
    const fmt = (v) => {
      if (!isFinite(v)) return '--';
      const abs = Math.abs(v);
      if (abs >= 100)  return Math.round(v).toString();
      if (abs >= 10)   return v.toFixed(1);
      return v.toFixed(2);
    };
    document.getElementById('legend-min').textContent = fmt(min) + unit;
    document.getElementById('legend-max').textContent = fmt(max) + unit;

    // 複数ラップ選択中は凡例グラデーションを薄くしてラップ色を強調
    const legendRow = document.getElementById('legend-row');
    const isMulti = analysis.selectedLaps.length > 1;
    legendRow.style.opacity = isMulti ? '0.35' : '1';
  }

  // ── マップ初期化 ───────────────────────────────────
  function initSessionMap(s) {
    const mapEl = document.getElementById('session-map');
    const emptyEl = document.getElementById('session-map-empty');

    // 既存マップは破棄
    if (analysis.map) {
      try { analysis.map.remove(); } catch (_) {}
      analysis.map = null;
      analysis.layers = [];
    }

    // GPS データがあるか確認
    const validRows = s.rows.filter(r =>
      isFinite(parseFloat(r[1])) && isFinite(parseFloat(r[2])));
    if (validRows.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    // 中心位置・範囲を計算
    const lats = validRows.map(r => parseFloat(r[1]));
    const lons = validRows.map(r => parseFloat(r[2]));
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);

    analysis.map = L.map(mapEl, {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    });
    L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(analysis.map);

    // 境界 fit
    analysis.map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [20, 20] });

    drawAnalysis(s);
  }

  // ── メイン描画ロジック ─────────────────────────────
  function drawAnalysis(s) {
    if (!analysis.map) return;
    // 既存レイヤー削除
    analysis.layers.forEach(l => analysis.map.removeLayer(l));
    analysis.layers = [];

    const isMulti = analysis.selectedLaps.length > 1;
    const metricDef = METRICS.find(m => m.key === analysis.metric);

    if (isMulti) {
      // 複数ラップ: 各ラップを別色でベタ塗り
      analysis.selectedLaps.forEach(lapNum => {
        const colorIdx = (lapNum - 1) % LAP_COLORS.length;
        const color = LAP_COLORS[colorIdx];
        drawLapSolid(s, lapNum, color);
      });
      // 凡例ダミー: メトリック範囲だけは出しておく
      const range = computeMetricRange(s, analysis.selectedLaps, metricDef);
      updateLegend(range.min, range.max, metricDef.unit);
    } else if (analysis.selectedLaps.length === 1) {
      // 単独ラップ: グラデーション着色
      const lapNum = analysis.selectedLaps[0];
      const range = computeMetricRange(s, [lapNum], metricDef);
      drawLapGradient(s, lapNum, metricDef, range);
      updateLegend(range.min, range.max, metricDef.unit);
    }
  }

  // ラップ行をフィルタ + lat/lon/value 抽出
  function extractLapPoints(s, lapNum, col) {
    const pts = [];
    for (const r of s.rows) {
      if (parseInt(r[5], 10) !== lapNum) continue;
      const lat = parseFloat(r[1]);
      const lon = parseFloat(r[2]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const rawV = r[col];
      const v = (rawV === '' || rawV == null) ? null : parseFloat(rawV);
      pts.push({ lat, lon, v });
    }
    return pts;
  }

  function computeMetricRange(s, lapNums, metricDef) {
    let min = Infinity, max = -Infinity;
    for (const lapNum of lapNums) {
      const pts = extractLapPoints(s, lapNum, metricDef.col);
      for (const p of pts) {
        if (p.v == null || !isFinite(p.v)) continue;
        const v = metricDef.abs ? Math.abs(p.v) : p.v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!isFinite(min) || !isFinite(max) || min === max) {
      return { min: 0, max: 1 };
    }
    return { min, max };
  }

  // 値 → 色 (0..1 を blue→cyan→green→yellow→red にマッピング)
  function metricColor(t) {
    t = Math.max(0, Math.min(1, t));
    // 5 ストップ補間
    const stops = [
      [0.00, [44, 127, 255]],
      [0.25, [0, 212, 255]],
      [0.50, [0, 255, 127]],
      [0.75, [255, 210, 0]],
      [1.00, [255, 61, 26]],
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i];
      const [t1, c1] = stops[i + 1];
      if (t >= t0 && t <= t1) {
        const k = (t - t0) / (t1 - t0);
        const r = Math.round(c0[0] + (c1[0] - c0[0]) * k);
        const g = Math.round(c0[1] + (c1[1] - c0[1]) * k);
        const b = Math.round(c0[2] + (c1[2] - c0[2]) * k);
        return `rgb(${r},${g},${b})`;
      }
    }
    return 'rgb(255,255,255)';
  }

  // 単一ラップをグラデーション着色（小区間ごとに色を変える）
  function drawLapGradient(s, lapNum, metricDef, range) {
    const pts = extractLapPoints(s, lapNum, metricDef.col);
    if (pts.length < 2) return;
    const span = (range.max - range.min) || 1;

    // 各セグメントを個別 polyline として追加（短いので軽い）
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      // 区間値: 平均
      let vA = a.v, vB = b.v;
      if (metricDef.abs) {
        if (vA != null) vA = Math.abs(vA);
        if (vB != null) vB = Math.abs(vB);
      }
      let v = null;
      if (vA != null && vB != null) v = (vA + vB) / 2;
      else if (vA != null) v = vA;
      else if (vB != null) v = vB;

      const color = (v == null) ? '#6a6f7c' : metricColor((v - range.min) / span);

      const seg = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
        color, weight: 4, opacity: 0.9, lineJoin: 'round', lineCap: 'round',
      }).addTo(analysis.map);
      analysis.layers.push(seg);
    }
  }

  // 複数ラップ: 単色 polyline
  function drawLapSolid(s, lapNum, color) {
    const pts = extractLapPoints(s, lapNum, 4);
    if (pts.length < 2) return;
    const latlngs = pts.map(p => [p.lat, p.lon]);
    const line = L.polyline(latlngs, {
      color, weight: 3.5, opacity: 0.78, lineJoin: 'round',
    }).addTo(analysis.map);
    analysis.layers.push(line);
  }

  // ── ラップタイム一覧（選択中ラップ強調 + 色マーカー）─────
  function renderSessionLapList(s) {
    const listEl = document.getElementById('session-lap-list');
    listEl.innerHTML = '';

    if (s.laps.length === 0) {
      listEl.innerHTML = '<div class="splits-empty" style="padding:18px;text-align:center;color:var(--fg-faint)">完走ラップなし</div>';
      return;
    }

    const isMulti = analysis.selectedLaps.length > 1;

    s.laps.forEach((lap, i) => {
      const isBest = (i === s.bestLapIdx);
      const isSelected = analysis.selectedLaps.includes(lap.number);
      const splitsTxt = (lap.splits && lap.splits.length > 0)
        ? lap.splits.map(sp => formatTime(sp.splitMs)).join(' · ')
        : '';
      const colorIdx = (lap.number - 1) % LAP_COLORS.length;
      const colorDot = (isMulti && isSelected)
        ? `<span class="lap-row-color" style="background:${LAP_COLORS[colorIdx]}"></span>`
        : '';

      const row = document.createElement('div');
      row.className = 'lap-row' + (isBest ? ' best' : '') +
        ((isMulti && isSelected) ? ' selected-multi' : '');
      row.innerHTML = `
        <div class="lap-row-num">${colorDot}L${lap.number}${isBest ? '<span class="badge">BEST</span>' : ''}</div>
        <div class="lap-row-time">${formatTime(lap.totalMs)}</div>
        <div class="lap-row-splits">${splitsTxt}</div>
      `;
      listEl.appendChild(row);
    });
  }

  // History/Session: ナビゲーション
  document.getElementById('btn-open-history').addEventListener('click', openHistory);
  document.getElementById('btn-history-back').addEventListener('click', () => showScreen('home'));
  document.getElementById('btn-session-back').addEventListener('click', () => {
    // マップリソースを解放
    if (analysis.map) {
      try { analysis.map.remove(); } catch (_) {}
      analysis.map = null;
      analysis.layers = [];
    }
    showScreen('history');
  });

  // CSV エクスポート
  document.getElementById('btn-session-export').addEventListener('click', () => {
    if (!_currentSessionId) return;
    const s = loadSessions().find(x => x.id === _currentSessionId);
    if (!s) { toast('セッションが見つかりません'); return; }
    const header = [
      'ISO_TIME', 'LAT', 'LON', 'ACC_M', 'SPEED_KMH',
      'LAP', 'SECTOR', 'G_LAT', 'G_LON',
      'RPM', 'COOLANT_C', 'OIL_TEMP_C', 'INTAKE_C', 'THROTTLE_PCT',
    ];
    const lines = [header.join(',')].concat(s.rows.map(r => r.join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const stamp = new Date(s.startTime).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `timeattacker_${(s.courseName || 'session').replace(/\s+/g, '_')}_${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`CSV出力: ${s.rows.length}行`);
  });

  // セッション削除
  document.getElementById('btn-session-delete').addEventListener('click', () => {
    if (!_currentSessionId) return;
    if (!confirm('この履歴を削除しますか？')) return;
    deleteSession(_currentSessionId);
    _currentSessionId = null;
    toast('履歴を削除しました');
    showScreen('history');
    renderHistoryList();
  });

  // ============================================================
  // OBD2 PID ポーリング & パース (Phase 2)
  // ============================================================
  // 設定された PID を「高速」「低速」に振り分け、高速は毎サイクル送信、
  // 低速はラウンドロビンで1つずつ送信する
  // ── 高速: RPM (動きの激しい値、高頻度で必要)
  // ── 低速: 水温 / 油温 / 吸気温 / スロットル (値の変化が緩やか)
  let ACTIVE_PIDS_FAST = [];
  let ACTIVE_PIDS_SLOW = [];
  let _slowIdx = 0;

  // ELM327 のエラー応答キーワード
  const OBD_NOISE = ['NODATA', 'ERROR', 'UNABLE', 'SEARCHING', 'STOPPED', 'BUSBUSY'];

  // ポーリング状態
  const pollState = {
    active:   false,
    pidQueue: [],
    curPid:   '',
    buf:      '',
    waiting:  false,
  };
  let _pollTimer    = null;
  let _timeoutTimer = null;

  function recomputeActivePids() {
    const pids = state.settings.pids;
    const fast = new Set();
    const slow = new Set();
    if (pids.rpm)      fast.add('010C');  // RPM
    if (pids.coolant)  slow.add('0105');
    if (pids.oiltemp)  slow.add('015C');
    if (pids.intake)   slow.add('010F');
    if (pids.throttle) slow.add('0111');
    ACTIVE_PIDS_FAST = [...fast];
    ACTIVE_PIDS_SLOW = [...slow];
    _slowIdx = 0;
    pollState.pidQueue = [];
    pollState.waiting  = false;
    pollState.buf      = '';
    clearTimeout(_timeoutTimer);
  }

  function nextPids() {
    const pids = [...ACTIVE_PIDS_FAST];
    if (ACTIVE_PIDS_SLOW.length > 0) {
      pids.push(ACTIVE_PIDS_SLOW[_slowIdx % ACTIVE_PIDS_SLOW.length]);
      _slowIdx++;
    }
    return pids;
  }

  // 50ms 間隔で 1 PID 送信。応答待ち中は何もしない
  function bleStartPolling() {
    recomputeActivePids();
    pollState.active   = true;
    pollState.pidQueue = nextPids();
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
      if (!pollState.active || !state.obd.connected) {
        clearInterval(_pollTimer);
        _pollTimer = null;
        return;
      }
      if (pollState.waiting) return;
      if (!pollState.pidQueue.length) pollState.pidQueue = nextPids();
      if (!pollState.pidQueue.length) return;  // PIDが何も選択されていない
      pollState.curPid  = pollState.pidQueue.shift();
      pollState.waiting = true;
      bleSend(pollState.curPid);
      // 500ms 応答なければ諦めて次へ
      _timeoutTimer = setTimeout(() => {
        pollState.buf     = '';
        pollState.waiting = false;
        _consecutiveTimeouts++;
      }, 500);
    }, 50);
  }

  function bleStopPolling() {
    pollState.active  = false;
    pollState.buf     = '';
    pollState.waiting = false;
    if (_pollTimer)    { clearInterval(_pollTimer);    _pollTimer = null; }
    if (_timeoutTimer) { clearTimeout(_timeoutTimer);  _timeoutTimer = null; }
  }

  // notify ハンドラ — 受信データをバッファに蓄積し、'>' で1応答完了として処理
  function bleOnData(event) {
    try {
      pollState.buf += new TextDecoder().decode(event.target.value);
    } catch (_) { return; }
    // バッファ肥大化ガード
    if (pollState.buf.length > 512) {
      pollState.buf = '';
      pollState.waiting = false;
      return;
    }
    // ELM327 はプロンプト '>' で応答完了
    if (!pollState.buf.includes('>')) return;
    clearTimeout(_timeoutTimer);
    const raw = pollState.buf;
    pollState.buf = '';
    pollState.waiting = false;
    if (!state.obd.connected) return;

    state.obd.lastUpdateMs = Date.now();
    _lastDataAt            = Date.now();
    _consecutiveTimeouts   = 0;

    const lines = raw.split('\r')
      .map(l => l.replace(/[\n>]/g, '').trim())
      .filter(l => l.length > 3);
    const pid = pollState.curPid;

    if (lines.length > 0) {
      const mode = state.settings.obdMode;
      if (mode === 'single') {
        // Single: 最初に解析できた行で打ち切り（単一ECU向け）
        for (const l of lines) { if (parseObdLine(pid, l)) break; }
      } else {
        // Double: 全行をパース（UniCarScan + BMW など複数ECU応答向け）
        for (const l of lines) parseObdLine(pid, l);
      }
    }
  }

  // PID 別パース
  function parseObdLine(pid, raw) {
    const s = raw.replace(/[\s\r\n>]/g, '').toUpperCase();
    if (!s || OBD_NOISE.some(n => s.includes(n))) return false;
    // 応答ヘッダ "4x" を探す (PID 010C → 41 0C ... の場合 "41" の "1" 部分は元の "1")
    const hdr = '4' + pid.slice(1);
    const idx = s.indexOf(hdr);
    if (idx < 0) return false;
    const v = s.slice(idx + 4);
    try {
      if (pid === '010C' && v.length >= 4) {
        // RPM = ((A*256) + B) / 4
        state.obd.rpm = (parseInt(v.slice(0, 2), 16) * 256 + parseInt(v.slice(2, 4), 16)) >> 2;
        return true;
      } else if (pid === '0105' && v.length >= 2) {
        state.obd.coolant = parseInt(v.slice(0, 2), 16) - 40;
        return true;
      } else if (pid === '015C' && v.length >= 2) {
        state.obd.oiltemp = parseInt(v.slice(0, 2), 16) - 40;
        return true;
      } else if (pid === '010F' && v.length >= 2) {
        state.obd.intake = parseInt(v.slice(0, 2), 16) - 40;
        return true;
      } else if (pid === '0111' && v.length >= 2) {
        state.obd.throttle = Math.round(parseInt(v.slice(0, 2), 16) / 255 * 100);
        return true;
      }
    } catch (e) {
      console.warn('[OBD PARSE]', e);
    }
    return false;
  }

  // ============================================================
  // 接続安定化 (Phase 3)
  // Watchdog: 通信断や応答無しを検知 → 設定に応じて自動再接続
  // Keep-Alive: 30秒ごとに無害なATコマンドを送り Android の OS による
  //             BLE スリープ強制切断を防ぐ
  // ============================================================
  const WATCHDOG_MS  = 5000;    // 5秒ごとにヘルスチェック
  const NO_DATA_MS   = 15000;   // 15秒以上データ無 → 異常判定
  const MAX_TIMEOUTS = 15;      // 連続15回タイムアウト → 異常判定
  const KEEPALIVE_MS = 30000;   // Keep-Alive 送信間隔
  const RECONNECT_SAFETY_MS = 20000;  // 再接続が固まった場合の安全弁

  let _lastDataAt          = 0;
  let _consecutiveTimeouts = 0;
  let _watchdogTimer  = null;
  let _keepAliveTimer = null;
  let _reconnecting   = false;

  function startKeepAlive() {
    if (_keepAliveTimer) clearInterval(_keepAliveTimer);
    _keepAliveTimer = setInterval(() => {
      if (!state.obd.connected || !state.obd.txChar) return;
      // 'AT I' = ELM327 識別情報。無害で応答が返るため接続維持に最適
      bleSend('AT I');
    }, KEEPALIVE_MS);
  }
  function stopKeepAlive() {
    if (_keepAliveTimer) {
      clearInterval(_keepAliveTimer);
      _keepAliveTimer = null;
    }
  }

  function startWatchdog() {
    if (_watchdogTimer) clearInterval(_watchdogTimer);
    _lastDataAt          = Date.now();
    _consecutiveTimeouts = 0;
    _watchdogTimer = setInterval(() => {
      if (!state.obd.connected || !pollState.active) return;
      const stale   = (Date.now() - _lastDataAt) > NO_DATA_MS;
      const tooMany = _consecutiveTimeouts >= MAX_TIMEOUTS;
      if (stale || tooMany) {
        console.warn('[WATCHDOG] stale=' + stale + ' tooMany=' + tooMany);
        if (state.settings.obdAutoReconnect === 'on') {
          attemptReconnect();
        } else {
          // 自動再接続OFFなら切断のみ
          bleDisconnect();
        }
      }
    }, WATCHDOG_MS);
  }
  function stopWatchdog() {
    if (_watchdogTimer) {
      clearInterval(_watchdogTimer);
      _watchdogTimer = null;
    }
  }

  async function attemptReconnect() {
    if (_reconnecting) return;
    _reconnecting = true;
    bleSetStatus('connecting');
    toast('OBD2 再接続中...');

    // 安全弁: 20秒以内に完了しなければ強制リセット
    const safety = setTimeout(() => {
      if (_reconnecting) {
        _reconnecting = false;
        bleSetStatus('disconnected');
        toast('再接続タイムアウト');
      }
    }, RECONNECT_SAFETY_MS);

    try {
      bleStopPolling();
      stopKeepAlive();
      stopWatchdog();
      state.obd.txChar = null;
      state.obd.rxChar = null;
      pollState.buf     = '';
      pollState.waiting = false;

      if (state.obd.device?.gatt?.connected) {
        try { state.obd.device.gatt.disconnect(); } catch (_) {}
      }
      await bleSleep(500);

      if (state.obd.device) {
        const server = await state.obd.device.gatt.connect();
        await bleInitAfterConnect(server, state.obd.device);
      } else {
        bleSetStatus('disconnected');
      }
    } catch (e) {
      console.error('[RECONNECT]', e);
      bleSetStatus('disconnected');
      toast('再接続失敗');
    } finally {
      clearTimeout(safety);
      _reconnecting = false;
    }
  }

  // 画面が再表示された時、誤検知を防ぐためカウンタをリセット
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.obd.connected) {
      _lastDataAt          = Date.now();
      _consecutiveTimeouts = 0;
    }
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
      const labels = { start: 'スタート線', finish: 'フィニッシュ線', section: 'セクター線' };
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
    if (!confirm('全セクター線を削除しますか？')) return;
    c.sections = [];
    c.bestLap = null;
    saveCourses();
    redrawEditLines();
    toast('セクター線を消去');
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
      list.innerHTML = '<div class="splits-empty">セクター線を描くと表示されます</div>';
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
      state.completedLaps = [];
      state.sessionStartTime = Date.now();

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

    // セッションを履歴に永続化
    const c = getActiveCourse();
    persistCurrentSession(c);
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
      // OBD2 値の安全な文字列化（null → '' で CSV の空セルになる）
      const obdStr = v => (v === null || v === undefined) ? '' : v;
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
        // ── OBD2 カラム（Phase 1 未接続時は空欄）────────
        obdStr(state.obd.rpm),
        obdStr(state.obd.coolant),
        obdStr(state.obd.oiltemp),
        obdStr(state.obd.intake),
        obdStr(state.obd.throttle),
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

    // セッション中のラップ履歴へ追加
    state.completedLaps.push({
      number:  state.lapNumber,
      totalMs: lapMs,
      splits:  lapRecord.splits,
      date:    lapRecord.date,
    });

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
      grid.innerHTML = '<div class="splits-empty">セクター未設定</div>';
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
    const header = [
      'ISO_TIME', 'LAT', 'LON', 'ACC_M', 'SPEED_KMH',
      'LAP', 'SECTOR', 'G_LAT', 'G_LON',
      // OBD2 カラム (Phase 1 で BLE 接続時に値が入る、未接続時は空)
      'RPM', 'COOLANT_C', 'OIL_TEMP_C', 'INTAKE_C', 'THROTTLE_PCT',
    ];
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
  // ============================================================
  // SPLASH → WARNING 自動遷移（2秒）
  // ============================================================
  renderHome();
  showScreen('splash');
  setTimeout(() => {
    showScreen('warning');
  }, 2000);

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
