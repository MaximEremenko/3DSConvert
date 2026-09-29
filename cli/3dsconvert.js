#!/usr/bin/env node
'use strict';
/*
 * Command-line 3DSConvert: the same readers, processing and writers as the
 * page, run in Node. The page's worker core runs in-process; input files are
 * read from disk as needed (WORKERFS over synchronous file reads), text
 * output is streamed to disk, and HDF5 output is assembled in memory, which
 * in Node is not capped at the browser's 2 GB. Several inputs convert one by
 * one with the same settings (a temperature or composition series).
 *
 *   node cli/3dsconvert.js --help
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const ROOT = path.resolve(__dirname, '..');
const FORMATS = ['unified', 'yell', 'dat', 'vtk', 'vti', 'npz', 'mrc', 'hkl', 'profile'];
const STREAMED = new Set(['dat', 'vtk', 'profile', 'hkl', 'vti']);
const SUFFIX = {
    unified: '_unified.h5', yell: '_yell.h5', dat: '_diffuse3d.dat', vtk: '_diffuse.vtk', profile: '_profile.txt',
    hkl: '_hkl.txt', npz: '.npz', vti: '.vti', mrc: '.mrc',
};

const USAGE = `Usage: node cli/3dsconvert.js INPUT... --to FORMAT [options]

Converts each INPUT (any format the page reads) to FORMAT:
  unified, yell, dat, vtk, vti, npz, mrc, hkl, profile

Output
  -o, --out FILE          output file (one input only)
  -d, --out-dir DIR       folder for the outputs (default: the current one)
      --precision P       same | float64 | float32 (HDF5, .npz, .vti)
      --layout L          both | entry (unified)
      --gzip N            gzip level 1-9 for HDF5 (default: none)
      --radiation R       neutron | xray | electron
      --dat-frame F       q | hkl (the _hkl.dat variant)
      --dat-sections G    Laue group for RMCProfile symmetry sections
      --vtk-binary        legacy VTK as binary float32
      --hkl-target T      spinteract | scatty | plain
      --profile-width W   |Q| shell width in 1/Angstrom (default 0.05)
  -f, --force             overwrite existing outputs

Unit cell (for Q-space inputs and outputs)
      --cell a,b,c,al,be,ga  the parent cell (Angstrom, degrees)
      --structure FILE    .rmc6f, unified structure .h5 or subhkl indexer.h5
      --cell-source S     data | structure | manual (default: data, then the others)

Input
      --crop h=LO:HI,k=LO:HI,l=LO:HI  read only this hkl box (HDF5, .npz, .json)
      --sigma             read uncertainties where the file has them
      --zero-empty        0 means no data (RMCProfile .dat, Scatty/Spinteract VTK)
      --nexus-path P      the NXdata group to read
      --linked FILE       a file an input's external links point to (repeat)
      --yell-space reciprocal   read a Yell file with a corrupted is_direct
      --grid-config FILE  Scatty/Spinteract config giving the hkl grid

Processing
      --recipe FILE       a recipe .json saved by the page
      --extra FILE        a volume the recipe names (combine, normalize; repeat)

  -q, --quiet             only errors
  -h, --help              this text`;

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
    const o = { inputs: [], linked: [], extra: [], layout: 'both', precision: 'same', gzip: 0, profileWidth: 0.05 };
    const value = (i, name) => {
        if (i + 1 >= argv.length || /^-/.test(argv[i + 1]) && !/^-\d/.test(argv[i + 1])) throw new Error(`${name} needs a value`);
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const take = name => value(i++, name);
        switch (a) {
            case '-h': case '--help': o.help = true; break;
            case '-q': case '--quiet': o.quiet = true; break;
            case '-f': case '--force': o.force = true; break;
            case '--to': o.to = take(a); break;
            case '-o': case '--out': o.out = take(a); break;
            case '-d': case '--out-dir': o.outDir = take(a); break;
            case '--precision': o.precision = take(a); break;
            case '--layout': o.layout = take(a); break;
            case '--gzip': o.gzip = Number(take(a)); break;
            case '--radiation': o.radiation = take(a); break;
            case '--dat-frame': o.datFrame = take(a); break;
            case '--dat-sections': o.datSections = take(a); break;
            case '--vtk-binary': o.vtkBinary = true; break;
            case '--hkl-target': o.hklTarget = take(a); break;
            case '--profile-width': o.profileWidth = Number(take(a)); break;
            case '--cell': o.cell = take(a); break;
            case '--structure': o.structure = take(a); break;
            case '--cell-source': o.cellSource = take(a); break;
            case '--crop': o.crop = take(a); break;
            case '--sigma': o.sigma = true; break;
            case '--zero-empty': o.zeroEmpty = true; break;
            case '--nexus-path': o.nexusPath = take(a); break;
            case '--linked': o.linked.push(take(a)); break;
            case '--yell-space': o.yellSpace = take(a); break;
            case '--grid-config': o.gridConfig = take(a); break;
            case '--recipe': o.recipe = take(a); break;
            case '--extra': o.extra.push(take(a)); break;
            default:
                if (/^-/.test(a)) throw new Error(`unknown option ${a}`);
                o.inputs.push(a);
        }
    }
    return o;
}

// Wildcards the shell left as they are (Windows shells do not expand them).
function expandInputs(inputs) {
    return inputs.flatMap(p => {
        if (!/[*?]/.test(p) || fs.existsSync(p) || typeof fs.globSync !== 'function') return [p];
        const found = fs.globSync(p.replace(/\\/g, '/')).sort();
        if (!found.length) throw new Error(`no file matches ${p}`);
        return found;
    });
}

function check(o) {
    o.inputs = expandInputs(o.inputs);
    if (!o.inputs.length) throw new Error('no input file');
    if (!FORMATS.includes(o.to)) throw new Error(`--to must be one of ${FORMATS.join(', ')}`);
    if (o.out && o.inputs.length > 1) throw new Error('--out takes one input; use --out-dir for several');
    if (!['same', 'float64', 'float32'].includes(o.precision)) throw new Error('--precision: same, float64 or float32');
    if (!['both', 'entry'].includes(o.layout)) throw new Error('--layout: both or entry');
    if (!(Number.isInteger(o.gzip) && o.gzip >= 0 && o.gzip <= 9)) throw new Error('--gzip: 0 to 9');
    if (o.radiation && !['neutron', 'xray', 'electron'].includes(o.radiation)) throw new Error('--radiation: neutron, xray or electron');
    if (o.datFrame && !['q', 'hkl'].includes(o.datFrame)) throw new Error('--dat-frame: q or hkl');
    if (o.hklTarget && !['spinteract', 'scatty', 'plain'].includes(o.hklTarget)) throw new Error('--hkl-target: spinteract, scatty or plain');
    if (o.cellSource && !['data', 'structure', 'manual'].includes(o.cellSource)) throw new Error('--cell-source: data, structure or manual');
    if (!(o.profileWidth > 0)) throw new Error('--profile-width must be positive');
    for (const f of [...o.inputs, ...o.linked, ...o.extra, o.structure, o.recipe, o.gridConfig].filter(Boolean)) {
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error(`no such file: ${f}`);
    }
}

function parseCell(text) {
    const v = String(text).split(/[,\s]+/).filter(Boolean).map(Number);
    if (v.length !== 6 || v.some(x => !(x > 0))) throw new Error('--cell needs six positive numbers: a,b,c,alpha,beta,gamma');
    return { lengths: v.slice(0, 3), angles: v.slice(3) };
}

function parseCrop(text) {
    const crop = {};
    for (const part of String(text).split(',').filter(Boolean)) {
        const m = /^\s*([hkl])\s*=\s*(-?[\d.eE+-]+)\s*:\s*(-?[\d.eE+-]+)\s*$/.exec(part);
        if (!m || !(Number(m[2]) <= Number(m[3]))) throw new Error(`--crop: "${part}" is not like h=-2:2`);
        crop[m[1]] = [Number(m[2]), Number(m[3])];
    }
    return crop;
}

// ------------------------------------------------------------- files on disk

// A file on disk that WORKERFS and the text readers take like a browser
// File: slices read synchronously (FileReaderSync below) or as promises and
// streams, without loading the whole file.
class DiskFile {
    constructor(filePath, range) {
        this.path = filePath;
        this.name = path.basename(filePath);
        if (range) {
            Object.assign(this, range);
        } else {
            const st = fs.statSync(filePath);
            this.fd = fs.openSync(filePath, 'r');
            this.start = 0;
            this.end = st.size;
            this.lastModifiedDate = st.mtime;
        }
    }
    get size() { return this.end - this.start; }
    slice(from, to) {
        const n = this.size;
        const clamp = x => Math.max(0, Math.min(n, x < 0 ? n + x : x));
        const a = from === undefined ? 0 : clamp(from), b = to === undefined ? n : clamp(to);
        return new DiskFile(this.path, { fd: this.fd, name: this.name, start: this.start + a, end: this.start + Math.max(a, b),
            lastModifiedDate: this.lastModifiedDate });
    }
    readSync() {
        const out = new Uint8Array(this.size);
        let done = 0;
        while (done < out.length) {
            const n = fs.readSync(this.fd, out, done, out.length - done, this.start + done);
            if (!n) break;
            done += n;
        }
        return out.buffer;
    }
    async arrayBuffer() { return this.readSync(); }
    async text() { return new TextDecoder().decode(this.readSync()); }
    stream() {
        if (!this.size) return new Blob([]).stream();
        return Readable.toWeb(fs.createReadStream(this.path, { fd: this.fd, autoClose: false, start: this.start, end: this.end - 1 }));
    }
}

// ------------------------------------------------------------------- engine

// The page's worker core, in this process. The vendored h5wasm bundle mounts
// WORKERFS only in a worker, so it is loaded with WorkerGlobalScope defined;
// FileReaderSync reads DiskFile slices.
function startEngine() {
    const load = (file, ret) => new Function('require', fs.readFileSync(path.join(ROOT, 'js', file), 'utf8') + `\nreturn ${ret};`)(require);
    globalThis.FileReaderSync = class { readAsArrayBuffer(blob) { return blob.readSync(); } };
    globalThis.WorkerGlobalScope = globalThis.WorkerGlobalScope || function WorkerGlobalScope() {};
    const h5wasm = load('h5wasm.js', 'h5wasmModule()');
    delete globalThis.WorkerGlobalScope;
    const Converter = require(path.join(ROOT, 'js', 'converter.js'));
    const Processing = require(path.join(ROOT, 'js', 'processing.js'));
    const wgpuFftWeb = load('wgpu_fft_web.js', 'wgpuFftWebModule()');
    const converterWorker = load('worker.js', 'converterWorker');

    const pending = new Map();
    let seq = 0;
    const self = {
        navigator: {},
        onmessage: null,
        postMessage(msg) {
            const call = pending.get(msg.id);
            if (!call) return;
            if (msg.type === 'progress') call.onProgress && call.onProgress(msg.phase, msg.fraction);
            else if (msg.type === 'log') call.onLog && call.onLog(msg.text);
            else if (msg.type === 'chunk') {
                Promise.resolve(call.onChunk(msg.chunk)).then(
                    () => self.onmessage({ data: { type: 'ack', id: msg.id } }),
                    e => {
                        call.sinkError = e;
                        self.onmessage({ data: { type: 'cancel', id: msg.id } });
                    });
            } else if (msg.type === 'result') {
                pending.delete(msg.id);
                call.resolve(msg.result);
            } else if (msg.type === 'error') {
                pending.delete(msg.id);
                call.reject(call.sinkError || new Error(msg.message));
            }
        },
    };
    converterWorker(self, h5wasm, Converter, Processing, wgpuFftWeb);
    return {
        Converter, Processing,
        call(method, args, hooks) {
            const id = ++seq;
            return new Promise((resolve, reject) => {
                pending.set(id, Object.assign({ resolve, reject }, hooks));
                self.onmessage({ data: { type: 'call', id, method, args } });
            });
        },
    };
}

// --------------------------------------------------------------- conversion

function outputName(o, base, tag) {
    if (o.to === 'hkl' && (o.hklTarget || 'spinteract') === 'spinteract') return `${base}${tag}_xtal_data_01.txt`;
    if (o.to === 'hkl' && o.hklTarget === 'scatty') return 'scatty_data_01.txt';
    if (o.to === 'dat' && o.datFrame === 'hkl') return `${base}${tag}_diffuse3d_hkl.dat`;
    return base + tag + SUFFIX[o.to];
}

// A whole file from memory, in pieces (one write call takes at most 2 GB);
// a partial file is removed.
function writeBytes(target, bytes) {
    const fd = fs.openSync(target, 'w');
    try {
        for (let at = 0; at < bytes.length; at += 1 << 28) {
            const part = bytes.subarray(at, Math.min(bytes.length, at + (1 << 28)));
            for (let done = 0; done < part.length;) done += fs.writeSync(fd, part, done, part.length - done);
        }
    } catch (e) {
        fs.closeSync(fd);
        fs.unlinkSync(target);
        throw e;
    }
    fs.closeSync(fd);
}

// Write a stream of text or byte chunks to a file, waiting when it is full.
function fileSink(target) {
    const out = fs.createWriteStream(target);
    let failed = null;
    out.on('error', e => { failed = e; });
    return {
        write(chunk) {
            if (failed) throw failed;
            if (out.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) return null;
            return new Promise(resolve => out.once('drain', resolve));
        },
        close: () => new Promise((resolve, reject) => out.end(e => (e || failed ? reject(e || failed) : resolve()))),
        abort() {
            out.destroy();
            try { fs.unlinkSync(target); } catch (_) { /* never written */ }
        },
    };
}

