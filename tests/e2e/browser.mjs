// Browser end-to-end test: drives index.html from file:// in headless Chrome
// or Edge through the DevTools protocol (no dependencies), feeding files into
// the real inputs and checking the log and the downloaded outputs.
//
//   npm run test:e2e        (set CHROME=/path/to/chrome if it is not found)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const H = require('../helpers.js');
const NX = require('../nexus-fixtures.js');
const Processing = require('../../js/processing.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// CHROME, else the usual install folders (from the environment) and PATH.
function findBrowser() {
    const env = process.env;
    const installed = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).flatMap(dir => [
        path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]);
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
    const onPath = (env.PATH || '').split(path.delimiter).filter(Boolean)
        .flatMap(dir => names.map(name => path.join(dir, name)));
    const found = [env.CHROME, ...installed, ...onPath].find(p => p && fs.existsSync(p));
    if (!found) throw new Error('no Chrome/Edge found; set CHROME to the browser executable');
    return found;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(os.tmpdir(), '3dsconvert-e2e-'));
const downloads = path.join(work, 'downloads');
fs.mkdirSync(downloads);

// Inputs generated here, so the test needs nothing outside the repository.
const t = 2 * Math.PI / 4;
fs.writeFileSync(path.join(work, 'rotated_sc.vtk'), H.vtkText('TITLE diffuse scattering', [5, 3, 1],
    [-t, -t, -t].map(x => x.toFixed(6)), [t * Math.SQRT2 / 2, t, 0].map(x => x.toFixed(6)),
    Array.from({ length: 15 }, (_, i) => i + 1)));
fs.writeFileSync(path.join(work, 'scatty_config.txt'), 'CENTRE 0 0 0\nX_AXIS 1 1 0 2\nY_AXIS 0 0 1 1\nZ_AXIS 0 0 0 0\n');

// NeXus inputs: a Mantid MDHistoWorkspace with a [H,H,0] projection, and an
// NXrefine-like entry whose data sit in a second file behind an external link.
const h5wasm = await H.loadH5wasm();
async function saveH5(filePromise, name) {
    const file = await filePromise;
    fs.writeFileSync(path.join(work, name), h5wasm.FS.readFile(file.filename));
    file.close();
}
await saveH5(NX.mantidFile({ W: [1, -1, 0, 1, 1, 0, 0, 0, 1], names: ['[H,H,0]', '[-H,H,0]', '[0,0,L]'] }), 'projected.nxs');
await saveH5(H.buildH5(f => f.create_group('entry').create_group('data').create_dataset({
    name: 'v', data: NX.fastestFirst(5, 4, 3, Float32Array), shape: [3, 4, 5], dtype: '<f',
})), 't.nxs');
await saveH5(NX.nxrefineFile({ link: 'scan/t.nxs' }), 'wrapper.nxs');
const rspace = await NX.rspace3dFile({});
await saveH5(Promise.resolve(rspace.file), 'volume_rspace3d.h5');
await saveH5(NX.subhklFile(), 'indexer.h5');

const port = 9300 + Math.floor(Math.random() * 600);
const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(work, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'];
if (process.env.CI) args.unshift('--no-sandbox');
const proc = spawn(findBrowser(), args, { stdio: 'ignore' });

let ws;
const pending = new Map();
const exceptions = [];
let seq = 0;
const send = (method, params = {}) => new Promise(resolve => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
    return r.result && r.result.result && r.result.result.value;
};

async function connect() {
    for (let i = 0; i < 80; i++) {
        await sleep(250);
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = list.find(x => x.type === 'page');
            if (page) {
                ws = new WebSocket(page.webSocketDebuggerUrl);
                await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
                ws.onmessage = ev => {
                    const msg = JSON.parse(ev.data);
                    if (msg.id && pending.has(msg.id)) {
                        pending.get(msg.id)(msg);
                        pending.delete(msg.id);
                    } else if (msg.method === 'Runtime.exceptionThrown') {
                        exceptions.push(msg.params.exceptionDetails.text);
                    }
                };
                return;
            }
        } catch (_) {
            // browser still starting
        }
    }
    throw new Error('could not connect to the browser');
}

