// 內容腳本：注入每個網頁（含 iframe），負責實際控制 <video>/<audio>。
(() => {
  if (window.__vcContentLoaded) return;
  window.__vcContentLoaded = true;

  const { api } = VC;

  let settings = VC.mergeSettings(null);
  const state = { ...VC.DEFAULT_STATE };
  let lastCustomRate = 2; // 「倍速重設」在 1x 與此值之間切換
  let notice = null; // 'cors' | 'gesture' | 'inuse' | 'rate' | 'mse' | 'noaudio'
  // 使用者還沒調過音量時，不去動影片原本的音量，顯示值直接反映影片目前的音量
  let volumeTouched = false;
  let overlayHiddenByKey = false;
  let lastPageInteraction = 0;
  let waitingForGesture = false;

  const media = new Set();
  const graphs = new WeakMap(); // el -> { ctx, source, gain, mix, analyser, status }
  const pendingGraphs = new WeakMap(); // el -> Promise
  const fights = new WeakMap(); // el -> 最近被網站改回倍速的時間戳
  const volumeFights = new WeakMap();
  const originalVolumes = new WeakMap(); // el -> 第一次調整前的音量，全部重設時還原
  let audioCtx = null;

  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- 影片偵測

  function track(el) {
    if (media.has(el)) return;
    media.add(el);
    applyTo(el);
    overlay.refresh();
  }

  function scan() {
    for (const el of media) if (!el.isConnected) media.delete(el);
    document.querySelectorAll('video, audio').forEach(track);
  }

  // 也掃描開放的 shadow root（部分播放器把 <video> 放在 web component 裡）
  function deepScan() {
    const walker = document.createTreeWalker(document.documentElement || document, NodeFilter.SHOW_ELEMENT);
    const visit = (root) => root.querySelectorAll('video, audio').forEach(track);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.shadowRoot) {
        visit(n.shadowRoot);
        const inner = document.createTreeWalker(n.shadowRoot, NodeFilter.SHOW_ELEMENT);
        for (let m = inner.nextNode(); m; m = inner.nextNode()) if (m.shadowRoot) visit(m.shadowRoot);
      }
    }
  }

  const liveMedia = () => [...media].filter((el) => el.isConnected);
  const hasMedia = () => liveMedia().length > 0;

  // 「目前正在播放」的那一個：播放中優先，其次畫面面積最大
  function primaryMedia({ videoOnly = false } = {}) {
    let best = null;
    let bestScore = -1;
    for (const el of liveMedia()) {
      const isVideo = el instanceof HTMLVideoElement;
      if (videoOnly && !isVideo) continue;
      const r = el.getBoundingClientRect();
      const area = isVideo ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
      const playing = !el.paused && !el.ended;
      const score = (playing ? 1e9 : 0) + area + (el.currentSrc || el.srcObject ? 1 : 0);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- 套用設定

  function applyAll() {
    return Promise.all(liveMedia().map(applyTo));
  }

  function applyTo(el) {
    applyRate(el);
    applyElementVolume(el);
    return applyAudio(el);
  }

  // 0–100% 直接用影片元素本身的音量：不需要 Web Audio，任何網站都有效
  function applyElementVolume(el) {
    if (!volumeTouched) return;
    if (!originalVolumes.has(el)) originalVolumes.set(el, el.volume);
    const v = Math.min(state.volume, 1);
    if (Math.abs(el.volume - v) > 0.001) el.volume = v;
  }

  function currentVolume() {
    if (volumeTouched) return state.volume;
    const p = primaryMedia();
    return p ? VC.clampVolume(p.volume) : 1;
  }

  function applyRate(el) {
    if (Math.abs(el.playbackRate - state.rate) < 0.001) return;
    try {
      el.playbackRate = state.rate;
      if (notice === 'rate') notice = null;
    } catch {
      notice = 'rate';
    }
  }

  // 只有放大超過 100% 或單聲道才需要 Web Audio
  const needsGraph = () => (volumeTouched && state.volume > 1.001) || state.mono;

  async function applyAudio(el) {
    let g = graphs.get(el);
    if (!g) {
      if (!needsGraph()) return;
      g = await ensureGraph(el);
      if (!g) return;
    }
    if (g.status === 'broken' && needsGraph()) notice = g.brokenNotice;
    const boost = volumeTouched ? Math.max(state.volume, 1) : 1;
    g.gain.gain.setTargetAtTime(boost, g.ctx.currentTime, 0.015);
    if (state.mono) {
      // 強制把聲道數降為 1：Web Audio 會以 (L+R)/2 混成單聲道，輸出時再複製到左右喇叭
      g.mix.channelCountMode = 'explicit';
      g.mix.channelCount = 1;
      g.mix.channelInterpretation = 'speakers';
    } else {
      g.mix.channelCountMode = 'max';
      g.mix.channelCount = 2;
    }
  }

  // 跨網域且沒有 CORS 的媒體接進 Web Audio 會變成完全無聲，所以先擋下來
  function isCrossOriginTainted(el) {
    if (el.crossOrigin != null) return false;
    const src = el.currentSrc || el.src;
    if (!src || /^(blob|data|mediastream):/i.test(src)) return false;
    try {
      return new URL(src, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  }

  function ensureGraph(el) {
    if (graphs.has(el)) return Promise.resolve(graphs.get(el));
    if (pendingGraphs.has(el)) return pendingGraphs.get(el);
    const p = createGraph(el).finally(() => pendingGraphs.delete(el));
    pendingGraphs.set(el, p);
    return p;
  }

  async function createGraph(el) {
    // 尚未載入來源時先不接，等 loadedmetadata 再試（才知道是否跨網域）
    if (!el.currentSrc && !el.srcObject) return null;
    if (isCrossOriginTainted(el)) {
      notice = 'cors';
      return null;
    }
    const ctx = await getAudioContext();
    if (!ctx) {
      notice = 'gesture';
      waitingForGesture = true;
      return null;
    }
    if (graphs.has(el)) return graphs.get(el);
    let source;
    try {
      source = ctx.createMediaElementSource(el);
    } catch {
      // 網站自己已經把這個元素接到 Web Audio 了
      notice = 'inuse';
      return null;
    }
    const gain = ctx.createGain();
    const mix = ctx.createGain();
    source.connect(gain);
    gain.connect(mix);
    mix.connect(ctx.destination);
    // 用來確認 Safari 真的有把聲音送進 Web Audio（MSE 串流影片不會）
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const g = {
      ctx, source, gain, mix, analyser,
      buf: new Float32Array(analyser.fftSize),
      status: 'checking', // 'checking' | 'ok' | 'broken'
      silentMs: 0,
      brokenNotice: /^blob:/i.test(el.currentSrc || el.src) ? 'mse' : 'noaudio',
    };
    graphs.set(el, g);
    if (notice === 'gesture' || notice === 'cors') notice = null;
    return g;
  }

  async function getAudioContext() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        audioCtx = new AC({ latencyHint: 'playback' });
      } catch {
        audioCtx = new AC();
      }
      audioCtx.addEventListener('statechange', () => {
        if (audioCtx.state !== 'running' && liveMedia().some((el) => graphs.has(el) && !el.paused)) {
          audioCtx.resume().catch(() => {});
          waitingForGesture = true;
        }
      });
    }
    if (audioCtx.state !== 'running') {
      // Safari 若不允許，resume() 可能永遠不會 resolve，所以加上逾時
      try {
        await Promise.race([audioCtx.resume(), sleep(400)]);
      } catch {}
    }
    return audioCtx.state === 'running' ? audioCtx : null;
  }

  // 在網頁上的使用者操作（點擊、按鍵）中呼叫，才能解除 Safari 的自動播放限制
  function resumeFromGesture() {
    if (!waitingForGesture) return;
    waitingForGesture = false;
    if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        try {
          audioCtx = new AC({ latencyHint: 'playback' });
        } catch {}
      }
    }
    setTimeout(() => applyAll().then(() => overlay.render()), 50);
  }

  function setState(patch) {
    if ('rate' in patch) {
      state.rate = VC.clampRate(patch.rate);
      if (Math.abs(state.rate - 1) > 0.001) lastCustomRate = state.rate;
    }
    if ('volume' in patch) {
      state.volume = VC.clampVolume(patch.volume);
      volumeTouched = true;
    }
    if ('mono' in patch) state.mono = !!patch.mono;
    if (!needsGraph() && ['gesture', 'cors', 'inuse', 'mse', 'noaudio'].includes(notice)) {
      notice = null;
      waitingForGesture = false;
    }
    overlay.render();
    overlay.flash();
    return applyAll().then(() => overlay.render());
  }

  // 全部重設：倍速 1×、取消放大與單聲道，並把影片音量還原成調整前的值
  function resetState() {
    const restore = volumeTouched;
    volumeTouched = false;
    state.volume = 1;
    if (restore) {
      for (const el of liveMedia()) {
        if (originalVolumes.has(el)) el.volume = originalVolumes.get(el);
        originalVolumes.delete(el);
      }
    }
    return setState({ rate: 1, mono: false });
  }

  function report() {
    const p = primaryMedia();
    return {
      hasMedia: hasMedia(),
      mediaCount: liveMedia().length,
      playing: !!p && !p.paused && !p.ended,
      isVideo: p instanceof HTMLVideoElement,
      rate: state.rate,
      volume: currentVolume(),
      mono: state.mono,
      notice,
      host: location.hostname,
    };
  }

  // Safari 對 MSE 串流（YouTube 等網站）的影片不會把聲音送進 Web Audio，
  // 而且不會報錯，只能靠實際量測有沒有訊號來判斷
  const CHECK_MS = 500;
  function checkGraphs() {
    for (const el of liveMedia()) {
      const g = graphs.get(el);
      if (!g || g.status === 'ok') continue;
      if (el.paused || el.muted || el.volume === 0 || el.readyState < 3 || g.ctx.state !== 'running') continue;
      g.analyser.getFloatTimeDomainData(g.buf);
      let peak = 0;
      for (const x of g.buf) if (Math.abs(x) > peak) peak = Math.abs(x);
      if (peak > 1e-4) {
        g.status = 'ok';
        if (notice === g.brokenNotice) notice = null;
        overlay.render();
      } else if (g.status === 'checking' && (g.silentMs += CHECK_MS) >= 3000) {
        g.status = 'broken';
        if (needsGraph()) notice = g.brokenNotice;
        overlay.render();
      }
    }
  }

  // ---------------------------------------------------------------- 媒體事件

  function onRateChange(e) {
    const el = e.target;
    if (!media.has(el) || Math.abs(el.playbackRate - state.rate) < 0.001) return;
    if (now() - lastPageInteraction < 1000) {
      // 使用者剛用網站自己的選單改了倍速 → 採用它
      state.rate = VC.clampRate(el.playbackRate);
      liveMedia().forEach(applyRate);
      overlay.render();
      return;
    }
    // 網站自行把倍速改回去（例如換片、廣告結束）→ 改回使用者設定；
    // 但若網站一直跟我們搶，就放手以免無限迴圈
    const t = now();
    const recent = (fights.get(el) || []).filter((x) => t - x < 2000);
    recent.push(t);
    fights.set(el, recent);
    if (recent.length <= 10) applyRate(el);
  }

  function onMediaEvent(e) {
    const el = e.target;
    if (!(el instanceof HTMLMediaElement)) return;
    if (!media.has(el)) {
      track(el);
      return;
    }
    if (e.type === 'play' && audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    applyTo(el);
    overlay.refresh();
  }

  for (const type of ['loadstart', 'loadedmetadata', 'play', 'playing']) {
    document.addEventListener(type, onMediaEvent, true);
  }
  document.addEventListener('ratechange', onRateChange, true);

  function onVolumeChange(e) {
    const el = e.target;
    if (!media.has(el)) return;
    if (!volumeTouched) {
      overlay.render();
      return;
    }
    const want = Math.min(state.volume, 1);
    if (Math.abs(el.volume - want) < 0.005) return;
    if (now() - lastPageInteraction < 1000) {
      // 使用者剛用網站自己的音量鈕調整 → 採用它（同時取消放大）
      state.volume = VC.clampVolume(el.volume);
      applyAll();
      overlay.render();
      return;
    }
    const t = now();
    const recent = (volumeFights.get(el) || []).filter((x) => t - x < 2000);
    recent.push(t);
    volumeFights.set(el, recent);
    if (recent.length <= 10) applyElementVolume(el);
  }
  document.addEventListener('volumechange', onVolumeChange, true);

  // ---------------------------------------------------------------- 快捷鍵

  function isEditableTarget(e) {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!t || !(t instanceof Element)) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = (t.getAttribute('type') || 'text').toLowerCase();
      return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
    }
    return false;
  }

  function actionFor(e) {
    if (!settings.shortcutsEnabled || isEditableTarget(e) || overlay.isEditing() || !hasMedia()) return null;
    const combo = VC.comboFromEvent(e);
    for (const [action, key] of Object.entries(settings.keys)) if (key && key === combo) return action;
    return null;
  }

  function runAction(action) {
    const step = settings.speedStep;
    const vStep = settings.volumeStep / 100;
    switch (action) {
      case 'faster':
        return setState({ rate: VC.stepRate(state.rate, +1, step) });
      case 'slower':
        return setState({ rate: VC.stepRate(state.rate, -1, step) });
      case 'resetSpeed':
        return setState({ rate: Math.abs(state.rate - 1) > 0.001 ? 1 : lastCustomRate });
      case 'volUp':
        return setState({ volume: currentVolume() + vStep });
      case 'volDown':
        return setState({ volume: currentVolume() - vStep });
      case 'mono':
        return setState({ mono: !state.mono });
      case 'resetAll':
        return resetState();
      case 'toggleOverlay':
        overlayHiddenByKey = !overlayHiddenByKey;
        overlay.refresh();
        if (!overlayHiddenByKey) overlay.flash();
        return;
    }
  }

  window.addEventListener(
    'keydown',
    (e) => {
      const action = actionFor(e);
      if (!action) {
        lastPageInteraction = now();
        resumeFromGesture();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      resumeFromGesture();
      runAction(action);
    },
    true
  );
  // 把同一組按鍵的 keyup/keypress 也攔下，避免網站在放開按鍵時觸發自己的功能
  for (const type of ['keyup', 'keypress']) {
    window.addEventListener(
      type,
      (e) => {
        if (actionFor(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true
    );
  }
  window.addEventListener(
    'pointerdown',
    () => {
      lastPageInteraction = now();
      resumeFromGesture();
    },
    true
  );

  // ---------------------------------------------------------------- 浮動面板

  const overlay = (() => {
    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .vc {
        --accent: #0a84ff;
        --bg: rgba(22, 22, 26, 0.86);
        --fg: #f5f5f7;
        --muted: rgba(245, 245, 247, 0.62);
        --line: rgba(255, 255, 255, 0.14);
        position: absolute; top: 0; left: 0;
        font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang TC", system-ui, sans-serif;
        color: var(--fg);
        pointer-events: auto;
        opacity: 1;
        transition: opacity .18s ease;
        -webkit-user-select: none; user-select: none;
      }
      .vc.right { transform: translateX(-100%); }
      .vc.hidden { opacity: 0; pointer-events: none; }
      .pill {
        all: unset; cursor: pointer;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 9px; border-radius: 999px;
        background: var(--bg); border: 1px solid var(--line);
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        box-shadow: 0 2px 10px rgba(0,0,0,.3);
        font-variant-numeric: tabular-nums; font-weight: 650; white-space: nowrap;
      }
      .right .pill { float: right; }
      .pill .tag { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,.16); }
      .pill .tag.vol.boost { background: #ff9f0a; color: #1d1d1f; }
      .pill .tag.mono { background: var(--accent); color: #fff; }
      .pill .tag[hidden] { display: none; }
      .body {
        display: none; clear: both;
        margin-top: 6px; width: 252px; padding: 10px 12px 12px;
        border-radius: 14px; background: var(--bg); border: 1px solid var(--line);
        -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
        box-shadow: 0 10px 30px rgba(0,0,0,.4);
      }
      .vc.open .body { display: block; }
      .label { display: flex; justify-content: space-between; align-items: baseline; color: var(--muted); font-size: 11px; margin: 2px 0 4px; }
      .label b { color: var(--fg); font-size: 13px; font-variant-numeric: tabular-nums; }
      .label input.num {
        all: unset; box-sizing: border-box; width: 5.5em; margin: -2px -5px -2px 0; padding: 1px 5px;
        border: 1px solid transparent; border-radius: 6px; text-align: right; cursor: text;
        color: var(--fg); font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums;
        -webkit-user-select: text; user-select: text;
      }
      .label input.num:hover { background: rgba(255,255,255,.1); }
      .label input.num:focus { background: rgba(0,0,0,.35); border-color: var(--accent); }
      .label input.num.invalid { border-color: #ff453a; }
      .vol.boost .label input.num { color: #ff9f0a; }
      .row { display: flex; align-items: center; gap: 8px; }
      .section + .section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
      button.icon {
        all: unset; cursor: pointer; flex: none;
        width: 24px; height: 24px; border-radius: 7px; text-align: center; line-height: 24px;
        background: rgba(255,255,255,.1); font-size: 15px; font-weight: 600;
      }
      button.icon:hover { background: rgba(255,255,255,.2); }
      input[type=range] {
        -webkit-appearance: none; appearance: none; flex: 1; min-width: 0; height: 4px; margin: 0;
        border-radius: 2px; outline: none; cursor: pointer;
        background: linear-gradient(to right, var(--accent) 0 var(--p, 50%), rgba(255,255,255,.2) var(--p, 50%) 100%);
      }
      input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
        background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4);
      }
      .vol input[type=range] { --accent: #30d158; }
      .vol.boost input[type=range] { --accent: #ff9f0a; }
      .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
      .chips button {
        all: unset; cursor: pointer; padding: 2px 7px; border-radius: 6px;
        background: rgba(255,255,255,.08); color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums;
      }
      .chips button:hover { background: rgba(255,255,255,.18); color: var(--fg); }
      .chips button.on { background: var(--accent); color: #fff; }
      .switch { position: relative; width: 34px; height: 20px; flex: none; cursor: pointer; }
      .switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
      .switch span { position: absolute; inset: 0; border-radius: 10px; background: rgba(255,255,255,.22); transition: background .15s; pointer-events: none; }
      .switch span::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
      .switch input:checked + span { background: var(--accent); }
      .switch input:checked + span::after { transform: translateX(14px); }
      .grow { flex: 1; }
      button.reset {
        all: unset; cursor: pointer; padding: 3px 9px; border-radius: 7px;
        background: rgba(255,255,255,.1); font-size: 11px;
      }
      button.reset:hover { background: rgba(255,255,255,.2); }
      .notice { display: none; margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: rgba(255,159,10,.16); color: #ffd28a; font-size: 11px; }
      .notice.show { display: block; }
    `;

    const RATE_CHIPS = [0.5, 1, 1.5, 2, 3, 4, 8, 16];
    let host = null;
    let root = null;
    let $ = {};
    let target = null;
    let open = false;
    let hoverPanel = false;
    let lastMoveInVideo = -1e9;
    let flashUntil = 0;
    let rafId = 0;
    let closeTimer = 0;
    let dragging = false;

    const enabled = () => (settings.uiMode === 'both' || settings.uiMode === 'overlay') && !overlayHiddenByKey;

    function build() {
      host = document.createElement('vc-video-controller');
      // 不用 `all: initial`：它的簡寫會蓋過之後用 setProperty 設定的 top/left
      for (const [k, v] of Object.entries({
        position: 'fixed', 'z-index': '2147483647', top: '0', left: '0', right: 'auto', bottom: 'auto',
        width: '0', height: '0', margin: '0', padding: '0', border: '0', display: 'block',
        transform: 'none', filter: 'none', opacity: '1', visibility: 'visible', 'pointer-events': 'none',
        contain: 'none', overflow: 'visible',
      })) {
        host.style.setProperty(k, v, 'important');
      }
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>${CSS}</style>
        <div class="vc hidden">
          <button class="pill" title="Video Controller">
            <span class="rate">1×</span>
            <span class="tag vol" hidden></span>
            <span class="tag mono" hidden>MONO</span>
          </button>
          <div class="body">
            <div class="section">
              <div class="label"><span>播放速度</span><b class="rate-val">1×</b></div>
              <div class="row">
                <button class="icon" data-act="slower" title="減速">−</button>
                <input type="range" class="rate-slider" min="0" max="1" step="0.001">
                <button class="icon" data-act="faster" title="加速">+</button>
              </div>
              <div class="chips">${RATE_CHIPS.map((r) => `<button data-rate="${r}">${r}×</button>`).join('')}</div>
            </div>
            <div class="section vol">
              <div class="label"><span>音量</span><input class="num vol-val" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="音量百分比，可直接輸入" title="點一下可直接輸入音量（可超過 400%）"></div>
              <div class="row">
                <button class="icon" data-act="volDown" title="音量 −">−</button>
                <input type="range" class="vol-slider" min="0" max="400" step="5">
                <button class="icon" data-act="volUp" title="音量 +">+</button>
              </div>
            </div>
            <div class="section">
              <div class="row">
                <label class="switch"><input type="checkbox" class="mono-toggle"><span></span></label>
                <span class="grow">立體聲轉單聲道</span>
                <button class="reset" data-act="resetAll">全部重設</button>
              </div>
              <div class="notice"></div>
            </div>
          </div>
        </div>`;
      const q = (s) => root.querySelector(s);
      $ = {
        panel: q('.vc'), pill: q('.pill'), pillRate: q('.pill .rate'), pillBoost: q('.tag.vol'), pillMono: q('.tag.mono'),
        rateVal: q('.rate-val'), rateSlider: q('.rate-slider'), chips: [...root.querySelectorAll('.chips button')],
        volSection: q('.section.vol'), volVal: q('.vol-val'), volSlider: q('.vol-slider'), mono: q('.mono-toggle'), notice: q('.notice'),
      };

      // 不讓點擊穿透到網頁（例如點面板時影片被暫停）
      for (const t of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'contextmenu', 'keydown', 'keyup', 'keypress']) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }

      $.panel.addEventListener('pointerenter', () => {
        hoverPanel = true;
        clearTimeout(closeTimer);
        open = true;
        update();
      });
      $.panel.addEventListener('pointerleave', () => {
        hoverPanel = false;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
          if (!hoverPanel && !dragging && !isEditing()) {
            open = false;
            update();
          }
        }, 350);
      });
      $.pill.addEventListener('click', () => {
        open = !open;
        update();
      });
      root.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.rate) setState({ rate: Number(btn.dataset.rate) });
        else if (btn.dataset.act) runAction(btn.dataset.act);
      });
      $.rateSlider.addEventListener('input', () => setState({ rate: VC.sliderToRate(Number($.rateSlider.value)) }));
      $.volSlider.addEventListener('input', () => setState({ volume: Number($.volSlider.value) / 100 }));
      $.mono.addEventListener('change', () => setState({ mono: $.mono.checked }));

      // 音量數字可直接輸入（例如 250 或 800%），不受滑桿 400% 的限制
      const commitVolume = () => {
        const v = VC.parseVolumeInput($.volVal.value);
        $.volVal.classList.toggle('invalid', v == null);
        if (v != null && Math.abs(v - currentVolume()) > 0.001) setState({ volume: v });
        $.volVal.value = VC.formatVolume(v ?? currentVolume());
      };
      // 點進輸入框時全選；Safari 放開滑鼠時會取消選取，所以擋掉那次 mouseup
      let selectOnMouseUp = false;
      $.volVal.addEventListener('focus', () => {
        $.volVal.classList.remove('invalid');
        $.volVal.select();
        selectOnMouseUp = true;
      });
      $.volVal.addEventListener('mouseup', (e) => {
        if (selectOnMouseUp) e.preventDefault();
        selectOnMouseUp = false;
      });
      $.volVal.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          $.volVal.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          $.volVal.value = VC.formatVolume(currentVolume());
          $.volVal.blur();
        }
      });
      $.volVal.addEventListener('blur', () => {
        commitVolume();
        if (!hoverPanel) open = false; // 打完字後滑鼠已不在面板上 → 收起
        update();
      });

      for (const s of [$.rateSlider, $.volSlider]) {
        s.addEventListener('pointerdown', () => (dragging = true));
        s.addEventListener('pointerup', () => (dragging = false));
        s.addEventListener('blur', () => (dragging = false));
      }
      // 在面板上用滾輪微調
      $.rateSlider.addEventListener('wheel', (e) => {
        e.preventDefault();
        runAction(e.deltaY < 0 ? 'faster' : 'slower');
      }, { passive: false });
      $.volSlider.addEventListener('wheel', (e) => {
        e.preventDefault();
        runAction(e.deltaY < 0 ? 'volUp' : 'volDown');
      }, { passive: false });

      render();
    }

    const NOTICE_TEXT = {
      cors: '這個影片來自其他網域且未開放 CORS，無法放大音量或轉單聲道（倍速仍可使用）。',
      gesture: 'Safari 需要先在網頁上點一下，才能啟用音量放大／單聲道。點一下影片畫面即可。',
      inuse: '這個網站已自行處理影片音訊，無法再套用音量放大／單聲道。',
      rate: 'Safari 不允許這個影片使用此倍速。',
      mse: '這個網站用串流方式播放，Safari 不允許擴充功能處理這類影片的聲音，所以無法放大超過 100% 或轉單聲道（0–100% 仍可調整）。',
      noaudio: 'Safari 沒有把這個影片的聲音交給擴充功能處理，無法放大超過 100% 或轉單聲道（0–100% 仍可調整）。',
    };

    function render() {
      if (!root) return;
      const r = state.rate;
      $.pillRate.textContent = VC.formatRate(r);
      const vol = currentVolume();
      const boosted = volumeTouched && Math.abs(vol - 1) > 0.001;
      $.pillBoost.hidden = !boosted;
      $.pillBoost.classList.toggle('boost', vol > 1.001);
      $.pillBoost.textContent = VC.formatVolume(vol);
      $.pillMono.hidden = !state.mono;
      $.rateVal.textContent = VC.formatRate(r);
      if (!isEditing()) $.volVal.value = VC.formatVolume(vol);
      $.volSection.classList.toggle('boost', vol > 1.001);
      if (!dragging) $.rateSlider.value = VC.rateToSlider(r);
      if (!dragging) $.volSlider.value = Math.round(vol * 100);
      $.rateSlider.style.setProperty('--p', VC.rateToSlider(r) * 100 + '%');
      $.volSlider.style.setProperty('--p', VC.volumeSliderPercent(vol));
      $.mono.checked = state.mono;
      for (const b of $.chips) b.classList.toggle('on', Math.abs(Number(b.dataset.rate) - r) < 0.001);
      const text = notice && NOTICE_TEXT[notice];
      $.notice.textContent = text || '';
      $.notice.classList.toggle('show', !!text);
    }

    function fullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    const isEditing = () => !!root && root.activeElement === $.volVal;

    function visible() {
      if (!enabled() || !target) return false;
      if (open || hoverPanel || dragging || isEditing() || !settings.overlayAutoHide) return true;
      if (now() < flashUntil) return true;
      return now() - lastMoveInVideo < 2500;
    }

    // 決定要跟著哪個影片、要不要顯示、放在哪裡
    function update() {
      if (!enabled()) {
        if (host) host.remove();
        stopLoop();
        return;
      }
      const t = primaryMedia({ videoOnly: true });
      target = t && isLargeEnough(t) ? t : null;
      if (!target) {
        if (host) $.panel.classList.add('hidden');
        stopLoop();
        return;
      }
      if (!host) build();
      const fs = fullscreenElement();
      let parent = document.documentElement;
      if (fs) {
        // 影片本身全螢幕（Safari 原生播放器）時無法疊加任何東西
        if (fs === target || !fs.contains(target)) parent = null;
        else parent = fs;
      }
      if (!parent) {
        $.panel.classList.add('hidden');
        stopLoop();
        return;
      }
      if (host.parentNode !== parent) parent.appendChild(host);
      const show = visible();
      $.panel.classList.toggle('hidden', !show);
      $.panel.classList.toggle('open', show && open);
      $.panel.classList.toggle('right', settings.overlayPosition === 'top-right');
      position();
      if (show) startLoop();
      else stopLoop();
    }

    function isLargeEnough(el) {
      const r = el.getBoundingClientRect();
      return r.width >= 160 && r.height >= 90 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    }

    function position() {
      if (!host || !target) return;
      const r = target.getBoundingClientRect();
      const top = Math.max(r.top, 0) + 10;
      const left = settings.overlayPosition === 'top-right' ? Math.min(r.right, innerWidth) - 10 : Math.max(r.left, 0) + 10;
      host.style.setProperty('top', top + 'px', 'important');
      host.style.setProperty('left', left + 'px', 'important');
    }

    function loop() {
      position();
      if (!visible()) {
        rafId = 0;
        update();
        return;
      }
      rafId = requestAnimationFrame(loop);
    }
    function startLoop() {
      if (!rafId) rafId = requestAnimationFrame(loop);
    }
    function stopLoop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    document.addEventListener(
      'mousemove',
      (e) => {
        if (!target || !enabled()) return;
        const r = target.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          const wasVisible = visible();
          lastMoveInVideo = now();
          if (!wasVisible) update();
        }
      },
      { capture: true, passive: true }
    );
    for (const t of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(t, () => setTimeout(update, 60));

    return {
      refresh: update,
      render,
      isEditing,
      flash() {
        flashUntil = now() + 1500;
        update();
      },
    };
  })();

  // ---------------------------------------------------------------- 與工具列面板溝通

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('vc:')) return false;
    let p = Promise.resolve();
    if (msg.type === 'vc:set' && msg.patch) p = setState(msg.patch);
    else if (msg.type === 'vc:reset') p = resetState();
    else if (msg.type === 'vc:toggleOverlay') {
      overlayHiddenByKey = !overlayHiddenByKey;
      overlay.refresh();
    }
    // 沒有影片的 frame 不回應，讓真正有影片的 frame 來回答
    if (!hasMedia()) return false;
    p.then(() => sendResponse(report()));
    return true;
  });

  // ---------------------------------------------------------------- 啟動

  VC.loadSettings().then((s) => {
    settings = s;
    overlay.refresh();
  });
  VC.onSettingsChanged((s) => {
    settings = s;
    overlay.refresh();
    overlay.render();
  });

  // 「不記住設定」：網址換頁（含 YouTube 這類單頁應用切換影片）就回到預設值
  const pageKey = () => location.origin + location.pathname + location.search;
  let lastPageKey = pageKey();

  function tick() {
    const key = pageKey();
    if (key !== lastPageKey) {
      lastPageKey = key;
      lastCustomRate = 2;
      if (state.rate !== 1 || volumeTouched || state.mono) resetState();
    }
    scan();
    overlay.refresh();
  }

  function start() {
    scan();
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n instanceof HTMLMediaElement) track(n);
          else if (n.querySelectorAll && n.firstElementChild) n.querySelectorAll('video, audio').forEach(track);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(tick, 1000);
    setInterval(checkGraphs, CHECK_MS);
    setInterval(deepScan, 4000);
    addEventListener('resize', () => overlay.refresh(), { passive: true });
    addEventListener('scroll', () => overlay.refresh(), { passive: true, capture: true });
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
