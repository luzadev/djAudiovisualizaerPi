// Network shim that recreates the Electron `window.djv` API over WebSocket + HTTP,
// so the visual engine (output.js) and the control UI run unchanged in a browser.
// The page sets window.DJV_ROLE = 'output' | 'control' before loading this file.
(function () {
  const role = window.DJV_ROLE || 'control';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws = null, ready = false;
  const queue = [];
  const ctlCbs = [], rptCbs = [], statusCbs = [];
  const setStatus = (ok) => statusCbs.forEach(cb => cb(ok));

  function connect() {
    ws = new WebSocket(proto + '://' + location.host + '/?role=' + role);
    ws.onopen = () => { ready = true; setStatus(true); while (queue.length) ws.send(queue.shift()); };
    ws.onclose = () => { ready = false; setStatus(false); setTimeout(connect, 1000); }; // survive server restarts
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
    const handle = (txt) => {
      let m; try { m = JSON.parse(txt); } catch (e) { return; }
      if (m.ch === 'ctl') ctlCbs.forEach(cb => cb(m.msg));
      else if (m.ch === 'rpt') rptCbs.forEach(cb => cb(m.msg));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') handle(ev.data);
      else if (ev.data && typeof ev.data.text === 'function') ev.data.text().then(handle); // Blob
      else handle(String(ev.data));
    };
  }
  connect();

  function rawSend(obj) {
    const s = JSON.stringify(obj);
    if (ready && ws.readyState === 1) ws.send(s); else queue.push(s);
  }

  async function post(url, body, raw) {
    const opts = { method: 'POST' };
    if (raw) { opts.headers = { 'Content-Type': 'application/octet-stream' }; opts.body = body; }
    else if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    try { return await r.json(); } catch (e) { return null; }
  }

  window.djv = {
    role,
    // control -> output
    send: (msg) => rawSend({ ch: 'ctl', msg }),
    onControl: (cb) => ctlCbs.push(cb),
    // output -> control
    report: (msg) => rawSend({ ch: 'rpt', msg }),
    onReport: (cb) => rptCbs.push(cb),
    onStatus: (cb) => { statusCbs.push(cb); cb(ready); },
    // recording (output side streams chunks to the server)
    recStart: () => post('/api/rec/start'),
    recChunk: (bytes) => post('/api/rec/chunk', bytes, true),
    recStop: (opts) => post('/api/rec/stop', opts || {}),
    // helpers used by the control UI
    listMedia: () => fetch('/api/media').then(r => r.json()),
    listSvgs: () => fetch('/api/svgs').then(r => r.json()),
    loadState: (key) => fetch('/api/state/' + key).then(r => r.json()),
    saveState: (key, data) => post('/api/state/' + key, data),
    peaks: (file, buckets) => fetch('/api/peaks?file=' + encodeURIComponent(file) + '&buckets=' + (buckets || 400)).then(r => r.json())
  };
})();
