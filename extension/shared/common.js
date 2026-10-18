// 共用常數與工具，content script、popup、設定頁都會載入。
(() => {
  if (globalThis.VC) return;

  const api = globalThis.browser ?? globalThis.chrome;

  const LIMITS = {
    rateMin: 0.1,
    rateMax: 16,
    volumeMin: 0,
    volumeMax: 4, // 400%
  };

  const DEFAULT_STATE = { rate: 1, volume: 1, mono: false };

  // 可自訂快捷鍵的動作，順序即設定頁顯示順序
  const ACTIONS = [
    { id: 'slower', label: '減速' },
    { id: 'faster', label: '加速' },
    { id: 'resetSpeed', label: '倍速重設（1x ↔ 上次倍速）' },
    { id: 'volDown', label: '音量 −' },
    { id: 'volUp', label: '音量 +' },
    { id: 'mono', label: '切換單聲道' },
    { id: 'resetAll', label: '全部重設' },
    { id: 'toggleOverlay', label: '顯示／隱藏浮動面板' },
  ];

  const DEFAULT_SETTINGS = {
    // 'both' | 'popup' | 'overlay'
    uiMode: 'both',
    overlayPosition: 'top-left', // 'top-left' | 'top-right'
    overlayAutoHide: true,
    shortcutsEnabled: true,
    speedStep: 0.25,
    volumeStep: 10, // 百分比
    keys: {
      slower: 'KeyS',
      faster: 'KeyD',
      resetSpeed: 'KeyR',
      volDown: 'KeyQ',
      volUp: 'KeyW',
      mono: 'KeyN',
      resetAll: 'Shift+KeyR',
      toggleOverlay: 'KeyV',
    },
  };

  const RATE_PRESETS = [0.5, 1, 1.25, 1.5, 2, 3, 4, 8, 16];
  const VOLUME_PRESETS = [0, 50, 100, 200, 300, 400];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function clampRate(r) {
    r = clamp(Number(r) || 1, LIMITS.rateMin, LIMITS.rateMax);
    return Math.round(r * 100) / 100;
  }

  function clampVolume(v) {
    v = clamp(Number(v), LIMITS.volumeMin, LIMITS.volumeMax);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 1;
  }

  // 倍速滑桿用對數刻度，讓 0.5x~2x 的區間不會擠在一起
  const RATE_LOG_SPAN = Math.log(LIMITS.rateMax / LIMITS.rateMin);
  function sliderToRate(t) {
    const r = LIMITS.rateMin * Math.exp(t * RATE_LOG_SPAN);
    const step = r < 2 ? 0.05 : r < 4 ? 0.1 : 0.25;
    return clampRate(Math.round(r / step) * step);
  }
  function rateToSlider(r) {
    return Math.log(clampRate(r) / LIMITS.rateMin) / RATE_LOG_SPAN;
  }

  // 加減速：4x 以上每次跳 1x，以免按到 16x 要按幾十下
  function stepRate(rate, dir, step) {
    const s = (dir > 0 ? rate >= 4 : rate > 4) ? Math.max(step, 1) : step;
    const next = dir > 0 ? (Math.floor(rate / s + 1e-6) + 1) * s : (Math.ceil(rate / s - 1e-6) - 1) * s;
    return clampRate(next);
  }

  function formatRate(r) {
    return String(Math.round(r * 100) / 100) + '×';
  }
  const formatVolume = (v) => Math.round(v * 100) + '%';

  // 'Shift+KeyD' 這類字串 <-> KeyboardEvent
  function comboFromEvent(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Meta');
    return [...mods, e.code].join('+');
  }

  const MOD_LABEL = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
  const CODE_LABEL = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  };
  function formatCombo(combo) {
    if (!combo) return '—';
    const parts = combo.split('+');
    const code = parts.pop();
    let key = CODE_LABEL[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
    return parts.map((m) => MOD_LABEL[m] ?? m).join('') + key;
  }

  function mergeSettings(stored) {
    const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
    s.keys = { ...DEFAULT_SETTINGS.keys, ...((stored && stored.keys) || {}) };
    return s;
  }

  async function loadSettings() {
    try {
      const res = await api.storage.local.get('settings');
      return mergeSettings(res && res.settings);
    } catch {
      return mergeSettings(null);
    }
  }

  async function saveSettings(settings) {
    await api.storage.local.set({ settings });
  }

  function onSettingsChanged(cb) {
    try {
      api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) cb(mergeSettings(changes.settings.newValue));
      });
    } catch {}
  }

  globalThis.VC = {
    api, LIMITS, DEFAULT_STATE, DEFAULT_SETTINGS, ACTIONS, RATE_PRESETS, VOLUME_PRESETS,
    clamp, clampRate, clampVolume, sliderToRate, rateToSlider, stepRate,
    formatRate, formatVolume, comboFromEvent, formatCombo,
    loadSettings, saveSettings, onSettingsChanged, mergeSettings,
  };
})();