const logText = () => evaluate('Array.from(document.getElementById("log").children).map(d => d.textContent).join("\\n")');
async function waitLog(pattern, ms = 30000) {
    const t0 = Date.now();
    let text = '';
    while (Date.now() - t0 < ms) {
        text = (await logText()) || '';
        if (pattern.test(text)) return text;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${pattern}; log:\n${text}`);
}
async function fresh() {
    await send('Page.navigate', { url: pathToFileURL(path.join(ROOT, 'index.html')).href });
    for (let i = 0; i < 200; i++) {
        await sleep(100);
        const text = await evaluate('document.getElementById("log").textContent').catch(() => '');
        if (/Ready\./.test(text || '')) return;
        if (/Could not start/.test(text || '')) throw new Error(text);
    }
    throw new Error('page did not become ready');
}
async function setFile(selector, file) {
    const doc = await send('DOM.getDocument', {});
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
    const r = await send('DOM.setFileInputFiles', { files: [].concat(file), nodeId: q.result.nodeId });
    if (r.error) throw new Error(r.error.message);
}
const setValue = (id, v) => evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)});
    e.value = ${JSON.stringify(String(v))}; e.dispatchEvent(new Event('change')); })()`);
// Click Convert once it is enabled (inputs still loading keep it disabled).
async function clickConvert() {
    await evaluate('window.showSaveFilePicker = undefined');   // no save dialog when headless
    for (let i = 0; i < 300 && await evaluate('document.getElementById("convertBtn").disabled'); i++) await sleep(100);
    await evaluate('document.getElementById("convertBtn").click()');
}
async function convert(outName) {
    await clickConvert();
    const text = await waitLog(new RegExp(`Wrote ${outName.replace(/\./g, '\\.')}|Error`));
    if (/Error/.test(text)) throw new Error(text);
    const file = path.join(downloads, outName);
    for (let i = 0; i < 200; i++) {
        if (fs.existsSync(file) && fs.statSync(file).size > 0) {
            await sleep(200);
            return file;
        }
        await sleep(100);
    }
    throw new Error('no download ' + outName);
}

const scenarios = [
    ['unified example -> .dat through the in-memory download', async () => {
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 5 x 5 x 5/);
        await setValue('outFormat', 'dat');
        const rows = fs.readFileSync(await convert('example_unified_diffuse3d.dat'), 'utf8').trim().split('\n');
        if (rows.length !== 126 || rows[0] !== '125 1') throw new Error(`bad .dat (${rows.length} lines)`);
    }],
    ['Yell example -> float32 unified, /entry/data only', async () => {
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_yell.h5'));
        await waitLog(/Yell 1\.0/);
        await setValue('outFormat', 'unified');
        await setValue('precision', 'float32');
        await setValue('layout', 'entry');
        const f = await H.openH5Bytes(fs.readFileSync(await convert('example_yell_unified.h5')));
        if (f.get('scattering') !== null) throw new Error('unexpected /scattering group');
        const model = await H.Converter.readUnifiedData(f);
        const ref = await H.Converter.readYell(await H.openH5('Examples/example_yell.h5'));
        if (!(model.values instanceof Float32Array)) throw new Error('output is not float32');
        if (H.maxAbsDiff(model.values, Float32Array.from(ref.values)) !== 0) throw new Error('values differ');
    }],
    ['rotated Scatty VTK + grid config + manual cell -> Yell', async () => {
        await setFile('#dataFile', path.join(work, 'rotated_sc.vtk'));
        await setFile('#gridConfigFile', path.join(work, 'scatty_config.txt'));
        await waitLog(/Scatty config \| grid 5 x 3 x 1/);
        for (const [id, v] of [['ca', 4], ['cb', 4], ['cc', 4], ['cal', 90], ['cbe', 90], ['cga', 90]]) {
            await setValue(id, v);
        }
        await setValue('outFormat', 'yell');
        const model = await H.Converter.readYell(await H.openH5Bytes(fs.readFileSync(await convert('rotated_sc_yell.h5'))));
        if (JSON.stringify(model.vectors) !== JSON.stringify([[0.5, 0.5, 0], [0, 0, 1], [0, 0, 0]])) {
            throw new Error('wrong grid vectors ' + JSON.stringify(model.vectors));
        }
    }],
    ['plugin-compressed HDF5 is refused', async () => {
        await setFile('#dataFile', path.join(ROOT, 'tests/fixtures/yell_lzf.h5'));
        await waitLog(/compressed with LZF \(filter id 32000\)/);
    }],
    ['Mantid MDHistoWorkspace with a [H,H,0] projection -> Yell', async () => {
        await setFile('#dataFile', path.join(work, 'projected.nxs'));
        await waitLog(/Mantid MDHistoWorkspace \| grid 4 x 3 x 2/);
        await setValue('outFormat', 'yell');
        const model = await H.Converter.readYell(await H.openH5Bytes(fs.readFileSync(await convert('projected_yell.h5'))));
        if (H.maxAbsDiff(model.vectors.flat(), [0.5, 0.5, 0, -2, 2, 0, 0, 0, 1]) > 1e-12) {
            throw new Error('wrong grid vectors ' + JSON.stringify(model.vectors));
        }
        if (NX.at(model, 3, 2, 1) !== NX.code(3, 2, 1)) throw new Error('values out of place');
    }],
    ['recipe file: symmetrize + 3D-ΔPDF -> unified u, v, w data with the recipe recorded', async () => {
        const recipe = { version: 1, steps: [{ op: 'symmetrize', laue: 'm-3m' }, { op: 'deltaPdf', taper: 0.5 }] };
        fs.writeFileSync(path.join(work, 'recipe.json'), JSON.stringify(recipe));
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 5 x 5 x 5/);
        await setFile('#recipeFile', path.join(work, 'recipe.json'));
        await waitLog(/Recipe "recipe\.json": 2 step\(s\)/);
        await setValue('outFormat', 'unified');
        const f = await H.openH5Bytes(fs.readFileSync(await convert('example_unified_dpdf_unified.h5')));
        if (!/FFT of 5 x 5 x 5 on the CPU \(float64\)/.test(await logText())) throw new Error('no FFT line in the log');
        const got = await H.Converter.readUnifiedData(f);
        const input = await H.Converter.readUnifiedData(await H.openH5('Examples/example_unified.h5'));
        const want = await Processing.applyRecipe(input, recipe,
            { cell: { lengths: input.cellLengths, angles: input.cellAngles }, fft: H.cpuFft });
        if (got.axesType !== 'uvw' || got.content !== '3d-delta-pdf' || got.symmetrized !== 'laue') {
            throw new Error(`labels ${got.axesType} ${got.content} ${got.symmetrized}`);
        }
        if (H.maxAbsDiff(got.values, want.values) > 1e-9 * Math.max(...want.values.map(Math.abs)) ||
            H.maxAbsDiff(got.vectors.flat(), want.vectors.flat()) > 1e-12) {
            throw new Error('the 3D-ΔPDF differs from the one computed in Node');
        }
        const saved = JSON.parse(String(f.get('entry/process/recipe/data').value));
        if (JSON.stringify(saved) !== JSON.stringify(Processing.normalizeRecipe(recipe))) {
            throw new Error('recorded recipe ' + JSON.stringify(saved));
        }
    }],
    // WebGPU in a headless browser depends on the machine: without it the
    // step must fail with a clear message instead.
    ['3D-ΔPDF on the GPU where WebGPU exists (else a clear refusal)', async () => {
        const recipe = { version: 1, steps: [{ op: 'deltaPdf', engine: 'gpu' }] };
        fs.writeFileSync(path.join(work, 'gpu.json'), JSON.stringify(recipe));
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 5 x 5 x 5/);
        await setFile('#recipeFile', path.join(work, 'gpu.json'));
        await waitLog(/Recipe "gpu\.json": 1 step/);
        await setValue('outFormat', 'yell');
        await clickConvert();
        const text = await waitLog(/Wrote example_unified_dpdf_yell\.h5|Error/, 120000);
        if (/Error/.test(text)) {
            if (!/no usable WebGPU/.test(text)) throw new Error(text);
            console.log('  (no WebGPU in this browser: ' + text.split('\n').filter(l => /Error/.test(l))[0] + ')');
            return;
        }
        const out = path.join(downloads, 'example_unified_dpdf_yell.h5');
        for (let i = 0; i < 100 && !(fs.existsSync(out) && fs.statSync(out).size); i++) await sleep(100);
        await sleep(200);
        const got = await H.Converter.readYell(await H.openH5Bytes(fs.readFileSync(out)));
        const input = await H.Converter.readUnifiedData(await H.openH5('Examples/example_unified.h5'));
        const want = await Processing.applyRecipe(input, { steps: [{ op: 'deltaPdf' }] }, { fft: H.cpuFft });
        const line = (text.split('\n').find(l => /FFT of/.test(l)) || '').replace(/^[\d:]+ /, '');
        const tol = 1e-5 * Math.max(...want.values.map(Math.abs));        // float32 on the GPU
        if (got.axesType !== 'uvw' || H.maxAbsDiff(got.values, want.values) > tol) {
            throw new Error(`GPU result differs from the CPU one by ${H.maxAbsDiff(got.values, want.values)} (${line.trim()})`);
        }
        console.log('  (' + line.trim() + ')');
    }],
    ['step editor: combine with another volume, then a |Q| profile', async () => {
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_yell.h5'));
        await waitLog(/Yell 1\.0/);
        await setFile('#extraFiles', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Volume "example_unified\.h5": grid 5 x 5 x 5/);
        await setValue('stepOp', 'combine');
        await evaluate('document.getElementById("addStep").click()');
        const status = await evaluate('document.querySelector("#steps .step .hint").textContent');
        if (status !== 'subtract "example_unified.h5"') throw new Error('step reads ' + status);
        await setValue('outFormat', 'yell');
        const diff = await H.Converter.readYell(await H.openH5Bytes(fs.readFileSync(await convert('example_yell_processed_yell.h5'))));
        if (diff.values.some(x => x !== 0)) throw new Error('the same volume did not subtract to zero');
        await evaluate('document.querySelector("#steps .step button[title=remove]").click()');
        await setValue('outFormat', 'profile');
        await setValue('profileWidth', 0.5);
        const rows = fs.readFileSync(await convert('example_yell_profile.txt'), 'utf8').trim().split('\n')
            .filter(r => !r.startsWith('#')).map(r => r.split(' ').map(Number));
        const n = rows.reduce((s, r) => s + r[3], 0);
        if (n !== 125 || rows.some(r => !(r[1] >= 111 && r[1] <= 555))) throw new Error('bad profile ' + JSON.stringify(rows));
    }],
    ['preview: slices as read and after a preset recipe, reused by Convert', async () => {
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 5 x 5 x 5/);
        for (let i = 0; i < 50 && !(await evaluate('document.getElementById("sliceCanvas").width === 5')); i++) await sleep(100);
        const stats = await evaluate('document.getElementById("sliceStats").textContent');
        if (!/l = 0 · 3 of 5/.test(stats)) throw new Error('slice stats: ' + stats);
        // pin (h, k) = (0.5, 0.5) and switch to the h-l plane through it
        await evaluate(`(() => {
            const c = document.getElementById('sliceCanvas'), r = c.getBoundingClientRect();
            c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 3.5 / 5, clientY: r.top + r.height * 1.5 / 5 }));
            document.querySelector('#planeSeg [data-normal="1"]').click();
        })()`);
        for (let i = 0; i < 50 && !/k = 0\.5 · 4 of 5/.test(await evaluate('document.getElementById("sliceStats").textContent')); i++) await sleep(100);
        const through = await evaluate('document.getElementById("sliceStats").textContent');
        if (!/k = 0\.5 · 4 of 5/.test(through)) throw new Error('plane through the point: ' + through);
        await evaluate('document.getElementById("presetBtn").click()');
        await evaluate('document.querySelector("#presetMenu button").click()');
        await evaluate('document.querySelector("#stageSeg [data-stage=processed]").click()');
        await waitLog(/Preview of the processed data: grid 5 x 5 x 5 in direct space/);
        for (let i = 0; i < 50 && !/u v/.test(await evaluate('document.getElementById("planeSeg").textContent')); i++) await sleep(100);
        const f = await H.openH5Bytes(fs.readFileSync(await convert('example_unified_dpdf_unified.h5')));
        if (!/Using the processed data from the preview/.test(await logText())) throw new Error('the preview result was not reused');
        if ((await H.Converter.readUnifiedData(f)).axesType !== 'uvw') throw new Error('not a 3D-ΔPDF');
    }],
    ['recipe editor: drag to reorder, undo, and the JSON view', async () => {
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 5 x 5 x 5/);
        const titles = () => evaluate('Array.from(document.querySelectorAll("#steps .step .toggle b"), b => b.textContent).join(",")');
        for (const op of ['rebin', 'scale']) {
            await setValue('stepOp', op);
            await evaluate('document.getElementById("addStep").click()');
        }
        if (await titles() !== 'Rebin,Scale and offset') throw new Error('steps: ' + await titles());
        await evaluate(`(() => {
            const items = document.querySelectorAll('#steps .step'), dt = new DataTransfer();
            const y = items[1].getBoundingClientRect().bottom - 2;
            items[0].querySelector('.rail').dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
            items[1].dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y }));
            items[1].dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y }));
        })()`);
        if (await titles() !== 'Scale and offset,Rebin') throw new Error('after the drag: ' + await titles());
        await evaluate('document.getElementById("undoBtn").click()');
        if (await titles() !== 'Rebin,Scale and offset') throw new Error('after undo: ' + await titles());
        await evaluate('document.getElementById("jsonBtn").click()');
        await evaluate(`(() => {
            document.getElementById('recipeJson').value =
                JSON.stringify({ steps: [{ op: 'symmetrize', laue: 'm-3m' }, { op: 'deltaPdf', enabled: false }] });
            document.getElementById('jsonApply').click();
        })()`);
        if (await titles() !== 'Symmetrize,3D-ΔPDF') throw new Error('after the JSON edit: ' + await titles());
        const off = await evaluate('Array.from(document.querySelectorAll("#steps .step"), li => li.classList.contains("off")).join(",")');
        if (off !== 'false,true') throw new Error('switched off: ' + off);
        if (await evaluate('document.querySelector("[data-format=dat]").disabled')) throw new Error('.dat disabled by a switched-off ΔPDF');
        // after a ΔPDF, a Bragg mask is flagged at once; symmetrize is fine in direct space
        await evaluate('document.getElementById("jsonBtn").click()');
        await evaluate(`(() => {
            document.getElementById('recipeJson').value = JSON.stringify({ steps: [
                { op: 'deltaPdf' }, { op: 'maskBragg', size: 0.1 }, { op: 'symmetrize', laue: 'm-3m' }] });
            document.getElementById('jsonApply').click();
        })()`);
        const status = await evaluate('Array.from(document.querySelectorAll("#steps .step .hint"), h => h.className + ": " + h.textContent).join("\\n")');
        if (!/hint err: needs reciprocal-space data, but step 1 \(3D-ΔPDF\)/.test(status) || /hint err: .*symmetrize/i.test(status)) {
            throw new Error('statuses:\n' + status);
        }
    }],
    ['normalize: data over a norm volume, summed over m-3m', async () => {
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 5 x 5 x 5/);
        await setFile('#extraFiles', path.join(ROOT, 'Examples/example_yell.h5'));
        await waitLog(/Volume "example_yell\.h5": grid 5 x 5 x 5/);
        await setValue('stepOp', 'normalize');
        await evaluate('document.getElementById("addStep").click()');
        const status = await evaluate('document.querySelector("#steps .step .hint").textContent');
        if (status !== 'Σdata/Σnorm with "example_yell.h5"') throw new Error('step reads ' + status);
        await evaluate(`(() => {
            const sel = Array.from(document.querySelectorAll('#steps .step select')).find(s => s.value === 'none');
            sel.value = 'm-3m';
            sel.dispatchEvent(new Event('change'));
        })()`);
        await setValue('outFormat', 'yell');
        const out = await H.Converter.readYell(await H.openH5Bytes(fs.readFileSync(await convert('example_unified_processed_yell.h5'))));
        if (out.values.some(x => Math.abs(x - 1) > 1e-12)) throw new Error('data / identical norm is not 1');
        if (!/summed over m-3m/.test(await logText())) throw new Error('no symmetry in the log');
    }],
    ['hkl list: write a Spinteract data file, then read it back as data', async () => {
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 5 x 5 x 5/);
        await setValue('outFormat', 'hkl');
        const out = await convert('example_unified_xtal_data_01.txt');
        const back = H.Converter.hklListModel(H.Converter.parseHklList(fs.readFileSync(out, 'utf8')));
        const ref = await H.Converter.readUnifiedData(await H.openH5('Examples/example_unified.h5'));
        if (H.maxAbsDiff(back.values, ref.values) > 1e-6 * Math.max(...ref.values)) throw new Error('values differ');
        const text = await logText();
        if (!/ORIGIN -1 -1 -1/.test(text) || !/every sigma is 1/.test(text)) throw new Error('log:\n' + text);
        await fresh();
        await setFile('#dataFile', out);
        await waitLog(/hkl list \| grid 5 x 5 x 5 \| σ/);
    }],
    ['.dat with hkl coordinates and m-3m symmetry sections, read back as _hkl.dat', async () => {
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 5 x 5 x 5/);
        await setValue('outFormat', 'dat');
        await setValue('datFrame', 'hkl');
        await setValue('datSections', 'm-3m');
        const out = await convert('example_unified_diffuse3d_hkl.dat');
        const lines = fs.readFileSync(out, 'utf8').split('\n');
        if (lines[0] !== '125 48' || lines[1].split(' ').length !== 3 + 3 * 48 + 1) throw new Error('header ' + lines[0]);
        if (lines[1].split(' ').slice(3, 6).map(Number).join() !== '-1,-1,-1') throw new Error('row ' + lines[1].slice(0, 80));
        await fresh();
        await setFile('#dataFile', out);
        await waitLog(/RMCProfile \.dat · hkl \| grid 5 x 5 x 5 in hkl/);
    }],
    ['.npz and .vti out, the .npz read back; a 3D-ΔPDF as a CCP4/MRC map', async () => {
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 5 x 5 x 5/);
        if (!(await evaluate('document.querySelector("[data-format=mrc]").disabled'))) throw new Error('MRC offered for Q-space data');
        await setValue('outFormat', 'npz');
        const npz = await convert('example_unified.npz');
        const ref = await H.Converter.readUnifiedData(await H.openH5('Examples/example_unified.h5'));
        const back = H.Converter.readNpz(fs.readFileSync(npz));
        if (H.maxAbsDiff(back.values, ref.values) !== 0 || H.maxAbsDiff(back.vectors.flat(), ref.vectors.flat()) !== 0) {
            throw new Error('the .npz differs from the input');
        }
        await setValue('outFormat', 'vti');
        const vti = fs.readFileSync(await convert('example_unified.vti'), 'utf8');
        if (!/<ImageData WholeExtent="0 4 0 4 0 4"[^>]* Direction="1\.0+ 0 0 0 1\.0+ 0 0 0 1\.0+"/.test(vti)) {
            throw new Error('.vti header ' + vti.slice(0, 400));
        }
        await setValue('stepOp', 'deltaPdf');
        await evaluate('document.getElementById("addStep").click()');
        if (!(await evaluate('document.querySelector("[data-format=dat]").disabled'))) throw new Error('.dat offered for a 3D-ΔPDF');
        await setValue('outFormat', 'mrc');
        const mrc = fs.readFileSync(await convert('example_unified_dpdf.mrc'));
        if (mrc.readInt32LE(0) !== 5 || mrc.readInt32LE(12) !== 2 || mrc.readInt32LE(16) !== -2 ||
            mrc.toString('latin1', 208, 212) !== 'MAP ' || mrc.length !== 1024 + 4 * 125) {
            throw new Error('bad MRC header');
        }
        await fresh();
        await setFile('#dataFile', npz);
        await waitLog(/NumPy \.npz \| grid 5 x 5 x 5 \| axes hkl/);
    }],
    ['a dropped 3DSCalculator .json loads as data, a recipe .json as a recipe', async () => {
        const t = 2 * Math.PI / 4;
        const calc = JSON.stringify({ shape: [2, 2, 1], hAxis: [0, 0.5], kAxis: [0, 0.5], lAxis: [1],
            Bq: [[t, 0, 0], [0, t, 0], [0, 0, t]], intensity: [1, 2, 3, 4], backend: 'cpu' });
        const recipe = JSON.stringify({ version: 1, steps: [{ op: 'scale', factor: 2, offset: 0 }] });
        await evaluate(`(() => {
            const dt = new DataTransfer();
            dt.items.add(new File([${JSON.stringify(calc)}], 'calc.json', { type: 'application/json' }));
            dt.items.add(new File([${JSON.stringify(recipe)}], 'recipe.json', { type: 'application/json' }));
            window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        })()`);
        await waitLog(/3DSCalculator \.json \| grid 2 x 2 x 1 \| float64 \| stored cell: 4\.00000 4\.00000 4\.00000 \/ 90\.00 90\.00 90\.00/);
        await waitLog(/Recipe "recipe\.json": 1 step/);
    }],
    ['rspace3d volume of an oblique cell -> unified, the raster shear kept', async () => {
        await setFile('#dataFile', path.join(work, 'volume_rspace3d.h5'));
        await waitLog(/rspace3d \(CrysAlisPro\) \| grid 4 x 3 x 2/);
        await waitLog(/HK raster of an oblique cell/);
        await setValue('outFormat', 'unified');
        const model = await H.Converter.readUnifiedData(await H.openH5Bytes(fs.readFileSync(await convert('volume_rspace3d_unified.h5'))));
        if (Math.abs(model.vectors[1][0] - rspace.shear * 0.2) > 1e-12 || model.symmetrized !== 'laue') {
            throw new Error('grid ' + JSON.stringify(model.vectors) + ' ' + model.symmetrized);
        }
    }],
    ['a subhkl indexer file chosen as data becomes the cell source', async () => {
        await setFile('#dataFile', path.join(work, 'indexer.h5'));
        await waitLog(/"indexer\.h5" holds a unit cell, not a volume/);
        await waitLog(/Structure "indexer\.h5": parent cell 8\.10000 8\.10000 8\.10000 \/ 90\.00 90\.00 90\.00 from subhkl, space group F d -3 m/);
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_diffuse3d.dat'));
        await waitLog(/RMCProfile \.dat \| grid/);
        await setValue('outFormat', 'unified');
        const m = await H.Converter.readUnifiedData(await H.openH5Bytes(fs.readFileSync(await convert('example_diffuse3d_unified.h5'))));
        if (Math.abs(m.cellLengths[0] - 8.1) > 1e-9) throw new Error('cell ' + m.cellLengths);
    }],
    ['crop on read: only the chosen hkl box is read', async () => {
        await evaluate(`(() => {
            for (const [axis, end, v] of [['h', 0, -0.5], ['h', 1, 1], ['l', 0, 0], ['l', 1, 0.5]]) {
                document.querySelector('#cropRow [data-axis="' + axis + '"][data-end="' + end + '"]').value = v;
            }
        })()`);
        await setFile('#dataFile', path.join(ROOT, 'Examples/example_unified.h5'));
        await waitLog(/Unified data format \| grid 4 x 5 x 2/);
        await waitLog(/cropped on read to 4 x 5 x 2 of 5 x 5 x 5/);
    }],
    ['NeXus entry + externally linked data file -> unified', async () => {
        await setFile('#dataFile', [path.join(work, 'wrapper.nxs'), path.join(work, 't.nxs')]);
        await waitLog(/linked files: t\.nxs as scan\/t\.nxs/);
        await waitLog(/NeXus \/entry\/transform \| grid 5 x 4 x 3/);
        await setValue('outFormat', 'unified');
        const model = await H.Converter.readUnifiedData(await H.openH5Bytes(fs.readFileSync(await convert('wrapper_unified.h5'))));
        if (NX.at(model, 4, 3, 2) !== NX.code(4, 3, 2)) throw new Error('values out of place');
        if (H.maxAbsDiff(model.corner, [-1, -1.5, 0]) > 1e-12) throw new Error('corner ' + model.corner);
    }],
];

let failed = 0;
try {
    await connect();
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    for (const [name, fn] of scenarios) {
        try {
            await fresh();
            await fn();
            console.log(`ok - ${name}`);
        } catch (e) {
            failed++;
            console.log(`not ok - ${name}\n  ${e.message.replace(/\n/g, '\n  ')}`);
        }
    }
    if (exceptions.length) {
        failed++;
        console.log('not ok - page exceptions:\n  ' + exceptions.join('\n  '));
    }
} finally {
    try { ws && ws.close(); } catch (_) { /* closed */ }
    proc.kill();
    await sleep(500);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* browser still holds files */ }
}
console.log(failed ? `# ${failed} failed` : `# all ${scenarios.length} browser scenarios passed`);
process.exit(failed ? 1 : 0);
