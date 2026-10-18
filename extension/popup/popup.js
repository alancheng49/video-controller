(() => {
  const { api } = VC;
  const $ = (id) => document.getElementById(id);

  const els = {
    status: $('status'), controls: $('controls'), overlayOnly: $('overlayOnly'),
    rate: $('rate'), rateVal: $('rateVal'), rateChips: $('rateChips'),
    volume: $('volume'), volVal: $('volVal'), volSection: document.querySelector('section.vol'),
    mono: $('mono'), notice: $('notice'), shortcutHint: $('shortcutHint'),
  };

  const NOTICE_TEXT = {
    cors: '這個影片來自其他網域且未開放 CORS，Safari 不允許處理它的音訊，因此無法放大音量或轉單聲道（倍速仍可使用）。',
    gesture: 'Safari 需要你先在網頁上互動一次，才能啟用音量放大／單聲道：請點一下影片畫面，設定會自動套用。',
    inuse: '這個網站已自行處理影片音訊，無法再套用音量放大／單聲道。',
    rate: 'Safari 不允許這個影片使用此倍速，請換一個速度試試。',
    mse: '這個網站用串流方式播放（例如 YouTube），Safari 不允許擴充功能處理這類影片的聲音，所以無法放大超過 100% 或轉單聲道。0–100% 的音量仍可正常調整。',
    noaudio: 'Safari 沒有把這個影片的聲音交給擴充功能處理，因此無法放大超過 100% 或轉單聲道。0–100% 的音量仍可正常調整。',
  };

  let tabId = null;
  let state = { ...VC.DEFAULT_STATE };
  let settings = VC.mergeSettings(null);
  let dragging = false;

  // ---------------------------------------------------------------- 與分頁溝通

  async function send(msg) {
    if (tabId == null) return { error: true };
    try {
      const res = await api.tabs.sendMessage(tabId, msg);
      return res || { hasMedia: false };
    } catch (e) {
      // Chrome：內容腳本在，但沒有任何 frame 有影片可回應
      if (/message port closed|before a response/i.test(String(e && e.message))) return { hasMedia: false };
      // 內容腳本不存在：通常是尚未授權此網站，或是瀏覽器內建頁面
      return { error: true };
    }
  }

  async function command(patch) {
    Object.assign(state, patch);
    render(); // 先更新畫面，讓操作感覺即時
    const res = await send({ type: 'vc:set', patch });
    apply(res);
  }

  function apply(res) {
    if (res && res.hasMedia) {
      state = { rate: res.rate, volume: res.volume, mono: res.mono };
    }
    renderStatus(res);
    if (!dragging) render();
    const text = res && res.notice && NOTICE_TEXT[res.notice];
    els.notice.hidden = !text;
    els.notice.textContent = text || '';
  }

  // ---------------------------------------------------------------- 畫面

  function renderStatus(res) {
    const s = els.status;
    s.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    s.append(dot);
    let disabled = false;
    if (!res || res.error) {
      s.append('無法存取這個頁面。請在 Safari 允許「Video Controller」存取此網站後重新整理頁面。');
      disabled = true;
    } else if (!res.hasMedia) {
      s.append('這個頁面沒有偵測到影片或音訊');
      disabled = true;
    } else {
      dot.classList.toggle('playing', res.playing);
      const b = document.createElement('b');
      b.textContent = res.host || '本頁';
      const kind = res.isVideo ? '影片' : '音訊';
      s.append(b, `・${res.playing ? '播放中' : '已暫停'}的${kind}` + (res.mediaCount > 1 ? `（共 ${res.mediaCount} 個）` : ''));
    }
    els.controls.classList.toggle('disabled', disabled);
  }

  function render() {
    const { rate, volume, mono } = state;
    els.rateVal.textContent = VC.formatRate(rate);
    els.volVal.textContent = VC.formatVolume(volume);
    if (!dragging) {
      els.rate.value = VC.rateToSlider(rate);
      els.volume.value = Math.round(volume * 100);
    }
    els.rate.style.setProperty('--p', VC.rateToSlider(rate) * 100 + '%');
    els.volume.style.setProperty('--p', (volume / VC.LIMITS.volumeMax) * 100 + '%');
    els.volSection.classList.toggle('boost', volume > 1.001);
    els.mono.checked = mono;
    for (const b of document.querySelectorAll('[data-rate]')) b.classList.toggle('on', Math.abs(Number(b.dataset.rate) - rate) < 0.001);
    for (const b of document.querySelectorAll('[data-volume]')) b.classList.toggle('on', Math.round(volume * 100) === Number(b.dataset.volume));
  }

  function buildStatic() {
    for (const r of VC.RATE_PRESETS) {
      const b = document.createElement('button');
      b.dataset.rate = r;
      b.textContent = r + '×';
      els.rateChips.append(b);
    }
    // 倍速滑桿是對數刻度，刻度文字要放在對應位置
    for (const b of document.querySelectorAll('.rate-ticks button')) {
      b.style.left = VC.rateToSlider(Number(b.dataset.rate)) * 100 + '%';
    }
    for (const b of document.querySelectorAll('.vol-ticks button')) {
      b.style.left = (Number(b.dataset.volume) / (VC.LIMITS.volumeMax * 100)) * 100 + '%';
    }
  }

  function renderShortcutHint() {
    const k = settings.keys;
    els.shortcutHint.innerHTML = '';
    if (!settings.shortcutsEnabled) return;
    const add = (combo, label) => {
      if (!combo) return;
      const kbd = document.createElement('kbd');
      kbd.textContent = VC.formatCombo(combo);
      els.shortcutHint.append(kbd, ` ${label}  `);
    };
    add(k.slower, '減速');
    add(k.faster, '加速');
    add(k.resetSpeed, '重設');
  }

  function renderMode() {
    const overlayOnly = settings.uiMode === 'overlay';
    els.controls.hidden = overlayOnly;
    els.overlayOnly.hidden = !overlayOnly;
  }

  // ---------------------------------------------------------------- 事件

  els.rate.addEventListener('input', () => command({ rate: VC.sliderToRate(Number(els.rate.value)) }));
  els.volume.addEventListener('input', () => command({ volume: Number(els.volume.value) / 100 }));
  for (const s of [els.rate, els.volume]) {
    s.addEventListener('pointerdown', () => (dragging = true));
    s.addEventListener('pointerup', () => {
      dragging = false;
      render();
    });
  }
  els.rate.addEventListener('wheel', (e) => {
    e.preventDefault();
    act(e.deltaY < 0 ? 'faster' : 'slower');
  }, { passive: false });
  els.volume.addEventListener('wheel', (e) => {
    e.preventDefault();
    act(e.deltaY < 0 ? 'volUp' : 'volDown');
  }, { passive: false });
  els.mono.addEventListener('change', () => command({ mono: els.mono.checked }));
  $('resetAll').addEventListener('click', async () => {
    state = { ...VC.DEFAULT_STATE };
    render();
    apply(await send({ type: 'vc:reset' }));
  });
  $('openOptions').addEventListener('click', () => {
    api.runtime.openOptionsPage();
    window.close();
  });
  $('useBoth').addEventListener('click', async () => {
    settings.uiMode = 'both';
    await VC.saveSettings(settings);
    renderMode();
    refresh();
  });

  function act(action) {
    const step = settings.speedStep;
    const vStep = settings.volumeStep / 100;
    if (action === 'faster') command({ rate: VC.stepRate(state.rate, +1, step) });
    if (action === 'slower') command({ rate: VC.stepRate(state.rate, -1, step) });
    if (action === 'volUp') command({ volume: VC.clampVolume(state.volume + vStep) });
    if (action === 'volDown') command({ volume: VC.clampVolume(state.volume - vStep) });
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.rate) command({ rate: Number(b.dataset.rate) });
    else if (b.dataset.volume) command({ volume: Number(b.dataset.volume) / 100 });
    else if (b.dataset.act) act(b.dataset.act);
  });

  // ---------------------------------------------------------------- 啟動

  async function refresh() {
    if (dragging) return;
    apply(await send({ type: 'vc:get' }));
  }

  async function init() {
    buildStatic();
    settings = await VC.loadSettings();
    renderMode();
    renderShortcutHint();
    render();
    try {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      tabId = tab ? tab.id : null;
    } catch {}
    await refresh();
    // 定期同步，讓用快捷鍵或浮動面板做的變更也反映在這裡
    setInterval(refresh, 1000);
  }

  init();
})();
