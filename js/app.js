/*
 * The 3DSConvert page: builds the worker, drives the inputs, the processing
 * recipe, the preview and the output, and keeps the log. Everything heavy
 * runs in the worker (js/worker.js); this file only moves summaries, slices
 * and choices.
 */
'use strict';
(async function () {
  const $ = id => document.getElementById(id);
  const logEl = $('log');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // An icon from the sprite in index.html.
  function icon(name, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', size ? `i s${size}` : 'i');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(cls, label, iconName, title) {
    const b = el('button', cls);
    b.type = 'button';
    if (iconName) b.appendChild(icon(iconName, 15));
    if (label) b.appendChild(document.createTextNode(label));
    if (title) {
      b.title = title;
      if (!label) b.setAttribute('aria-label', title);
    }
    return b;
  }

  // ------------------------------------------------------------ log
  const LEVEL_ICON = { info: 'info', ok: 'check', warn: 'alert', err: 'alert' };
  function log(msg, level) {
    level = level || (/^(Note|Warning)\b/.test(msg) ? 'warn' : 'info');
    const line = el('div', level);
    const lv = el('span', 'lv');
    lv.appendChild(icon(LEVEL_ICON[level] || 'info', 15));
    line.append(el('time', null, new Date().toTimeString().slice(0, 8) + ' '), lv, el('span', 'msg', msg));
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    if (level === 'err' || (level === 'ok' && /^Wrote /.test(msg))) toast(msg.replace(/^Error: /, ''), level);
  }

  // Errors and finished files also pop up, bottom right, for a while.
  function toast(msg, level) {
    const box = $('toasts');
    const t = el('div', 'toast ' + level);
    const mark = el('span', 'ti');
    mark.appendChild(icon(level === 'err' ? 'alert' : 'check', 16));
    const close = button('btn ghost icon small', '', 'x', 'Dismiss');
    close.addEventListener('click', () => t.remove());
    t.append(mark, el('p', null, msg), close);
    box.appendChild(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => t.remove(), level === 'err' ? 12000 : 6000);
  }
  function clearLog() { logEl.textContent = ''; }
  function logNotes(notes) {
    for (const note of notes || []) log('Note: ' + note, 'warn');
  }
  const logText = () => Array.from(logEl.children, d => d.textContent).join('\n') + '\n';
  $('copyLog').addEventListener('click', () => {
    navigator.clipboard.writeText(logText()).then(() => log('Log copied to the clipboard.', 'ok'),
      () => log('The browser blocks the clipboard here; use Download instead.', 'warn'));
  });
  $('saveLog').addEventListener('click', () => download([logText()], '3dsconvert_log.txt', 'text/plain'));

  // ------------------------------------------------------------ formatting
  function fmtCell(c) {
    return c.lengths.map(x => x.toPrecision(6)).join(' ') + ' / ' + c.angles.map(x => x.toPrecision(4)).join(' ');
  }
  function fmtBytes(n) {
    return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB'
      : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB';
  }
  // Short numbers for axis ranges and readouts; a true minus sign.
  function fmtNum(x, digits) {
    if (!Number.isFinite(x)) return String(x);
    if (Math.abs(x) < 1e-9) x = 0;                  // rounding noise of grid coordinates
    const t = Math.abs(x) >= 1e4 || (x !== 0 && Math.abs(x) < 1e-3) ? x.toExponential(2) : String(+x.toFixed(digits === undefined ? 3 : digits));
    return t.replace(/^-/, '−');
  }
  const fmtInt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  // A typed number, with either minus sign; NaN when empty or not a number.
  const parseNum = text => {
    const t = String(text).trim().replace(/−/g, '-');
    return t === '' ? NaN : Number(t);
  };
  // n significant digits, a true minus sign.
  const sig = (x, n) => (Number.isFinite(x) ? String(+x.toPrecision(n || 3)).replace(/^-/, '−') : String(x));

  // ------------------------------------------------------------ theme
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const currentTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
  function showTheme() {
    const dark = currentTheme() === 'dark';
    $('themeBtn').setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
    $('themeBtn').replaceChildren(icon(dark ? 'sun' : 'moon'));
  }
  $('themeBtn').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('3dsconvert-theme', next);
    } catch (_) {
      // the choice is not kept
    }
    showTheme();
    redrawPreview();
  });
  darkQuery.addEventListener('change', () => {
    showTheme();
    redrawPreview();
  });
  showTheme();

  // ------------------------------------------------------------ layout
  // The panels' columns and order, the first column's width, the log's
  // height and which side the columns are on: changed by dragging (or the
  // keyboard) and kept in this browser.
  const LAYOUT_KEY = '3dsconvert-layout';
  const workspace = document.querySelector('.workspace');
  const COLUMNS = [document.querySelector('.flow'), document.querySelector('.side')];
  const PANELS = ['dataCard', 'cellCard', 'procCard', 'outCard', 'previewCard', 'logCard'];
  const defaultLayout = () => ({
    cols: [['dataCard', 'cellCard', 'procCard', 'outCard'], ['previewCard', 'logCard']], flowW: null, logH: null, swapped: false,
  });
  let layout = defaultLayout();
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    const ids = saved && Array.isArray(saved.cols) && saved.cols.length === 2 && saved.cols.every(Array.isArray) ? saved.cols.flat() : [];
    if (ids.length === PANELS.length && PANELS.every(id => ids.includes(id))) {
      const size = (x, lo, hi) => (Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x) : null);
      layout = { cols: saved.cols, flowW: size(saved.flowW, 280, 4000), logH: size(saved.logH, 80, 4000), swapped: !!saved.swapped };
    }
  } catch (_) {
    // no saved layout
  }
  function saveLayout() {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch (_) {
      // the layout is not kept
    }
  }
  const setVar = (node, name, px) => (px ? node.style.setProperty(name, `${px}px`) : node.style.removeProperty(name));
  function applyLayout() {
    layout.cols.forEach((ids, c) => ids.forEach(id => COLUMNS[c].appendChild($(id))));
    setVar(workspace, '--flow-w', layout.flowW);
    setVar(workspace, '--log-h', layout.logH);
    workspace.classList.toggle('swapped', layout.swapped);
    $('colSplit').setAttribute('aria-valuenow', String(Math.round(COLUMNS[0].getBoundingClientRect().width)));
  }
  // The order as the page shows it, after a move.
  function readLayout() {
    layout.cols = COLUMNS.map(col => Array.from(col.children).filter(n => PANELS.includes(n.id)).map(n => n.id));
    saveLayout();
  }
  applyLayout();

  // Dragging a bar: onMove gets the pointer's offset from where it started.
  function dragBar(bar, onStart, onMove) {
    bar.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const x0 = ev.clientX, y0 = ev.clientY, start = onStart();
      bar.classList.add('dragging');
      try {
        bar.setPointerCapture(ev.pointerId);
      } catch (_) {
        // not a live pointer (synthetic events)
      }
      const move = e => onMove(start, e.clientX - x0, e.clientY - y0);
      const up = () => {
        bar.classList.remove('dragging');
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        saveLayout();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
  }
  // The first column's width, leaving the other at least 360 px.
  function setFlowWidth(w) {
    const room = workspace.clientWidth - 48 - 20;
    layout.flowW = Math.round(Math.max(320, Math.min(room - 360, w)));
    applyLayout();
  }
  const flowWidth = () => COLUMNS[0].getBoundingClientRect().width;
  dragBar($('colSplit'), flowWidth, (w0, dx) => setFlowWidth(w0 + (layout.swapped ? -dx : dx)));
  $('colSplit').addEventListener('keydown', ev => {
    const step = { ArrowLeft: -24, ArrowRight: 24 }[ev.key];
    if (step) {
      ev.preventDefault();
      setFlowWidth(flowWidth() + (layout.swapped ? -step : step));
      saveLayout();
    } else if (ev.key === 'Enter' || ev.key === 'Home') {
      ev.preventDefault();
      layout.flowW = null;
      applyLayout();
      saveLayout();
    }
  });
  $('colSplit').addEventListener('dblclick', () => {
    layout.flowW = null;
    applyLayout();
    saveLayout();
  });
  // The log's height; in the preview's column the preview keeps 380 px.
  function setLogHeight(h) {
    const col = $('logCard').parentElement;
    const room = col === COLUMNS[1] && $('previewCard').parentElement === col && window.innerWidth > 1100
      ? col.clientHeight - 380 - 14 : 2000;
    layout.logH = Math.round(Math.max(90, Math.min(room, h)));
    applyLayout();
  }
  const logHeight = () => $('logCard').getBoundingClientRect().height;
  dragBar($('logSplit'), logHeight, (h0, dx, dy) => setLogHeight(h0 - dy));
  $('logSplit').addEventListener('keydown', ev => {
    const step = { ArrowUp: 24, ArrowDown: -24 }[ev.key];
    if (step) {
      ev.preventDefault();
      setLogHeight(logHeight() + step);
      saveLayout();
    } else if (ev.key === 'Enter' || ev.key === 'Home') {
      ev.preventDefault();
      layout.logH = null;
      applyLayout();
      saveLayout();
    }
  });
  $('logSplit').addEventListener('dblclick', () => {
    layout.logH = null;
    applyLayout();
    saveLayout();
  });

  // Moving a panel: drag its grip onto a column (before the panel under the
  // pointer), or focus the grip and press the arrow keys (up and down within
  // the column, left and right to the other one).
  let movingPanel = null;
  const clearDropMarks = () => {
    for (const n of document.querySelectorAll('.drop-before, .drop-end')) n.classList.remove('drop-before', 'drop-end');
  };
  // The panel of this column the pointer is above the middle of (null: the end).
  const panelAt = (col, y) => Array.from(col.children).find(n => PANELS.includes(n.id) && n !== movingPanel &&
    y < n.getBoundingClientRect().top + n.getBoundingClientRect().height / 2) || null;
  for (const id of PANELS) {
    const panel = $(id), grip = panel.querySelector('.grip');
    grip.addEventListener('dragstart', ev => {
      movingPanel = panel;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', 'panel');
      ev.dataTransfer.setDragImage(panel, 28, 22);
      panel.classList.add('moving');
    });
    grip.addEventListener('dragend', () => {
      movingPanel = null;
      panel.classList.remove('moving');
      clearDropMarks();
    });
    grip.addEventListener('keydown', ev => {
      const col = panel.parentElement, c = COLUMNS.indexOf(col);
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        const sib = ev.key === 'ArrowUp' ? panel.previousElementSibling : panel.nextElementSibling;
        if (!sib || !PANELS.includes(sib.id)) return;
        ev.preventDefault();
        col.insertBefore(panel, ev.key === 'ArrowUp' ? sib : sib.nextElementSibling);
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        const other = COLUMNS[1 - c];
        const toward = (ev.key === 'ArrowRight') !== layout.swapped ? 1 : 0;
        if (COLUMNS.indexOf(other) !== toward) return;
        ev.preventDefault();
        other.appendChild(panel);
      } else {
        return;
      }
      readLayout();
      grip.focus();
      panel.scrollIntoView({ block: 'nearest' });
    });
  }
  for (const col of COLUMNS) {
    col.addEventListener('dragover', ev => {
      if (!movingPanel) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      const at = panelAt(col, ev.clientY);
      if (at) at.classList.add('drop-before');
      else col.classList.add('drop-end');
    });
    col.addEventListener('drop', ev => {
      if (!movingPanel) return;
      ev.preventDefault();
      const at = panelAt(col, ev.clientY);
      col.insertBefore(movingPanel, at);
      clearDropMarks();
      readLayout();
    });
  }
  COLUMNS.forEach(col => col.addEventListener('dragleave', ev => {
    if (!col.contains(ev.relatedTarget)) clearDropMarks();
  }));

  const layoutMenu = $('layoutMenu');
  function closeLayoutMenu() {
    layoutMenu.hidden = true;
    $('layoutBtn').setAttribute('aria-expanded', 'false');
  }
  $('layoutBtn').addEventListener('click', ev => {
    ev.stopPropagation();
    const open = layoutMenu.hidden;
    layoutMenu.hidden = !open;
    $('layoutBtn').setAttribute('aria-expanded', String(open));
    if (open) layoutMenu.querySelector('button').focus();
  });
  layoutMenu.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      closeLayoutMenu();
      $('layoutBtn').focus();
    }
  });
  document.addEventListener('click', ev => {
    if (!layoutMenu.hidden && !layoutMenu.contains(ev.target)) closeLayoutMenu();
  });
  $('layoutSwap').addEventListener('click', () => {
    layout.swapped = !layout.swapped;
    applyLayout();
    saveLayout();
    closeLayoutMenu();
  });
  $('layoutReset').addEventListener('click', () => {
    layout = defaultLayout();
    applyLayout();
    saveLayout();
    closeLayoutMenu();
  });

  // ------------------------------------------------------------ worker
  // All reading, processing and writing run in a Web Worker built from the
  // source of h5wasmModule, ConverterFactory, ProcessingFactory,
  // wgpuFftWebModule and converterWorker, so the page stays responsive and
  // works from file:// without fetching anything.
  function createClient() {
    const source = [
      'var h5wasm = (' + h5wasmModule.toString() + ')();',
      'var Converter = (' + ConverterFactory.toString() + ')();',
      'var Processing = (' + ProcessingFactory.toString() + ')(Converter);',
      'var wgpuFftWeb = (' + wgpuFftWebModule.toString() + ')();',
      '(' + converterWorker.toString() + ')(self, h5wasm, Converter, Processing, wgpuFftWeb);',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const pending = new Map();
    let seq = 0;
    const fail = err => {
      for (const call of pending.values()) call.reject(err);
      pending.clear();
    };
    worker.onmessage = async ev => {
      const msg = ev.data;
      const call = pending.get(msg.id);
      if (!call) return;
      if (msg.type === 'progress') {
        if (call.onProgress) call.onProgress(msg.phase, msg.fraction);
      } else if (msg.type === 'log') {
        if (call.onLog) call.onLog(msg.text);
      } else if (msg.type === 'chunk') {
        try {
          await call.onChunk(msg.chunk);
          worker.postMessage({ type: 'ack', id: msg.id });
        } catch (e) {
          call.sinkError = e;
          worker.postMessage({ type: 'cancel', id: msg.id });
        }
      } else if (msg.type === 'result') {
        pending.delete(msg.id);
        call.resolve(msg.result);
      } else if (msg.type === 'error') {
        pending.delete(msg.id);
        call.reject(call.sinkError || Object.assign(new Error(msg.message), { cancelled: msg.cancelled }));
      }
    };
    worker.onerror = ev => {
      ev.preventDefault();
      fail(new Error(ev.message || 'the conversion worker failed'));
    };
    return {
      call(method, args, hooks) {
        const id = ++seq;
        const promise = new Promise((resolve, reject) => pending.set(id, Object.assign({ resolve, reject }, hooks)));
        worker.postMessage({ type: 'call', id, method, args });
        return { id, promise };
      },
      cancel(id) { worker.postMessage({ type: 'cancel', id }); },
      terminate() {
        worker.terminate();
        URL.revokeObjectURL(url);
        fail(Object.assign(new Error('cancelled'), { cancelled: true }));
      },
    };
  }

  const state = {
    data: null, struct: null, dataFiles: [], gridConfig: null, recipe: [], extraFiles: [], extraNames: [],
    cellPrefer: null,           // null: pick the cell source automatically
  };
  let client, current = null, hardCancelTimer = null;

  try {
    client = createClient();
    await client.call('ping').promise;
    clearLog();
    log('Ready. Drop a data file here, or choose one.');
  } catch (e) {
    clearLog();
    log('Could not start the conversion worker: ' + e.message, 'err');
    return;
  }

  // ------------------------------------------------------------ busy state
  const LOCKED = ['dataFile', 'browseBtn', 'replaceBtn', 'structFile', 'gridConfigFile', 'yellSpace', 'nexusPath',
    'extraFiles', 'extraBtn', 'addStep', 'loadRecipe', 'clearRecipe', 'presetBtn', 'seriesBtn'];

  let seriesRunning = false;
  function updateButton() {
    const busy = !!current || seriesRunning;
    $('convertBtn').disabled = !state.data || busy;
    $('processBtn').disabled = !state.data || busy || !activeRecipe().length;
    $('seriesBtn').disabled = busy;
    updateOutput();
  }

  function setBusy(label) {
    const on = !!label;
    $('busy').hidden = !on;
    $('cancelBtn').hidden = !on;
    $('progressBar').removeAttribute('value');   // indeterminate until the first report
    $('progressText').textContent = label || '';
    for (const id of LOCKED) $(id).disabled = on;
    for (const b of document.querySelectorAll('#stageSeg button, #planeSeg button')) b.disabled = on;
    $('sliceIndex').disabled = on;
    updateButton();
  }

  function showProgress(phase, fraction) {
    $('progressBar').value = fraction;
    $('progressText').textContent = `${phase} · ${Math.round(100 * fraction)} %`;
  }

  // Run one worker call with the progress bar and Cancel button.
  async function run(label, method, args, hooks) {
    const call = client.call(method, args, Object.assign({ onProgress: showProgress, onLog: text => log(text) }, hooks));
    current = call;
    setBusy(label);
    try {
      return await call.promise;
    } finally {
      current = null;
      clearTimeout(hardCancelTimer);
      setBusy(null);
    }
  }

  $('cancelBtn').addEventListener('click', () => {
    if (!current) return;
    client.cancel(current.id);
    $('progressText').textContent = 'Cancelling…';
    // A single long HDF5 call cannot yield; restart the worker if it does not stop.
    hardCancelTimer = setTimeout(() => {
      if (!current) return;
      client.terminate();
      client = createClient();
      state.data = null;
      state.struct = null;
      state.dataFiles = [];
      state.extraFiles = [];
      state.extraNames = [];
      for (const id of ['dataFile', 'structFile', 'extraFiles']) $(id).value = '';
      $('nexusPick').hidden = true;
      for (const id of ['dataInfo', 'structInfo', 'extraInfo']) $(id).textContent = '';
      showData(null);
      renderCell();
      renderExtras();
      renderSteps();
      log('The worker did not stop in time and was restarted; select the files again.', 'err');
    }, 5000);
  });

  // ------------------------------------------------------------ data
  const KIND_LABEL = {
    yell: 'Yell 1.0', unified: 'Unified HDF5', 'mantid-md': 'Mantid MDHistoWorkspace', nexus: 'NeXus NXdata',
    dat: 'RMCProfile .dat', 'dat-hkl': 'RMCProfile .dat · hkl', 'dat-amp': 'RMCProfile amplitudes',
    'dat-interf': 'RMCProfile interference function',
    vtk: 'VTK · Q', 'vtk-hkl': 'VTK · r.l.u.', hkl: 'hkl list', npz: 'NumPy .npz',
    'calc-dat': '3DSCalculator .dat', 'calc-json': '3DSCalculator .json', rspace3d: 'rspace3d (CrysAlisPro)',
  };

  // Per grid axis: the component it runs along, its range and step.
  function axisRanges(s) {
    return [0, 1, 2].map(a => {
      const v = s.vectors[a].map(Math.abs), c = v.indexOf(Math.max(...v));
      return { name: s.names[c], from: s.corner[c], to: s.corner[c] + (s.dims[a] - 1) * s.vectors[a][c], step: v[c], n: s.dims[a] };
    });
  }

  function stat(label, value) {
    const d = el('div', 'stat');
    const b = el('b', null, value);
    b.title = value;
    d.append(el('span', null, label), b);
    return d;
  }

  function showData(s) {
    const has = !!s;
    $('dropzone').hidden = has;
    $('fileCard').hidden = !has;
    $('replaceBtn').hidden = !has;
    $('dataCard').classList.toggle('done', has);
    $('notesBtn').hidden = !(has && s.notes && s.notes.length);
    $('notesList').hidden = true;
    $('notesBtn').setAttribute('aria-expanded', 'false');
    resetPreview(s);
    if (!has) return;
    $('fileName').textContent = s.main;
    $('fileKind').textContent = s.kind === 'nexus' ? `NeXus ${s.nexusPath}` : KIND_LABEL[s.kind] || s.kind;
    $('fileSize').textContent = s.size ? fmtBytes(s.size) : '';
    const r = axisRanges(s);
    const same = r.every(x => x.n > 1 && fmtNum(x.from) === fmtNum(r[0].from) && fmtNum(x.to) === fmtNum(r[0].to));
    const range = same ? `${r.map(x => x.name).join(', ')}  ${fmtNum(r[0].from)} … ${fmtNum(r[0].to)}`
      : r.map(x => (x.n > 1 ? `${x.name} ${fmtNum(x.from)} … ${fmtNum(x.to)}` : `${x.name} = ${fmtNum(x.from)}`)).join(' · ');
    const steps = [...new Set(r.filter(x => x.n > 1).map(x => fmtNum(x.step, 4)))].join(' / ');
    $('fileStats').replaceChildren(stat('Grid', s.dims.join(' × ')), stat('Range', range),
      stat('Step · type', `${steps || '–'} · ${s.precision}${s.hasSigma ? ' · σ' : ''}`));
    const total = s.dims[0] * s.dims[1] * s.dims[2];
    const measured = total ? 1 - (s.nonFinite || 0) / total : 1;
    $('fileMeter').hidden = false;
    $('fileMeterBar').style.width = (100 * measured).toFixed(1) + '%';
    $('fileMeterText').textContent = (100 * measured).toFixed(1) + ' %';
    const notes = s.notes || [];
    $('notesCount').textContent = `${notes.length} note${notes.length === 1 ? '' : 's'} from the reader`;
    $('notesList').replaceChildren(...notes.map(n => el('li', null, n)));
  }

  $('notesBtn').addEventListener('click', () => {
    const open = $('notesList').hidden;
    $('notesList').hidden = !open;
    $('notesBtn').setAttribute('aria-expanded', String(open));
    $('notesBtn').lastElementChild.replaceWith(icon(open ? 'up' : 'down', 15));
  });

  // nexusPath: keep the chosen NXdata group when reloading the same files.
  async function loadDataFile(nexusPath) {
    const files = state.dataFiles;
    $('dataInfo').textContent = '';
    state.data = null;
    showData(null);
    updateButton();
    if (!nexusPath) $('nexusPick').hidden = true;
    try {
      const s = await run('Reading…', 'loadData', {
        files, paths: files.map(f => f.webkitRelativePath || ''),
        yellSpace: $('yellSpace').value, nexusPath: nexusPath || null, crop: readCrop(), readSigma: $('readSigma').checked,
        zeroEmpty: $('zeroEmpty').checked,
        grid: state.gridConfig ? state.gridConfig.grids[pickGrid(state.gridConfig, files[0] && files[0].name)] : null,
      });
      if (!s) return;
      if (s.cellFiles && s.cellFiles.length) {
        const cellFile = files.find(f => f.name === s.cellFiles[0]);
        log(`"${cellFile.name}" holds a unit cell, not a volume: it is used as the structure file.`);
        state.cellPrefer = 'structure';
        await loadStructureFile(cellFile);
        if (!s.main) {
          state.dataFiles = [];
          return;
        }
      }
      s.baseName = baseNameOf(s.main);
      s.size = (files.find(f => f.name === s.main) || {}).size || 0;
      state.data = s;
      if (files.length > 1) {
        log(`Data file: ${s.main}` + (s.companions && s.companions.length
          ? `; linked files: ${s.companions.join(', ')}` : '; the other selected files are not used'));
      }
      if (s.candidates && s.candidates.length > 1) {
        const pick = $('nexusPath');
        pick.replaceChildren(...s.candidates.map(c => {
          const opt = el('option', null, `${c.path} (${c.shape ? c.shape.join(' × ') : 'linked'})` + (c.isDefault ? ' · default' : ''));
          opt.value = c.path;
          return opt;
        }));
        pick.value = s.nexusPath;
        $('nexusPick').hidden = false;
      }
      let info;
      if (s.kind === 'dat' || s.kind === 'dat-amp' || s.kind === 'dat-hkl' || s.kind === 'dat-interf') {
        info = `${KIND_LABEL[s.kind]} | grid ${s.dims.join(' x ')} in ${s.kind === 'dat-hkl' ? 'hkl' : 'Q'}`;
      } else if (s.kind === 'vtk') {
        info = `VTK STRUCTURED_POINTS in Q | grid ${s.dims.join(' x ')}`;
      } else if (s.kind === 'hkl' || s.kind === 'calc-dat') {
        info = `${KIND_LABEL[s.kind]} | grid ${s.dims.join(' x ')}${s.hasSigma ? ' | σ' : ''}`;
      } else if (s.kind === 'vtk-hkl') {
        info = `VTK STRUCTURED_POINTS in r.l.u. ("${s.title}") | grid ${s.dims.join(' x ')}`;
      } else {
        const label = {
          yell: 'Yell 1.0', unified: 'Unified data format', 'mantid-md': 'Mantid MDHistoWorkspace', nexus: `NeXus ${s.nexusPath}`,
          npz: 'NumPy .npz', 'calc-json': '3DSCalculator .json', rspace3d: 'rspace3d (CrysAlisPro)',
        }[s.kind];
        info = label + ` | grid ${s.dims.join(' x ')}` +
          (s.kind === 'unified' || s.kind === 'nexus' || s.kind === 'npz' ? ` | axes ${s.axesType || 'hkl'}` : '') +
          ` | ${s.precision} | stored cell: ${fmtCell({ lengths: s.cellLengths, angles: s.cellAngles })}` +
          (Converter.isUnitMetric(s.cellLengths, s.cellAngles) ? '  (unit metric)' : '');
      }
      log(`Data file "${s.main}": ${info}`, 'ok');
      logNotes(s.notes);
      if (s.legacyContract) {
        log('Legacy unified metadata accepted; new unified output will write the mandatory current contract.');
      }
      showData(s);
      renderCell();
      renderSteps();
      refreshPreview();
    } catch (e) {
      const msg = e.cancelled ? 'reading cancelled' : e.message;
      $('dataInfo').textContent = 'Error: ' + msg;
      log('Error reading data file: ' + msg, 'err');
    }
    updateButton();
  }

  // The crop-on-read ranges that have both ends, or null.
  function readCrop() {
    const crop = {};
    for (const axis of ['h', 'k', 'l']) {
      const ends = [0, 1].map(e => $('cropRow').querySelector(`[data-axis="${axis}"][data-end="${e}"]`).value.trim());
      if (ends.every(Boolean) && ends.every(x => isFinite(Number(x)))) crop[axis] = ends.map(Number).sort((a, b) => a - b);
    }
    return Object.keys(crop).length ? crop : null;
  }
  for (const id of ['readSigma', 'zeroEmpty']) {
    $(id).addEventListener('change', () => {
      if (state.dataFiles.length && !current) loadDataFile(state.data && state.data.nexusPath);
      if (state.extraFiles.length && !current) loadExtras(state.extraFiles);
    });
  }
  for (const input of $('cropRow').querySelectorAll('input')) {
    input.addEventListener('change', () => {
      if (state.dataFiles.length && !current) loadDataFile(state.data && state.data.nexusPath);
    });
  }

  function useDataFiles(files) {
    state.dataFiles = files;
    loadDataFile();
  }
  $('dataFile').addEventListener('change', ev => useDataFiles(Array.from(ev.target.files)));
  for (const id of ['browseBtn', 'replaceBtn']) $(id).addEventListener('click', () => $('dataFile').click());
  $('yellSpace').addEventListener('change', () => {
    if (state.dataFiles.length) loadDataFile(state.data && state.data.nexusPath);
  });
  $('nexusPath').addEventListener('change', () => {
    if (state.dataFiles.length) loadDataFile($('nexusPath').value);
  });

  async function loadGridConfig(fileObj) {
    $('gridConfigInfo').textContent = '';
    state.gridConfig = null;
    if (!fileObj) return;
    try {
      const cfg = Converter.parseGridConfig(await fileObj.text());
      state.gridConfig = cfg;
      const g = cfg.grids[0];
      const info = (cfg.program === 'scatty' ? 'Scatty' : 'Spinteract') + ' config | ' +
        (cfg.grids.length > 1 ? `${cfg.grids.length} grids, first ` : 'grid ') +
        `${g.dims.join(' x ')} from hkl ${g.corner.map(x => +x.toFixed(6)).join(' ')}` +
        (cfg.customFrame ? ' | custom HKL_TO_X/Y/Z frame' : '');
      $('gridConfigInfo').textContent = info;
      log(`Grid config "${fileObj.name}": ${info}`, 'ok');
      if (state.data && state.data.kind === 'hkl' && !current) loadDataFile();
    } catch (e) {
      $('gridConfigInfo').textContent = 'Error: ' + e.message;
      log('Error reading grid config: ' + e.message, 'err');
    }
  }
  $('gridConfigFile').addEventListener('change', ev => loadGridConfig(ev.target.files[0]));

  // Spinteract writes one image per data set (..._img_NN.vtk) and one grid
  // per data set in its config; match them by number.
  function pickGrid(cfg, dataName) {
    const m = /_(\d+)\.(vtk|txt)$/i.exec(dataName || '');
    const index = cfg.grids.length > 1 && m ? Number(m[1]) - 1 : 0;
    return index >= 0 && index < cfg.grids.length ? index : 0;
  }

  // Dropped or chosen files by content: recipes, structures, grid configs
  // and everything else as data (3DSCalculator's .json exports included).
  async function routeFiles(files) {
    const data = [];
    for (const f of files) {
      if (/\.json$/i.test(f.name) && !Converter.is3dsCalculatorJson(await f.slice(0, 4096).text())) await loadRecipeFile(f);
      else if (/\.rmc6f$/i.test(f.name)) await loadStructureFile(f);
      else if (f.size < 65536 && !/\.(vtk|dat|h5|nxs|nx5|hdf5?)$/i.test(f.name) &&
        /^\s*(CENTRE|ORIGIN|X_AXIS)\b/m.test(await f.slice(0, 4096).text())) await loadGridConfig(f);
      else data.push(f);
    }
    if (data.length) useDataFiles(data);
  }

  let dragDepth = 0;
  const hasFiles = ev => !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', ev => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth++;
    $('dropVeil').hidden = false;
  });
  window.addEventListener('dragover', ev => {
    if (hasFiles(ev)) ev.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropVeil').hidden = true;
  });
  window.addEventListener('drop', ev => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    $('dropVeil').hidden = true;
    if (current || seriesRunning) {
      log('Busy with another task; drop the files again when it ends.', 'warn');
      return;
    }
    routeFiles(Array.from(ev.dataTransfer.files));
  });

  // ------------------------------------------------------------ unit cell
  const CELL_IDS = ['ca', 'cb', 'cc', 'cal', 'cbe', 'cga'];
  const SOURCE_NAME = { data: 'the data file', structure: 'the structure file', manual: 'manual entry' };

  const dataCell = () => {
    const s = state.data;
    return s && s.cellLengths && !Converter.isUnitMetric(s.cellLengths, s.cellAngles)
      ? { lengths: s.cellLengths, angles: s.cellAngles } : null;
  };

  // The source the conversion uses: the user's pick when it is available,
  // else the data file's cell, a structure file, or manual entry.
  function cellSource() {
    const has = { data: !!dataCell(), structure: !!state.struct, manual: true };
    if (state.cellPrefer && has[state.cellPrefer]) return state.cellPrefer;
    return has.data ? 'data' : has.structure ? 'structure' : 'manual';
  }

  function manualCell() {
    const raw = CELL_IDS.map(id => $(id).value.trim());
    if (raw.some(v => v === '')) return null;
    const vals = raw.map(Number);
    if (vals.some(v => !isFinite(v) || v <= 0)) return null;
    return { lengths: vals.slice(0, 3), angles: vals.slice(3, 6) };
  }

  function latticeName(c) {
    const [a, b, cc] = c.lengths, [al, be, ga] = c.angles;
    const eq = (x, y) => Math.abs(x - y) <= 1e-4 * Math.max(Math.abs(x), Math.abs(y));
    const is = (x, v) => Math.abs(x - v) < 0.05;
    if (is(al, 90) && is(be, 90) && is(ga, 90)) return eq(a, b) && eq(b, cc) ? 'cubic' : eq(a, b) ? 'tetragonal' : 'orthorhombic';
    if (is(al, 90) && is(be, 90) && is(ga, 120) && eq(a, b)) return 'hexagonal';
    if (eq(a, b) && eq(b, cc) && eq(al, be) && eq(be, ga)) return 'rhombohedral';
    if (is(al, 90) && is(ga, 90)) return 'monoclinic';
    return 'triclinic';
  }

  function renderCell() {
    const src = cellSource();
    for (const b of $('cellSource').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.src === src));
      b.disabled = b.dataset.src === 'data' && !dataCell();
    }
    $('structRow').hidden = src !== 'structure' && !state.struct;
    const shown = src === 'data' ? dataCell() : src === 'structure' ? state.struct : null;
    CELL_IDS.forEach((id, i) => {
      $(id).disabled = src !== 'manual';
      if (shown) $(id).value = i < 3 ? +shown.lengths[i].toFixed(5) : +shown.angles[i - 3].toFixed(4);
    });
    const cell = shown || manualCell();
    $('cellCard').classList.toggle('done', !!cell);
    $('cellNote').textContent = cell ? `${latticeName(cell)} · from ${SOURCE_NAME[src]}`
      : src === 'structure' ? 'choose a structure file' : 'type the parent cell, or load a structure file';
    const d = dataCell(), s = state.struct;
    const differs = d && s && [0, 1, 2].some(i => Math.abs(d.lengths[i] - s.lengths[i]) > 0.005 * d.lengths[i] ||
      Math.abs(d.angles[i] - s.angles[i]) > 0.5);
    $('cellWarn').hidden = !differs;
    renderUB();
    if (differs) {
      $('cellWarn').textContent = `The structure file's cell (${fmtCell(s)}) differs from the data file's (${fmtCell(d)}); ` +
        `the conversion uses ${SOURCE_NAME[src]}.`;
    }
  }

  for (const b of $('cellSource').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      state.cellPrefer = b.dataset.src;
      renderCell();
      if (b.dataset.src === 'structure' && !state.struct) $('structFile').click();
      stepsChanged();
    });
  }
  for (const id of CELL_IDS) $(id).addEventListener('input', () => {
    renderCell();
    stepsChanged();
    if (preview.frame === 'cartesian') {
      clearTimeout(preview.timer);
      preview.timer = setTimeout(loadSlice, 300);
    }
  });

  // ------------------------------------------------------------ UB matrix
  // Typed, else from the data file (Mantid, rspace3d, NeXus) or the
  // structure file (subhkl): Q = 2 pi UB hkl.
  const UB_IDS = [0, 1, 2].flatMap(r => [0, 1, 2].map(c => `ub${r}${c}`));
  const fileUB = () => (state.data && state.data.ub) || (state.struct && state.struct.ub) || null;
  const currentUB = () => state.ubManual || fileUB();
  function renderUB() {
    const ub = currentUB();
    UB_IDS.forEach((id, i) => {
      if (document.activeElement !== $(id)) $(id).value = ub ? String(+ub[Math.floor(i / 3)][i % 3].toPrecision(8)) : '';
    });
    $('ubNote').textContent = state.ubManual ? 'typed (used for Cartesian Q data and the preview)'
      : ub ? `from the ${state.data && state.data.ub ? 'data' : 'structure'} file` : 'none: the cell, with a along x, sets the Cartesian frame';
    $('ubClear').hidden = !state.ubManual;
  }
  function readUB() {
    const v = UB_IDS.map(id => parseNum($(id).value));
    if (v.every(x => !Number.isFinite(x))) {
      state.ubManual = null;
    } else if (v.every(Number.isFinite)) {
      const m = [v.slice(0, 3), v.slice(3, 6), v.slice(6, 9)];
      const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      if (!det) {
        $('ubNote').textContent = 'that UB is singular';
        return;
      }
      state.ubManual = m;
    } else {
      return;                                   // still typing
    }
    renderUB();
    stepsChanged();
    if (preview.frame === 'cartesian') loadSlice();
  }
  for (const id of UB_IDS) $(id).addEventListener('change', readUB);
  $('ubClear').addEventListener('click', () => {
    state.ubManual = null;
    renderUB();
    stepsChanged();
    if (preview.frame === 'cartesian') loadSlice();
  });

  async function loadStructureFile(file) {
    $('structInfo').textContent = '';
    state.struct = null;
    try {
      const parent = await run('Reading structure…', 'loadStructure', { file });
      if (parent) {
        state.struct = parent;
        const info = `parent cell ${fmtCell(parent)}` + (parent.supercell ? ` (supercell ${parent.supercell.join(' x ')})` : '') +
          (parent.source === 'subhkl' ? ` from subhkl${parent.spaceGroup ? `, space group ${parent.spaceGroup}` : ''}` : '');
        $('structInfo').textContent = `${file.name}: ${info}`;
        log(`Structure "${file.name}": ${info}`, 'ok');
      }
    } catch (e) {
      $('structInfo').textContent = 'Error: ' + e.message;
      log('Error reading structure file: ' + e.message, 'err');
    }
    renderCell();
    stepsChanged();
    updateButton();
  }
  $('structFile').addEventListener('change', ev => loadStructureFile(ev.target.files[0] || null));
  renderCell();

  // ------------------------------------------------------------ processing
  // Form fields per step op: [key, type, label]. A type is a list of
  // choices, or 'num', 'num?' (blank = none), 'nums' (a list), 'range'
  // (min max, blank = all), 'axis' (min max step), 'ints3', 'json', 'bool',
  // 'text', 'clipTo' (a number or nan) or 'extra' (a loaded volume).
  const STEP_FORMS = {
    crop: ['Crop to hkl ranges', [['h', 'range', 'h'], ['k', 'range', 'k'], ['l', 'range', 'l']]],
    resample: ['Resample onto an hkl grid', [['h', 'axis', 'h min max step'], ['k', 'axis', 'k'], ['l', 'axis', 'l']]],
    rebin: ['Rebin', [['factors', 'ints3', 'factors along the grid axes']]],
    maskBragg: ['Mask Bragg peaks', [['shape', ['box', 'sphere'], 'shape'],
      ['size', 'num', 'half-width (box, r.l.u.) or radius (sphere, Å⁻¹)'],
      ['centring', ['P', 'I', 'F', 'C', 'A', 'B', 'R'], 'lattice centring']]],
    maskRings: ['Mask powder rings', [['powder', ['none', 'aluminium', 'copper', 'vanadium'], 'the lines of a sample holder'],
      ['a', 'num?', 'its lattice parameter (Å; blank: room temperature)'], ['q', 'nums', 'more rings at |Q| (Å⁻¹)'],
      ['width', 'num', 'half-width (Å⁻¹)']]],
    maskRange: ['Mask a value range', [['min', 'num?', 'keep from'], ['max', 'num?', 'keep up to']]],
    maskQ: ['Mask a |Q| range', [['min', 'num?', 'keep from |Q| (Å⁻¹)'], ['max', 'num?', 'keep up to |Q| (Å⁻¹)']]],
    removeRings: ['Remove powder rings', [
      ['materials', 'text', 'materials: aluminium, copper, vanadium, niobium, titanium, ice, ice-ic, … or fcc Al 4.05 · any: every sharp ring'],
      ['temperature', 'num', 'temperature of the aluminium (K; 0 = room): its lattice parameter, and a check of the |Q| scale'],
      ['radiation', ['auto', 'xray', 'neutron', 'electron'], 'radiation for the line intensities (auto: the data’s)'],
      ['intensities', ['structure', 'free'], 'line intensities from the structure factors, or each line its own'],
      ['refine', 'num', 'refine the lattice parameter within ± (fraction, e.g. 0.01)'], ['fitWidth', 'bool', 'fit the line widths'],
      ['sigma0', 'num', 'line width: constant part σ₀ (Å⁻¹)'], ['resolution', 'num', 'line width: part growing with |Q|, σ/Q'],
      ['highPass', 'num', 'Fourier high-pass: broader than this many line widths is background'],
      ['sectors', 'num', 'direction sectors (1 = whole shells)'], ['coverage', 'num', 'judge only shells covered at least this much (0–1)'],
      ['cutoff', 'num', 'any: remove what is sharper in |Q| than (Å⁻¹)'], ['width', 'num', 'any: |Q| profile bin (Å⁻¹)'],
      ['voxelWidth', 'bool', 'widen the lines by the voxel size along each direction (binned data)'],
      ['shift', 'num', 'let each direction sector shift its lines by up to (fraction; a part off the sample position)'],
      ['maskSpots', 'bool', 'mask bright spots left on the rings (large grains)'],
      ['positive', 'bool', 'only positive rings (off after an empty-can subtraction, which can leave negative ones)']]],
    filterRings: ['Ring filter at the lines (Fourier)', [
      ['materials', 'text', 'materials whose lines are filtered: aluminium, copper, … (as a ring removal before fitted them, else fitted here)'],
      ['temperature', 'num', 'temperature of the aluminium (K; 0 = room), when fitted here'],
      ['radiation', ['auto', 'xray', 'neutron', 'electron'], 'radiation for the line intensities, when fitted here (auto: the data’s)'],
      ['axis', 'text', 'rotation axis: auto (found from the rings) or a direction h k l'],
      ['angleStep', 'num', 'bins of the angle to the axis (degrees)'],
      ['azimuth', 'num', 'azimuthal orders about the axis (0–4; 0: the rings follow the angle to it only)'],
      ['window', 'num', 'change the data within this many line widths of each line'],
      ['highPass', 'num', 'Fourier high-pass: broader than this many line widths stays'],
      ['smooth', 'num', 'Fourier low-pass: finer than this many line widths is noise'],
      ['bragg', 'num', 'leave the sample’s Bragg regions out of the estimate: radius (r.l.u.; 0 = none)'],
      ['passes', 'num', 'passes (1–10)']]],
    backgroundDebyeWaller: ['Background: Laue + thermal (Debye–Waller)', [
      ['composition', 'text', 'sites, e.g. Pb; Mg 0.333 + Nb 0.667; 3*O'], ['uiso', 'text', 'Uiso (Å²): one value, or e.g. 0.01, Pb 0.03'],
      ['radiation', ['auto', 'xray', 'neutron', 'electron'], 'radiation (auto: the data’s)'],
      ['fit', 'bool', 'scale it to the floor of the data'], ['percentile', 'num', 'floor: percentile of each |Q| shell'],
      ['width', 'num', 'shell width (Å⁻¹)'], ['offset', 'bool', 'fit and subtract an offset too'], ['scale', 'num', 'scale when not fitted']]],
    correctUB: ['Correct the UB (Bragg peaks on integers)', [['mode', ['refine', 'matrix'], 'refine from the Bragg peaks, or from a new UB'],
      ['centring', ['P', 'I', 'F', 'C', 'A', 'B', 'R'], 'lattice centring'], ['radius', 'num', 'search around integer hkl within (r.l.u.)'],
      ['snr', 'num', 'a peak stands out by (robust σ)'], ['peaks', 'num', 'use the strongest'], ['shift', 'bool', 'allow a shift too'],
      ['ub', 'nums', 'matrix: the UB the grid was made with (9 numbers; blank: the data’s)'], ['ubNew', 'nums', 'matrix: the corrected UB (9 numbers)']]],
    despike: ['Despike (median)', [['size', 'num', 'neighbourhood: 1 = 3×3×3, 2 = 5×5×5'],
      ['k', 'num', 'replace beyond k robust σ of the neighbours (0 = median filter); single-voxel Bragg peaks count as spikes']]],
    window: ['|Q| window (before a ΔPDF)', [['kind', ['lorch', 'hann', 'gauss', 'sphere'], 'window'],
      ['qmax', 'num', 'to |Q| (Å⁻¹; 0 = the largest sphere in the grid)']]],
    scale: ['Scale and offset', [['factor', 'num', 'factor'], ['offset', 'num', 'offset'],
      ['positive', 'bool', 'then shift up so every value is positive (RMCProfile reads 0 as masked)']]],
    smooth: ['Smooth (Gaussian)', [['sigma', 'num', 'σ in voxels; empty voxels are left out']]],
    fill: ['Fill empty voxels', [['passes', 'num', 'voxels deep, from their measured neighbours']]],
    backgroundFunction: ['Subtract B(|Q|)', [
      ['kind', ['constant', 'linear', 'exponential', 'table'], 'kind'],
      ['params', 'json', 'parameters: [c], [a, b] for a + bQ, [a, b, c] for a − b c^Q, or [[Q, B], …]']]],
    backgroundShells: ['Background from |Q| shells', [['width', 'num', 'shell width (Å⁻¹)'],
      ['percentile', 'num', 'percentile per shell (0 = minimum)'], ['smooth', 'num', 'smooth over ± shells']]],
    normalize: ['Normalize by Mantid norms', [['norm', 'extra', 'norm volume'], ['background', 'extra?', 'background data'],
      ['backgroundNorm', 'extra?', 'background norm'], ['scale', 'num', 'background times'],
      ['fitScale', 'bool', 'fit that scale by least squares instead'],
      ['laue', ['none'].concat(Processing.LAUE_GROUPS), 'sum over the Laue group']]],
    combine: ['Combine with a volume', [['operation', ['subtract', 'add', 'multiply', 'divide'], 'operation'],
      ['file', 'extra', 'volume'], ['scale', 'num', 'times']]],
    clip: ['Replace low values', [['below', 'num', 'below'], ['to', 'clipTo', 'with (a number or nan)']]],
    symmetrize: ['Symmetrize', [['laue', Processing.LAUE_GROUPS, 'Laue group'],
      ['mode', ['average', 'fill', 'median', 'clip'], 'average all · fill empty voxels · median · mean without outliers'],
      ['k', 'num', 'clip: leave out equivalents beyond k robust σ'],
      ['expand', 'bool', 'extend the grid to the symmetric range (a half volume becomes whole)']]],
    deltaPdf: ['3D-ΔPDF', [['taper', 'num', 'Tukey taper (0–1)'], ['engine', ['cpu', 'gpu'], 'FFT on (CPU float64, GPU float32)'],
      ['fill', 'num', 'fill holes, voxels deep (0 = count them as 0)']]],
  };
  const STEP_GROUPS = [
    ['Grid', ['crop', 'resample', 'rebin', 'correctUB']], ['Masks', ['maskBragg', 'maskRings', 'maskQ', 'maskRange', 'fill']],
    ['Background', ['normalize', 'backgroundShells', 'backgroundDebyeWaller', 'backgroundFunction', 'removeRings', 'filterRings', 'combine']],
    ['Values', ['scale', 'clip', 'smooth', 'despike']], ['Symmetry', ['symmetrize']], ['Transform', ['window', 'deltaPdf']],
  ];
  const STEP_ICON = {
    crop: 'crop', resample: 'grid', rebin: 'grid', maskBragg: 'mask', maskRings: 'rings', maskRange: 'sliders',
    scale: 'sliders', backgroundFunction: 'curve', backgroundShells: 'curve', combine: 'layers', normalize: 'layers', clip: 'sliders',
    symmetrize: 'sym', deltaPdf: 'wave', smooth: 'curve', fill: 'wand', maskQ: 'rings', removeRings: 'rings', filterRings: 'rings',
    backgroundDebyeWaller: 'curve', correctUB: 'grid', despike: 'wand', window: 'wave',
  };
  // Starting values of a new step.
  const STEP_START = {
    crop: {}, resample: { h: [-2, 2, 0.05], k: [-2, 2, 0.05], l: [0, 0, 0] }, rebin: { factors: [2, 2, 2] },
    maskBragg: { shape: 'box', size: 0.1, centring: 'P' }, maskRings: { powder: 'aluminium', q: [], width: 0.03 }, maskRange: { min: 0 },
    scale: { factor: 1, offset: 0, positive: false }, backgroundFunction: { kind: 'constant', params: [0] },
    smooth: { sigma: 0.5 }, fill: { passes: 2 },
    backgroundShells: { width: 0.05, percentile: 5, smooth: 1 }, combine: { operation: 'subtract', scale: 1 },
    clip: { below: 0, to: 0 }, symmetrize: { laue: 'm-3m', mode: 'average', k: 3, expand: true },
    deltaPdf: { taper: 0, engine: 'cpu', fill: 0 },
    normalize: { background: '', backgroundNorm: '', scale: 1, fitScale: false, laue: 'none' },
    maskQ: { min: 0.3 },
    removeRings: { materials: 'aluminium', temperature: 0, radiation: 'auto', intensities: 'free', refine: 0.01, fitWidth: true, sigma0: 0.005,
      resolution: 0.004, voxelWidth: true, shift: 0.002, maskSpots: false, highPass: 6, sectors: 8, coverage: 0.25, cutoff: 0.05, width: 0.005,
      positive: true },
    filterRings: { materials: 'aluminium', temperature: 0, radiation: 'auto', axis: 'auto', angleStep: 1, azimuth: 2, window: 3, highPass: 4, smooth: 0.4,
      bragg: 0.3, passes: 3 },
    backgroundDebyeWaller: { composition: '', uiso: '0.01', radiation: 'auto', fit: true, percentile: 5, width: 0.05, offset: false, scale: 1 },
    correctUB: { mode: 'refine', centring: 'P', radius: 0.25, snr: 10, peaks: 300, shift: false, ub: [], ubNew: [] },
    despike: { size: 1, k: 5 }, window: { kind: 'lorch', qmax: 0 },
  };
  const PRESETS = [
    { name: '3D-ΔPDF of a cubic crystal', note: 'm-3m symmetrize · Bragg mask · ΔPDF', steps: [
      { op: 'symmetrize', laue: 'm-3m', mode: 'average', k: 3, expand: true },
      { op: 'maskBragg', shape: 'box', size: 0.2, centring: 'P' }, { op: 'deltaPdf', taper: 0, engine: 'cpu' }] },
    { name: 'Clean up a volume', note: 'despike · sample-environment rings, fitted then filtered · symmetrize without outliers', steps: [
      { op: 'despike', size: 1, k: 5 }, { op: 'removeRings', materials: 'aluminium, copper', temperature: 0, radiation: 'auto', intensities: 'free', refine: 0.01,
        fitWidth: true, sigma0: 0.005, resolution: 0.004, voxelWidth: true, shift: 0.002, maskSpots: false, highPass: 6, sectors: 8,
        coverage: 0.25, cutoff: 0.05, width: 0.005, positive: true },
      { op: 'filterRings', materials: 'aluminium, copper', temperature: 0, radiation: 'auto', axis: 'auto', angleStep: 1, azimuth: 2,
        window: 3, highPass: 4, smooth: 0.4, bragg: 0.3, passes: 3 },
      { op: 'symmetrize', laue: 'm-3m', mode: 'clip', k: 3, expand: true }] },
    { name: 'Subtract a background volume', note: 'load it under Other volumes', steps: [
      { op: 'combine', operation: 'subtract', scale: 1 }] },
    { name: 'Diffuse scattering only', note: 'Bragg mask · background from |Q| shells', steps: [
      { op: 'maskBragg', shape: 'box', size: 0.1, centring: 'P' }, { op: 'backgroundShells', width: 0.05, percentile: 5, smooth: 1 }] },
    { name: 'Sample-environment rings', note: 'aluminium and copper lines fitted from their structures and taken off; what is left Fourier-filtered along the rotation axis', steps: [
      { op: 'removeRings', materials: 'aluminium, copper', temperature: 0, radiation: 'auto', intensities: 'free', refine: 0.01,
        fitWidth: true, sigma0: 0.005, resolution: 0.004, voxelWidth: true, shift: 0.002, maskSpots: false, highPass: 6, sectors: 8,
        coverage: 0.25, cutoff: 0.05, width: 0.005, positive: true },
      { op: 'filterRings', materials: 'aluminium, copper', temperature: 0, radiation: 'auto', axis: 'auto', angleStep: 1, azimuth: 2,
        window: 3, highPass: 4, smooth: 0.4, bragg: 0.3, passes: 3 }] },
  ];

  for (const [group, ops] of STEP_GROUPS) {
    const g = el('optgroup');
    g.label = group;
    for (const op of ops) {
      const opt = el('option', null, STEP_FORMS[op][0]);
      opt.value = op;
      g.appendChild(opt);
    }
    $('stepOp').appendChild(g);
  }

  const blankOr = (x, text) => (x === undefined || x === null || Number.isNaN(x) ? '' : text);
  const numberIn = text => (text.trim() === '' ? NaN : Number(text));

  // One form field; returns { node, read } where read() gives the value.
  function makeField(type, value, changed) {
    const node = el('span', 'inputs');
    const input = (text, wide, hint) => {
      const e = el('input', wide ? 'wide' : null);
      e.value = text;
      if (hint) e.placeholder = hint;
      e.addEventListener('input', changed);
      node.appendChild(e);
      return e;
    };
    const select = (choices, current, labels) => {
      const e = el('select');
      choices.forEach((c, i) => {
        const opt = el('option', null, labels ? labels[i] : c);
        opt.value = c;
        e.appendChild(opt);
      });
      e.value = current;
      e.addEventListener('change', changed);
      node.appendChild(e);
      return e;
    };
    if (Array.isArray(type)) {
      const e = select(type, value);
      return { node, read: () => e.value };
    }
    if (type === 'num') {
      const e = input(blankOr(value, String(value)));
      return { node, read: () => numberIn(e.value) };
    }
    if (type === 'num?') {
      const e = input(blankOr(value, String(value)));
      return { node, read: () => (e.value.trim() === '' ? undefined : Number(e.value)) };
    }
    if (type === 'nums') {
      const e = input((value || []).join(', '), true);
      return { node, read: () => e.value.split(/[\s,;]+/).filter(Boolean).map(Number) };
    }
    if (type === 'range') {
      const [a, b] = ['min', 'max'].map((hint, i) => input(value ? String(value[i]) : '', false, hint));
      return { node, read: () => (a.value.trim() === '' && b.value.trim() === '' ? undefined : [numberIn(a.value), numberIn(b.value)]) };
    }
    if (type === 'axis' || type === 'ints3') {
      const hints = type === 'axis' ? ['min', 'max', 'step'] : ['', '', ''];
      const es = hints.map((hint, i) => input(value ? String(value[i]) : '', false, hint));
      return { node, read: () => es.map(e => numberIn(e.value)) };
    }
    if (type === 'json') {
      const e = input(value === undefined ? '' : JSON.stringify(value), true);
      return {
        node, read: () => {
          try {
            return JSON.parse(e.value);
          } catch (_) {
            return undefined;
          }
        },
      };
    }
    if (type === 'bool') {
      const e = el('input');
      e.type = 'checkbox';
      e.checked = !!value;
      e.addEventListener('change', changed);
      node.appendChild(e);
      return { node, read: () => e.checked };
    }
    if (type === 'text') {
      const e = input(value === undefined || value === null ? '' : String(value), true);
      e.classList.add('text-field');
      return { node, read: () => e.value.trim() };
    }
    if (type === 'clipTo') {
      const e = input(value === undefined ? '' : String(value));
      return { node, read: () => (e.value.trim().toLowerCase() === 'nan' ? 'nan' : numberIn(e.value)) };
    }
    // 'extra' / 'extra?': the loaded volumes, and a recipe's name that is not loaded
    const optional = type === 'extra?';
    const names = (optional ? [''] : []).concat(state.extraNames);
    const labels = (optional ? ['(none)'] : []).concat(state.extraNames);
    if (value && !names.includes(value)) {
      names.push(value);
      labels.push(value + ' (not loaded)');
    }
    if (!names.length) {
      names.push('');
      labels.push('(add a volume below)');
    }
    const e = select(names, value || names[0], labels);
    return { node, read: () => e.value };
  }

  // The step as valid recipe JSON, or the reason it is not. With its index
  // n, also whether the data still are in reciprocal space when it runs.
  function checkStep(step, n) {
    const copy = Object.assign({}, step);
    delete copy.enabled;
    let text;
    try {
      text = Processing.describeStep(Processing.normalizeRecipe({ steps: [copy] }).steps[0]);
    } catch (e) {
      return { error: e.message.replace(/^recipe step 1 /, '') };
    }
    if (n !== undefined && step.enabled !== false && Processing.RECIPROCAL_ONLY.includes(step.op)) {
      const pdf = state.recipe.slice(0, n).findIndex(s => s.op === 'deltaPdf' && s.enabled !== false);
      if (pdf >= 0) return { error: `needs reciprocal-space data, but step ${pdf + 1} (3D-ΔPDF) turns them into a direct-space map; move this step above it` };
      if (state.data && state.data.axesType === 'uvw') return { error: 'needs reciprocal-space data, but the loaded data are a direct-space map' };
    }
    return { text };
  }

  // The steps that run: switched-off ones stay out.
  function activeRecipe() {
    return state.recipe.filter(s => s.enabled !== false).map(s => {
      const copy = Object.assign({}, s);
      delete copy.enabled;
      return copy;
    });
  }

  let openStep = null;          // index of the expanded step
  let dragFrom = null;          // index of the step being dragged

  // Undo: the recipe as it was before each change; a burst of edits to the
  // fields counts as one change.
  const undoStack = [];
  let editBurst = 0;
  function remember() {
    undoStack.push(JSON.stringify(state.recipe));
    if (undoStack.length > 50) undoStack.shift();
    $('undoBtn').disabled = false;
  }
  function rememberEdit() {
    if (!editBurst) remember();
    clearTimeout(editBurst);
    editBurst = setTimeout(() => { editBurst = 0; }, 1200);
  }
  function undo() {
    if (!undoStack.length) return;
    state.recipe = JSON.parse(undoStack.pop());
    openStep = null;
    renderSteps();
    stepsChanged();
    $('undoBtn').disabled = !undoStack.length;
  }
  $('undoBtn').addEventListener('click', undo);
  document.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'z' && undoStack.length &&
      !/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) && !ev.target.isContentEditable) {
      ev.preventDefault();
      undo();
    }
  });

  function renderSteps() {
    const list = $('steps');
    list.textContent = '';
    state.recipe.forEach((step, n) => {
      const [title, fields] = STEP_FORMS[step.op];
      const on = step.enabled !== false, open = openStep === n;
      const item = el('li', 'step' + (open ? ' open' : '') + (on ? '' : ' off'));
      const rail = el('div', 'rail');
      const dot = el('div', 'dot');
      dot.appendChild(icon(STEP_ICON[step.op] || 'sliders', 16));
      rail.append(dot, el('div', 'line'));
      rail.draggable = true;
      rail.title = 'Drag to reorder';
      rail.addEventListener('dragstart', ev => {
        dragFrom = n;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', 'recipe step');
        ev.dataTransfer.setDragImage(item, 18, 18);
        item.classList.add('dragging');
      });
      rail.addEventListener('dragend', () => {
        dragFrom = null;
        for (const li of $('steps').children) li.classList.remove('dragging', 'drop-before', 'drop-after');
      });
      const dropAfter = ev => {
        const r = item.getBoundingClientRect();
        return ev.clientY > r.top + r.height / 2;
      };
      item.addEventListener('dragover', ev => {
        if (dragFrom === null) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        const after = dropAfter(ev);
        item.classList.toggle('drop-before', !after);
        item.classList.toggle('drop-after', after);
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
      item.addEventListener('drop', ev => {
        if (dragFrom === null) return;
        ev.preventDefault();
        ev.stopPropagation();
        const from = dragFrom;
        let to = n + (dropAfter(ev) ? 1 : 0);
        dragFrom = null;
        if (to > from) to--;
        if (to !== from) {
          remember();
          const [moved] = state.recipe.splice(from, 1);
          state.recipe.splice(to, 0, moved);
          openStep = null;
          stepsChanged();
        }
        renderSteps();
      });
      const box = el('div', 'box');
      const head = el('div', 'stephead');
      const toggle = button('toggle');
      toggle.setAttribute('aria-expanded', String(open));
      const status = el('span', 'hint');
      toggle.append(el('b', null, title), status);
      toggle.addEventListener('click', () => {
        openStep = open ? null : n;
        renderSteps();
      });
      const sw = button('switch');
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(on));
      sw.setAttribute('aria-label', (on ? 'Turn off: ' : 'Turn on: ') + title);
      sw.addEventListener('click', () => {
        remember();
        state.recipe[n] = Object.assign({}, state.recipe[n], { enabled: !on });
        if (on) state.recipe[n].enabled = false;
        else delete state.recipe[n].enabled;
        renderSteps();
        stepsChanged();
      });
      const remove = button('btn ghost icon', '', 'x', 'remove');
      remove.setAttribute('aria-label', 'Remove ' + title);
      remove.addEventListener('click', () => {
        remember();
        state.recipe.splice(n, 1);
        openStep = openStep === n ? null : openStep !== null && openStep > n ? openStep - 1 : openStep;
        renderSteps();
        stepsChanged();
      });
      head.append(toggle, sw, remove);
      const body = el('div', 'stepbody');
      body.hidden = !open;
      const box2 = el('div', 'fields');
      const readers = [];
      const update = quiet => {
        const next = { op: step.op };
        for (const [key, read] of readers) {
          const v = read();
          if (v !== undefined) next[key] = v;
        }
        if (!on) next.enabled = false;
        if (!quiet) rememberEdit();
        state.recipe[n] = next;
        const c = checkStep(next, n);
        status.textContent = c.error || c.text;
        status.className = c.error ? 'hint err' : 'hint';
        item.classList.toggle('bad', !!c.error);
        if (!quiet) stepsChanged();
      };
      for (const [key, type, label] of fields) {
        const wrap = el('span');
        const field = makeField(type, step[key], () => update());
        wrap.append(el('label', null, label), field.node);
        readers.push([key, field.read]);
        box2.appendChild(wrap);
      }
      const actions = el('div', 'stepactions');
      for (const [label, iconName, tip, shift] of [['Move up', 'up', 'move up', -1], ['Move down', 'down', 'move down', 1]]) {
        const b = button('btn small', label, iconName, tip);
        b.disabled = shift < 0 ? n === 0 : n === state.recipe.length - 1;
        b.addEventListener('click', () => {
          remember();
          const [moved] = state.recipe.splice(n, 1);
          state.recipe.splice(n + shift, 0, moved);
          openStep = n + shift;
          renderSteps();
          stepsChanged();
        });
        actions.appendChild(b);
      }
      body.append(box2, actions);
      box.append(head, body);
      item.append(rail, box);
      list.appendChild(item);
      update(true);
    });
    const on = state.recipe.filter(s => s.enabled !== false).length;
    $('stepSummary').textContent = state.recipe.length
      ? `${on} of ${state.recipe.length} step${state.recipe.length === 1 ? '' : 's'} on · run in order`
      : 'optional; the steps run in order';
    $('procCard').classList.toggle('active', !!state.recipe.length);
  }

  // The recipe, cell or volumes changed: the output choices and a processed
  // preview may no longer hold.
  function stepsChanged() {
    updateButton();
    markPreviewStale();
    if (preview.view === 'profile' && preview.stage === 'input') {
      clearTimeout(preview.ptimer);
      preview.ptimer = setTimeout(loadProfile, 300);
    }
  }

  function addSteps(steps) {
    remember();
    for (const s of steps) {
      // every field starts from its default, so presets name only what differs
      const step = JSON.parse(JSON.stringify(Object.assign({}, STEP_START[s.op] || {}, s)));
      if (step.op === 'combine' && !step.file && state.extraNames.length) step.file = state.extraNames[0];
      if (step.op === 'normalize' && !step.norm && state.extraNames.length) step.norm = state.extraNames[0];
      state.recipe.push(step);
    }
    openStep = state.recipe.length - 1;
    renderSteps();
    stepsChanged();
  }

  $('addStep').addEventListener('click', () => {
    const op = $('stepOp').value;
    addSteps([Object.assign({ op }, STEP_START[op] || {})]);
  });

  $('clearRecipe').addEventListener('click', () => {
    if (state.recipe.length) remember();
    state.recipe = [];
    openStep = null;
    renderSteps();
    stepsChanged();
  });

  $('saveRecipe').addEventListener('click', () => {
    const text = JSON.stringify({ version: 1, steps: state.recipe }, null, 2) + '\n';
    download([text], ((state.data && state.data.baseName) || 'processing') + '_recipe.json', 'application/json');
  });

  // A recipe object (or a bare list of steps) as editor steps: checked,
  // defaults filled in, switched-off steps kept.
  function parseRecipe(raw) {
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.steps) ? raw.steps : null;
    if (!list) throw new Error('expected { "steps": [ ... ] }');
    const steps = Processing.normalizeRecipe({
      steps: list.map(s => Object.fromEntries(Object.entries(s || {}).filter(([k]) => k !== 'enabled'))),
    }).steps;
    return steps.map((s, i) => (list[i] && list[i].enabled === false ? Object.assign(s, { enabled: false }) : s));
  }

  async function loadRecipeFile(file) {
    try {
      const steps = parseRecipe(JSON.parse(await file.text()));
      remember();
      state.recipe = steps;
      openStep = null;
      renderSteps();
      stepsChanged();
      log(`Recipe "${file.name}": ${state.recipe.length} step(s)`, 'ok');
    } catch (e) {
      log(`Error reading recipe "${file.name}": ${e.message}`, 'err');
    }
  }
  $('loadRecipe').addEventListener('click', () => $('recipeFile').click());

  function openJson(open) {
    $('jsonPanel').hidden = !open;
    $('jsonBtn').setAttribute('aria-expanded', String(open));
    if (!open) return;
    $('recipeJson').value = JSON.stringify({ version: 1, steps: state.recipe }, null, 2);
    $('jsonError').textContent = '';
    $('recipeJson').focus();
  }
  $('jsonBtn').addEventListener('click', () => openJson($('jsonPanel').hidden));
  $('jsonCancel').addEventListener('click', () => openJson(false));
  $('jsonApply').addEventListener('click', () => {
    try {
      const steps = parseRecipe(JSON.parse($('recipeJson').value));
      remember();
      state.recipe = steps;
      openStep = null;
      renderSteps();
      stepsChanged();
      openJson(false);
      log(`Recipe applied from JSON: ${steps.length} step(s)`, 'ok');
    } catch (e) {
      $('jsonError').textContent = e.message;
    }
  });
  $('recipeFile').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    if (file) await loadRecipeFile(file);
    ev.target.value = '';
  });

  const presetMenu = $('presetMenu');
  for (const p of PRESETS) {
    const b = button(null);
    b.append(el('span', null, p.name), el('small', null, p.note));
    b.addEventListener('click', () => {
      closePresets();
      addSteps(p.steps);
      log(`Preset "${p.name}" added; check the parameters for your data.`);
    });
    presetMenu.appendChild(b);
  }
  function closePresets() {
    presetMenu.hidden = true;
    $('presetBtn').setAttribute('aria-expanded', 'false');
  }
  $('presetBtn').addEventListener('click', ev => {
    ev.stopPropagation();
    const open = presetMenu.hidden;
    presetMenu.hidden = !open;
    $('presetBtn').setAttribute('aria-expanded', String(open));
    if (open) presetMenu.querySelector('button').focus();
  });
  presetMenu.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      closePresets();
      $('presetBtn').focus();
    }
  });
  document.addEventListener('click', ev => {
    if (!presetMenu.hidden && !presetMenu.contains(ev.target)) closePresets();
  });

  // Other volumes for combine steps, read whole by the worker.
  function renderExtras() {
    $('extraChips').replaceChildren(...state.extraFiles.map(f => {
      const chip = el('span', 'chip soft');
      chip.append(icon('layers', 15), document.createTextNode(f.name));
      const x = button(null, '', 'x', 'Remove ' + f.name);
      x.addEventListener('click', () => loadExtras(state.extraFiles.filter(g => g !== f)));
      chip.appendChild(x);
      return chip;
    }));
  }

  async function loadExtras(files) {
    $('extraInfo').textContent = '';
    state.extraFiles = files;
    state.extraNames = [];
    renderExtras();
    try {
      const list = await run('Reading volumes…', 'loadExtras', { files, readSigma: $('readSigma').checked, zeroEmpty: $('zeroEmpty').checked });
      state.extraNames = list.map(x => x.name);
      for (const x of list) {
        log(`Volume "${x.name}": grid ${x.dims.join(' x ')}` + (x.frame === 'q' ? ' in Q' : ''), 'ok');
        logNotes(x.notes);
      }
    } catch (e) {
      $('extraInfo').textContent = 'Error: ' + (e.cancelled ? 'reading cancelled' : e.message);
      log('Error reading volumes: ' + e.message, 'err');
    }
    renderSteps();
    stepsChanged();
  }
  $('extraBtn').addEventListener('click', () => $('extraFiles').click());
  $('extraFiles').addEventListener('change', ev => {
    const added = Array.from(ev.target.files);
    loadExtras(state.extraFiles.filter(f => !added.some(a => a.name === f.name)).concat(added));
    ev.target.value = '';
  });

  // ------------------------------------------------------------ preview
  const VIRIDIS = [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137],
    [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]];
  const DIVERGING = [[33, 64, 154], [67, 118, 190], [140, 180, 222], [246, 246, 244], [243, 179, 104], [218, 123, 34], [160, 72, 6]];
  const preview = {
    view: 'slice', stage: 'input', normal: 2, index: null, plane: null, profile: null, hover: -1,
    point: null, names: null, cursor: null,
    // colour levels: 'volume' (the whole volume's range, kept for every plane),
    // 'slice' (each plane's own range) or 'set' (typed, in data units)
    levelMode: 'volume', levelSet: null,
    // slice zoom (scale and offset in CSS pixels of the plot) and its plane;
    // the |Q| range shown in the profile (null: all)
    zoom: { z: 1, x: 0, y: 0, key: '' }, qRange: null,
    // a custom plane: its normal, the point it goes through (null: the
    // middle of the data) and its offset t along the unit normal (null: from
    // the slider index, else 0); the frame ('grid' or 'cartesian')
    vector: [1, -1, 0], origin: null, offset: null, frame: 'grid',
    ready: false, stale: false, seq: 0, timer: 0, ptimer: 0,
  };

  function colorAt(stops, f) {
    const x = Math.min(1, Math.max(0, f)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), u = x - i;
    return [0, 1, 2].map(c => Math.round(stops[i][c] + (stops[i + 1][c] - stops[i][c]) * u));
  }
  const gradient = stops => 'linear-gradient(to top, ' +
    stops.map((s, i) => `rgb(${s.join(',')}) ${(100 * i / (stops.length - 1)).toFixed(1)}%`).join(', ') + ')';

  function resetPreview(s) {
    preview.stage = 'input';
    preview.plane = null;
    preview.ready = false;
    preview.stale = false;
    preview.index = null;
    preview.origin = null;
    preview.offset = null;
    preview.normal = s ? (s.dims.indexOf(1) >= 0 ? s.dims.indexOf(1) : 2) : 2;
    $('customRow').hidden = true;
    preview.profile = null;
    preview.point = null;
    preview.names = null;
    preview.cursor = null;
    preview.levelMode = 'volume';
    preview.levelSet = null;
    preview.qRange = null;
    $('levelSlice').checked = false;
    $('sliceMark').hidden = true;
    $('previewEmpty').hidden = !!s;
    showView();
    $('previewSub').textContent = '';
    $('readout').textContent = 'Point at the slice to read values · the wheel zooms, dragging pans';
    setPreviewButtons();
  }

  function setPreviewButtons(names) {
    for (const b of $('viewSeg').children) b.disabled = !state.data || !!current;
    for (const b of $('stageSeg').children) {
      b.setAttribute('aria-pressed', String(b.dataset.stage === preview.stage));
      b.disabled = !state.data || !!current || (b.dataset.stage === 'processed' && !activeRecipe().length);
    }
    const n = names || (state.data ? state.data.names && axisRanges(state.data).map(r => r.name) : null) || ['h', 'k', 'l'];
    for (const b of $('planeSeg').children) {
      if (b.dataset.normal === 'custom') {
        b.setAttribute('aria-pressed', String(preview.normal === 'custom'));
        b.disabled = !state.data || !!current || state.data.dims.filter(d => d > 1).length < 2;
        continue;
      }
      const normal = Number(b.dataset.normal);
      b.textContent = [0, 1, 2].filter(a => a !== normal).map(a => n[a]).join(' ');
      b.setAttribute('aria-pressed', String(normal === preview.normal));
      b.disabled = !state.data || !!current || (state.data && state.data.dims[normal] === 1 && state.data.dims.indexOf(1) !== normal);
    }
  }

  function markPreviewStale() {
    setPreviewButtons();
    if (!preview.ready || preview.stale) return;
    preview.stale = true;
    if (preview.stage === 'processed') $('previewSub').textContent = 'the recipe changed · press Process to update';
  }

  async function loadSlice() {
    if (!state.data || current) return;
    const token = ++preview.seq;
    try {
      // the pinned point, in the order of the grid coordinates, places new planes
      const names = (preview.plane && preview.plane.names) || state.data.names || null;
      const point = preview.point && names && names.every(k => k in preview.point) ? names.map(k => preview.point[k]) : null;
      const args = {
        stage: preview.stage, normal: preview.normal, index: preview.index, frame: preview.frame,
        cell: previewCell(), ub: currentUB(), point: preview.index === null ? point : null,
      };
      if (preview.normal === 'custom') {
        const o = preview.origin;
        args.vector = preview.vector;
        args.origin = o && names && names.every(k => k in o) ? names.map(k => o[k]) : null;
        args.offset = preview.offset;
      }
      const plane = await client.call('slice', args).promise;
      if (token !== preview.seq) return;
      preview.plane = plane;
      preview.index = plane.normal.index;
      if (preview.normal === 'custom') {
        const n = plane.normal, xyz = v => v.map(x => fmtNum(x)).join(' ');
        preview.offset = n.level;
        ['origin0', 'origin1', 'origin2'].forEach((id, i) => {
          if (document.activeElement !== $(id)) $(id).value = fmtNum(n.origin[i]);
        });
        $('normalNote').textContent = `${plane.x.name} ∥ ${n.text.u}, ${plane.y.name} ∥ ${n.text.v}` +
          `${plane.skew ? ' (square to u in Q)' : ''} · centre ${xyz(n.centre)} · t along n̂`;
      }
      const zoomKey = `${plane.width}x${plane.height} ${plane.x.name} ${plane.y.name}` +
        (plane.general && plane.normal.unit ? ` ${plane.normal.unit.join(' ')}` : '');
      if (zoomKey !== preview.zoom.key) {
        preview.zoom.key = zoomKey;
        resetZoom();
      }
      preview.cursor = null;
      const slider = $('sliceIndex');
      slider.max = String(plane.normal.n - 1);
      slider.value = String(plane.normal.index);
      slider.disabled = plane.normal.n < 2;
      $('sliceName').textContent = plane.normal.name;
      const unit = plane.unit ? ` ${plane.unit}` : '';
      $('axisX').textContent = `${plane.x.name}  ${fmtNum(plane.x.from)} … ${fmtNum(plane.x.to)}${unit}`;
      $('axisY').textContent = plane.y.name;
      if (!plane.general) {
        setPreviewButtons([0, 1, 2].map(a => (a === preview.normal ? plane.normal.name
          : a === [0, 1, 2].filter(b => b !== preview.normal)[0] ? plane.x.name : plane.y.name)));
      } else {
        setPreviewButtons();
      }
      if (!preview.stale) {
        $('previewSub').textContent = preview.stage === 'processed' ? 'after the recipe' : 'as read';
      }
      drawSlice();
      placeMark();
    } catch (e) {
      if (token === preview.seq) $('previewSub').textContent = 'no preview: ' + e.message;
    }
  }

  // Grid coordinate of pixel i along a plane axis.
  const coordOf = (axis, i) => (axis.n > 1 ? axis.from + i * (axis.to - axis.from) / (axis.n - 1) : axis.from);
  const indexOf = (axis, x) => (axis.n > 1 && axis.to !== axis.from ? Math.round((x - axis.from) / (axis.to - axis.from) * (axis.n - 1)) : 0);

  // The value under plane pixel (ix, iy from the top), as readout text.
  // Grid coordinates (hkl, uvw or Q) of plane pixel (ix, iy from the top).
  function pixelPoint(p, ix, iy) {
    const r = p.height - 1 - iy, px = p.pixel;
    return [0, 1, 2].map(c => px.origin[c] + ix * px.dx[c] + r * px.dy[c]);
  }
  // Plane pixel of grid coordinates x (its projection onto the plane).
  function pointPixel(p, x) {
    const px = p.pixel, n = [px.dx[1] * px.dy[2] - px.dx[2] * px.dy[1], px.dx[2] * px.dy[0] - px.dx[0] * px.dy[2],
      px.dx[0] * px.dy[1] - px.dx[1] * px.dy[0]];
    const M = [0, 1, 2].map(r => [px.dx[r], px.dy[r], n[r]]);
    const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
      M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    if (!det) return null;
    const d = x.map((v, i) => v - px.origin[i]);
    const col = (k, v) => M.map((row, r) => row.map((m, c) => (c === k ? v[r] : m)));
    const det3 = A => A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
      A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    return [Math.round(det3(col(0, d)) / det), p.height - 1 - Math.round(det3(col(1, d)) / det)];
  }

  // The value under plane pixel (ix, iy from the top), as readout text.
  function readoutAt(ix, iy) {
    const p = preview.plane, x = pixelPoint(p, ix, iy);
    const val = p.values[iy * p.width + ix], names = p.names || ['h', 'k', 'l'];
    const what = names[0] === 'u' ? 'P' : 'I';
    let q = '';
    if (p.cartesian && p.cartesian.source !== 'none') {
      const M = p.cartesian.M, v = [0, 1, 2].map(r => M[r][0] * x[0] + M[r][1] * x[1] + M[r][2] * x[2]);
      q = `   |${names[0] === 'u' ? 'r' : 'Q'}| ${fmtNum(Math.hypot(...v))} ${p.cartesian.unit}`;
    }
    const outside = p.outside && p.outside[iy * p.width + ix];
    return names.map((n, i) => `${n} ${fmtNum(x[i])}`).join('   ') + q + '   ' +
      (outside ? 'outside the grid' : val === val ? `${what} = ${fmtNum(val, 4)}` : 'no data');
  }

  // The marker at the pinned point (or the keyboard cursor) in this plane.
  function placeMark() {
    const p = preview.plane, mark = $('sliceMark');
    let ix, iy;
    if (p && preview.cursor) {
      [ix, iy] = preview.cursor;
    } else if (p && preview.point && p.names && p.names.every(n => n in preview.point)) {
      const at = pointPixel(p, p.names.map(n => preview.point[n]));
      if (at) [ix, iy] = at;
    }
    mark.hidden = !(ix >= 0 && ix < p.width && iy >= 0 && iy < p.height);
    if (mark.hidden) return;
    mark.style.left = `${(100 * (ix + 0.5) / p.width).toFixed(3)}%`;
    mark.style.top = `${(100 * (iy + 0.5) / p.height).toFixed(3)}%`;
  }

  // Pin the point under plane pixel (ix, iy); other planes then go through it.
  function pinPoint(ix, iy) {
    const p = preview.plane, x = pixelPoint(p, ix, iy);
    preview.point = Object.fromEntries((p.names || ['h', 'k', 'l']).map((n, i) => [n, x[i]]));
    preview.cursor = null;
    // custom planes go through it too; this one (it lies on it) now from t = 0
    preview.origin = Object.assign({}, preview.point);
    placeMark();
    const text = readoutAt(ix, iy) + '   · pinned; the other planes go through it';
    $('readout').textContent = text;
    if (preview.normal === 'custom') {
      preview.offset = null;
      preview.index = null;
      loadSlice().then(() => { $('readout').textContent = text; });
    }
  }

  function percentile(sorted, p) {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : NaN;
  }

  function drawSlice() {
    const p = preview.plane;
    if (!p) return;
    const canvas = $('sliceCanvas'), w = p.width, h = p.height, v = p.values;
    canvas.width = w;
    canvas.height = h;
    fitCanvas();                                // also picks the rendering: voxels when coarse or zoomed
    const direct = (p.names || [])[0] === 'u';
    const logScale = $('logScale').checked && !direct;
    $('logScale').disabled = direct;
    // Robust range from a sample of the finite values.
    const step = Math.max(1, Math.floor(v.length / 40000));
    const finite = [];
    let nan = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (x !== x) {
        nan++;
        continue;
      }
      if (x < min) min = x;
      if (x > max) max = x;
      if (i % step === 0) finite.push(logScale ? x : direct ? Math.abs(x) : x);
    }
    // The levels, in data units: typed, the whole volume's (kept while
    // moving through the planes) or this plane's own.
    const mode = preview.levelMode === 'set' && preview.levelSet ? 'set'
      : preview.levelMode === 'volume' && p.levels ? 'volume' : 'slice';
    let lo, hi, tf;
    if (mode === 'set') {
      [lo, hi] = preview.levelSet;
      if (logScale) {
        const floor = p.levels && p.levels.log[0] > 0 ? p.levels.log[0] : 1e-6;
        lo = Math.log10(lo > 0 ? lo : Math.min(floor, hi > 0 ? hi / 1000 : floor));
        hi = Math.log10(hi > 0 ? hi : 1);
      }
    } else if (direct) {
      if (mode === 'volume') {
        hi = p.levels.abs || 1;
      } else {
        finite.sort((a, b) => a - b);
        hi = percentile(finite, 0.998) || 1;
      }
      lo = -hi;
    } else if (logScale) {
      let a, b;
      if (mode === 'volume') {
        [a, b] = p.levels.log;
      } else {
        const pos = finite.filter(x => x > 0).sort((x, y) => x - y);
        [a, b] = [percentile(pos, 0.01), percentile(pos, 0.998)];
      }
      lo = Math.log10(a || 1e-3);
      hi = Math.log10(b || 1);
    } else if (mode === 'volume') {
      [lo, hi] = p.levels.lin;
    } else {
      finite.sort((a, b) => a - b);
      lo = percentile(finite, 0.005);
      hi = percentile(finite, 0.995);
    }
    tf = logScale && !direct ? (x => (x > 0 ? Math.log10(x) : lo)) : (x => x);
    if (!(hi > lo)) hi = lo + 1;
    const stops = direct ? DIVERGING : VIRIDIS;
    const nanHex = getComputedStyle(document.documentElement).getPropertyValue('--nan').trim() || '#c9ced8';
    const nanRgb = [1, 3, 5].map(i => parseInt(nanHex.slice(i, i + 2), 16));
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      const rgb = x === x ? colorAt(stops, (tf(x) - lo) / (hi - lo)) : nanRgb;
      d[4 * i] = rgb[0];
      d[4 * i + 1] = rgb[1];
      d[4 * i + 2] = rgb[2];
      d[4 * i + 3] = p.outside && p.outside[i] ? 0 : 255;         // beyond the grid: the background
    }
    ctx.putImageData(img, 0, 0);
    $('colorbar').style.background = gradient(stops);
    const label = t => fmtNum(logScale ? 10 ** t : t, 3);
    $('colorTicks').replaceChildren(el('span', null, label(hi)), el('span', null, label((lo + hi) / 2)), el('span', null, label(lo)));
    drawHistogram(v, step, t => (tf(t) - lo) / (hi - lo), stops);
    $('histoLo').textContent = label(lo);
    $('histoHi').textContent = label(hi);
    for (const [id, value] of [['levelLo', lo], ['levelHi', hi]]) {
      if (document.activeElement !== $(id)) $(id).value = label(value);
    }
    $('levelNote').textContent = mode === 'volume' ? 'whole volume, kept for every plane'
      : mode === 'set' ? 'as typed, kept for every plane' : 'this plane only';
    const n = p.normal, at = Number.isFinite(n.level) ? n.level : n.n > 1 ? n.from + n.index * (n.to - n.from) / (n.n - 1) : n.from;
    if (document.activeElement !== $('sliceAt')) $('sliceAt').value = fmtNum(at);
    $('sliceStats').replaceChildren(
      stat('Slice', `${n.name} = ${fmtNum(at)} · ${n.index + 1} of ${n.n}`),
      stat('Values', Number.isFinite(min) ? `${fmtNum(min)} … ${fmtNum(max)}` : 'none'),
      stat('No data', `${(100 * (nan - (p.outside ? p.outside.reduce((s, x) => s + x, 0) : 0)) / v.length).toFixed(1)} % of the slice`),
      stat('Scale', (direct ? 'linear, centred on 0' : logScale ? 'log₁₀' : 'linear') +
        (mode === 'volume' ? ', volume levels' : mode === 'set' ? ', set levels' : ', slice levels')));
  }

  // Counts of the (sampled) finite values across the colour scale; the
  // end bins also hold what the scale clips. Heights go as the square root.
  function drawHistogram(v, step, frac, stops) {
    const canvas = $('histogram'), dpr = window.devicePixelRatio || 1;
    const w = Math.max(100, Math.round(canvas.clientWidth * dpr)), h = Math.round(56 * dpr);
    canvas.width = w;
    canvas.height = h;
    const bins = new Float64Array(64);
    for (let i = 0; i < v.length; i += step) {
      const x = v[i];
      if (x === x) bins[Math.min(63, Math.max(0, Math.floor(frac(x) * 64)))]++;
    }
    const top = Math.sqrt(Math.max(...bins)) || 1, ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const bw = w / 64;
    for (let b = 0; b < 64; b++) {
      if (!bins[b]) continue;
      const bh = Math.max(1, Math.round((h - 2) * Math.sqrt(bins[b]) / top));
      ctx.fillStyle = `rgb(${colorAt(stops, (b + 0.5) / 64).join(',')})`;
      ctx.fillRect(Math.round(b * bw), h - bh, Math.max(1, Math.round(bw) - 1), bh);
    }
  }

  $('sliceCanvas').addEventListener('mousemove', ev => {
    const p = preview.plane;
    if (!p) return;
    const r = ev.currentTarget.getBoundingClientRect();
    const ix = Math.min(p.width - 1, Math.max(0, Math.floor((ev.clientX - r.left) / r.width * p.width)));
    const iy = Math.min(p.height - 1, Math.max(0, Math.floor((ev.clientY - r.top) / r.height * p.height)));
    $('readout').textContent = readoutAt(ix, iy);
  });
  $('sliceCanvas').addEventListener('click', ev => {
    const p = preview.plane;
    if (!p || drag.moved) return;
    const r = ev.currentTarget.getBoundingClientRect();
    pinPoint(Math.min(p.width - 1, Math.max(0, Math.floor((ev.clientX - r.left) / r.width * p.width))),
      Math.min(p.height - 1, Math.max(0, Math.floor((ev.clientY - r.top) / r.height * p.height))));
  });
  // Keyboard: arrows move a cursor, Enter or Space pins it, Page Up and
  // Page Down step through the planes.
  $('sliceCanvas').addEventListener('keydown', ev => {
    const p = preview.plane;
    if (!p) return;
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (move) {
      ev.preventDefault();
      const stride = ev.shiftKey ? 10 : 1;
      const at = preview.cursor || [Math.floor(p.width / 2), Math.floor(p.height / 2)];
      preview.cursor = [Math.min(p.width - 1, Math.max(0, at[0] + move[0] * stride)),
        Math.min(p.height - 1, Math.max(0, at[1] + move[1] * stride))];
      placeMark();
      $('readout').textContent = readoutAt(preview.cursor[0], preview.cursor[1]);
    } else if ((ev.key === 'Enter' || ev.key === ' ') && preview.cursor) {
      ev.preventDefault();
      pinPoint(preview.cursor[0], preview.cursor[1]);
    } else if (ev.key === 'PageUp' || ev.key === 'PageDown') {
      ev.preventDefault();
      preview.index = Math.min(p.normal.n - 1, Math.max(0, p.normal.index + (ev.key === 'PageUp' ? 1 : -1)));
      preview.offset = null;
      loadSlice();
    } else if (ev.key === '+' || ev.key === '=' || ev.key === '-' || ev.key === '_') {
      ev.preventDefault();
      const wrap = $('canvasWrap');
      zoomAt(ev.key === '+' || ev.key === '=' ? 1.5 : 1 / 1.5, wrap.clientWidth / 2, wrap.clientHeight / 2);
    } else if (ev.key === '0') {
      ev.preventDefault();
      resetZoom();
    }
  });
  $('sliceCanvas').addEventListener('mouseleave', () => {
    $('readout').textContent = 'Point at the slice to read values · the wheel zooms, dragging pans';
  });

  // Zoom and pan: the wheel or + and − zoom about the pointer (or the
  // middle), dragging pans, 0 or a double-click shows the whole plane. The
  // canvas keeps its voxels; the layer holding it and the pin is scaled.
  const drag = { at: null, moved: false };
  // The largest box of the plane's proportions (its spans, so lengths stay
  // true) that fits the plot area; the zoom works inside it.
  // In the column that stays in view the area fills the preview panel;
  // elsewhere it is as high as the plot, up to 64 % of the window.
  const wideWindow = window.matchMedia('(min-width: 1101px)');
  function fitCanvas() {
    const area = $('plotArea'), wrap = $('canvasWrap'), p = preview.plane;
    const fill = wideWindow.matches && $('previewCard').parentElement === COLUMNS[1];
    const W = area.clientWidth, H = fill ? area.clientHeight : Math.min(0.64 * window.innerHeight, 560);
    if (p && W && H) {
      const spanX = Math.abs(p.x.to - p.x.from) || 1, spanY = Math.abs(p.y.to - p.y.from) || 1;
      const ratio = Math.min(4, Math.max(0.25, spanX / spanY));
      const w = Math.max(40, Math.floor(Math.min(W, H * ratio))), h = Math.max(40, Math.floor(Math.min(H, W / ratio)));
      wrap.style.width = `${w}px`;
      wrap.style.height = `${h}px`;
      area.style.height = fill ? '' : `${h}px`;
    }
    applyZoom();
  }
  new ResizeObserver(() => {
    if (preview.view === 'slice') fitCanvas();
    else if (preview.profile) drawProfile();
  }).observe($('plotArea'));
  new ResizeObserver(() => {
    if (preview.view === 'profile' && preview.profile) drawProfile();
  }).observe($('profileCanvas'));
  function applyZoom() {
    const wrap = $('canvasWrap'), zm = preview.zoom, W = wrap.clientWidth, H = wrap.clientHeight;
    zm.z = Math.min(64, Math.max(1, zm.z));
    zm.x = Math.min(0, Math.max(W - W * zm.z, zm.x));
    zm.y = Math.min(0, Math.max(H - H * zm.z, zm.y));
    $('zoomLayer').style.transform = zm.z > 1 ? `translate(${zm.x}px, ${zm.y}px) scale(${zm.z})` : '';
    wrap.style.setProperty('--zoom', String(zm.z));
    wrap.classList.toggle('zoomed', zm.z > 1);
    $('zoomOut').disabled = $('zoomReset').disabled = zm.z <= 1;
    const p = preview.plane;
    // Coarse grids, or a zoom that makes voxels big, show their voxels.
    if (p) $('sliceCanvas').style.imageRendering = Math.max(p.width, p.height) < 256 || zm.z * W > 3 * p.width ? 'pixelated' : 'auto';
  }
  function zoomAt(factor, cx, cy) {
    const zm = preview.zoom, z = Math.min(64, Math.max(1, zm.z * factor));
    zm.x = cx - (cx - zm.x) * z / zm.z;
    zm.y = cy - (cy - zm.y) * z / zm.z;
    zm.z = z;
    applyZoom();
  }
  function resetZoom() {
    Object.assign(preview.zoom, { z: 1, x: 0, y: 0 });
    applyZoom();
  }
  $('canvasWrap').addEventListener('wheel', ev => {
    if (!preview.plane) return;
    ev.preventDefault();
    const r = $('canvasWrap').getBoundingClientRect();
    zoomAt(Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015)), ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });
  $('sliceCanvas').addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    drag.at = { x: ev.clientX, y: ev.clientY, x0: preview.zoom.x, y0: preview.zoom.y };
    drag.moved = false;
    try {
      $('sliceCanvas').setPointerCapture(ev.pointerId);
    } catch (_) {
      // not a live pointer (synthetic events)
    }
  });
  $('sliceCanvas').addEventListener('pointermove', ev => {
    if (!drag.at) return;
    const dx = ev.clientX - drag.at.x, dy = ev.clientY - drag.at.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved && preview.zoom.z > 1) {
      preview.zoom.x = drag.at.x0 + dx;
      preview.zoom.y = drag.at.y0 + dy;
      $('canvasWrap').classList.add('panning');
      applyZoom();
    }
  });
  const endDrag = () => {
    drag.at = null;
    $('canvasWrap').classList.remove('panning');
    // the click that follows a drag is not a pin; later clicks are
    setTimeout(() => { drag.moved = false; }, 0);
  };
  $('sliceCanvas').addEventListener('pointerup', endDrag);
  $('sliceCanvas').addEventListener('pointercancel', endDrag);
  $('sliceCanvas').addEventListener('dblclick', resetZoom);
  $('zoomIn').addEventListener('click', () => zoomAt(1.5, $('canvasWrap').clientWidth / 2, $('canvasWrap').clientHeight / 2));
  $('zoomOut').addEventListener('click', () => zoomAt(1 / 1.5, $('canvasWrap').clientWidth / 2, $('canvasWrap').clientHeight / 2));
  $('zoomReset').addEventListener('click', resetZoom);
  window.addEventListener('resize', applyZoom);
  $('sliceIndex').addEventListener('input', () => {
    preview.index = Number($('sliceIndex').value);
    preview.offset = null;
    clearTimeout(preview.timer);
    preview.timer = setTimeout(loadSlice, 40);
  });
  $('logScale').addEventListener('change', drawSlice);
  // A typed plane position: the nearest plane.
  $('sliceAt').addEventListener('change', () => {
    const p = preview.plane, x = parseNum($('sliceAt').value);
    if (!p || !Number.isFinite(x)) {
      drawSlice();
      return;
    }
    if (preview.normal === 'custom') {
      preview.offset = x;
      preview.index = null;
    } else {
      preview.index = Math.min(p.normal.n - 1, Math.max(0, indexOf(p.normal, x)));
    }
    $('sliceAt').blur();
    loadSlice();
  });
  // Typed levels stay for every plane until auto (or per slice).
  function setLevels() {
    const lo = parseNum($('levelLo').value), hi = parseNum($('levelHi').value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) {
      drawSlice();
      return;
    }
    preview.levelMode = 'set';
    preview.levelSet = [lo, hi];
    $('levelSlice').checked = false;
    drawSlice();
  }
  for (const id of ['levelLo', 'levelHi']) $(id).addEventListener('change', setLevels);
  $('levelAuto').addEventListener('click', () => {
    preview.levelMode = 'volume';
    preview.levelSet = null;
    $('levelSlice').checked = false;
    drawSlice();
  });
  $('levelSlice').addEventListener('change', () => {
    preview.levelMode = $('levelSlice').checked ? 'slice' : 'volume';
    preview.levelSet = null;
    drawSlice();
  });
  for (const b of $('planeSeg').children) {
    b.addEventListener('click', () => {
      preview.normal = b.dataset.normal === 'custom' ? 'custom' : Number(b.dataset.normal);
      preview.index = null;
      preview.offset = null;
      $('customRow').hidden = preview.normal !== 'custom';
      setPreviewButtons();
      loadSlice();
    });
  }
  // A typed normal: its plane through the origin (t = 0).
  const readNormal = () => {
    const v = ['normal0', 'normal1', 'normal2'].map(id => parseNum($(id).value));
    if (!v.every(Number.isFinite) || v.every(x => x === 0)) return;
    preview.vector = v;
    preview.index = null;
    preview.offset = null;
    clearTimeout(preview.timer);
    preview.timer = setTimeout(loadSlice, 200);
  };
  for (const id of ['normal0', 'normal1', 'normal2']) $(id).addEventListener('input', readNormal);
  // A typed point the plane goes through (t = 0 there); middle: the data's.
  const readOrigin = () => {
    const v = ['origin0', 'origin1', 'origin2'].map(id => parseNum($(id).value));
    const names = preview.plane && preview.plane.names;
    if (!v.every(Number.isFinite) || !names) return;
    preview.origin = Object.fromEntries(names.map((k, i) => [k, v[i]]));
    preview.index = null;
    preview.offset = null;
    clearTimeout(preview.timer);
    preview.timer = setTimeout(loadSlice, 200);
  };
  for (const id of ['origin0', 'origin1', 'origin2']) $(id).addEventListener('input', readOrigin);
  $('originMiddle').addEventListener('click', () => {
    preview.origin = null;
    preview.index = null;
    preview.offset = null;
    loadSlice();
  });
  $('cartesian').addEventListener('change', () => {
    preview.frame = $('cartesian').checked ? 'cartesian' : 'grid';
    loadSlice();
  });

  // The cell and UB the preview draws a Cartesian plane with.
  function previewCell() {
    const src = cellSource();
    const c = src === 'data' ? dataCell() : src === 'structure' ? state.struct : manualCell();
    return c ? { lengths: c.lengths.slice(), angles: c.angles.slice() } : null;
  }


  for (const b of $('stageSeg').children) {
    b.addEventListener('click', async () => {
      if (b.dataset.stage === 'input') {
        preview.stage = 'input';
        preview.index = null;
        setPreviewButtons();
        refreshPreview();
        return;
      }
      if (preview.ready && !preview.stale) {
        preview.stage = 'processed';
        preview.index = null;
        setPreviewButtons();
        refreshPreview();
        return;
      }
      processForPreview();
    });
  }

  // Run the recipe and show its result in the preview (the stage buttons
  // compare it with the data as read). The worker keeps the result, so a
  // Download with the same data, cell and recipe writes it as it is.
  async function processForPreview() {
    const params = checkedParams();
    if (!params) return;
    try {
      const r = await run('Processing…', 'previewRecipe', params);
      preview.stage = 'processed';
      preview.ready = true;
      preview.stale = false;
      preview.index = null;
      log(`Preview of the processed data: grid ${r.dims.join(' x ')}` + (r.axesType === 'uvw' ? ' in direct space (u, v, w)' : ''), 'ok');
      setPreviewButtons();
      await refreshPreview();
    } catch (e) {
      log(e.cancelled ? 'Cancelled.' : 'Error: ' + e.message, e.cancelled ? 'warn' : 'err');
    }
  }
  $('processBtn').addEventListener('click', () => {
    clearLog();
    processForPreview();
  });

  // ------------------------------------------------------------ |Q| profile
  function showView() {
    const profile = preview.view === 'profile';
    for (const b of $('viewSeg').children) {
      b.setAttribute('aria-pressed', String(b.dataset.view === preview.view));
      b.disabled = !state.data;
    }
    $('previewView').hidden = !state.data || profile;
    $('profileView').hidden = !state.data || !profile;
    $('planeSeg').hidden = profile;
  }

  function refreshPreview() {
    return preview.view === 'profile' ? loadProfile() : loadSlice();
  }

  function redrawPreview() {
    if (preview.view === 'profile') drawProfile();
    else drawSlice();
  }

  // The cell choice for the worker (the grid config too, for Q-space VTK).
  function cellParams() {
    const src = cellSource();
    const params = { manual: src === 'manual' ? manualCell() : null, cellPrefer: src };
    if (state.gridConfig && state.data && state.data.kind === 'vtk') {
      const index = pickGrid(state.gridConfig, state.data.main);
      params.grid = state.gridConfig.grids[index];
      params.customFrame = state.gridConfig.customFrame;
    }
    return params;
  }

  async function loadProfile() {
    if (!state.data || current) return;
    const width = Number($('profileShell').value);
    if (!(width > 0)) {
      $('profileNote').textContent = 'the shell width must be a positive number';
      return;
    }
    const token = ++preview.seq;
    $('profileNote').textContent = 'computing…';
    try {
      const p = await client.call('profile', { stage: preview.stage, width, params: cellParams() }).promise;
      if (token !== preview.seq) return;
      preview.profile = p;
      preview.hover = -1;
      $('profileNote').textContent = `${p.q.length} shells with data`;
      if (!preview.stale) $('previewSub').textContent = preview.stage === 'processed' ? 'after the recipe' : 'as read';
    } catch (e) {
      if (token !== preview.seq) return;
      preview.profile = null;
      $('profileNote').textContent = e.message;
    }
    drawProfile();
  }

  // 1, 2 or 5 times a power of ten, near x.
  function niceStep(x) {
    const e = 10 ** Math.floor(Math.log10(x)), f = x / e;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * e;
  }

  function drawProfile() {
    const canvas = $('profileCanvas'), p = preview.profile, dpr = window.devicePixelRatio || 1;
    const W = Math.max(200, Math.round(canvas.clientWidth * dpr)), H = Math.round(Math.max(200, canvas.clientHeight || 380) * dpr);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement), col = name => css.getPropertyValue(name).trim();
    ctx.clearRect(0, 0, W, H);
    if (!p || !p.q.length) return;
    const [qa, qb] = profileRange(p);
    const shown = i => p.q[i] >= qa && p.q[i] <= qb;
    const logY = $('profileLog').checked && p.mean.some(v => v > 0);
    const ty = v => (logY ? (v > 0 ? Math.log10(v) : NaN) : v);
    const lo = p.mean.map((v, i) => ty(v - p.sigma[i])), hi = p.mean.map((v, i) => ty(v + p.sigma[i])), mid = p.mean.map(ty);
    let ylo = Infinity, yhi = -Infinity;
    [mid, hi, lo].forEach(list => list.forEach((y, i) => {
      if (Number.isFinite(y) && shown(i)) {
        ylo = Math.min(ylo, y);
        yhi = Math.max(yhi, y);
      }
    }));
    if (!logY) ylo = Math.min(ylo, 0);
    if (!(yhi > ylo)) yhi = ylo + 1;
    const pad = 0.05 * (yhi - ylo);
    ylo -= pad;
    yhi += pad;
    const m = { l: 62 * dpr, r: 14 * dpr, t: 12 * dpr, b: 32 * dpr };
    const X = q => m.l + (W - m.l - m.r) * (q - qa) / (qb - qa);
    const Y = y => H - m.b - (H - m.t - m.b) * (y - ylo) / (yhi - ylo);
    ctx.font = `${11 * dpr}px ${col('--mono')}`;
    ctx.lineWidth = dpr;
    ctx.strokeStyle = col('--border');
    ctx.fillStyle = col('--muted');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xs = niceStep((qb - qa) / 6);
    for (let q = Math.ceil(qa / xs - 1e-9) * xs; q <= qb + 1e-9; q += xs) {
      ctx.beginPath();
      ctx.moveTo(X(q), m.t);
      ctx.lineTo(X(q), H - m.b);
      ctx.stroke();
      ctx.fillText(fmtNum(q, 2), X(q), H - m.b + 6 * dpr);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    // Linear: 1-2-5 steps. Log: decades, or 1, 2, 5 per decade over a short range.
    const yticks = [];
    if (!logY) {
      const ystep = niceStep((yhi - ylo) / 5);
      for (let y = Math.ceil(ylo / ystep) * ystep; y <= yhi; y += ystep) yticks.push(y);
    } else {
      const every = Math.max(1, Math.round((yhi - ylo) / 5));
      for (let k = Math.floor(ylo); k <= Math.ceil(yhi); k++) {
        for (const f of yhi - ylo < 2.5 ? [1, 2, 5] : [1]) {
          const y = k + Math.log10(f);
          if (y >= ylo && y <= yhi && (f > 1 || k % every === 0)) yticks.push(y);
        }
      }
    }
    for (const y of yticks) {
      ctx.beginPath();
      ctx.moveTo(m.l, Y(y));
      ctx.lineTo(W - m.r, Y(y));
      ctx.stroke();
      ctx.fillText(logY ? sig(10 ** y) : fmtNum(y, 3), m.l - 8 * dpr, Y(y));
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('|Q| (Å⁻¹)', W - m.r, H - m.b - 4 * dpr);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(logY ? 'mean I (log scale)' : 'mean I', m.l + 6 * dpr, m.t + 2 * dpr);
    // ±sigma band, then the mean, inside the plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.l, m.t, W - m.l - m.r, H - m.t - m.b);
    ctx.clip();
    ctx.fillStyle = col('--accent-soft');
    ctx.beginPath();
    let open = false;
    const band = [];
    for (let i = 0; i < p.q.length; i++) if (Number.isFinite(hi[i]) && Number.isFinite(lo[i])) band.push(i);
    band.forEach((i, k) => (k ? ctx.lineTo(X(p.q[i]), Y(hi[i])) : ctx.moveTo(X(p.q[i]), Y(hi[i]))));
    for (let k = band.length - 1; k >= 0; k--) ctx.lineTo(X(p.q[band[k]]), Y(lo[band[k]]));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = col('--accent');
    ctx.lineWidth = 1.8 * dpr;
    ctx.beginPath();
    for (let i = 0; i < p.q.length; i++) {
      if (!Number.isFinite(mid[i])) {
        open = false;
        continue;
      }
      if (open) ctx.lineTo(X(p.q[i]), Y(mid[i]));
      else ctx.moveTo(X(p.q[i]), Y(mid[i]));
      open = true;
    }
    ctx.stroke();
    ctx.restore();
    if (preview.hover >= 0 && preview.hover < p.q.length && Number.isFinite(mid[preview.hover]) && shown(preview.hover)) {
      const x = X(p.q[preview.hover]), y = Y(mid[preview.hover]);
      ctx.strokeStyle = col('--muted');
      ctx.lineWidth = dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(x, m.t);
      ctx.lineTo(x, H - m.b);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col('--accent');
      ctx.beginPath();
      ctx.arc(x, y, 4 * dpr, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // The |Q| range shown: all of it, or the zoomed part.
  function profileRange(p) {
    const half = p.q.length > 1 ? (p.q[1] - p.q[0]) / 2 : 0.05, full = [0, p.q[p.q.length - 1] + half];
    return preview.qRange ? preview.qRange : full;
  }
  // |Q| under a pointer x position on the profile canvas.
  function profileQ(ev) {
    const p = preview.profile, r = $('profileCanvas').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = r.width * dpr, left = 62 * dpr, right = 14 * dpr, [qa, qb] = profileRange(p);
    return qa + ((ev.clientX - r.left) * dpr - left) / (W - left - right) * (qb - qa);
  }
  function setQRange(qa, qb) {
    const p = preview.profile, half = p.q.length > 1 ? (p.q[1] - p.q[0]) / 2 : 0.05, full = p.q[p.q.length - 1] + half;
    const span = Math.min(full, Math.max(4 * half, qb - qa));
    qa = Math.min(full - span, Math.max(0, qa));
    preview.qRange = span >= full - 1e-12 ? null : [qa, qa + span];
    drawProfile();
  }
  const qdrag = { at: null };
  $('profileCanvas').addEventListener('wheel', ev => {
    const p = preview.profile;
    if (!p || !p.q.length) return;
    ev.preventDefault();
    const q = profileQ(ev), [qa, qb] = profileRange(p), f = Math.exp(ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
    setQRange(q - (q - qa) * f, q + (qb - q) * f);
  }, { passive: false });
  $('profileCanvas').addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || !preview.profile || !preview.qRange) return;
    qdrag.at = { x: ev.clientX, range: preview.qRange.slice() };
    try {
      $('profileCanvas').setPointerCapture(ev.pointerId);
    } catch (_) {
      // not a live pointer (synthetic events)
    }
  });
  $('profileCanvas').addEventListener('pointerup', () => { qdrag.at = null; });
  $('profileCanvas').addEventListener('dblclick', () => {
    preview.qRange = null;
    drawProfile();
  });
  $('profileCanvas').addEventListener('mousemove', ev => {
    const p = preview.profile;
    if (!p || !p.q.length) return;
    if (qdrag.at) {
      // the plot spans the canvas less 62 + 14 CSS pixels of margins
      const [qa, qb] = qdrag.at.range, width = $('profileCanvas').getBoundingClientRect().width - 76;
      const dq = (ev.clientX - qdrag.at.x) / Math.max(1, width) * (qb - qa);
      setQRange(qa - dq, qb - dq);
      return;
    }
    const q = profileQ(ev);
    let best = 0;
    for (let i = 1; i < p.q.length; i++) if (Math.abs(p.q[i] - q) < Math.abs(p.q[best] - q)) best = i;
    preview.hover = best;
    $('profileReadout').textContent = `|Q| ${fmtNum(p.q[best], 3)} Å⁻¹   mean I = ${sig(p.mean[best], 4)} ± ${sig(p.sigma[best], 2)}   ` +
      `${fmtInt(p.n[best])} voxels`;
    drawProfile();
  });
  $('profileCanvas').addEventListener('mouseleave', () => {
    preview.hover = -1;
    $('profileReadout').textContent = 'Point at the curve to read values · the wheel zooms |Q|, dragging pans';
    drawProfile();
  });
  $('profileLog').addEventListener('change', drawProfile);
  $('profileShell').addEventListener('change', loadProfile);
  for (const b of $('viewSeg').children) {
    b.addEventListener('click', () => {
      preview.view = b.dataset.view;
      showView();
      refreshPreview();
    });
  }

  // ------------------------------------------------------------ output
  const SUFFIX = {
    unified: '_unified.h5', yell: '_yell.h5', dat: '_diffuse3d.dat', vtk: '_diffuse.vtk', profile: '_profile.txt', hkl: '_hkl.txt',
    npz: '.npz', vti: '.vti', mrc: '.mrc',
  };
  const FORMAT_TITLE = {
    unified: 'Unified HDF5', yell: 'Yell 1.0', dat: 'RMCProfile .dat', vtk: 'Legacy VTK', profile: '|Q| profile', hkl: 'hkl list',
    npz: 'NumPy .npz', vti: 'VTK XML .vti', mrc: 'CCP4/MRC map',
  };
  // Written in pieces through a file sink (text, and binary legacy VTK).
  const STREAMED = new Set(['dat', 'vtk', 'profile', 'hkl', 'vti']);
  // Formats for Q-space grids only, and for direct-space (3D-ΔPDF) grids only.
  const RECIPROCAL_FORMATS = new Set(['dat', 'vtk', 'profile', 'hkl']);
  const DIRECT_FORMATS = new Set(['mrc']);
  // The formats each output option applies to.
  const USES = {
    precision: ['unified', 'yell', 'npz', 'vti'], layout: ['unified'], compression: ['unified', 'yell'],
    radiation: ['unified', 'yell', 'npz'],
  };

  // The output file name: Spinteract and Scatty read their data by name.
  function fileNameFor(base, tag, format) {
    if (format === 'hkl' && $('hklTarget').value === 'spinteract') return `${base}${tag}_xtal_data_01.txt`;
    if (format === 'hkl' && $('hklTarget').value === 'scatty') return 'scatty_data_01.txt';
    if (format === 'dat' && $('datFrame').value === 'hkl') return `${base}${tag}_diffuse3d_hkl.dat`;
    return base + tag + SUFFIX[format];
  }

  // Direct-space output: a 3D-ΔPDF in the recipe, or direct-space input.
  const directOutput = () => !!state.data && (state.data.axesType === 'uvw' || activeRecipe().some(s => s.op === 'deltaPdf'));

  function outputName() {
    const s = state.data, steps = activeRecipe().length;
    const tag = !steps ? '' : directOutput() && s.axesType !== 'uvw' ? '_dpdf' : '_processed';
    return fileNameFor(s.baseName || 'converted', tag, $('outFormat').value);
  }

  function updateOutput() {
    const select = $('outFormat');
    const direct = directOutput();
    const offFor = f => (direct ? RECIPROCAL_FORMATS.has(f) : !!state.data && DIRECT_FORMATS.has(f));
    if (offFor(select.value)) select.value = 'unified';
    for (const card of $('formatCards').children) {
      const f = card.dataset.format, off = offFor(f);
      card.disabled = off;
      card.setAttribute('aria-pressed', String(select.value === f));
      const note = card.querySelector('small');
      note.textContent = !off ? note.dataset.note
        : direct ? 'Q-space grids only; this output is a 3D-ΔPDF' : 'Direct-space maps only; add a 3D-ΔPDF step';
    }
    const fmt = select.value;
    for (const seg of document.querySelectorAll('.seg[data-for]')) {
      const target = $(seg.dataset.for);
      const idle = !USES[seg.dataset.for].includes(fmt);
      for (const b of seg.children) {
        b.setAttribute('aria-pressed', String(b.dataset.value === target.value));
        b.disabled = idle;
      }
    }
    $('radiation').disabled = !USES.radiation.includes(fmt);
    $('profileOpts').hidden = fmt !== 'profile';
    $('vtkOpts').hidden = fmt !== 'vtk';
    $('hklOpts').hidden = fmt !== 'hkl';
    $('datOpts1').hidden = $('datOpts2').hidden = fmt !== 'dat';
    $('outCard').classList.toggle('done', !!state.data);
    if (seriesRunning) return;                 // the bar shows the series position
    const s = state.data;
    if (!s) {
      $('outName').textContent = 'No data loaded yet';
      $('outDetail').textContent = 'Load a data file to choose an output';
      return;
    }
    $('outName').textContent = outputName();
    const precision = $('precision').value;
    const single = precision === 'float32' || (precision === 'same' && s.precision === 'float32' && !direct);
    const bytes = Converter.estimateOutputBytes({ dims: s.dims, values: single ? new Float32Array(0) : new Float64Array(0) },
      fmt, { precision, layout: $('layout').value, binary: $('vtkEncoding').value === 'binary',
        nsec: $('datSections').value === 'none' ? 1 : Processing.laueOperations($('datSections').value).length });
    $('outDetail').textContent = FORMAT_TITLE[fmt] + (fmt === 'vtk' && $('vtkEncoding').value === 'binary' ? ' · binary' : '') +
      (bytes ? ` · about ${fmtBytes(bytes)}` + (USES.compression.includes(fmt) && Number($('compression').value) ? ' before compression' : '') : '');
  }

  for (const card of $('formatCards').children) {
    card.addEventListener('click', () => {
      $('outFormat').value = card.dataset.format;
      $('outFormat').dispatchEvent(new Event('change'));
    });
  }
  for (const seg of document.querySelectorAll('.seg[data-for]')) {
    for (const b of seg.children) {
      b.addEventListener('click', () => {
        const target = $(seg.dataset.for);
        target.value = b.dataset.value;
        target.dispatchEvent(new Event('change'));
      });
    }
  }
  for (const id of ['outFormat', 'precision', 'layout', 'compression', 'radiation', 'hklTarget', 'datFrame', 'datSections', 'vtkEncoding']) {
    $(id).addEventListener('change', updateOutput);
  }
  for (const g of Processing.LAUE_GROUPS) {
    const opt = el('option', null, `${g} (nsec ${Processing.laueOperations(g).length})`);
    opt.value = g;
    $('datSections').appendChild(opt);
  }

  function download(bytes, filename, mime) {
    const blob = new Blob(Array.isArray(bytes) ? bytes : [bytes], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Where streamed output goes: straight to disk through the File System
  // Access API (Chromium), else a chunked in-memory download (separate pieces
  // avoid the maximum string length, but the Blob still has to fit in memory).
  async function openTextSink(filename, format, binary) {
    const mime = binary ? 'application/octet-stream' : 'text/plain';
    if ('showSaveFilePicker' in window) {
      try {
        const [description, extension] = {
          dat: ['RMCProfile old diffuse text format', '.dat'], vtk: ['VTK legacy file', '.vtk'], profile: ['|Q| profile', '.txt'],
          hkl: ['hkl list', '.txt'], vti: ['VTK XML image data', '.vti'],
        }[format];
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description, accept: { [mime]: [extension] } }],
        });
        const writable = await handle.createWritable();
        return {
          how: 'streamed directly to disk',
          write: chunk => writable.write(chunk),
          close: () => writable.close(),
          abort: () => writable.abort().catch(() => {}),
        };
      } catch (e) {
        if (e.name === 'AbortError') throw Object.assign(new Error('cancelled'), { cancelled: true });
        log(`No save dialog (${e.message}); building the download in memory instead.`);
      }
    } else {
      log('Direct file streaming is unavailable in this browser; building a chunked download in memory.');
    }
    const parts = [];
    return {
      how: 'prepared as a chunked browser download',
      write: chunk => { parts.push(chunk); },
      close: () => download(parts, filename, mime),
      abort: () => {},
    };
  }

  // The conversion parameters, or null (with the reasons logged) when a
  // step or an option is not valid.
  function checkedParams() {
    const src = cellSource();
    const steps = activeRecipe();
    const params = {
      format: $('outFormat').value, radiation: $('radiation').value,
      manual: src === 'manual' ? manualCell() : null, cellPrefer: src,
      precision: $('precision').value, layout: $('layout').value, compression: Number($('compression').value),
      recipe: steps.length ? { version: 1, steps } : null,
      profileWidth: Number($('profileWidth').value), hklTarget: $('hklTarget').value,
      datFrame: $('datFrame').value, datSections: $('datSections').value, vtkEncoding: $('vtkEncoding').value,
      ub: state.ubManual || undefined,
    };
    const bad = state.recipe.map((s, n) => [n + 1, s.enabled === false ? null : checkStep(s, n).error]).filter(x => x[1]);
    for (const [n, error] of bad) log(`Error: processing step ${n}: ${error}`, 'err');
    if (bad.length) return null;
    if (params.format === 'profile' && !(params.profileWidth > 0)) {
      log('Error: the |Q| shell width must be a positive number', 'err');
      return null;
    }
    if (state.gridConfig && state.data && state.data.kind === 'vtk') {
      const index = pickGrid(state.gridConfig, state.data.main);
      params.grid = state.gridConfig.grids[index];
      params.customFrame = state.gridConfig.customFrame;
      if (state.gridConfig.grids.length > 1) log(`Using grid ${index + 1} of ${state.gridConfig.grids.length} from the config.`);
    }
    return params;
  }

  // Where output goes: the browser's save dialog or a download, or a folder
  // the user picked (a series). text() gives a sink for streamed output,
  // bytes() saves a whole file; both say how in their `how`.
  const BROWSER_SAVER = {
    text: openTextSink,
    async bytes(name, data, mime) {
      download(data, name, mime);
      return 'downloaded';
    },
  };

  function folderSaver(dir) {
    const open = async name => {
      let existed = true;
      try {
        await dir.getFileHandle(name);
      } catch (_) {
        existed = false;
      }
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      return { writable, how: `into the folder "${dir.name}"` + (existed ? ', replacing the old file' : '') };
    };
    return {
      async text(name) {
        const { writable, how } = await open(name);
        return { how, write: chunk => writable.write(chunk), close: () => writable.close(), abort: () => writable.abort().catch(() => {}) };
      },
      async bytes(name, data) {
        const { writable, how } = await open(name);
        await writable.write(data);
        await writable.close();
        return how;
      },
    };
  }

  // Prepare and write the data the worker holds with `params` and save the
  // output through `saver`; base and inputAxes name the output. Returns
  // the output name.
  async function convertLoaded(params, base, inputAxes, saver) {
    const format = params.format, streamed = STREAMED.has(format);
    let sink = null;
    try {
      const plan = await run(params.recipe ? 'Processing…' : 'Preparing…', 'prepare', params);
      logNotes(plan.notes);
      const direct = plan.axesType === 'uvw';
      log(`Grid ${plan.dims.join(' x ')} (${plan.dims[0] * plan.dims[1] * plan.dims[2]} points)` +
        (direct ? ' in direct space (u, v, w)' : ''));
      log(`Cell for hkl <-> Q: ${fmtCell(plan.cell)}  [from ${plan.cellSource}]`);
      if (plan.estimate) {
        log(`Output: about ${fmtBytes(plan.estimate)}` + (USES.compression.includes(format) && params.compression ? ' before compression' : '') + '.');
      }
      const tag = !plan.processed ? '' : direct && inputAxes !== 'uvw' ? '_dpdf' : '_processed';
      const outName = fileNameFor(base, tag, format);
      const t0 = Date.now();
      if (plan.nonFinite) {
        log(`${fmtInt(plan.nonFinite)} NaN/infinite voxels written as 0` +
          (format === 'dat' ? ' (RMCProfile leaves points with I = 0 out of the fit).' : '.'), 'warn');
      }
      if (streamed) {
        sink = await saver.text(outName, format, format === 'vtk' && params.vtkEncoding === 'binary');
        const written = await run('Writing…', 'write', {}, { onChunk: chunk => sink.write(chunk) });
        await sink.close();
        log(`Wrote ${outName} (${sink.how})`, 'ok');
        const r = written && written.report;
        if (r) {
          log(`${fmtInt(r.written)} rows written` + (r.noSigma ? '; no uncertainties, so every sigma is 1' : '') +
            (r.badSigma ? `; ${fmtInt(r.badSigma)} voxels without a positive sigma left out` : ''), r.noSigma || r.badSigma ? 'warn' : 'info');
        }
        if (written && written.snippet) log(`Grid for the ${params.hklTarget === 'scatty' ? 'Scatty' : 'Spinteract'} config:\n${written.snippet}`);
      } else {
        if (plan.estimate > 1.9 * 1073741824) {
          log(USES.compression.includes(format)
            ? 'Warning: HDF5 files are assembled in memory, and Chrome/Edge cannot hold one above ' +
              'about 2 GB; float32, the /entry/data-only layout or compression reduce the size (or use the command-line tool).'
            : 'Warning: this file is assembled in memory, and above about 2 GB the browser may fail; float32 halves it.', 'err');
        }
        const result = await run('Writing…', 'write', {});
        const how = result.kind === 'blob'
          ? await saver.bytes(outName, result.blob, 'application/octet-stream')
          : await saver.bytes(outName, result.bytes, 'application/x-hdf5');
        log(`Wrote ${outName} in ${((Date.now() - t0) / 1000).toFixed(1)} s (${how})`, 'ok');
      }
      return outName;
    } catch (e) {
      if (sink) await sink.abort();
      throw e;
    }
  }

  $('convertBtn').addEventListener('click', async () => {
    clearLog();
    const params = checkedParams();
    if (!params) return;
    try {
      const outName = await convertLoaded(params, state.data.baseName || 'converted', state.data.axesType, BROWSER_SAVER);
      $('outDetail').textContent = `Saved ${outName}`;
      // the worker now holds this recipe's result: the processed preview is current
      if (params.recipe && (!preview.ready || preview.stale)) {
        const shown = preview.stage === 'processed';
        preview.ready = true;
        preview.stale = false;
        setPreviewButtons();
        if (shown) refreshPreview();
      }
    } catch (e) {
      if (e.cancelled) log('Cancelled.', 'warn');
      else log('Error: ' + e.message, 'err');
    }
  });

  // ------------------------------------------------------------ series
  // The current cell, recipe and output settings applied to each chosen file
  // in turn (a temperature or composition series): written into one folder
  // where the browser allows it, else downloaded one by one. A file that
  // fails is reported and the series goes on; Cancel stops it.
  const baseNameOf = name => name.replace(/\.(h5|hdf5|hdf|he5|nx|nxs|nx5|dat|txt|vtk|npz|json)$/i, '');

  async function convertSeries(files) {
    clearLog();
    const params = checkedParams();
    if (!params) return;
    let saver = BROWSER_SAVER;
    if ('showDirectoryPicker' in window && window.showDirectoryPicker) {
      try {
        saver = folderSaver(await window.showDirectoryPicker({ mode: 'readwrite' }));
      } catch (e) {
        if (e.name === 'AbortError') return;
        log(`No folder access (${e.message}); each output is downloaded instead.`, 'warn');
      }
    }
    log(`Series of ${files.length} files to ${FORMAT_TITLE[params.format]}, with this page's cell, recipe and output settings.`);
    const title = $('outName').textContent;
    let done = 0;
    seriesRunning = true;
    for (const [i, file] of files.entries()) {
      const label = `${i + 1} of ${files.length}: ${file.name}`;
      $('outName').textContent = `Series ${label}`;
      try {
        const cfg = state.gridConfig;
        const s = await run(`Reading ${i + 1}/${files.length}…`, 'loadData', {
          files: [file], paths: [''], yellSpace: $('yellSpace').value, nexusPath: null, crop: readCrop(),
          readSigma: $('readSigma').checked, zeroEmpty: $('zeroEmpty').checked, grid: cfg ? cfg.grids[pickGrid(cfg, file.name)] : null,
        });
        if (!s || !s.dims) throw new Error(s && s.cellFiles ? 'the file holds a unit cell, not a volume' : 'no data read');
        log(`${label}: ${KIND_LABEL[s.kind] || s.kind} | grid ${s.dims.join(' x ')}`, 'ok');
        const p = Object.assign({}, params, { grid: undefined, customFrame: undefined });
        if (cfg && s.kind === 'vtk') {
          p.grid = cfg.grids[pickGrid(cfg, file.name)];
          p.customFrame = cfg.customFrame;
        }
        await convertLoaded(p, baseNameOf(file.name), s.axesType, saver);
        done++;
      } catch (e) {
        if (e.cancelled) {
          log('Series cancelled.', 'warn');
          break;
        }
        log(`Error: ${file.name}: ${e.message}`, 'err');
      }
    }
    seriesRunning = false;
    log(`${done} of ${files.length} converted.`, done === files.length ? 'ok' : 'warn');
    $('outName').textContent = title;
    // The worker now holds the last file of the series: reload the page's own.
    if (state.dataFiles.length) await loadDataFile(state.data && state.data.nexusPath);
    else updateButton();
  }
  $('seriesBtn').addEventListener('click', () => $('seriesFiles').click());
  $('seriesFiles').addEventListener('change', ev => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    if (files.length) convertSeries(files);
  });

  renderSteps();
  renderExtras();
  updateOutput();
  setPreviewButtons();
})();
