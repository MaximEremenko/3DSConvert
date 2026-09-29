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
    const state = { files: {}, data: null, struct: null, extras: {}, plan: null };
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

    const DATA_KINDS = new Set(['unified', 'yell', 'mantid-md', 'nexus']);

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

    // Old-format .dat or VTK text, parsed as a stream: { kind, grid }.
    async function readTextVolume(file, opts) {
        const head = new TextDecoder().decode(await file.slice(0, 256).arrayBuffer());
        const vtk = Converter.isVtk(head);
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

    // The extra volumes a recipe's combine steps name, on hkl grids.
    function recipeExtras(recipe, params) {
        const extras = {};
        for (const step of recipe.steps) {
            if (step.op !== 'combine' || extras[step.file]) continue;
            const x = state.extras[step.file];
            if (!x) continue;                 // the step reports the missing volume
            try {
                extras[step.file] = Converter.planConversion(x.grid ? { grid: x.grid } : { model: x.model },
                    { format: 'unified', structure: state.struct, manual: params.manual }).model;
            } catch (e) {
                throw new Error(`volume "${step.file}": ${e.message}`);
            }
        }
        return extras;
    }

    function summarize(data) {
        if (data.model) {
            const m = data.model;
            return {
                kind: data.kind, dims: m.dims, cellLengths: m.cellLengths, cellAngles: m.cellAngles,
                axesType: m.axesType, content: m.content || null, legacyContract: !!m.legacyContract,
                notes: m.notes || [], precision: m.values instanceof Float32Array ? 'float32' : 'float64',
            };
        }
        const g = data.grid;
        return {
            kind: data.kind, dims: g.dims, frame: g.frame, title: g.title || '', notes: g.notes || [],
            datHeader: g.datHeader || null, precision: 'float64',
        };
    }

    const methods = {
        async ping() {
            return {};
        },

        // files: the selected data file, or a NeXus file plus the files its
        // external links point to; paths: their folder-relative paths (may be
        // empty); nexusPath: the NXdata group to read (default: @default).
        async loadData({ files, paths, yellSpace, nexusPath }, ctx) {
            state.data = null;
            state.plan = null;
            files = (files || []).filter(Boolean);
            state.files.data = files.map((file, i) => ({ at: `${i}/${file.name}`, file }));
            mountFiles();
            if (!files.length) return { result: null };
            const hdf5 = [];
            for (const file of files) hdf5.push(await isHdf5(file));
            let main = 0;
            if (files.length > 1) {
                if (hdf5.some(x => !x)) {
                    throw new Error('several files can be selected only for NeXus data whose external ' +
                        'links point to the others; select a single text data file');
                }
                const kinds = files.map((file, i) => kindOf(`data/${i}/${file.name}`));
                main = kinds.findIndex(k => DATA_KINDS.has(k));
                if (main < 0) throw new Error(Converter.unsupportedKindMessage(kinds[0]) || 'no data file among the selection');
            }
            const file = files[main];
            const opts = { size: file.size, tick: ctx.tick, progress: f => ctx.progress('Reading', f) };
            if (!hdf5[main]) {
                state.data = await readTextVolume(file, opts);
                return { result: Object.assign(summarize(state.data), { main: file.name }) };
            }

            state.files.data = [{ at: file.name, file }];
            mountFiles();
            let f = openAt('data/' + file.name);
            const extra = { main: file.name, companions: [] };
            try {
                const kind = Converter.detectH5Kind(f);
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
            state.files.struct = file || null;
            mountFiles();
            if (!file) return { result: null };
            let parent;
            if (await isHdf5(file)) {
                const f = openAt('struct/' + file.name);
                try {
                    parent = Converter.readUnifiedStructure(f);
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
        async loadExtras({ files }, ctx) {
            state.extras = {};
            state.files.extras = (files || []).filter(Boolean);
            mountFiles();
            const out = [];
            for (const [i, file] of state.files.extras.entries()) {
                const opts = { size: file.size, tick: ctx.tick, progress: f => ctx.progress(`Reading ${file.name}`, f) };
                let volume;
                if (!(await isHdf5(file))) {
                    volume = await readTextVolume(file, opts);
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

        // params: { format, radiation, manual, grid, customFrame, precision,
        // layout, compression, recipe, profileWidth } - see
        // Converter.planConversion and Processing.applyRecipe.
        async prepare(params, ctx) {
            state.plan = null;
            if (!state.data) throw new Error('no data file loaded');
            const input = state.data.grid ? { grid: state.data.grid } : { model: state.data.model };
            const plan = Converter.planConversion(input, Object.assign({}, params, { structure: state.struct }));
            for (const line of plan.logs) ctx.log(line);
            let process = null;
            if (params.recipe && params.recipe.steps && params.recipe.steps.length) {
                const recipe = Processing.normalizeRecipe(params.recipe);
                ctx.log(`Processing ${plan.model.dims.join(' x ')} voxels with ${recipe.steps.length} step(s):`);
                plan.model = await Processing.applyRecipe(plan.model, recipe, {
                    cell: plan.cell, extras: recipeExtras(recipe, params), fft: fftEngine(ctx.log),
                    tick: ctx.tick, progress: f => ctx.progress('Processing', f), log: ctx.log,
                });
                Converter.checkWritable(plan.model, params.format);
                process = {
                    program: '3DSConvert', recipe,
                    description: recipe.steps.map((s, n) => `${n + 1}. ${Processing.describeStep(s)}`).join('\n'),
                };
            }
            state.plan = { plan, params, process };
            const text = params.format === 'dat' || params.format === 'vtk';
            return {
                result: {
                    notes: plan.model.notes || [], dims: plan.model.dims,
                    axesType: plan.model.axesType || 'hkl', processed: !!process,
                    cell: plan.cell, cellSource: plan.cellSource,
                    estimate: Converter.estimateOutputBytes(plan.model, params.format, params),
                    nonFinite: text ? Converter.countNonFinite(plan.model.values) : 0,
                },
            };
        },

        async write(_args, ctx) {
            if (!state.plan) throw new Error('nothing to write; prepare the conversion first');
            const { plan, params, process } = state.plan;
            const progress = f => ctx.progress('Writing', f);
            if (params.format === 'dat' || params.format === 'vtk' || params.format === 'profile') {
                const chunks = params.format === 'dat' ? Converter.writeOldDatChunks(plan.model, plan.cell)
                    : params.format === 'vtk' ? Converter.writeVtkChunks(plan.model, plan.cell)
                    : Processing.writeProfileChunks(plan.model, plan.cell, params.profileWidth);
                const estimate = Math.max(1, Converter.estimateOutputBytes(plan.model, params.format));
                let written = 0;
                for (const chunk of chunks) {
                    await ctx.emit(chunk);
                    written += chunk.length;
                    progress(Math.min(0.99, written / estimate));
                }
                progress(1);
                return { result: { kind: 'text' } };
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
