/*
 * Conversion worker for index.html. The page starts it from a Blob URL
 * assembled from the source text of h5wasmModule (js/h5wasm.js),
 * ConverterFactory (js/converter.js), ProcessingFactory (js/processing.js),
 * wgpuFftWebModule (js/wgpu_fft_web.js) and converterWorker below, so it also
 * runs from a file:// page. Input files are mounted with WORKERFS: HDF5 reads
 * only the bytes it needs, and text files are parsed as streams. The loaded
 * data stay in the worker; the page only receives summaries.
 *
 * Messages, page -> worker:
 *   { type: 'call', id, method, args }   run methods[method](args)
 *   { type: 'cancel', id }               stop call `id` at its next yield
 *   { type: 'ack', id }                  the page has consumed the last chunk
 * worker -> page:
 *   { type: 'progress', id, phase, fraction }
 *   { type: 'log', id, text }            a line for the log (processing steps)
 *   { type: 'chunk', id, chunk }         text output; the worker waits for 'ack'
 *   { type: 'result', id, result }
 *   { type: 'error', id, message, cancelled }
 */
function converterWorker(self, h5wasm, Converter, Processing, wgpuFftWeb) {
    'use strict';

    const MOUNT = '/work';
    const state = {
        files: {}, data: null, struct: null, extras: {}, plan: null, processed: null,
        dataVersion: 0, extrasVersion: 0, structVersion: 0,
    };
    const cancelled = new Set();
    const acks = new Map();
    let outSeq = 0;
    let FS = null;              // h5wasm.FS exists once the module is ready

    const ready = h5wasm.ready.then(() => {
        FS = h5wasm.FS;
        // Raise HDF5 read errors instead of returning undecoded bytes.
        h5wasm.Module.activate_throwing_error_handler();
        FS.mkdir(MOUNT);
    });

    // Macrotask yield without timer clamping, so 'cancel' and 'ack' messages
    // are handled during long loops.
    const channel = new MessageChannel();
    const waiting = [];
    channel.port1.onmessage = () => {
        const resume = waiting.shift();
        if (resume) resume();
    };
    const yieldNow = () => new Promise(resolve => {
        waiting.push(resolve);
        channel.port2.postMessage(null);
    });

    function cancelError() {
        return Object.assign(new Error('cancelled'), { cancelled: true });
    }

    function context(id) {
        let lastYield = Date.now(), lastProgress = 0;
        const check = () => {
            if (cancelled.has(id)) throw cancelError();
        };
        return {
            async tick() {
                if (Date.now() - lastYield >= 50) {
                    await yieldNow();
                    lastYield = Date.now();
                }
                check();
            },
            progress(phase, fraction) {
                const now = Date.now();
                if (fraction >= 1 || now - lastProgress >= 100) {
                    lastProgress = now;
                    self.postMessage({ type: 'progress', id, phase, fraction });
                }
            },
            log(text) {
                self.postMessage({ type: 'log', id, text });
            },
            async emit(chunk) {
                const consumed = new Promise(resolve => acks.set(id, resolve));
                self.postMessage({ type: 'chunk', id, chunk });
                await consumed;
                lastYield = Date.now();
                check();
            },
        };
    }

    // Remount the inputs; HDF5 files are closed between calls.
    // state.files.data: [{ at, file }] placed under data/<at>; .struct: File;
    // .extras: Files placed under extra/<index>/<name>.
    function mountFiles() {
        try {
            FS.unmount(MOUNT);
        } catch (_) {
            // nothing mounted yet
        }
        const blobs = (state.files.data || []).map(x => ({ name: 'data/' + x.at, data: x.file }));
        if (state.files.struct) blobs.push({ name: 'struct/' + state.files.struct.name, data: state.files.struct });
        (state.files.extras || []).forEach((file, i) => blobs.push({ name: `extra/${i}/${file.name}`, data: file }));
        FS.mount(FS.filesystems.WORKERFS, { blobs }, MOUNT);
    }

    function openAt(relPath) {
        return new h5wasm.File(`${MOUNT}/${relPath}`, 'r');
    }

    const DATA_KINDS = new Set(['unified', 'yell', 'mantid-md', 'nexus', 'rspace3d']);

    function kindOf(relPath) {
        const f = openAt(relPath);
        try {
            return Converter.detectH5Kind(f);
        } finally {
            f.close();
        }
    }

    async function isHdf5(file) {
        return Converter.isHdf5Signature(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
    }

    // A volume that is not HDF5: NumPy .npz (by its ZIP signature) or text.
    async function readOtherVolume(file, opts) {
        const sig = new Uint8Array(await file.slice(0, 4).arrayBuffer());
        if (sig.length === 4 && sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 3 && sig[3] === 4) {
            return { kind: 'npz', model: Converter.readNpz(new Uint8Array(await file.arrayBuffer()), opts) };
        }
        return readTextVolume(file, opts);
    }

    // Old-format .dat, VTK or an hkl list, parsed as a stream: { kind, grid }
    // or, for an hkl list (placed on opts.grid when a config gives one),
    // { kind, model }.
    async function readTextVolume(file, opts) {
        const head = new TextDecoder().decode(await file.slice(0, 4096).arrayBuffer());
        // RMCProfile's amplitude files and the _hkl.dat variant go by their names.
        if (/_amp_calc\.dat$/i.test(file.name)) {
            return { kind: 'dat-amp', grid: await Converter.readOldDatStream(file.stream(), Object.assign({ amplitudes: true }, opts)) };
        }
        if (/_hkl\.dat$/i.test(file.name)) {
            return { kind: 'dat-hkl', grid: await Converter.readOldDatStream(file.stream(), Object.assign({ frame: 'hkl' }, opts)) };
        }
        if (Converter.is3dsCalculatorJson(head)) {
            return { kind: 'calc-json', model: Converter.read3dsCalculatorJson(await file.text(), opts) };
        }
        if (Converter.isHklList(head)) {
            const list = await Converter.readHklListStream(file.stream(), opts);
            const kind = Converter.is3dsCalculatorDat(head) ? 'calc-dat' : 'hkl';
            return { kind, model: Converter.hklListModel(list, opts.grid || null) };
        }
        const vtk = Converter.isVtk(head);
        if (vtk && Converter.isBinaryVtk(head)) {
            const grid = Converter.readVtkBinary(new Uint8Array(await file.arrayBuffer()));
            return { kind: grid.frame === 'hkl' ? 'vtk-hkl' : 'vtk', grid };
        }
        const grid = vtk ? await Converter.readVtkStream(file.stream(), opts)
            : await Converter.readOldDatStream(file.stream(), opts);
        return { kind: vtk ? (grid.frame === 'hkl' ? 'vtk-hkl' : 'vtk') : 'dat', grid };
    }

    // The model in an open HDF5 file of a known kind. opts also carries
    // `space` (Yell) and `path` (the NeXus NXdata group).
    function readModel(f, kind, opts) {
        if (kind === 'yell') return Converter.readYell(f, opts);
        if (kind === 'unified') return Converter.readUnifiedData(f, opts);
        if (kind === 'mantid-md') return Converter.readMantidMD(f, opts);
        if (kind === 'nexus') return Converter.readNexusData(f, opts);
        if (kind === 'rspace3d') return Converter.readRspace3d(f, opts);
        throw new Error(Converter.unsupportedKindMessage(kind));
    }

    // The FFT behind Processing's 3D-ΔPDF step, from wgpuFFT: its CPU plan in
    // float64, or WebGPU in float32. (wgpuFFT's double-float GPU plans are
    // accurate, but Chrome takes 30-90 s to compile their shaders for each
    // new grid size, far longer than the CPU transform.) The module and the
    // device load on first use.
    let fftModule = null, gpuDevice = null;
    function fftEngine(log) {
        return async (shape, data, direction, engine) => {
            if (!fftModule) fftModule = wgpuFftWeb.load().catch(e => { fftModule = null; throw e; });
            const api = await fftModule;
            const dir = direction === 'inverse' ? api.WebFftDirection.Inverse : api.WebFftDirection.Forward;
            const dims = Uint32Array.from(shape);
            if (engine !== 'gpu') {
                log(`FFT of ${shape.join(' x ')} on the CPU (float64)`);
                return api.cpuFft(dims, data, dir, api.WebFftNormalization.None);
            }
            if (!gpuDevice) {
                gpuDevice = (self.navigator && self.navigator.gpu ? api.WgpuFft.init()
                    : Promise.reject(new Error('this browser offers no WebGPU to workers')))
                    .catch(e => {
                        gpuDevice = null;
                        throw new Error(`no usable WebGPU (${(e && e.message) || e}); choose the CPU engine`);
                    });
            }
            const gpu = await gpuDevice;
            const plan = await gpu.createPlan(dims, 1, dir, api.WebFftPrecision.F32, api.WebFftNormalization.None);
            let input = null, output = null;
            try {
                const staged = new Float32Array(plan.inputBytes / 4);
                staged.set(data);
                input = gpu.upload(staged);
                output = gpu.createBuffer(plan.outputBytes);
                log(`FFT of ${shape.join(' x ')} on ${gpu.adapterName || 'the GPU'} (float32, ${plan.route})`);
                await plan.execute(input, output);
                const bytes = await gpu.download(output);
                return Float64Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, data.length));
            } finally {
                if (input) input.free();
                if (output) output.free();
                plan.free();
            }
        };
    }

    // Plan the conversion (cell, Q -> hkl) and run the recipe. The result is
    // kept in state.processed and reused while the data, the extra volumes,
    // the cell and the recipe stay the same.
    async function processData(params, ctx) {
        if (!state.data) throw new Error('no data file loaded');
        const recipe = params.recipe && params.recipe.steps && params.recipe.steps.length
            ? Processing.normalizeRecipe(params.recipe) : null;
        const key = JSON.stringify([state.dataVersion, state.extrasVersion, state.structVersion, params.manual || null,
            params.cellPrefer || null, params.grid || null, params.customFrame || null, params.radiation || null, recipe]);
        if (state.processed && state.processed.key === key) {
            ctx.log('Using the processed data from the preview.');
            return state.processed;
        }
        const input = state.data.grid ? { grid: state.data.grid } : { model: state.data.model };
        const plan = Converter.planConversion(input, Object.assign({}, params, { format: 'unified', structure: state.struct }));
        for (const line of plan.logs) ctx.log(line);
        let process = null;
        if (recipe) {
            ctx.log(`Processing ${plan.model.dims.join(' x ')} voxels with ${recipe.steps.length} step(s):`);
            const t0 = Date.now();
            plan.model = await Processing.applyRecipe(plan.model, recipe, {
                cell: plan.cell, extras: recipeExtras(recipe, params), fft: fftEngine(ctx.log),
                tick: ctx.tick, progress: f => ctx.progress('Processing', f), log: ctx.log,
            });
            ctx.log(`Processed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
            process = {
                program: '3DSConvert', recipe,
                description: recipe.steps.map((s, n) => `${n + 1}. ${Processing.describeStep(s)}`).join('\n'),
            };
        }
        state.processed = { key, plan, process };
        return state.processed;
    }

    // Output written in pieces through the page's file sink (text, and the
    // binary legacy VTK); the others come back whole.
    const STREAMED = new Set(['dat', 'vtk', 'profile', 'hkl', 'vti']);

    // estimateOutputBytes options for the conversion parameters.
    const estimateOpts = params => Object.assign({}, params, {
        binary: params.vtkEncoding === 'binary',
        nsec: params.datSections && params.datSections !== 'none' ? Processing.laueOperations(params.datSections).length : 1,
    });

    // Sort key that puts the identity operation first.
    const identityFirst = G => (G.flat().join() === '1,0,0,0,1,0,0,0,1' ? 0 : 1);

    // The extra volumes a recipe's steps name (combine, normalize), on hkl grids.
    function recipeExtras(recipe, params) {
        const extras = {};
        const names = recipe.steps.flatMap(step => (step.op === 'combine' ? [step.file]
            : step.op === 'normalize' ? [step.norm, step.background, step.backgroundNorm] : []));
        for (const name of names) {
            if (!name || extras[name]) continue;
            const x = state.extras[name];
            if (!x) continue;                 // the step reports the missing volume
            try {
                extras[name] = Converter.planConversion(x.grid ? { grid: x.grid } : { model: x.model },
                    { format: 'unified', structure: state.struct, manual: params.manual, cellPrefer: params.cellPrefer }).model;
            } catch (e) {
                throw new Error(`volume "${name}": ${e.message}`);
            }
        }
        return extras;
    }

    function summarize(data) {
        const geo = geometryOf(data);
        const common = { corner: geo.corner, vectors: geo.vectors, names: geo.names, nonFinite: Converter.countNonFinite(geo.values) };
        if (data.model) {
            const m = data.model;
            return Object.assign(common, {
                kind: data.kind, dims: m.dims, cellLengths: m.cellLengths, cellAngles: m.cellAngles,
                axesType: m.axesType, content: m.content || null, legacyContract: !!m.legacyContract, hasSigma: !!m.sigma,
                notes: m.notes || [], precision: m.values instanceof Float32Array ? 'float32' : 'float64',
            });
        }
        const g = data.grid;
        return Object.assign(common, {
            kind: data.kind, dims: g.dims, frame: g.frame, title: g.title || '', notes: g.notes || [],
            datHeader: g.datHeader || null, precision: 'float64',
        });
    }

    // Grid geometry in the file's own frame, for summaries and the preview:
    // corner, step vectors and a component name per axis (hkl, uvw or Q).
    function geometryOf(data) {
        if (data.model) {
            const m = data.model;
            const names = m.axesType === 'uvw' ? ['u', 'v', 'w'] : m.axesType === 'Q' ? ['Qx', 'Qy', 'Qz'] : ['h', 'k', 'l'];
            return { dims: m.dims, values: m.values, corner: m.corner, vectors: m.vectors, names };
        }
        const g = data.grid;
        const names = g.frame === 'hkl' ? ['h', 'k', 'l'] : ['Qx', 'Qy', 'Qz'];
        if (g.qCorner) return { dims: g.dims, values: g.values, corner: g.qCorner, vectors: g.qVectors, names };
        const vectors = [0, 1, 2].map(a => [0, 1, 2].map(c => (a === c ? g.spacing[a] : 0)));
        return { dims: g.dims, values: g.values, corner: g.origin, vectors, names };
    }

    // The plane of the grid with grid axis `normal` fixed at `index` (or at
    // the plane nearest the coordinate `coord` along it), as float32 rows from
    // the top (the second in-plane axis increases upwards).
    // Colour levels over the whole volume (from a sample of it), so the page
    // keeps one scale while it moves through the planes: robust linear and
    // log ranges, and the largest |value| for the diverging scale.
    const levelCache = new WeakMap();
    function volumeLevels(values) {
        const cached = levelCache.get(values);
        if (cached) return cached;
        const step = Math.max(1, Math.floor(values.length / 400000));
        const all = [], pos = [], abs = [];
        for (let i = 0; i < values.length; i += step) {
            const x = values[i];
            if (!Number.isFinite(x)) continue;
            all.push(x);
            abs.push(Math.abs(x));
            if (x > 0) pos.push(x);
        }
        const sorted = a => Float64Array.from(a).sort();
        const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.round(p * (a.length - 1)))] : NaN);
        const [s, sp, sa] = [sorted(all), sorted(pos), sorted(abs)];
        const out = { lin: [q(s, 0.005), q(s, 0.995)], log: [q(sp, 0.01), q(sp, 0.998)], abs: q(sa, 0.998) };
        levelCache.set(values, out);
        return out;
    }

    function slicePlane(geo, normal, index, coord) {
        const [nh, nk, nl] = geo.dims;
        const [ax, ay] = [0, 1, 2].filter(a => a !== normal);
        const w = geo.dims[ax], h = geo.dims[ay];
        let i0;
        const nv = geo.vectors[normal].map(Math.abs), nc = nv.indexOf(Math.max(...nv));
        if (Number.isFinite(coord) && geo.vectors[normal][nc]) {
            i0 = Math.max(0, Math.min(geo.dims[normal] - 1, Math.round((coord - geo.corner[nc]) / geo.vectors[normal][nc])));
        } else if (index === null || index === undefined) {
            // The plane through 0 along the normal, else the middle one.
            const v = geo.vectors[normal].map(Math.abs), c = v.indexOf(Math.max(...v));
            const k = geo.vectors[normal][c] ? Math.round(-geo.corner[c] / geo.vectors[normal][c]) : 0;
            i0 = k >= 0 && k < geo.dims[normal] ? k : Math.floor(geo.dims[normal] / 2);
        } else {
            i0 = Math.max(0, Math.min(geo.dims[normal] - 1, Math.round(index)));
        }
        const out = new Float32Array(w * h);
        const at = [0, 0, 0];
        at[normal] = i0;
        for (let y = 0; y < h; y++) {
            at[ay] = y;
            const row = (h - 1 - y) * w;
            for (let x = 0; x < w; x++) {
                at[ax] = x;
                out[row + x] = geo.values[(at[2] * nk + at[1]) * nh + at[0]];
            }
        }
        const axis = a => {
            const v = geo.vectors[a].map(Math.abs);
            const c = v.indexOf(Math.max(...v));
            return {
                name: geo.names[c], n: geo.dims[a], from: geo.corner[c],
                to: geo.corner[c] + (geo.dims[a] - 1) * geo.vectors[a][c],
            };
        };
        const at0 = [0, 1, 2].map(c => geo.corner[c] + i0 * geo.vectors[normal][c]);
        return { width: w, height: h, values: out, x: axis(ax), y: axis(ay), normal: Object.assign(axis(normal), { index: i0, at: at0 }) };
    }

    const methods = {
        async ping() {
            return {};
        },

        // files: the selected data file, or a NeXus file plus the files its
        // external links point to; paths: their folder-relative paths (may be
        // empty); nexusPath: the NXdata group to read (default: @default).
        async loadData({ files, paths, yellSpace, nexusPath, crop, readSigma, grid }, ctx) {
            state.data = null;
            state.plan = null;
            state.processed = null;
            state.dataVersion++;
            files = (files || []).filter(Boolean);
            state.files.data = files.map((file, i) => ({ at: `${i}/${file.name}`, file }));
            mountFiles();
            if (!files.length) return { result: null };
            const hdf5 = [];
            for (const file of files) hdf5.push(await isHdf5(file));
            // Structure and subhkl indexer files hold a cell, not a volume: the
            // page takes them as the structure file.
            const CELL_KINDS = new Set(['structure', 'subhkl']);
            let main = 0, cellFiles = [];
            if (files.length > 1) {
                if (hdf5.some(x => !x)) {
                    throw new Error('several files can be selected only for NeXus data whose external ' +
                        'links point to the others; select a single text data file');
                }
                const kinds = files.map((file, i) => kindOf(`data/${i}/${file.name}`));
                cellFiles = files.filter((_, i) => CELL_KINDS.has(kinds[i])).map(x => x.name);
                main = kinds.findIndex(k => DATA_KINDS.has(k));
                if (main < 0) {
                    if (cellFiles.length) return { result: { cellFiles } };
                    throw new Error(Converter.unsupportedKindMessage(kinds[0]) || 'no data file among the selection');
                }
            }
            const file = files[main];
            const opts = { size: file.size, tick: ctx.tick, progress: f => ctx.progress('Reading', f), crop, sigma: !!readSigma, grid };
            if (!hdf5[main]) {
                state.data = await readOtherVolume(file, opts);
                return { result: Object.assign(summarize(state.data), { main: file.name }) };
            }

            state.files.data = [{ at: file.name, file }];
            mountFiles();
            let f = openAt('data/' + file.name);
            const extra = { main: file.name, companions: [], cellFiles };
            try {
                const kind = Converter.detectH5Kind(f);
                if (CELL_KINDS.has(kind)) return { result: { cellFiles: [file.name] } };
                let model;
                if (kind !== 'nexus') {
                    model = await readModel(f, kind, Object.assign({ space: yellSpace }, opts));
                } else {
                    const candidates = Converter.nexusCandidates(f);
                    const path = candidates.some(c => c.path === nexusPath) ? nexusPath : candidates[0].path;
                    // Put the other selected files where the external links expect them.
                    const links = Converter.unresolvedLinks(f, path);
                    const others = files.map((x, i) => ({ name: x.name, path: (paths && paths[i]) || '', i }))
                        .filter(x => x.i !== main);
                    if (links.length && others.length) {
                        const plan = Converter.planLinkMounts(links, others);
                        if (plan.mounts.length) {
                            f.close();
                            f = null;
                            for (const m of plan.mounts) {
                                const other = others[m.index];
                                state.files.data.push({ at: m.at, file: files[other.i] });
                                extra.companions.push(`${other.name} as ${m.at}`);
                            }
                            mountFiles();
                            f = openAt('data/' + file.name);
                        }
                    }
                    model = await readModel(f, kind, Object.assign({ path }, opts));
                    extra.candidates = candidates.map(c => ({ path: c.path, shape: c.shape, isDefault: c.isDefault }));
                    extra.nexusPath = path;
                }
                state.data = { kind, model };
            } finally {
                if (f) f.close();
            }
            return { result: Object.assign(summarize(state.data), extra) };
        },

        async loadStructure({ file }) {
            state.struct = null;
            state.structVersion++;
            state.files.struct = file || null;
            mountFiles();
            if (!file) return { result: null };
            let parent;
            if (await isHdf5(file)) {
                const f = openAt('struct/' + file.name);
                try {
                    parent = Converter.detectH5Kind(f) === 'subhkl' ? Converter.readSubhklCell(f) : Converter.readUnifiedStructure(f);
                } finally {
                    f.close();
                }
            } else {
                // The rmc6f header comes first; read the whole file only if needed.
                const limit = 1 << 20;
                try {
                    parent = Converter.parseRmc6f(await file.slice(0, limit).text());
                } catch (e) {
                    if (file.size <= limit) throw e;
                    parent = Converter.parseRmc6f(await file.text());
                }
            }
            state.struct = parent;
            return { result: parent };
        },

        // Volumes for the recipe's combine steps, named by their file names.
        // They are read whole and kept; Q-space text grids get their hkl
        // axes from the parent cell when a recipe uses them.
        async loadExtras({ files, readSigma }, ctx) {
            state.extras = {};
            state.extrasVersion++;
            state.files.extras = (files || []).filter(Boolean);
            mountFiles();
            const out = [];
            for (const [i, file] of state.files.extras.entries()) {
                const opts = { size: file.size, tick: ctx.tick, progress: f => ctx.progress(`Reading ${file.name}`, f), sigma: !!readSigma };
                let volume;
                if (!(await isHdf5(file))) {
                    volume = await readOtherVolume(file, opts);
                } else {
                    const f = openAt(`extra/${i}/${file.name}`);
                    try {
                        const kind = Converter.detectH5Kind(f);
                        const path = kind === 'nexus' ? Converter.nexusCandidates(f)[0].path : null;
                        volume = { kind, model: await readModel(f, kind, Object.assign({ path }, opts)) };
                    } finally {
                        f.close();
                    }
                }
                state.extras[file.name] = volume;
                out.push(Object.assign({ name: file.name }, summarize(volume)));
            }
            return { result: out };
        },

        // A plane of the loaded data ('input') or of the last previewRecipe
        // result ('processed'); see slicePlane.
        async slice({ stage, normal, index, at }) {
            const source = stage === 'processed' ? state.processed && { model: state.processed.plan.model } : state.data;
            if (!source) throw new Error(stage === 'processed' ? 'no processed preview yet' : 'no data file loaded');
            const geo = geometryOf(source);
            const plane = slicePlane(geo, normal, index, at);
            plane.levels = volumeLevels(geo.values);
            return { result: plane, transfer: [plane.values.buffer] };
        },

        // Shell averages over |Q| for the preview: the data as read (on hkl
        // axes with the chosen cell) or the processed result.
        async profile({ stage, width, params }) {
            let plan;
            if (stage === 'processed') {
                if (!state.processed) throw new Error('no processed preview yet');
                plan = state.processed.plan;
            } else {
                if (!state.data) throw new Error('no data file loaded');
                const input = state.data.grid ? { grid: state.data.grid } : { model: state.data.model };
                plan = Converter.planConversion(input, Object.assign({}, params, { format: 'unified', structure: state.struct }));
            }
            return { result: Processing.profileShells(plan.model, plan.cell, width) };
        },

        // Runs the recipe for the preview and keeps the result, which the
        // next prepare() with the same data, cell and recipe reuses.
        async previewRecipe(params, ctx) {
            const plan = await processData(params, ctx);
            return { result: { dims: plan.plan.model.dims, axesType: plan.plan.model.axesType || 'hkl' } };
        },

        // params: { format, radiation, manual, cellPrefer, grid, customFrame,
        // precision, layout, compression, recipe, profileWidth } - see
        // Converter.planConversion and Processing.applyRecipe.
        async prepare(params, ctx) {
            state.plan = null;
            const { plan, process } = await processData(params, ctx);
            Converter.checkWritable(plan.model, params.format);
            const unitMetric = Converter.isUnitMetric(plan.cell.lengths, plan.cell.angles);
            if (((params.format === 'dat' && params.datFrame !== 'hkl') || params.format === 'vtk' || params.format === 'mrc') && unitMetric) {
                throw new Error(`cannot write ${params.format} with a unit-metric cell - supply a structure file or a manual parent cell`);
            }
            state.plan = { plan, params, process };
            // formats that have no NaN and write empty voxels as 0
            const zeroed = params.format === 'dat' || params.format === 'vtk' || params.format === 'mrc';
            const notes = (plan.model.notes || []).slice();
            if (params.format === 'vti' && unitMetric) {
                notes.push(`no real cell, so the .vti axes are in ${plan.model.axesType === 'uvw' ? 'lattice units' : 'r.l.u.'}`);
            }
            return {
                result: {
                    notes, dims: plan.model.dims,
                    axesType: plan.model.axesType || 'hkl', processed: !!process,
                    cell: plan.cell, cellSource: plan.cellSource,
                    estimate: Converter.estimateOutputBytes(plan.model, params.format, estimateOpts(params)),
                    nonFinite: zeroed ? Converter.countNonFinite(plan.model.values) : 0,
                },
            };
        },

        async write(_args, ctx) {
            if (!state.plan) throw new Error('nothing to write; prepare the conversion first');
            const { plan, params, process } = state.plan;
            const progress = f => ctx.progress('Writing', f);
            if (STREAMED.has(params.format)) {
                let report = null;
                const sections = params.datSections && params.datSections !== 'none'
                    ? Processing.laueOperations(params.datSections).sort((a, b) => identityFirst(a) - identityFirst(b)) : null;
                const chunks = params.format === 'dat'
                    ? Converter.writeOldDatChunks(plan.model, plan.cell, 0, { frame: params.datFrame, sections })
                    : params.format === 'vtk' ? Converter.writeVtkChunks(plan.model, plan.cell, 0, { binary: params.vtkEncoding === 'binary' })
                    : params.format === 'vti' ? Converter.writeVtiChunks(plan.model, plan.cell, { precision: params.precision })
                    : params.format === 'hkl' ? Converter.writeHklListChunks(plan.model, r => { report = r; })
                    : Processing.writeProfileChunks(plan.model, plan.cell, params.profileWidth);
                const estimate = Math.max(1, Converter.estimateOutputBytes(plan.model, params.format, estimateOpts(params)));
                let written = 0;
                for (const chunk of chunks) {
                    await ctx.emit(chunk);
                    written += chunk.length;
                    progress(Math.min(0.99, written / estimate));
                }
                progress(1);
                const snippet = params.format === 'hkl' && params.hklTarget !== 'plain'
                    ? Converter.hklConfigSnippet(plan.model, params.hklTarget) : null;
                return { result: { kind: 'text', report, snippet } };
            }
            if (params.format === 'npz' || params.format === 'mrc') {
                progress(0);
                const blob = params.format === 'npz'
                    ? Converter.writeNpz(plan.model, plan.cell, { precision: params.precision })
                    : Converter.writeMrc(plan.model, plan.cell);
                progress(1);
                return { result: { kind: 'blob', blob } };
            }
            const path = `/out_${outSeq++}.h5`;
            let f = null;
            try {
                f = new h5wasm.File(path, 'w');
                const opts = {
                    precision: params.precision, layout: params.layout, compression: params.compression,
                    tick: ctx.tick, progress,
                };
                if (params.format === 'unified') {
                    await Converter.writeUnifiedData(f, plan.model, plan.cell, { process }, opts);
                } else {
                    await Converter.writeYell(f, plan.model, plan.cell, opts);
                }
                f.flush();
                f.close();
                f = null;
                const bytes = FS.readFile(path);
                return { result: { kind: 'bytes', bytes }, transfer: [bytes.buffer] };
            } catch (e) {
                if (e instanceof RangeError || /allocat|out of memory|enlarge/i.test((e && e.message) || '')) {
                    throw new Error('the output file is larger than the browser can hold in memory (about ' +
                        '2 GB in Chrome/Edge); choose float32, the /entry/data-only layout or compression');
                }
                throw e;
            } finally {
                try {
                    if (f) f.close();
                } catch (_) {
                    // already failed
                }
                try {
                    FS.unlink(path);
                } catch (_) {
                    // never created
                }
            }
        },
    };

    async function run(msg) {
        const ctx = context(msg.id);
        try {
            await ready;
            const method = methods[msg.method];
            if (!method) throw new Error('unknown worker method ' + msg.method);
            const out = (await method(msg.args || {}, ctx)) || {};
            self.postMessage({ type: 'result', id: msg.id, result: out.result }, out.transfer || []);
        } catch (e) {
            self.postMessage({
                type: 'error', id: msg.id, message: (e && e.message) || String(e), cancelled: !!(e && e.cancelled),
            });
        } finally {
            cancelled.delete(msg.id);
            acks.delete(msg.id);
        }
    }

    self.onmessage = ev => {
        const msg = ev.data || {};
        if (msg.type === 'call') {
            run(msg);
            return;
        }
        if (msg.type === 'cancel') cancelled.add(msg.id);
        if (msg.type === 'cancel' || msg.type === 'ack') {
            const resume = acks.get(msg.id);
            if (resume) {
                acks.delete(msg.id);
                resume();
            }
        }
    };
}
