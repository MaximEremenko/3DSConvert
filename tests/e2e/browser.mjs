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
        const line = text.split('\n').find(l => /^\s*FFT of/.test(l)) || '';
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
