// 開發用：在一般網頁中模擬擴充功能 API，讓 popup / 設定頁 / content script 可以在瀏覽器裡直接測試。
(() => {
  if (window.browser) return;
  const KEY = 'vc-dev-storage';
  const msgListeners = [];
  const changeListeners = [];
  const read = () => JSON.parse(localStorage.getItem(KEY) || '{}');

  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    const o = JSON.parse(e.oldValue || '{}');
    const n = JSON.parse(e.newValue || '{}');
    const changes = {};
    for (const k in n) changes[k] = { oldValue: o[k], newValue: n[k] };
    changeListeners.forEach((f) => f(changes, 'local'));
  });

  window.browser = {
    storage: {
      local: {
        async get(k) {
          const d = read();
          return typeof k === 'string' ? (k in d ? { [k]: d[k] } : {}) : d;
        },
        async set(obj) {
          const d = read();
          const changes = {};
          for (const k in obj) {
            changes[k] = { oldValue: d[k], newValue: obj[k] };
            d[k] = obj[k];
          }
          localStorage.setItem(KEY, JSON.stringify(d));
          changeListeners.forEach((f) => f(changes, 'local'));
        },
      },
      onChanged: { addListener: (f) => changeListeners.push(f) },
    },
    runtime: {
      onMessage: { addListener: (f) => msgListeners.push(f) },
      openOptionsPage() {
        window.open('/extension/options/options.html', '_blank');
      },
    },
    tabs: {
      async query() {
        return [{ id: 1 }];
      },
      sendMessage(_tabId, msg) {
        const target = window.parent !== window ? window.parent : window;
        if (!target.__vcDispatch) return Promise.reject(new Error('Could not establish connection'));
        return target.__vcDispatch(msg);
      },
    },
  };

  window.__vcDispatch = (msg) =>
    new Promise((resolve) => {
      let done = false;
      const send = (r) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      let pending = false;
      for (const f of msgListeners) if (f(msg, {}, send) === true) pending = true;
      if (!pending) send(undefined);
    });
})();
