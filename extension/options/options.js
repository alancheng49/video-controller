(() => {
  const $ = (id) => document.getElementById(id);
  let settings = VC.mergeSettings(null);
  let recording = null; // 正在錄製快捷鍵的動作 id
  let savedTimer = 0;

  async function save() {
    await VC.saveSettings(settings);
    const el = $('saved');
    el.textContent = '已儲存';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (el.textContent = ''), 1500);
  }

  function render() {
    document.querySelectorAll('input[name=uiMode]').forEach((r) => (r.checked = r.value === settings.uiMode));
    document.querySelectorAll('input[name=overlayPosition]').forEach((r) => (r.checked = r.value === settings.overlayPosition));
    $('overlayAutoHide').checked = settings.overlayAutoHide;
    $('shortcutsEnabled').checked = settings.shortcutsEnabled;
    $('speedStep').value = String(settings.speedStep);
    $('volumeStep').value = String(settings.volumeStep);
    $('overlaySettings').classList.toggle('dim', settings.uiMode === 'popup');
    renderKeys();
  }

  function renderKeys() {
    const table = $('keyTable');
    table.classList.toggle('dim', !settings.shortcutsEnabled);
    table.textContent = '';
    const counts = {};
    for (const k of Object.values(settings.keys)) if (k) counts[k] = (counts[k] || 0) + 1;

    for (const { id, label } of VC.ACTIONS) {
      const combo = settings.keys[id];
      const name = document.createElement('div');
      name.className = 'act';
      name.textContent = label;

      const btn = document.createElement('button');
      btn.className = 'key-btn';
      btn.dataset.action = id;
      if (recording === id) {
        btn.classList.add('recording');
        btn.textContent = '請按下按鍵…';
      } else {
        btn.textContent = VC.formatCombo(combo);
        if (combo && counts[combo] > 1) btn.classList.add('conflict');
      }
      btn.addEventListener('click', () => {
        recording = recording === id ? null : id;
        renderKeys();
      });

      const clear = document.createElement('button');
      clear.className = 'clear-btn';
      clear.title = '清除';
      clear.setAttribute('aria-label', `清除「${label}」快捷鍵`);
      clear.textContent = '✕';
      clear.addEventListener('click', () => {
        settings.keys[id] = '';
        recording = null;
        save();
        renderKeys();
      });

      table.append(name, btn, clear);
    }
    if (Object.values(counts).some((n) => n > 1)) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = '有兩個動作使用相同按鍵，只有第一個會生效。';
      table.append(warn);
    }
  }

  // 錄製快捷鍵
  document.addEventListener(
    'keydown',
    (e) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // 等待主要按鍵
      if (e.code === 'Escape') {
        recording = null;
      } else {
        settings.keys[recording] = VC.comboFromEvent(e);
        recording = null;
        save();
      }
      renderKeys();
    },
    true
  );

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'uiMode') settings.uiMode = t.value;
    else if (t.name === 'overlayPosition') settings.overlayPosition = t.value;
    else if (t.id === 'overlayAutoHide') settings.overlayAutoHide = t.checked;
    else if (t.id === 'shortcutsEnabled') settings.shortcutsEnabled = t.checked;
    else if (t.id === 'speedStep') settings.speedStep = Number(t.value);
    else if (t.id === 'volumeStep') settings.volumeStep = Number(t.value);
    else return;
    save();
    render();
  });

  $('restoreDefaults').addEventListener('click', () => {
    settings = VC.mergeSettings(null);
    recording = null;
    save();
    render();
  });

  VC.loadSettings().then((s) => {
    settings = s;
    render();
  });
})();