async function main(argv) {
    const o = parseArgs(argv);
    if (o.help || !argv.length) {
        console.log(USAGE);
        return 0;
    }
    check(o);
    const say = (text, level) => {
        if (!o.quiet || level === 'err') process.stderr.write(text + '\n');
    };
    const tty = process.stderr.isTTY && !o.quiet;
    const progress = (label, phase, f) => {
        if (tty) process.stderr.write(`\r${label}: ${phase} ${Math.round(100 * f)}%   `);
    };
    const endProgress = () => { if (tty) process.stderr.write('\r' + ' '.repeat(60) + '\r'); };

    const engine = startEngine();
    const { Converter, Processing } = engine;
    const recipe = o.recipe ? Processing.normalizeRecipe(JSON.parse(fs.readFileSync(o.recipe, 'utf8'))) : null;
    const manual = o.cell ? parseCell(o.cell) : null;
    const crop = o.crop ? parseCrop(o.crop) : null;
    let gridConfig = null;
    if (o.gridConfig) {
        gridConfig = Converter.parseGridConfig(fs.readFileSync(o.gridConfig, 'utf8'));
        say(`Grid config ${path.basename(o.gridConfig)}: ${gridConfig.grids.length} grid(s)`);
    }
    if (o.structure) {
        const s = await engine.call('loadStructure', { file: new DiskFile(o.structure) });
        say(`Structure ${path.basename(o.structure)}: cell ${s.lengths.map(x => +x.toFixed(5)).join(' ')} / ${s.angles.map(x => +x.toFixed(3)).join(' ')}`);
    }
    if (o.extra.length) {
        const vols = await engine.call('loadExtras', { files: o.extra.map(f => new DiskFile(f)), readSigma: !!o.sigma, zeroEmpty: !!o.zeroEmpty });
        for (const v of vols) say(`Volume ${v.name}: grid ${v.dims.join(' x ')}`);
    }
    const outDir = o.outDir || '.';
    if (!o.out) fs.mkdirSync(outDir, { recursive: true });

    let failures = 0;
    for (const [n, input] of o.inputs.entries()) {
        const label = o.inputs.length > 1 ? `[${n + 1}/${o.inputs.length}] ${path.basename(input)}` : path.basename(input);
        const hooks = { onProgress: (phase, f) => progress(label, phase, f), onLog: text => say('  ' + text) };
        let sink = null;
        try {
            const t0 = Date.now();
            const files = [input, ...o.linked].map(f => new DiskFile(f));
            const grid = gridConfig ? gridConfig.grids[Math.min(gridConfig.grids.length - 1, gridIndex(gridConfig, input))] : null;
            const data = await engine.call('loadData', {
                files, paths: files.map(() => ''), yellSpace: o.yellSpace || 'auto', nexusPath: o.nexusPath || null,
                crop, readSigma: !!o.sigma, grid, zeroEmpty: !!o.zeroEmpty,
            }, hooks);
            endProgress();
            if (!data || !data.dims) throw new Error(data && data.cellFiles ? 'this file holds a unit cell, not a volume; pass it with --structure' : 'no data read');
            say(`${label}: ${data.kind} | grid ${data.dims.join(' x ')}`);
            for (const note of data.notes || []) say('  note: ' + note);
            const params = {
                format: o.to, radiation: o.radiation || '', manual, cellPrefer: o.cellSource || (manual && !o.structure ? 'manual' : undefined),
                precision: o.precision, layout: o.layout, compression: o.gzip, recipe,
                profileWidth: o.profileWidth, hklTarget: o.hklTarget || 'spinteract',
                datFrame: o.datFrame || 'q', datSections: o.datSections || 'none', vtkEncoding: o.vtkBinary ? 'binary' : 'ascii',
            };
            if (grid && data.kind === 'vtk') {
                params.grid = grid;
                params.customFrame = gridConfig.customFrame;
            }
            const plan = await engine.call('prepare', params, hooks);
            endProgress();
            for (const note of plan.notes || []) if (!(data.notes || []).includes(note)) say('  note: ' + note);
            const tag = !plan.processed ? '' : plan.axesType === 'uvw' && data.axesType !== 'uvw' ? '_dpdf' : '_processed';
            const base = path.basename(input).replace(/\.(h5|hdf5|hdf|he5|nx|nxs|nx5|dat|txt|vtk|npz|json)$/i, '');
            const target = o.out || path.join(outDir, outputName(o, base, tag));
            if (fs.existsSync(target) && !o.force) throw new Error(`${target} exists (use --force to overwrite)`);
            if (plan.nonFinite) say(`  ${plan.nonFinite} NaN/infinite voxels written as 0`);
            if (STREAMED.has(o.to)) {
                sink = fileSink(target);
                const s = sink;
                const r = await engine.call('write', {}, Object.assign({ onChunk: chunk => s.write(chunk) }, hooks));
                await sink.close();
                if (r && r.report) say(`  ${r.report.written} rows` + (r.report.noSigma ? '; no uncertainties, every sigma is 1' : ''));
                if (r && r.snippet) say(`  grid for the ${o.hklTarget === 'scatty' ? 'Scatty' : 'Spinteract'} config:\n${r.snippet.replace(/^/gm, '    ')}`);
            } else {
                const r = await engine.call('write', {}, hooks);
                writeBytes(target, r.kind === 'blob' ? new Uint8Array(await r.blob.arrayBuffer()) : r.bytes);
            }
            endProgress();
            say(`${label} -> ${target} (${formatBytes(fs.statSync(target).size)}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        } catch (e) {
            endProgress();
            if (sink) sink.abort();
            failures++;
            say(`${label}: error: ${e.message}`, 'err');
        }
    }
    if (o.inputs.length > 1) say(`${o.inputs.length - failures} of ${o.inputs.length} converted`);
    return failures ? 1 : 0;
}

// Spinteract writes one image per data set (..._img_NN.vtk) and one grid
// per data set in its config; match them by number, as the page does.
function gridIndex(cfg, name) {
    const m = /_(\d+)\.(vtk|txt)$/i.exec(name || '');
    return cfg.grids.length > 1 && m ? Math.max(0, Number(m[1]) - 1) : 0;
}

function formatBytes(n) {
    return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
        : n >= 1024 ? (n / 1024).toFixed(1) + ' kB' : n + ' B';
}

if (require.main === module) {
    main(process.argv.slice(2)).then(
        code => process.exit(code),
        e => {
            process.stderr.write(`error: ${e.message}\n`);
            process.exit(2);
        });
}

module.exports = { main, parseArgs, parseCrop, parseCell, DiskFile, startEngine };
