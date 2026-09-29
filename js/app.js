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
    'extraFiles', 'extraBtn', 'addStep', 'loadRecipe', 'clearRecipe', 'presetBtn'];

  function updateButton() {
    $('convertBtn').disabled = !state.data || !!current;
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
    dat: 'RMCProfile .dat', vtk: 'VTK · Q', 'vtk-hkl': 'VTK · r.l.u.',
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
      stat('Step · type', `${steps || '–'} · ${s.precision}`));
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
        yellSpace: $('yellSpace').value, nexusPath: nexusPath || null, crop: readCrop(),
      });
      if (!s) return;
      s.baseName = s.main.replace(/\.(h5|hdf5|hdf|he5|nx|nxs|nx5|dat|txt|vtk)$/i, '');
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
      if (s.kind === 'dat') {
        info = `RMCProfile old text format | grid ${s.dims.join(' x ')} in Q`;
      } else if (s.kind === 'vtk') {
        info = `VTK STRUCTURED_POINTS in Q | grid ${s.dims.join(' x ')}`;
      } else if (s.kind === 'vtk-hkl') {
        info = `VTK STRUCTURED_POINTS in r.l.u. ("${s.title}") | grid ${s.dims.join(' x ')}`;
      } else {
        const label = {
          yell: 'Yell 1.0', unified: 'Unified data format', 'mantid-md': 'Mantid MDHistoWorkspace', nexus: `NeXus ${s.nexusPath}`,
        }[s.kind];
        info = label + ` | grid ${s.dims.join(' x ')}` +
          (s.kind === 'unified' || s.kind === 'nexus' ? ` | axes ${s.axesType || 'hkl'}` : '') +
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
    } catch (e) {
      $('gridConfigInfo').textContent = 'Error: ' + e.message;
      log('Error reading grid config: ' + e.message, 'err');
    }
  }
  $('gridConfigFile').addEventListener('change', ev => loadGridConfig(ev.target.files[0]));

  // Spinteract writes one image per data set (..._img_NN.vtk) and one grid
  // per data set in its config; match them by number.
  function pickGrid(cfg, dataName) {
    const m = /_(\d+)\.vtk$/i.exec(dataName || '');
    const index = cfg.grids.length > 1 && m ? Number(m[1]) - 1 : 0;
    return index >= 0 && index < cfg.grids.length ? index : 0;
  }

  // Dropped or chosen files by content: recipes, structures, grid configs
  // and everything else as data.
  async function routeFiles(files) {
    const data = [];
    for (const f of files) {
      if (/\.json$/i.test(f.name)) await loadRecipeFile(f);
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
    if (current) {
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
  });

  async function loadStructureFile(file) {
    $('structInfo').textContent = '';
    state.struct = null;
    try {
      const parent = await run('Reading structure…', 'loadStructure', { file });
      if (parent) {
        state.struct = parent;
        const info = `parent cell ${fmtCell(parent)}` + (parent.supercell ? ` (supercell ${parent.supercell.join(' x ')})` : '');
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
  // 'clipTo' (a number or nan) or 'extra' (a loaded volume).
  const STEP_FORMS = {
    crop: ['Crop to hkl ranges', [['h', 'range', 'h'], ['k', 'range', 'k'], ['l', 'range', 'l']]],
    resample: ['Resample onto an hkl grid', [['h', 'axis', 'h min max step'], ['k', 'axis', 'k'], ['l', 'axis', 'l']]],
    rebin: ['Rebin', [['factors', 'ints3', 'factors along the grid axes']]],
    maskBragg: ['Mask Bragg peaks', [['shape', ['box', 'sphere'], 'shape'],
      ['size', 'num', 'half-width (box, r.l.u.) or radius (sphere, Å⁻¹)'],
      ['centring', ['P', 'I', 'F', 'C', 'A', 'B', 'R'], 'lattice centring']]],
    maskRings: ['Mask powder rings', [['q', 'nums', '|Q| of the rings (Å⁻¹)'], ['width', 'num', 'half-width (Å⁻¹)']]],
    maskRange: ['Mask a value range', [['min', 'num?', 'keep from'], ['max', 'num?', 'keep up to']]],
    scale: ['Scale and offset', [['factor', 'num', 'factor'], ['offset', 'num', 'offset']]],
    backgroundFunction: ['Subtract B(|Q|)', [
      ['kind', ['constant', 'linear', 'exponential', 'table'], 'kind'],
      ['params', 'json', 'parameters: [c], [a, b] for a + bQ, [a, b, c] for a − b c^Q, or [[Q, B], …]']]],
    backgroundShells: ['Background from |Q| shells', [['width', 'num', 'shell width (Å⁻¹)'],
      ['percentile', 'num', 'percentile per shell (0 = minimum)'], ['smooth', 'num', 'smooth over ± shells']]],
    combine: ['Combine with a volume', [['operation', ['subtract', 'add', 'multiply', 'divide'], 'operation'],
      ['file', 'extra', 'volume'], ['scale', 'num', 'times']]],
    clip: ['Replace low values', [['below', 'num', 'below'], ['to', 'clipTo', 'with (a number or nan)']]],
    symmetrize: ['Symmetrize', [['laue', Processing.LAUE_GROUPS, 'Laue group'],
      ['mode', ['average', 'fill'], 'average all, or fill empty voxels'], ['expand', 'bool', 'extend the grid']]],
    deltaPdf: ['3D-ΔPDF', [['taper', 'num', 'Tukey taper (0–1)'], ['engine', ['cpu', 'gpu'], 'FFT on (CPU float64, GPU float32)']]],
  };
  const STEP_GROUPS = [
    ['Grid', ['crop', 'resample', 'rebin']], ['Masks', ['maskBragg', 'maskRings', 'maskRange']],
    ['Background', ['backgroundShells', 'backgroundFunction', 'combine']], ['Values', ['scale', 'clip']],
    ['Symmetry', ['symmetrize']], ['Transform', ['deltaPdf']],
  ];
  const STEP_ICON = {
    crop: 'crop', resample: 'grid', rebin: 'grid', maskBragg: 'mask', maskRings: 'rings', maskRange: 'sliders',
    scale: 'sliders', backgroundFunction: 'curve', backgroundShells: 'curve', combine: 'layers', clip: 'sliders',
    symmetrize: 'sym', deltaPdf: 'wave',
  };
  // Starting values of a new step.
  const STEP_START = {
    crop: {}, resample: { h: [-2, 2, 0.05], k: [-2, 2, 0.05], l: [0, 0, 0] }, rebin: { factors: [2, 2, 2] },
    maskBragg: { shape: 'box', size: 0.1, centring: 'P' }, maskRings: { q: [], width: 0.05 }, maskRange: { min: 0 },
    scale: { factor: 1, offset: 0 }, backgroundFunction: { kind: 'constant', params: [0] },
    backgroundShells: { width: 0.05, percentile: 5, smooth: 1 }, combine: { operation: 'subtract', scale: 1 },
    clip: { below: 0, to: 0 }, symmetrize: { laue: 'm-3m', mode: 'average', expand: false },
    deltaPdf: { taper: 0, engine: 'cpu' },
  };
  const PRESETS = [
    { name: '3D-ΔPDF of a cubic crystal', note: 'm-3m symmetrize · Bragg mask · ΔPDF', steps: [
      { op: 'symmetrize', laue: 'm-3m', mode: 'average', expand: false },
      { op: 'maskBragg', shape: 'box', size: 0.2, centring: 'P' }, { op: 'deltaPdf', taper: 0, engine: 'cpu' }] },
    { name: 'Subtract a background volume', note: 'load it under Other volumes', steps: [
      { op: 'combine', operation: 'subtract', scale: 1 }] },
    { name: 'Diffuse scattering only', note: 'Bragg mask · background from |Q| shells', steps: [
      { op: 'maskBragg', shape: 'box', size: 0.1, centring: 'P' }, { op: 'backgroundShells', width: 0.05, percentile: 5, smooth: 1 }] },
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
    if (type === 'clipTo') {
      const e = input(value === undefined ? '' : String(value));
      return { node, read: () => (e.value.trim().toLowerCase() === 'nan' ? 'nan' : numberIn(e.value)) };
    }
    // 'extra': the loaded volumes, and a recipe's name that is not loaded
    const names = state.extraNames.slice();
    const labels = names.slice();
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
    updateOutput();
    markPreviewStale();
    if (preview.view === 'profile' && preview.stage === 'input') {
      clearTimeout(preview.ptimer);
      preview.ptimer = setTimeout(loadProfile, 300);
    }
  }

  function addSteps(steps) {
    remember();
    for (const s of steps) {
      const step = JSON.parse(JSON.stringify(s));
      if (step.op === 'combine' && !step.file && state.extraNames.length) step.file = state.extraNames[0];
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
      const list = await run('Reading volumes…', 'loadExtras', { files });
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
    preview.normal = s ? (s.dims.indexOf(1) >= 0 ? s.dims.indexOf(1) : 2) : 2;
    preview.profile = null;
    preview.point = null;
    preview.names = null;
    preview.cursor = null;
    $('sliceMark').hidden = true;
    $('previewEmpty').hidden = !!s;
    showView();
    $('previewSub').textContent = '';
    $('readout').textContent = 'Point at the slice to read values';
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
      const normal = Number(b.dataset.normal);
      b.textContent = [0, 1, 2].filter(a => a !== normal).map(a => n[a]).join(' ');
      b.setAttribute('aria-pressed', String(normal === preview.normal));
      b.disabled = !state.data || !!current || (state.data && state.data.dims[normal] === 1 && state.data.dims.indexOf(1) !== normal);
    }
  }

  function markPreviewStale() {
    setPreviewButtons();
    if (preview.stage !== 'processed' || preview.stale) return;
    preview.stale = true;
    $('previewSub').textContent = 'the recipe changed · press After recipe to update';
  }

  async function loadSlice() {
    if (!state.data || current) return;
    const token = ++preview.seq;
    try {
      const at = preview.index === null && preview.point && preview.names ? preview.point[preview.names[preview.normal]] : undefined;
      const plane = await client.call('slice', { stage: preview.stage, normal: preview.normal, index: preview.index, at }).promise;
      if (token !== preview.seq) return;
      preview.plane = plane;
      preview.index = plane.normal.index;
      preview.names = [0, 1, 2].map(a => (a === preview.normal ? plane.normal.name
        : a === [0, 1, 2].filter(b => b !== preview.normal)[0] ? plane.x.name : plane.y.name));
      preview.cursor = null;
      const slider = $('sliceIndex');
      slider.max = String(plane.normal.n - 1);
      slider.value = String(plane.normal.index);
      slider.disabled = plane.normal.n < 2;
      $('sliceName').textContent = plane.normal.name;
      $('axisX').textContent = `${plane.x.name}  ${fmtNum(plane.x.from)} … ${fmtNum(plane.x.to)}`;
      $('axisY').textContent = plane.y.name;
      setPreviewButtons([0, 1, 2].map(a => (a === preview.normal ? plane.normal.name
        : a === [0, 1, 2].filter(b => b !== preview.normal)[0] ? plane.x.name : plane.y.name)));
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
  function readoutAt(ix, iy) {
    const p = preview.plane;
    const x = coordOf(p.x, ix), y = coordOf(p.y, p.height - 1 - iy), z = coordOf(p.normal, p.normal.index);
    const val = p.values[iy * p.width + ix];
    const what = [p.x.name, p.y.name].includes('u') ? 'P' : 'I';
    return `${p.x.name} ${fmtNum(x)}   ${p.y.name} ${fmtNum(y)}   ${p.normal.name} ${fmtNum(z)}   ` +
      (val === val ? `${what} = ${fmtNum(val, 4)}` : 'no data');
  }

  // The marker at the pinned point (or the keyboard cursor) in this plane.
  function placeMark() {
    const p = preview.plane, mark = $('sliceMark');
    let ix, iy;
    if (p && preview.cursor) {
      [ix, iy] = preview.cursor;
    } else if (p && preview.point && [p.x.name, p.y.name].every(n => n in preview.point)) {
      ix = indexOf(p.x, preview.point[p.x.name]);
      iy = p.height - 1 - indexOf(p.y, preview.point[p.y.name]);
    }
    mark.hidden = !(ix >= 0 && ix < p.width && iy >= 0 && iy < p.height);
    if (mark.hidden) return;
    mark.style.left = `${(100 * (ix + 0.5) / p.width).toFixed(3)}%`;
    mark.style.top = `${(100 * (iy + 0.5) / p.height).toFixed(3)}%`;
  }

  // Pin the point under plane pixel (ix, iy); other planes then go through it.
  function pinPoint(ix, iy) {
    const p = preview.plane;
    preview.point = {
      [p.x.name]: coordOf(p.x, ix), [p.y.name]: coordOf(p.y, p.height - 1 - iy), [p.normal.name]: coordOf(p.normal, p.normal.index),
    };
    preview.cursor = null;
    placeMark();
    $('readout').textContent = readoutAt(ix, iy) + '   · pinned; the other planes go through it';
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
    const spanX = Math.abs(p.x.to - p.x.from) || 1, spanY = Math.abs(p.y.to - p.y.from) || 1;
    canvas.style.aspectRatio = String(Math.min(4, Math.max(0.25, spanX / spanY)));
    // Coarse grids show their voxels; fine ones are smoothed when scaled.
    canvas.style.imageRendering = Math.max(w, h) < 256 ? 'pixelated' : 'auto';
    const direct = [p.x.name, p.y.name, p.normal.name].includes('u');
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
    let lo, hi, tf;
    if (direct) {
      finite.sort((a, b) => a - b);
      hi = percentile(finite, 0.998) || 1;
      lo = -hi;
      tf = x => x;
    } else if (logScale) {
      const pos = finite.filter(x => x > 0).sort((a, b) => a - b);
      lo = Math.log10(percentile(pos, 0.01) || 1e-3);
      hi = Math.log10(percentile(pos, 0.998) || 1);
      tf = x => (x > 0 ? Math.log10(x) : lo);
    } else {
      finite.sort((a, b) => a - b);
      lo = percentile(finite, 0.005);
      hi = percentile(finite, 0.995);
      tf = x => x;
    }
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
      d[4 * i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    $('colorbar').style.background = gradient(stops);
    const label = t => fmtNum(logScale ? 10 ** t : t, 3);
    $('colorTicks').replaceChildren(el('span', null, label(hi)), el('span', null, label((lo + hi) / 2)), el('span', null, label(lo)));
    drawHistogram(v, step, t => (tf(t) - lo) / (hi - lo), stops);
    $('histoLo').textContent = label(lo);
    $('histoHi').textContent = label(hi);
    const n = p.normal, at = n.n > 1 ? n.from + n.index * (n.to - n.from) / (n.n - 1) : n.from;
    $('sliceValue').textContent = `= ${fmtNum(at)}`;
    $('sliceStats').replaceChildren(
      stat('Slice', `${n.name} = ${fmtNum(at)} · ${n.index + 1} of ${n.n}`),
      stat('Values', Number.isFinite(min) ? `${fmtNum(min)} … ${fmtNum(max)}` : 'none'),
      stat('No data', `${(100 * nan / v.length).toFixed(1)} % of the slice`),
      stat('Scale', direct ? 'linear, centred on 0' : logScale ? 'log₁₀, robust range' : 'linear, robust range'));
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
    if (!p) return;
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
      loadSlice();
    }
  });
  $('sliceCanvas').addEventListener('mouseleave', () => {
    $('readout').textContent = 'Point at the slice to read values';
  });
  $('sliceIndex').addEventListener('input', () => {
    preview.index = Number($('sliceIndex').value);
    clearTimeout(preview.timer);
    preview.timer = setTimeout(loadSlice, 40);
  });
  $('logScale').addEventListener('change', drawSlice);
  for (const b of $('planeSeg').children) {
    b.addEventListener('click', () => {
      preview.normal = Number(b.dataset.normal);
      preview.index = null;
      setPreviewButtons();
      loadSlice();
    });
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
      const params = checkedParams();
      if (!params) return;
      try {
        const r = await run('Processing for the preview…', 'previewRecipe', params);
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
    });
  }

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
    const W = Math.max(200, Math.round(canvas.clientWidth * dpr)), H = Math.round(380 * dpr);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement), col = name => css.getPropertyValue(name).trim();
    ctx.clearRect(0, 0, W, H);
    if (!p || !p.q.length) return;
    const logY = $('profileLog').checked && p.mean.some(v => v > 0);
    const ty = v => (logY ? (v > 0 ? Math.log10(v) : NaN) : v);
    const lo = p.mean.map((v, i) => ty(v - p.sigma[i])), hi = p.mean.map((v, i) => ty(v + p.sigma[i])), mid = p.mean.map(ty);
    let ylo = Infinity, yhi = -Infinity;
    for (const y of mid.concat(hi, lo)) {
      if (Number.isFinite(y)) {
        ylo = Math.min(ylo, y);
        yhi = Math.max(yhi, y);
      }
    }
    if (!logY) ylo = Math.min(ylo, 0);
    if (!(yhi > ylo)) yhi = ylo + 1;
    const pad = 0.05 * (yhi - ylo);
    ylo -= pad;
    yhi += pad;
    const half = p.q.length > 1 ? (p.q[1] - p.q[0]) / 2 : 0.05, qmax = p.q[p.q.length - 1] + half;
    const m = { l: 62 * dpr, r: 14 * dpr, t: 12 * dpr, b: 32 * dpr };
    const X = q => m.l + (W - m.l - m.r) * q / qmax;
    const Y = y => H - m.b - (H - m.t - m.b) * (y - ylo) / (yhi - ylo);
    ctx.font = `${11 * dpr}px ${col('--mono')}`;
    ctx.lineWidth = dpr;
    ctx.strokeStyle = col('--border');
    ctx.fillStyle = col('--muted');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xs = niceStep(qmax / 6);
    for (let q = 0; q <= qmax + 1e-9; q += xs) {
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
    // ±sigma band, then the mean
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
    if (preview.hover >= 0 && preview.hover < p.q.length && Number.isFinite(mid[preview.hover])) {
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

  $('profileCanvas').addEventListener('mousemove', ev => {
    const p = preview.profile;
    if (!p || !p.q.length) return;
    const r = ev.currentTarget.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = r.width * dpr, left = 62 * dpr, right = 14 * dpr;
    const half = p.q.length > 1 ? (p.q[1] - p.q[0]) / 2 : 0.05, qmax = p.q[p.q.length - 1] + half;
    const q = ((ev.clientX - r.left) * dpr - left) / (W - left - right) * qmax;
    let best = 0;
    for (let i = 1; i < p.q.length; i++) if (Math.abs(p.q[i] - q) < Math.abs(p.q[best] - q)) best = i;
    preview.hover = best;
    $('profileReadout').textContent = `|Q| ${fmtNum(p.q[best], 3)} Å⁻¹   mean I = ${sig(p.mean[best], 4)} ± ${sig(p.sigma[best], 2)}   ` +
      `${fmtInt(p.n[best])} voxels`;
    drawProfile();
  });
  $('profileCanvas').addEventListener('mouseleave', () => {
    preview.hover = -1;
    $('profileReadout').textContent = 'Point at the curve to read values';
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
  const SUFFIX = { unified: '_unified.h5', yell: '_yell.h5', dat: '_diffuse3d.dat', vtk: '_diffuse.vtk', profile: '_profile.txt' };
  const FORMAT_TITLE = { unified: 'Unified HDF5', yell: 'Yell 1.0', dat: 'RMCProfile .dat', vtk: 'Scatty VTK', profile: '|Q| profile' };
  const TEXT_FORMATS = new Set(['dat', 'vtk', 'profile']);

  // Direct-space output: a 3D-ΔPDF in the recipe, or direct-space input.
  const directOutput = () => !!state.data && (state.data.axesType === 'uvw' || activeRecipe().some(s => s.op === 'deltaPdf'));

  function outputName() {
    const s = state.data, steps = activeRecipe().length;
    const tag = !steps ? '' : directOutput() && s.axesType !== 'uvw' ? '_dpdf' : '_processed';
    return (s.baseName || 'converted') + tag + SUFFIX[$('outFormat').value];
  }

  function updateOutput() {
    const select = $('outFormat');
    const direct = directOutput();
    if (direct && TEXT_FORMATS.has(select.value)) select.value = 'unified';
    for (const card of $('formatCards').children) {
      const f = card.dataset.format, off = direct && TEXT_FORMATS.has(f);
      card.disabled = off;
      card.setAttribute('aria-pressed', String(select.value === f));
      const note = card.querySelector('small');
      note.textContent = off ? 'Q-space grids only; this output is a 3D-ΔPDF' : note.dataset.note;
    }
    const fmt = select.value, text = TEXT_FORMATS.has(fmt);
    for (const seg of document.querySelectorAll('.seg[data-for]')) {
      const target = $(seg.dataset.for);
      const idle = text || (seg.dataset.for === 'layout' && fmt !== 'unified');
      for (const b of seg.children) {
        b.setAttribute('aria-pressed', String(b.dataset.value === target.value));
        b.disabled = idle;
      }
    }
    $('radiation').disabled = text;
    $('profileOpts').hidden = fmt !== 'profile';
    $('outCard').classList.toggle('done', !!state.data);
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
      fmt, { precision, layout: $('layout').value });
    $('outDetail').textContent = FORMAT_TITLE[fmt] +
      (bytes ? ` · about ${fmtBytes(bytes)}` + (!text && Number($('compression').value) ? ' before compression' : '') : '');
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
  for (const id of ['outFormat', 'precision', 'layout', 'compression', 'radiation']) $(id).addEventListener('change', updateOutput);

  function download(bytes, filename, mime) {
    const blob = new Blob(Array.isArray(bytes) ? bytes : [bytes], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Where text output goes: straight to disk through the File System Access
  // API (Chromium), else a chunked in-memory download (separate strings avoid
  // the maximum string length, but the Blob still has to fit in memory).
  async function openTextSink(filename, format) {
    if ('showSaveFilePicker' in window) {
      try {
        const [description, extension] = {
          dat: ['RMCProfile old diffuse text format', '.dat'], vtk: ['VTK legacy file', '.vtk'], profile: ['|Q| profile', '.txt'],
        }[format];
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description, accept: { 'text/plain': [extension] } }],
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
      close: () => download(parts, filename, 'text/plain'),
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
      profileWidth: Number($('profileWidth').value),
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

  $('convertBtn').addEventListener('click', async () => {
    clearLog();
    const params = checkedParams();
    if (!params) return;
    const format = params.format, text = TEXT_FORMATS.has(format);
    let sink = null;
    try {
      const plan = await run(params.recipe ? 'Processing…' : 'Preparing…', 'prepare', params);
      logNotes(plan.notes);
      const direct = plan.axesType === 'uvw';
      log(`Grid ${plan.dims.join(' x ')} (${plan.dims[0] * plan.dims[1] * plan.dims[2]} points)` +
        (direct ? ' in direct space (u, v, w)' : ''));
      log(`Cell for hkl <-> Q: ${fmtCell(plan.cell)}  [from ${plan.cellSource}]`);
      if (plan.estimate) {
        log(`Output: about ${fmtBytes(plan.estimate)}` + (!text && params.compression ? ' before compression' : '') + '.');
      }
      const tag = !plan.processed ? '' : direct && state.data.axesType !== 'uvw' ? '_dpdf' : '_processed';
      const outName = (state.data.baseName || 'converted') + tag + SUFFIX[format];
      const t0 = Date.now();
      if (text) {
        if (plan.nonFinite) {
          log(`${fmtInt(plan.nonFinite)} NaN/infinite voxels written as 0` +
            (format === 'dat' ? ' (RMCProfile leaves points with I = 0 out of the fit).' : '.'), 'warn');
        }
        sink = await openTextSink(outName, format);
        await run('Writing…', 'write', {}, { onChunk: chunk => sink.write(chunk) });
        await sink.close();
        log(`Wrote ${outName} (${sink.how})`, 'ok');
      } else {
        if (plan.estimate > 1.9 * 1073741824) {
          log('Warning: HDF5 files are assembled in memory, and Chrome/Edge cannot hold one above ' +
            'about 2 GB; float32, the /entry/data-only layout or compression reduce the size.', 'err');
        }
        const result = await run('Writing…', 'write', {});
        download(result.bytes, outName, 'application/x-hdf5');
        log(`Wrote ${outName} in ${((Date.now() - t0) / 1000).toFixed(1)} s`, 'ok');
      }
      $('outDetail').textContent = `Saved ${outName}`;
    } catch (e) {
      if (sink) await sink.abort();
      if (e.cancelled) log('Cancelled.', 'warn');
      else log('Error: ' + e.message, 'err');
    }
  });

  renderSteps();
  renderExtras();
  updateOutput();
  setPreviewButtons();
})();
