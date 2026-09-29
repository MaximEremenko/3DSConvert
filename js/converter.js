/*
 * Diffuse-scattering data format converter core.
 *
 * Converts between:
 *   - Unified data format HDF5 (/scattering/data and /entry/data layouts,
 *     as written by RMCProfile's unified_hdf5_io.f90 and DiffuseCode)
 *   - Yell 1.0 HDF5 (flat /data, /lower_limits, /step_sizes, /unit_cell)
 *   - RMCProfile old 3d-diffuse text format ("npoints nsec" header followed
 *     by "i j k qx qy qz intensity" rows with Q in cartesian 1/Angstrom)
 *
 * The internal model mirrors rmc_unified_data_t:
 *   dims    [nh, nk, nl]
 *   corner  hkl of pixel (1,1,1)
 *   vectors vectors[axis][component] hkl increment per pixel step
 *   values  Float32Array (float32 sources) or Float64Array, h fastest:
 *           idx = (il*nk + ik)*nh + ih; NaN marks a missing/masked voxel
 *   cellLengths/cellAngles: cell stored with the data (may be unit metric)
 *   notes   assumptions the reader made, for the log
 *
 * Large files: HDF5 readers are async and read the data array in slabs
 * along its slowest axis (opts.tick is awaited between slabs, so a caller
 * can yield and cancel; opts.progress gets the fraction done). Text formats
 * are parsed line by line, from a string or a byte stream, into a grid in
 * the file's own frame (Cartesian Q for .dat and Scatty VTK); toHklModel
 * applies the parent cell later, so a cell change needs no re-parse. HDF5
 * writers stream plane by plane into chunked datasets when the data are
 * large or compressed.
 *
 * Axis-order conventions (verified against files produced by the Fortran
 * writers and by DISCUS):
 *   /scattering/data/data     C dims [nl,nk,nh]  (flat: h fastest)
 *   /entry/data/data_values   C dims [nh,nk,nl]  (flat: l fastest)
 *   Yell /data                C dims [nh,nk,nl]  (flat: l fastest)
 *   /scattering/data/step_vectors      flat[axis*3 + comp]
 *   /entry/data/data_increment_vector  flat[comp*3 + axis]
 * Readers also accept the transposed /scattering/data layout of the
 * write_diffuse_scattering.py reference writer (C dims [nh,nk,nl],
 * step_vectors flat[comp*3 + axis]) when the shape or the NeXus
 * AXISNAME_indices attributes identify it, including legacy
 * "Disorder scattering 1.0" files without lower_limits/step_vectors.
 *
 * Scatty VTK (STRUCTURED_POINTS, ASCII): ORIGIN/SPACING are cartesian Q in
 * 1/Angstrom with the 2*pi convention (verified against Scatty's paired
 * *_list.txt hkl output); point values are x fastest, z slowest, which
 * matches the internal h-fastest layout directly. STRUCTURED_POINTS stores
 * no axis directions: Scatty and Spinteract write ORIGIN as the cartesian
 * corner but SPACING only as step lengths along their (orthogonal, possibly
 * rotated) grid axes, so rotated grids need the program's config file.
 * 3DSCalculator's "(HKL grid)" VTK and Scatty's supercell Bragg-peak VTK
 * store ORIGIN/SPACING in reciprocal-lattice units instead.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.Converter = factory();
        // index.html rebuilds the module inside its Web Worker from this source.
        root.ConverterFactory = factory;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEG = Math.PI / 180.0;
    const UNIT_METRIC_TOL = 1e-6;
    const UNIFIED_DATA_DICTIONARY = 'Disorder unified data';
    const LEGACY_DATA_DICTIONARY = 'Disorder scattering';
    const UNIFIED_STRUCTURE_DICTIONARY = 'Disorder structure';
    const ALLOWED_DATA_AXES = new Set([
        'hkl', 'Q', '2theta', 'dstar', 'sin(theta)/lambda', 'theta',
        'xyz', 'uvw', 'r',
    ]);
    // HDF5 filters compiled into h5wasm: deflate, shuffle, fletcher32, szip,
    // n-bit, scale-offset. Anything else is a plugin the engine lacks, and
    // h5wasm then returns undecoded bytes instead of raising an error.
    const BUILTIN_FILTERS = new Set([1, 2, 3, 4, 5, 6]);
    const PLUGIN_FILTER_NAMES = {
        307: 'bzip2', 32000: 'LZF', 32001: 'Blosc', 32004: 'LZ4',
        32008: 'bitshuffle', 32013: 'ZFP', 32015: 'Zstandard', 32026: 'Blosc2',
    };

    function textValue(value) {
        if (value === null || value === undefined) return '';
        if (ArrayBuffer.isView(value)) {
            if (value instanceof Uint8Array || value instanceof Int8Array) {
                const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                const end = bytes.indexOf(0);
                return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes).trim();
            }
            value = Array.from(value);
        }
        if (Array.isArray(value)) {
            if (!value.length) return '';
            if (value.every(v => typeof v === 'number')) {
                const bytes = Uint8Array.from(value);
                const end = bytes.indexOf(0);
                return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes).trim();
            }
            return String(value[0]).replace(/\0+$/g, '').trim();
        }
        return String(value).replace(/\0+$/g, '').trim();
    }

    function datasetText(f, path) {
        const ds = f.get(path);
        return ds ? textValue(ds.value) : '';
    }

    function attributeText(obj, name) {
        const attr = obj && obj.attrs && obj.attrs[name];
        return attr ? textValue(attr.value) : '';
    }

    // A 3 x 3 matrix (rows) from 9 numbers in row order, or null.
    function rows3(flat) {
        return flat && flat.length === 9 && flat.every(Number.isFinite) ? [flat.slice(0, 3), flat.slice(3, 6), flat.slice(6, 9)] : null;
    }

    // A numeric attribute (scalar or first element), or null.
    function attributeNumber(obj, name) {
        const attr = obj && obj.attrs && obj.attrs[name];
        if (!attr) return null;
        const v = Number(firstValue(attr.value));
        return Number.isFinite(v) ? v : null;
    }

    function firstValue(value) {
        if (ArrayBuffer.isView(value) || Array.isArray(value)) return value.length ? value[0] : undefined;
        return value;
    }

    function assertDecodable(ds, path) {
        let filters = [];
        try { filters = ds.filters || []; } catch (_) { filters = []; }
        const missing = filters.filter(x => !BUILTIN_FILTERS.has(Number(x.id)));
        if (missing.length) {
            const names = missing.map(x =>
                `${PLUGIN_FILTER_NAMES[x.id] || x.name || 'unknown'} (filter id ${x.id})`).join(', ');
            throw new Error(`${path} is compressed with ${names}, which this HDF5 engine cannot ` +
                'decode (it reads gzip/deflate, shuffle, szip, fletcher32, n-bit and scale-offset); ' +
                're-save the file without it, e.g. h5repack -f GZIP=4 in.h5 out.h5');
        }
    }

    function readDataset(ds, path) {
        assertDecodable(ds, path);
        const value = ds.value;
        if (value instanceof BigInt64Array || value instanceof BigUint64Array) {
            return Float64Array.from(value, Number);
        }
        return value;
    }

    // Numeric dataset as a plain array; null when absent unless `required`
    // names the file kind for the error message.
    function numbersAt(f, path, required) {
        const ds = f.get(path);
        if (!ds) {
            if (required) throw new Error(`${required}: missing ${path}`);
            return null;
        }
        const value = readDataset(ds, path);
        const list = ArrayBuffer.isView(value) || Array.isArray(value) ? Array.from(value) : [value];
        return list.map(Number);
    }

    // -------------------------------------------------------- slab-wise reads

    const SLAB_BYTES = 32 * 1048576;

    function isFloat32Dataset(ds) {
        const m = ds.metadata || {};
        return m.type === 1 && Number(m.size) === 4;       // H5T_FLOAT, 4 bytes
    }

    function allocFor(ds, n) {
        return isFloat32Dataset(ds) ? new Float32Array(n) : new Float64Array(n);
    }

    // Read a dataset slab by slab along its first dimension, so the HDF5
    // heap only ever holds one slab. Slabs follow the chunking when there is
    // one. onSlab(start, count, values) receives `count` planes in C order.
    // box: [start, end) per dimension to read only that hyperslab; start
    // then counts from the box's first plane.
    async function forEachSlab(ds, path, opts, onSlab, box) {
        opts = opts || {};
        const shape = Array.from(ds.shape || []).map(Number);
        if (!shape.length) throw new Error(`${path} is a scalar, expected an array`);
        assertDecodable(ds, path);
        const b = box || shape.map(n => [0, n]);
        const n0 = b[0][1] - b[0][0];
        const planeLen = b.slice(1).reduce((a, [lo, hi]) => a * (hi - lo), 1);
        const itemBytes = Math.max(1, Number((ds.metadata || {}).size) || 8);
        const chunks = (ds.metadata || {}).chunks;
        const chunk0 = chunks && chunks.length ? Number(chunks[0]) : 0;
        const fit = Math.max(1, Math.floor((opts.slabBytes || SLAB_BYTES) / (planeLen * itemBytes)));
        const planes = Math.min(n0, chunk0 > 0 && chunk0 <= fit ? chunk0 * Math.floor(fit / chunk0) : fit);
        for (let start = 0; start < n0; start += planes) {
            const count = Math.min(planes, n0 - start);
            let values = ds.slice(box ? [[b[0][0] + start, b[0][0] + start + count]].concat(b.slice(1)) : [[start, start + count]]);
            if (values instanceof BigInt64Array || values instanceof BigUint64Array) {
                values = Float64Array.from(values, Number);
            }
            onSlab(start, count, values);
            if (opts.progress) opts.progress((start + count) / n0);
            if (opts.tick) await opts.tick();
        }
    }

    // box: inclusive [lo, hi] index ranges per model axis (h, k, l), or null.
    const boxDims = box => box.map(([lo, hi]) => hi - lo + 1);
    const hyperslab = box => box.map(([lo, hi]) => [lo, hi + 1]);

    // Dataset in C order [nh,nk,nl] (l fastest) -> h-fastest values.
    async function readLFastest(ds, path, dims, opts, box) {
        const [nh, nk, nl] = box ? boxDims(box) : dims;
        const out = allocFor(ds, nh * nk * nl);
        await forEachSlab(ds, path, opts, (h0, count, slab) => {
            for (let dh = 0; dh < count; dh++) {
                const ih = h0 + dh;
                for (let ik = 0; ik < nk; ik++) {
                    const src = (dh * nk + ik) * nl;
                    for (let il = 0; il < nl; il++) out[(il * nk + ik) * nh + ih] = slab[src + il];
                }
            }
        }, box && hyperslab(box));
        return out;
    }

    // Dataset in C order [nl,nk,nh] (h fastest), or a lower-rank array in
    // the same flat order: slabs copy straight in.
    async function readHFastest(ds, path, dims, opts, box) {
        const sub = box && ds.shape && ds.shape.length === 3;
        const n = sub ? boxDims(box).reduce((a, b) => a * b, 1) : dims[0] * dims[1] * dims[2];
        const out = allocFor(ds, n);
        await forEachSlab(ds, path, opts, (start, count, slab) => out.set(slab, start * (slab.length / count)),
            sub ? hyperslab([box[2], box[1], box[0]]) : null);
        return out;
    }

    // Any rank-1..3 dataset; axisOfDim[d] is the model axis (0 = abscissa)
    // of dataset dimension d in C order. Returns { values, dims }.
    async function readPermuted(ds, path, axisOfDim, opts, box) {
        const shape = Array.from(ds.shape || []).map(Number);
        const rank = shape.length;
        while (shape.length < 3) shape.push(1);
        const sub = box && rank === 3;
        const dims = [1, 1, 1];
        axisOfDim.forEach((axis, d) => { dims[axis] = sub ? box[axis][1] - box[axis][0] + 1 : shape[d]; });
        const stride = [1, dims[0], dims[0] * dims[1]];
        const s0 = stride[axisOfDim[0]], s1 = stride[axisOfDim[1]], s2 = stride[axisOfDim[2]];
        const out = allocFor(ds, dims[0] * dims[1] * dims[2]);
        const n1 = dims[axisOfDim[1]], n2 = dims[axisOfDim[2]];
        await forEachSlab(ds, path, opts, (start, count, slab) => {
            let src = 0;
            for (let d0 = start; d0 < start + count; d0++) {
                for (let d1 = 0; d1 < n1; d1++) {
                    const base = d0 * s0 + d1 * s1;
                    for (let d2 = 0; d2 < n2; d2++) out[base + d2 * s2] = slab[src++];
                }
            }
        }, sub ? hyperslab(axisOfDim.map(axis => box[axis])) : null);
        return { values: out, dims };
    }

    // opts.crop ({ h: [min, max], k: ..., l: ... }) as an index box on this
    // grid, or null when nothing is cut or the crop cannot apply here (then
    // with a note). The grid axes must run along h, k and l.
    function readBox(dims, corner, vectors, opts, notes, axesType) {
        const crop = opts && opts.crop;
        if (!crop || !['h', 'k', 'l'].some(n => crop[n])) return null;
        if (axesType && axesType !== 'hkl') {
            notes.push('crop on read needs hkl axes; the whole grid was read');
            return null;
        }
        const axisOf = [-1, -1, -1];
        for (let a = 0; a < 3; a++) {
            if (dims[a] <= 1) continue;
            const v = vectors[a], big = Math.max(...v.map(Math.abs));
            const nz = [0, 1, 2].filter(c => Math.abs(v[c]) > 1e-9 * big);
            if (nz.length !== 1) {
                notes.push('crop on read needs grid axes along h, k and l; the whole grid was read');
                return null;
            }
            axisOf[nz[0]] = a;
        }
        const lo = [0, 0, 0], hi = dims.map(n => n - 1);
        ['h', 'k', 'l'].forEach((name, c) => {
            const r = crop[name];
            if (!r || axisOf[c] < 0) return;
            const a = axisOf[c], step = vectors[a][c];
            let i0 = (r[0] - corner[c]) / step, i1 = (r[1] - corner[c]) / step;
            if (step < 0) [i0, i1] = [i1, i0];
            lo[a] = Math.max(lo[a], Math.ceil(i0 - 1e-6));
            hi[a] = Math.min(hi[a], Math.floor(i1 + 1e-6));
            if (lo[a] > hi[a]) throw new Error(`crop on read: no grid points with ${name} in ${r[0]}..${r[1]}`);
        });
        if (lo.every(x => x === 0) && hi.every((x, a) => x === dims[a] - 1)) return null;
        const box = lo.map((x, a) => [x, hi[a]]);
        notes.push(`cropped on read to ${boxDims(box).join(' x ')} of ${dims.join(' x ')}`);
        return box;
    }

    // The grid of a box: its dims and corner, and the vectors of axes that
    // keep more than one point.
    function boxedGrid(box, dims, corner, vectors) {
        if (!box) return { dims, corner, vectors };
        const d = boxDims(box);
        return {
            dims: d,
            corner: [0, 1, 2].map(c => corner[c] + box.reduce((acc, [lo], a) => acc + lo * vectors[a][c], 0)),
            vectors: vectors.map((v, a) => (d[a] > 1 ? v.slice() : [0, 0, 0])),
        };
    }

    function normalizeRadiation(value) {
        const text = String(value || '').trim().toLowerCase();
        if (!text) return 'unknown';
        if (/^x[-_ ]?rays?$/.test(text)) return 'xray';
        if (/^neutrons?$/.test(text)) return 'neutron';
        if (/^electrons?$/.test(text)) return 'electron';
        return text;
    }

    // C-order [nh,nk,nl] (l fastest) -> internal h-fastest layout.
    function lFastestToHFastest(flat, nh, nk, nl, float32) {
        const values = float32 ? new Float32Array(nh * nk * nl) : new Float64Array(nh * nk * nl);
        for (let il = 0; il < nl; il++)
            for (let ik = 0; ik < nk; ik++)
                for (let ih = 0; ih < nh; ih++)
                    values[(il * nk + ik) * nh + ih] = flat[(ih * nk + ik) * nl + il];
        return values;
    }

    function countNonFinite(values) {
        let n = 0;
        for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) n++;
        return n;
    }

    // Number() plus Fortran "D" exponents (1.0D+00).
    function num(token) {
        const v = Number(token);
        return Number.isNaN(v) ? Number(String(token).replace(/[dD]/, 'e')) : v;
    }

    function unifiedDictionary(f) {
        return datasetText(f, 'entry/data/audit_conform_dict_name') ||
               attributeText(f, 'audit_conform_dict_name');
    }

    function validateUnifiedDictionary(f, expectedKind) {
        const dict = unifiedDictionary(f);
        // RMCProfile deliberately keeps a read fallback for pre-contract files.
        if (!dict) return { dictionary: '', legacy: true };
        if (expectedKind === 'structure') {
            if (dict !== UNIFIED_STRUCTURE_DICTIONARY) {
                throw new Error(`unified structure: wrong dictionary ${dict}`);
            }
        } else if (dict !== UNIFIED_DATA_DICTIONARY && dict !== LEGACY_DATA_DICTIONARY) {
            throw new Error(`unified data: wrong dictionary ${dict}`);
        }
        return { dictionary: dict, legacy: dict === LEGACY_DATA_DICTIONARY };
    }

    function validateDataContract(f, groupObj, reciprocalFallback) {
        const axesType = datasetText(f, 'entry/data/data_type_axes') ||
            attributeText(groupObj, 'data_type_axes') ||
            (String(reciprocalFallback || '').trim() === 'patterson' ? 'uvw' :
             String(reciprocalFallback || '').trim() === 'direct' ? 'xyz' : 'hkl');
        if (!ALLOWED_DATA_AXES.has(axesType)) {
            throw new Error(`unified data: unsupported data_type_axes ${axesType}`);
        }
        const numberType = datasetText(f, 'entry/data/data_type_number') ||
            attributeText(groupObj, 'data_type_number') || 'real';
        if (numberType !== 'real') {
            throw new Error(`unified data: unsupported data_type_number ${numberType}`);
        }
        if (axesType !== 'hkl' && axesType !== 'Q' && axesType !== 'uvw') {
            throw new Error(`unified data axes are ${axesType}; this 3-D converter supports hkl or Q axes ` +
                '(reciprocal space) and uvw axes (3D-ΔPDF)');
        }
        return { axesType, numberType };
    }

    // What the file says about its values, kept so the writers can pass it
    // on: data_type_content for direct-space data, data_type_symmetrized.
    function dataTypeMeta(axesType, content, symmetrized) {
        const out = {};
        if (axesType === 'uvw') out.content = content || '3d-delta-pdf';
        if (symmetrized && symmetrized !== 'none') out.symmetrized = symmetrized;
        return out;
    }

    // Grid component (0-2) an axis name stands for: h/k/l, or u/v/w for
    // direct (Patterson) space; -1 for anything else.
    function axisComponent(name) {
        const n = String(name).trim().toLowerCase();
        return n.length === 1 ? Math.max('hkl'.indexOf(n), 'uvw'.indexOf(n)) : -1;
    }

    // ----------------------------------------------------------------- cell math

    // Mirrors cell_to_lattice: columns of A are the lattice vectors.
    function cellToLattice(lengths, angles) {
        const [a, b, c] = lengths;
        const [al, be, ga] = angles.map(x => x * DEG);
        if (!(a > 0 && b > 0 && c > 0)) throw new Error('cell lengths must be positive');
        const ca = Math.cos(al), cb = Math.cos(be), cg = Math.cos(ga), sg = Math.sin(ga);
        if (Math.abs(sg) < 1e-12) throw new Error('gamma angle gives a singular lattice');
        const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        A[0][0] = a;
        A[0][1] = b * cg; A[1][1] = b * sg;
        A[0][2] = c * cb;
        A[1][2] = c * (ca - cb * cg) / sg;
        let z2 = c * c - A[0][2] * A[0][2] - A[1][2] * A[1][2];
        if (z2 < 0 && Math.abs(z2) < 1e-10) z2 = 0;
        if (z2 < 0) throw new Error('cell angles do not produce a real lattice');
        A[2][2] = Math.sqrt(z2);
        return A;
    }

    function latticeToCell(A) {
        const col = j => [A[0][j], A[1][j], A[2][j]];
        const norm = v => Math.hypot(v[0], v[1], v[2]);
        const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        const a = norm(col(0)), b = norm(col(1)), c = norm(col(2));
        const clamp = x => Math.max(-1, Math.min(1, x));
        return {
            lengths: [a, b, c],
            angles: [
                Math.acos(clamp(dot(col(1), col(2)) / (b * c))) / DEG,
                Math.acos(clamp(dot(col(0), col(2)) / (a * c))) / DEG,
                Math.acos(clamp(dot(col(0), col(1)) / (a * b))) / DEG,
            ],
        };
    }

    function cross(u, v) {
        return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    }

    // Columns of B are the reciprocal basis vectors (without 2*pi).
    function reciprocalBasis(A) {
        const col = j => [A[0][j], A[1][j], A[2][j]];
        const a1 = col(0), a2 = col(1), a3 = col(2);
        const vol = a1[0] * cross(a2, a3)[0] + a1[1] * cross(a2, a3)[1] + a1[2] * cross(a2, a3)[2];
        if (Math.abs(vol) < 1e-12) throw new Error('cell gives a singular reciprocal basis');
        const b1 = cross(a2, a3).map(x => x / vol);
        const b2 = cross(a3, a1).map(x => x / vol);
        const b3 = cross(a1, a2).map(x => x / vol);
        return [[b1[0], b2[0], b3[0]], [b1[1], b2[1], b3[1]], [b1[2], b2[2], b3[2]]];
    }

    function hklToQ(B, hkl) {
        const t = 2 * Math.PI;
        return [
            t * (B[0][0] * hkl[0] + B[0][1] * hkl[1] + B[0][2] * hkl[2]),
            t * (B[1][0] * hkl[0] + B[1][1] * hkl[1] + B[1][2] * hkl[2]),
            t * (B[2][0] * hkl[0] + B[2][1] * hkl[1] + B[2][2] * hkl[2]),
        ];
    }

    // hkl = A^T q / 2pi  (mirrors cart_q_to_hkl)
    function qToHkl(A, q) {
        const t = 2 * Math.PI;
        return [
            (A[0][0] * q[0] + A[1][0] * q[1] + A[2][0] * q[2]) / t,
            (A[0][1] * q[0] + A[1][1] * q[1] + A[2][1] * q[2]) / t,
            (A[0][2] * q[0] + A[1][2] * q[1] + A[2][2] * q[2]) / t,
        ];
    }

    function isUnitMetric(lengths, angles) {
        return lengths.every(x => Math.abs(x - 1) <= UNIT_METRIC_TOL) &&
               angles.every(x => Math.abs(x - 90) <= UNIT_METRIC_TOL);
    }

    // Cartesian Q axes to hkl: with a UB (Q = 2 pi UB hkl, the sample frame)
    // when one is given, else with the cell in the frame with a along x.
    function modelAxesToHkl(model, cell, ub) {
        if (!model || model.axesType === 'hkl' || !model.axesType) return model;
        if (model.axesType !== 'Q') {
            throw new Error(`cannot convert ${model.axesType} axes to hkl`);
        }
        let toHkl;
        if (ub) {
            const K = invert3x3(ub.map(r => r.map(x => 2 * Math.PI * x)));
            toHkl = q => [0, 1, 2].map(r => K[r][0] * q[0] + K[r][1] * q[1] + K[r][2] * q[2]);
        } else {
            const A = cellToLattice(cell.lengths, cell.angles);
            toHkl = q => qToHkl(A, q);
        }
        return Object.assign({}, model, {
            corner: toHkl(model.corner),
            vectors: model.vectors.map(toHkl),
            axesType: 'hkl',
        });
    }

    // ----------------------------------------------------------------- structure

    // Parse an .rmc6f header; returns parent cell = supercell / dimensions.
    function parseRmc6f(text) {
        let unitCells = null, cell = null, latticeRows = null;
        const lines = text.split(/\r?\n/);
        for (let n = 0; n < lines.length; n++) {
            const line = lines[n];
            if (/^Supercell dimensions:/i.test(line)) {
                unitCells = line.split(':')[1].trim().split(/\s+/).map(Number);
            } else if (/^Cell \(Ang\/deg\):/i.test(line)) {
                cell = line.split(':')[1].trim().split(/\s+/).map(Number);
            } else if (/^Lattice vectors \(Ang\):/i.test(line)) {
                latticeRows = [lines[n + 1], lines[n + 2], lines[n + 3]]
                    .map(s => s.trim().split(/\s+/).map(Number));
            } else if (/^Atoms/i.test(line)) {
                break;
            }
        }
        if (!cell && latticeRows) {
            // Each rmc6f line holds one lattice vector: column i of A.
            const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            for (let i = 0; i < 3; i++) for (let r = 0; r < 3; r++) A[r][i] = latticeRows[i][r];
            const derived = latticeToCell(A);
            cell = derived.lengths.concat(derived.angles);
        }
        if (!cell) throw new Error('rmc6f: no "Cell (Ang/deg)" or "Lattice vectors" found');
        if (!unitCells || unitCells.some(x => !(x > 0))) {
            throw new Error('rmc6f: no valid "Supercell dimensions" found');
        }
        return {
            lengths: [cell[0] / unitCells[0], cell[1] / unitCells[1], cell[2] / unitCells[2]],
            angles: [cell[3], cell[4], cell[5]],
            supercell: unitCells,
        };
    }

    // Unified structure stores the basic/parent cell directly. unit_cells
    // describes the supercell replication and must not divide these lengths.
    function readUnifiedStructure(f) {
        validateUnifiedDictionary(f, 'structure');
        const need = p => numbersAt(f, p, 'unified structure');
        const lengths = need('entry/data/unit_cell_lengths');
        const angles = need('entry/data/unit_cell_angles');
        const cells = need('entry/data/unit_cells');
        if (cells.some(x => !(x > 0))) throw new Error('unified structure: invalid unit_cells');
        return {
            lengths: lengths.slice(0, 3),
            angles,
            supercell: cells,
        };
    }

    // subhkl's indexer output: the refined cell (sample/a ... sample/gamma,
    // degrees) with its U and B matrices and the indexed peaks - a cell
    // source, not a volume.
    const isSubhklIndexer = f => !!(f.get('sample/a') && f.get('sample/alpha') && (f.get('sample/B') || f.get('peaks/h')));

    function readSubhklCell(f) {
        const need = name => {
            const v = firstNumber(f, 'sample/' + name);
            if (!(v > 0)) throw new Error(`subhkl indexer file: no valid sample/${name}`);
            return v;
        };
        const sg = datasetText(f, 'sample/space_group');
        // B is the upper Cholesky factor of the reciprocal metric (Busing-Levy,
        // no 2 pi), so U B is a UB in Mantid's sense.
        const U = rows3(numbersAt(f, 'sample/U')), B = rows3(numbersAt(f, 'sample/B'));
        const ub = U && B ? U.map(r => [0, 1, 2].map(c => r[0] * B[0][c] + r[1] * B[1][c] + r[2] * B[2][c])) : null;
        return Object.assign({ lengths: ['a', 'b', 'c'].map(need), angles: ['alpha', 'beta', 'gamma'].map(need), source: 'subhkl' },
            sg ? { spaceGroup: sg } : {}, ub ? { ub } : {});
    }

    // ----------------------------------------------------------------- readers

    function detectH5Kind(f) {
        const dict = unifiedDictionary(f);
        if (dict === UNIFIED_STRUCTURE_DICTIONARY) return 'structure';
        if (dict === UNIFIED_DATA_DICTIONARY || dict === LEGACY_DATA_DICTIONARY) return 'unified';
        if (f.get('scattering/data/data')) return 'unified';
        if (f.get('entry/data/data_values')) return 'unified';
        if (f.get('data') && f.get('lower_limits') && f.get('unit_cell')) return 'yell';
        if (f.get('data') && f.get('H') && f.get('K') && f.get('L')) return 'rspace3d';
        if (f.get('entry/data/atom_position') || f.get('entry/data/unit_cells')) return 'structure';
        if (isSubhklIndexer(f)) return 'subhkl';
        if (f.get('MDHistoWorkspace')) return 'mantid-md';
        if (f.get('MDEventWorkspace')) return 'mantid-events';
        const top = f.keys();
        if (top.some(k => /^mantid_workspace_\d+$/.test(k))) return 'mantid-workspace';
        if (nexusCandidates(f).length) return 'nexus';
        for (const k of top) {
            const g = f.get(k);
            if (isGroup(g) && g.keys().some(n => attributeText(g.get(n), 'NX_class') === 'NXevent_data')) return 'nexus-events';
        }
        return 'unknown';
    }

    // Why a recognised HDF5 file cannot be converted, or null.
    function unsupportedKindMessage(kind) {
        return {
            'mantid-events': 'this is a Mantid MDEventWorkspace (events, not a grid); bin it ' +
                '(e.g. BinMD or MDNorm) and save the MDHistoWorkspace with SaveMD',
            'mantid-workspace': 'this is a Mantid event or histogram workspace, not a reciprocal-space ' +
                'volume; convert it to an MDHistoWorkspace in HKL (e.g. MDNorm) and save that with SaveMD',
            'nexus-events': 'this is a raw event NeXus file from the instrument; it needs data reduction ' +
                '(e.g. in Mantid) into an HKL volume first',
            structure: 'this is a structure file - load it in section 2',
            subhkl: 'this is a subhkl indexer file (a cell and UB, no volume) - load it as the structure file in section 2',
            unknown: 'unrecognized HDF5 layout',
        }[kind] || null;
    }

    // opts: { tick, progress, slabBytes } (see forEachSlab).
    async function readUnifiedData(f, opts) {
        const identity = validateUnifiedDictionary(f, 'data');
        let model = null;
        if (f.get('scattering/data/data')) model = await readScatteringGroup(f, opts);
        else if (f.get('entry/data/data_values')) model = await readEntryGroup(f, opts);
        if (model) {
            model.dictionary = identity.dictionary || UNIFIED_DATA_DICTIONARY;
            model.legacyContract = identity.legacy;
            const steps = datasetText(f, 'entry/process/recipe/description');
            if (steps) {
                model.notes.push(`processed by ${datasetText(f, 'entry/process/program') || 'another program'} ` +
                    `on ${datasetText(f, 'entry/process/date') || 'an unknown date'}:\n${steps}`);
            }
            return model;
        }
        throw new Error('no unified diffuse data group found');
    }

    function axisNamesAttr(group) {
        const attr = group.attrs && group.attrs.axes;
        if (!attr) return ['h', 'k', 'l'];
        const v = attr.value;
        const list = typeof v === 'string' ? v.split(/[:,\s]+/) :
            Array.from(ArrayBuffer.isView(v) || Array.isArray(v) ? v : [v], x => textValue(x));
        const names = list.map(x => String(x).trim()).filter(Boolean);
        return names.length === 3 ? names : ['h', 'k', 'l'];
    }

    // Which of the two self-consistent /scattering/data layouts a file uses:
    //   'abs-fastest'  C dims [n_top, n_ord, n_abs], step_vectors flat[axis*3 + comp]
    //                  (this converter; RMCProfile/DISCUS Fortran writers)
    //   'abs-slowest'  C dims [n_abs, n_ord, n_top], step_vectors flat[comp*3 + axis]
    //                  (write_diffuse_scattering.py; legacy "Disorder scattering 1.0")
    function scatteringLayout(f, g, group, names, shape, notes) {
        const indices = names.map(n => {
            const attr = group.attrs && group.attrs[n + '_indices'];
            return attr ? Number(firstValue(attr.value)) : NaN;
        });
        if (indices.every(Number.isFinite)) {
            if (indices.join() === '0,1,2') return 'abs-slowest';
            if (indices.join() === '2,1,0') return 'abs-fastest';
            throw new Error('scattering/data: unsupported axis order ' +
                names.map((n, i) => `${n}_indices=${indices[i]}`).join(', '));
        }
        const lengths = names.map(n => {
            const ds = f.get(g + n);
            return ds && ds.shape && ds.shape.length === 1 ? Number(ds.shape[0]) : NaN;
        });
        if (!lengths.every(Number.isFinite)) return 'abs-fastest';
        const fastest = shape[0] === lengths[2] && shape[1] === lengths[1] && shape[2] === lengths[0];
        const slowest = shape[0] === lengths[0] && shape[1] === lengths[1] && shape[2] === lengths[2];
        if (slowest && !fastest) {
            notes.push(`scattering/data is stored as C [${names.join(',')}] ` +
                '(write_diffuse_scattering.py layout); read accordingly');
            return 'abs-slowest';
        }
        if (!slowest && !fastest) {
            throw new Error(`scattering/data: data shape ${shape.join(' x ')} does not match the ` +
                `${names.join('/')} coordinate lengths ${lengths.join('/')}`);
        }
        if (slowest && !f.get(g + 'data_axes') && !f.get('entry/data/data_values')) {
            notes.push(`the grid is ${shape.join(' x ')}, so its axis order cannot be told from the ` +
                'shape; assumed this converter\'s layout (abscissa fastest). If h and l look swapped, ' +
                'the file uses the write_diffuse_scattering.py layout');
        }
        return 'abs-fastest';
    }

    // Legacy files keep the grid only in the h/k/l coordinate arrays.
    function gridFromCoordinates(f, g, names, dims) {
        const corner = [0, 0, 0];
        const vectors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        names.forEach((name, axis) => {
            const comp = axisComponent(name);
            if (comp < 0) {
                throw new Error(`scattering/data: axis "${name}" is not h, k, l or u, v, w; ` +
                    'only hkl and 3D-ΔPDF uvw grids are supported');
            }
            const coords = numbersAt(f, g + name, 'scattering/data');
            const n = dims[axis];
            if (coords.length !== n) throw new Error(`scattering/data: ${name} has ${coords.length} values, expected ${n}`);
            const step = n > 1 ? (coords[n - 1] - coords[0]) / (n - 1) : 0;
            for (let i = 0; i < n; i++) {
                if (Math.abs(coords[i] - (coords[0] + i * step)) > 1e-6 * Math.max(1, Math.abs(coords[n - 1] - coords[0]))) {
                    throw new Error(`scattering/data: ${name} coordinates are not evenly spaced`);
                }
            }
            corner[comp] = coords[0];
            vectors[axis][comp] = step;
        });
        return { corner, vectors };
    }

    async function readScatteringGroup(f, opts) {
        const g = 'scattering/data/';
        const group = f.get('scattering/data');
        const ds = f.get(g + 'data');
        const shape = Array.from(ds.shape || []).map(Number);
        if (shape.length !== 3) throw new Error('scattering data must be rank 3');
        const notes = [];
        const names = axisNamesAttr(group);
        const layout = scatteringLayout(f, g, group, names, shape, notes);
        const fullDims = layout === 'abs-fastest' ? [shape[2], shape[1], shape[0]] : shape.slice();
        let corner = numbersAt(f, g + 'lower_limits');
        const sv = numbersAt(f, g + 'step_vectors');
        let vectors;
        if (corner && sv && sv.length === 9) {
            vectors = [0, 1, 2].map(axis => [0, 1, 2].map(comp =>
                layout === 'abs-fastest' ? sv[axis * 3 + comp] : sv[comp * 3 + axis]));
        } else {
            ({ corner, vectors } = gridFromCoordinates(f, g, names, fullDims));
            notes.push(`no lower_limits/step_vectors: grid taken from the ${names.join('/')} coordinate arrays`);
        }
        const contract = validateDataContract(f, group, attributeText(group, 'space') || 'reciprocal');
        const box = readBox(fullDims, corner, vectors, opts, notes, contract.axesType);
        const values = layout === 'abs-fastest'
            ? await readHFastest(ds, g + 'data', fullDims, opts, box)
            : await readLFastest(ds, g + 'data', fullDims, opts, box);
        const grid = boxedGrid(box, fullDims, corner, vectors);
        const dims = grid.dims;
        ({ corner, vectors } = grid);

        let lengths = numbersAt(f, g + 'unit_cell_lengths');
        let angles = numbersAt(f, g + 'unit_cell_angles');
        if (!lengths || !angles) {
            const cell = numbersAt(f, g + 'unit_cell');
            if (cell && cell.length >= 6) {
                lengths = cell.slice(0, 3);
                angles = cell.slice(3, 6);
            }
        }
        if (!lengths || !angles) {
            lengths = [1, 1, 1];
            angles = [90, 90, 90];
            notes.push('no unit cell stored; treated as unit metric');
        }
        const comps = names.map(axisComponent);
        const axes = numbersAt(f, g + 'data_axes') ||
            (comps.every(c => c >= 0) && new Set(comps).size === 3 ? comps.map(c => c + 1) : pickAxes(vectors, dims));
        const radiation = normalizeRadiation(
            attributeText(group, 'radiation') || attributeText(group, 'scattering'));
        return Object.assign({
            dims, corner, vectors, values,
            cellLengths: lengths, cellAngles: angles, radiation, axes,
            axesType: contract.axesType, numberType: contract.numberType, notes,
        }, dataTypeMeta(contract.axesType, attributeText(group, 'content'),
            attributeText(group, 'data_type_symmetrized')));
    }

    function sameShape(a, b) {
        return a.length === b.length && a.every((x, i) => x === b[i]);
    }

    async function readEntryGroup(f, opts) {
        const g = 'entry/data/';
        const dims = numbersAt(f, g + 'data_dimension', 'unified data');   // [nh,nk,nl]
        if (dims.length !== 3 || dims.some(d => !(Number.isInteger(d) && d >= 1))) {
            throw new Error('unified data: data_dimension must hold three positive integers');
        }
        const [nh, nk, nl] = dims;
        const ds = f.get(g + 'data_values');       // C dims [nh,nk,nl], l fastest
        const shape = Array.from(ds.shape || []).map(Number);
        const squeeze = a => a.filter(x => x !== 1);
        const notes = [];
        let reversed = false;
        if (!sameShape(shape, dims) && !(shape.length !== 3 && sameShape(squeeze(shape), squeeze(dims)))) {
            if (!sameShape(shape, [nl, nk, nh])) {
                throw new Error(`unified data: data_values shape ${shape.join(' x ')} does not match ` +
                    `data_dimension ${dims.join(' x ')}`);
            }
            // A Fortran-view writer stores the transpose of every array.
            reversed = true;
            notes.push('data_values is stored in reversed [nl,nk,nh] order; read accordingly');
        }
        const iv = numbersAt(f, g + 'data_increment_vector', 'unified data');
        const fullVectors = [0, 1, 2].map(axis => [0, 1, 2].map(comp =>
            reversed ? iv[axis * 3 + comp] : iv[comp * 3 + axis]));
        const fullCorner = numbersAt(f, g + 'data_corner', 'unified data');
        const reciprocal = datasetText(f, g + 'data_type_reciprocal');
        const contract = validateDataContract(f, f.get('entry/data'), reciprocal);
        const box = reversed || shape.length === 3 ? readBox(dims, fullCorner, fullVectors, opts, notes, contract.axesType) : null;
        let values;
        if (reversed) {
            values = await readHFastest(ds, g + 'data_values', dims, opts, box);
        } else if (shape.length === 3) {
            values = await readLFastest(ds, g + 'data_values', dims, opts, box);
        } else {
            // Size-1 axes dropped from the stored shape: the C order is unchanged.
            const flat = readDataset(ds, g + 'data_values');
            values = lFastestToHFastest(flat, nh, nk, nl, isFloat32Dataset(ds));
        }
        const grid = boxedGrid(box, dims, fullCorner, fullVectors);
        const { corner, vectors } = grid;
        const lengths = numbersAt(f, g + 'unit_cell_lengths', 'unified data');
        const angles = numbersAt(f, g + 'unit_cell_angles', 'unified data');
        const axes = numbersAt(f, g + 'data_axes') || [1, 2, 3];
        const radiation = normalizeRadiation(datasetText(f, g + 'data_radiation'));
        return Object.assign({
            dims: grid.dims, corner, vectors, values,
            cellLengths: lengths, cellAngles: angles, radiation, axes,
            axesType: contract.axesType, numberType: contract.numberType, notes,
        }, dataTypeMeta(contract.axesType, datasetText(f, g + 'data_type_content'),
            datasetText(f, g + 'data_type_symmetrized')));
    }

    // is_direct as a number (booleans and 64-bit ints included), or null.
    function yellDirectFlag(f) {
        const ds = f.get('is_direct');
        if (!ds) return null;
        const v = firstValue(ds.value);
        if (typeof v === 'boolean') return v ? 1 : 0;
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
    }

    function pad3(list, fill) {
        const out = list.slice(0, 3);
        while (out.length < 3) out.push(fill);
        return out;
    }

    // opts.space: 'auto' (default) trusts is_direct; 'reciprocal' overrides an
    // is_direct value that is neither 0 nor 1. Also takes the slab options.
    // is_direct = 1 marks Yell's 3D-ΔPDF output: a direct-space grid on u, v, w.
    async function readYell(f, opts) {
        opts = opts || {};
        const notes = [];
        const flag = yellDirectFlag(f);
        const direct = flag === 1;
        if (direct) notes.push('is_direct = 1: direct-space (3D-ΔPDF) data on u, v, w axes');
        if (flag !== null && flag !== 0 && !direct) {
            if (opts.space !== 'reciprocal') {
                const err = new Error(`Yell is_direct = ${flag} is neither 0 nor 1, so the flag looks ` +
                    'corrupted; if the file holds reciprocal-space intensities, set the Yell data space ' +
                    'to "reciprocal"');
                err.code = 'YELL_INVALID_IS_DIRECT';
                throw err;
            }
            notes.push(`is_direct = ${flag} ignored; read as reciprocal space`);
        }
        const ds = f.get('data');
        if (!ds) throw new Error('Yell file: missing data');
        const shape = Array.from(ds.shape || []).map(Number);   // [nh, nk, nl], l fastest
        if (shape.length < 1 || shape.length > 3) throw new Error('Yell data must be rank 1, 2 or 3');
        const [nh, nk, nl] = pad3(shape, 1);
        if (shape.length < 3) notes.push(`${shape.length}-D data read as a ${nh} x ${nk} x ${nl} grid`);
        const corner = pad3(numbersAt(f, 'lower_limits', 'Yell file'), 0);
        let vectors;
        if (f.get('step_sizes_abs') && f.get('step_sizes_ord') && f.get('step_sizes_top')) {
            vectors = ['step_sizes_abs', 'step_sizes_ord', 'step_sizes_top']
                .map(p => pad3(numbersAt(f, p), 0));
        } else {
            let s = numbersAt(f, 'step_sizes');
            if (!s) {
                s = numbersAt(f, 'step_size');
                if (!s) throw new Error('Yell file: missing step_sizes');
                notes.push('step sizes read from "step_size"');
            }
            s = pad3(s, 0);
            vectors = [[s[0], 0, 0], [0, s[1], 0], [0, 0, s[2]]];
        }
        const cell = numbersAt(f, 'unit_cell', 'Yell file');
        // C [nh], [nh,nk] and [nh,nk,nl] share one flat order, so slabs work for all.
        const box = shape.length === 3 ? readBox([nh, nk, nl], corner, vectors, opts, notes, direct ? 'uvw' : 'hkl') : null;
        const values = await readLFastest(ds, 'data', [nh, nk, nl], opts, box);
        const grid = boxedGrid(box, [nh, nk, nl], corner, vectors);
        return Object.assign({
            dims: grid.dims, corner: grid.corner, vectors: grid.vectors, values,
            cellLengths: cell.slice(0, 3), cellAngles: cell.slice(3, 6),
            radiation: 'unknown', axes: [1, 2, 3], notes,
        }, direct ? { axesType: 'uvw', content: '3d-delta-pdf' } : {});
    }

    // --- rspace3d: CrysAlisPro unwarp layers stacked into a volume ---
    // /data C [nh, nk, nl] (l fastest; NaN where unmeasured); /H, /K, /L the
    // Miller indices along the three axes; cell_* and wavelength attributes;
    // /UB (CrysAlisPro's, in units of 1/wavelength) and /M_inv, the 2x2
    // pixel-to-Miller map of the native raster plane (plane_type HK, HL or
    // KL). The raster is Cartesian, so for oblique cells its first in-plane
    // index also moves along the second: x = X[i] + shear * Y[j], with shear
    // = M_inv[0][1] / M_inv[1][1] = -(v1 . v2) / (v1 . v1) for the two
    // reciprocal vectors of the plane (/H etc. hold the line Y = 0).
    // grid_kind 'hkl_regular' (rawrecon) grids have no shear.
    async function readRspace3d(f, opts) {
        opts = opts || {};
        const notes = [];
        const ds = f.get('data');
        const shape = Array.from(ds.shape || []).map(Number);
        if (shape.length !== 3) throw new Error(`rspace3d: data has ${shape.length} dimensions, expected 3`);
        const axes = ['H', 'K', 'L'].map(n => numbersAt(f, n, 'rspace3d file'));
        const step = axes.map((a, i) => {
            if (a.length !== shape[i]) throw new Error(`rspace3d: ${'HKL'[i]} has ${a.length} values for ${shape[i]} data points`);
            if (a.length < 2) return 0;
            const s = (a[a.length - 1] - a[0]) / (a.length - 1);
            if (a.some((x, n) => Math.abs(x - (a[0] + n * s)) > 1e-6 * Math.max(1, Math.abs(s)))) {
                throw new Error(`rspace3d: the ${'HKL'[i]} axis is not evenly spaced`);
            }
            return s;
        });
        const corner = axes.map(a => a[0]);
        const vectors = [0, 1, 2].map(a => [0, 1, 2].map(c => (a === c ? step[a] : 0)));

        // the cell: attributes, else the UB matrix over the wavelength
        let lengths = ['cell_a', 'cell_b', 'cell_c'].map(n => attributeNumber(f, n));
        let angles = ['cell_alpha', 'cell_beta', 'cell_gamma'].map(n => attributeNumber(f, n));
        const wavelength = attributeNumber(f, 'wavelength');
        const ub = numbersAt(f, 'UB');
        let recip = null;                                     // reciprocal metric (no 2 pi)
        if (lengths.every(x => x > 0) && angles.every(x => x > 0)) {
            const B = reciprocalBasis(cellToLattice(lengths, angles));
            recip = [0, 1, 2].map(i => [0, 1, 2].map(j => B[0][i] * B[0][j] + B[1][i] * B[1][j] + B[2][i] * B[2][j]));
        } else if (ub && ub.length === 9 && wavelength > 0) {
            const U = [0, 1, 2].map(r => [0, 1, 2].map(c => ub[3 * r + c] / wavelength));
            recip = [0, 1, 2].map(i => [0, 1, 2].map(j => U[0][i] * U[0][j] + U[1][i] * U[1][j] + U[2][i] * U[2][j]));
            const G = invert3x3(recip);
            lengths = [0, 1, 2].map(i => Math.sqrt(G[i][i]));
            const ang = (i, j) => Math.acos(Math.max(-1, Math.min(1, G[i][j] / (lengths[i] * lengths[j])))) / DEG;
            angles = [ang(1, 2), ang(0, 2), ang(0, 1)];
            notes.push('cell from the UB matrix and the wavelength');
        } else {
            lengths = [1, 1, 1];
            angles = [90, 90, 90];
            notes.push('no cell in the file; supply the parent cell for Q-space output');
        }

        // the shear of a sheared unwarp raster
        const plane = attributeText(f, 'plane_type') || 'HK';
        const gridKind = attributeText(f, 'grid_kind') || 'unwarp_raster';
        if (gridKind === 'unwarp_raster') {
            const pair = { HK: [0, 1], HL: [0, 2], KL: [1, 2] }[plane];
            if (!pair) throw new Error(`rspace3d: unknown plane_type ${plane}`);
            const [x, y] = pair;
            const m = numbersAt(f, 'M_inv');
            const fromCell = recip ? -recip[x][y] / recip[x][x] : null;
            let shear = 0;
            if (m && m.length === 4 && Math.abs(m[3]) > 1e-15) {
                shear = m[1] / m[3];
                if (fromCell !== null && Math.abs(shear - fromCell) > 1e-6) {
                    notes.push(`M_inv gives a shear of ${shear.toPrecision(6)}, the cell ${fromCell.toPrecision(6)}; M_inv is used`);
                }
            } else if (fromCell !== null) {
                shear = fromCell;
            } else {
                notes.push('no M_inv and no cell, so the raster shear is unknown (taken as 0)');
            }
            if (Math.abs(shear) > 1e-12 && shape[y] > 1) {
                vectors[y][x] = shear * step[y];
                corner[x] += shear * corner[y];
                notes.push(`${plane} raster of an oblique cell: ${'hkl'[x]} moves by ${+shear.toFixed(6)} per unit of ${'hkl'[y]}`);
            }
        }
        const box = readBox(shape, corner, vectors, opts, notes, 'hkl');
        const values = await readLFastest(ds, 'data', shape, opts, box);
        const grid = boxedGrid(box, shape, corner, vectors);

        if (wavelength > 0) notes.push(`wavelength ${wavelength} Angstrom`);
        notes.push('radiation set to xray (CrysAlisPro); change it under Output if needed');
        const laue = attributeText(f, 'laue_group');
        const applied = attributeNumber(f, 'symmetry_ops_applied');
        const symmetrized = !!laue && applied > 0;
        if (symmetrized) notes.push(`symmetrized by rspace3d over Laue group ${laue} (${applied} operations)`);
        const measured = attributeNumber(f, 'measured_pct');
        if (measured !== null) notes.push(`${+measured.toFixed(1)}% of the voxels measured`);
        // CrysAlisPro's UB is in units of 1/wavelength
        const ubBL = ub && ub.length === 9 && wavelength > 0 ? rows3(ub.map(x => x / wavelength)) : null;
        return Object.assign({
            dims: grid.dims, corner: grid.corner, vectors: grid.vectors, values,
            cellLengths: lengths, cellAngles: angles, radiation: 'xray', axes: pickAxes(grid.vectors, grid.dims),
            axesType: 'hkl', notes,
        }, symmetrized ? { symmetrized: 'laue', laueGroup: laue } : {}, ubBL ? { ub: ubBL } : {});
    }

    // ------------------------------------------------------------------ NeXus

    const isDataset = obj => !!obj && typeof obj.slice === 'function' && obj.shape !== undefined;
    const isGroup = obj => !!obj && typeof obj.keys === 'function' && !isDataset(obj);
    const isExternalLink = obj => !!obj && typeof obj.filename === 'string' && typeof obj.obj_path === 'string';

    // Projection names such as "[H,H,0]", "[-H,H,0]", "[0.5H,0,0]", "[0,K,0]"
    // -> [1,1,0], [-1,1,0], [0.5,0,0], [0,1,0]; null when not of that form.
    function projectionVector(name) {
        const m = /^\s*\[([^\]]*)\]\s*$/.exec(String(name || ''));
        if (!m) return null;
        const parts = m[1].split(',').map(s => s.trim());
        if (parts.length !== 3) return null;
        const v = parts.map(p => {
            if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(p)) return Number(p);
            const q = /^([+-]?(?:\d+\.?\d*|\.\d+)?)\*?[HKL]$/i.exec(p);
            if (!q) return NaN;
            return q[1] === '' || q[1] === '+' ? 1 : q[1] === '-' ? -1 : Number(q[1]);
        });
        return v.every(Number.isFinite) && v.some(x => x !== 0) ? v : null;
    }

    // Axis values -> first grid point and step for n points. Values of length
    // n + 1 are bin edges (Mantid) and give bin centres; n values are points.
    function uniformAxis(values, n, label) {
        const edges = values.length === n + 1;
        if (!edges && values.length !== n) {
            throw new Error(`${label} has ${values.length} values for ${n} grid points`);
        }
        const m = values.length - 1;
        const step = m > 0 ? (values[m] - values[0]) / m : 0;
        const tol = 1e-4 * Math.abs(step) + 1e-6 * Math.max(Math.abs(values[0]), Math.abs(values[m]));
        for (let i = 1; i < m; i++) {
            if (Math.abs(values[i] - (values[0] + i * step)) > tol) throw new Error(`${label} is not evenly spaced`);
        }
        return { first: edges ? values[0] + step / 2 : values[0], step, edges };
    }

    function firstNumber(f, path) {
        const v = numbersAt(f, path);
        return v && v.length && Number.isFinite(v[0]) ? v[0] : null;
    }

    // --- Mantid SaveMD (version 2) MDHistoWorkspace ---
    // signal is stored C [D(n-1),...,D0], so D0 varies fastest and model axis j
    // is dimension Dj. D0..D2 hold bin edges. For the HKL frame each dimension
    // is a projection: hkl = W * (d0, d1, d2) with the basis vectors in the
    // columns of the row-major logs/W_MATRIX, also spelled out in the long
    // names ("[H,H,0]"). NaN marks bins without events.
    async function readMantidMD(f, opts) {
        opts = opts || {};
        const g = 'MDHistoWorkspace/data/';
        const notes = [];
        const sig = f.get(g + 'signal');
        if (!isDataset(sig)) throw new Error('MDHistoWorkspace: missing data/signal');
        const shape = Array.from(sig.shape || []).map(Number);
        if (shape.length === 1) {
            throw new Error('this MDHistoWorkspace was written by SaveMD version 1 (flat arrays); ' +
                're-save it with SaveMD version 2');
        }
        const rank = shape.length;
        const expected = Array.from({ length: rank }, (_, i) => 'D' + (rank - 1 - i)).join(':');
        const axesAttr = attributeText(sig, 'axes') || expected;
        if (axesAttr.split(/[:,]/).map(s => s.trim()).join(':') !== expected) {
            const named = axesAttr.split(/[:,]/).map(s => s.trim()).reverse();
            const frames = named.map(n => attributeText(f.get(g + n), 'frame')).filter(Boolean);
            throw new Error(`the MDHistoWorkspace's dimensions are ${named.join(', ')}` +
                (frames.length ? ` (${[...new Set(frames)].join('/')})` : '') + ', not an HKL grid; bin it in HKL ' +
                '(e.g. with MDNorm) before saving');
        }
        // Dimensions after the first three (DeltaE, a temperature ...) are
        // fine when integrated into one bin: the first three hold a volume.
        if (rank > 3) {
            const extra = [];
            for (let j = 3; j < rank; j++) {
                const d = f.get(g + 'D' + j);
                const edges = isDataset(d) ? numbersAt(f, g + 'D' + j) : null;
                extra.push({
                    name: (isDataset(d) && attributeText(d, 'long_name')) || 'D' + j, bins: shape[rank - 1 - j],
                    range: edges && edges.length ? [edges[0], edges[edges.length - 1]] : null, units: isDataset(d) ? attributeText(d, 'units') : '',
                });
            }
            const open = extra.filter(x => x.bins > 1);
            if (open.length) {
                throw new Error(`the MDHistoWorkspace has ${rank} dimensions, and ` +
                    open.map(x => `${x.name} (${x.bins} bins)`).join(', ') + ' is not integrated - a cut or spectrum, ' +
                    'not a volume; integrate it into one bin (e.g. IntegrateMDHistoWorkspace or BinMD) for a 3-D volume');
            }
            for (const x of extra) {
                notes.push(`${x.name} integrated` + (x.range ? ` over ${x.range.map(v => +v.toPrecision(6)).join(' to ')}` : '') +
                    (x.units && x.units !== x.name ? ` ${x.units}` : ''));
            }
            if (opts.crop) notes.push('crop on read does not apply to a workspace with more than three dimensions');
        }
        const nd = Math.min(rank, 3);
        const dims = [1, 1, 1];
        for (let j = 0; j < nd; j++) dims[j] = shape[rank - 1 - j];

        const system = firstNumber(f, 'MDHistoWorkspace/coordinate_system');
        const info = [];
        for (let j = 0; j < nd; j++) {
            const d = f.get(g + 'D' + j);
            if (!isDataset(d)) throw new Error(`MDHistoWorkspace: missing data/D${j}`);
            const longName = attributeText(d, 'long_name');
            const axis = uniformAxis(numbersAt(f, g + 'D' + j), dims[j], `dimension D${j} (${longName || 'unnamed'})`);
            info.push(Object.assign({ frame: attributeText(d, 'frame'), units: attributeText(d, 'units'), longName }, axis));
        }
        const frames = [...new Set(info.map(a => a.frame).filter(Boolean))];
        const hkl = system === 3 || (system === null && frames.length === 1 && frames[0] === 'HKL');
        // The UB of the oriented lattice: Q_sample = 2 pi UB hkl (Busing-Levy).
        const ub = rows3(numbersAt(f, 'MDHistoWorkspace/experiment0/sample/oriented_lattice/orientation_matrix'));
        const qsample = !hkl && (system === 2 || (frames.length === 1 && frames[0] === 'QSample'));
        if (qsample && !ub) {
            throw new Error('the MDHistoWorkspace is in the Q (sample frame) frame and stores no UB matrix ' +
                '(oriented_lattice/orientation_matrix), so it cannot be put on hkl axes; set the UB (SetUB) or bin it in HKL');
        }
        if (!qsample && (!hkl || frames.some(fr => fr !== 'HKL'))) {
            const name = { 0: 'general', 1: 'Q (lab frame)', 2: 'Q (sample frame)' }[system] || frames.join('/') || 'unknown';
            throw new Error(`the MDHistoWorkspace is in the ${name} frame; HKL and Q (sample frame) workspaces are ` +
                'supported - bin it in HKL (e.g. with MDNorm), or in Q_sample, before saving');
        }

        const W = qsample ? null : numbersAt(f, 'MDHistoWorkspace/experiment0/logs/W_MATRIX/value');
        const basis = [];
        for (let j = 0; j < 3; j++) {
            const named = j < nd ? projectionVector(info[j].longName) : null;
            let v = named;
            if (W && W.length === 9) {
                v = [W[j], W[3 + j], W[6 + j]];
                if (named && named.some((x, c) => Math.abs(x - v[c]) > 1e-6)) {
                    notes.push(`warning: W_MATRIX column ${j} (${v.join(', ')}) disagrees with the name ` +
                        `"${info[j].longName}" of dimension D${j}; W_MATRIX used`);
                }
            }
            basis.push(v || [0, 1, 2].map(c => (c === j ? 1 : 0)));
        }
        if (W && W.length === 9 && W.some((x, i) => Math.abs(x - (i % 4 === 0 ? 1 : 0)) > 1e-12)) {
            notes.push('projection from W_MATRIX: ' +
                info.map((a, j) => `D${j} = ${a.longName || basis[j].join(',')}`).join(', '));
        }
        const transform = f.get('MDHistoWorkspace/transform_to_orig');
        if (isDataset(transform)) {
            notes.push('warning: the workspace carries a BinMD transform (transform_to_orig), which is ' +
                'not applied; the grid follows the dimension names and W_MATRIX');
        }
        if (nd < 3) notes.push(`${nd}-D workspace read as a ${dims.join(' x ')} grid`);
        let corner = [0, 0, 0];
        let vectors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let j = 0; j < nd; j++) {
            for (let c = 0; c < 3; c++) {
                corner[c] += basis[j][c] * info[j].first;
                vectors[j][c] = dims[j] > 1 ? basis[j][c] * info[j].step : 0;
            }
        }
        if (qsample) {
            // hkl = s (2 pi UB)^-1 Q, s = -1 in Mantid's default Inelastic
            // convention (Q = k_i - k_f), +1 in the Crystallography one: an
            // exact, generally sheared, hkl grid.
            const convention = attributeText(f.get('MDHistoWorkspace'), 'QConvention') || 'Inelastic';
            const sign = /crystal/i.test(convention) ? 1 : -1;
            const K = invert3x3(ub.map(r => r.map(x => 2 * Math.PI * x))).map(r => r.map(x => sign * x));
            const apply = v => [0, 1, 2].map(r => K[r][0] * v[0] + K[r][1] * v[1] + K[r][2] * v[2]);
            corner = apply(corner);
            vectors = vectors.map(v => (v.some(Boolean) ? apply(v) : v));
            notes.push(`Q (sample frame) put on hkl axes with the workspace's UB: hkl = ${sign < 0 ? '−' : ''}(2π UB)⁻¹ Q ` +
                `(QConvention ${convention})`);
        }

        const progress = opts.progress;
        const box = shape.length === 3 ? readBox(dims, corner, vectors, opts, notes, 'hkl') : null;
        const values = await readHFastest(sig, g + 'signal', dims,
            Object.assign({}, opts, { progress: progress && (x => progress(0.9 * x)) }), box);
        let masked = 0, infinite = 0;
        const mask = f.get(g + 'mask');
        if (isDataset(mask) && sameShape(Array.from(mask.shape).map(Number), shape)) {
            await forEachSlab(mask, g + 'mask',
                { tick: opts.tick, progress: progress && (x => progress(0.9 + 0.1 * x)) }, (start, count, slab) => {
                    const off = start * (slab.length / count);
                    for (let i = 0; i < slab.length; i++) {
                        if (slab[i] && values[off + i] === values[off + i]) {
                            values[off + i] = NaN;
                            masked++;
                        }
                    }
                }, box && hyperslab([box[2], box[1], box[0]]));
        }
        const grid = boxedGrid(box, dims, corner, vectors);
        // opts.sigma: also read the uncertainties (errors_squared is a variance).
        let sigma;
        const errors = f.get(g + 'errors_squared');
        if (opts.sigma && isDataset(errors) && sameShape(Array.from(errors.shape).map(Number), shape)) {
            sigma = await readHFastest(errors, g + 'errors_squared', dims, { tick: opts.tick }, box);
            for (let i = 0; i < sigma.length; i++) sigma[i] = values[i] === values[i] ? Math.sqrt(sigma[i]) : NaN;
            notes.push('uncertainties read from errors_squared');
        }
        for (let i = 0; i < values.length; i++) {
            if (values[i] === Infinity || values[i] === -Infinity) {
                values[i] = NaN;
                infinite++;
            }
        }
        const missing = countNonFinite(values);
        if (masked) notes.push(`${masked} masked voxels set to NaN`);
        if (infinite) notes.push(`${infinite} infinite voxels (normalisation by zero) set to NaN`);
        if (missing) {
            notes.push(`${missing} of ${values.length} voxels (${(100 * missing / values.length).toFixed(1)}%) ` +
                'hold no data (NaN)');
        }

        const ol = 'MDHistoWorkspace/experiment0/sample/oriented_lattice/unit_cell_';
        const cell = ['a', 'b', 'c', 'alpha', 'beta', 'gamma'].map(n => firstNumber(f, ol + n));
        let lengths = [1, 1, 1], angles = [90, 90, 90];
        if (cell.every(x => x !== null) && cell[0] > 0 && cell[1] > 0 && cell[2] > 0) {
            lengths = cell.slice(0, 3);
            angles = cell.slice(3, 6);
        } else {
            notes.push('no oriented lattice stored; supply the parent cell');
        }
        if (ub) notes.push('UB matrix read from the oriented lattice');
        if (f.get('MDHistoWorkspace/experiment1')) {
            notes.push('the workspace holds several experiments; the lattice of experiment0 is used');
        }
        notes.push('radiation set to neutron (Mantid workspace); change it under Output if needed');
        return {
            dims: grid.dims, corner: grid.corner, vectors: grid.vectors, values, sigma, cellLengths: lengths, cellAngles: angles,
            radiation: 'neutron', axes: pickAxes(grid.vectors, grid.dims), axesType: 'hkl', notes,
            ub: ub || undefined,
        };
    }

    // --- generic NeXus NXdata ---

    function nxSignalName(group) {
        const name = attributeText(group, 'signal');
        if (name && !/^\d+$/.test(name)) return name;
        for (const key of group.keys()) {
            const child = group.get(key);
            if (isDataset(child) && child.attrs && child.attrs.signal &&
                Number(firstValue(child.attrs.signal.value)) === 1) return key;
        }
        return group.keys().includes('data') ? 'data' : null;
    }

    // NXdata groups with a 1- to 3-D signal (4-D ones are listed so that the
    // reader can explain them). The @default chain marks the preferred one.
    function nexusCandidates(f) {
        let defaultPath = null;
        const rootDefault = attributeText(f, 'default');
        if (rootDefault) {
            const entry = f.get(rootDefault);
            const inner = isGroup(entry) ? attributeText(entry, 'default') : '';
            if (inner) defaultPath = '/' + rootDefault + '/' + inner;
        }
        const found = [];
        const visit = (group, path, depth) => {
            for (const key of group.keys()) {
                const child = group.get(key);
                if (!isGroup(child)) continue;
                const childPath = path + '/' + key;
                if (attributeText(child, 'NX_class') === 'NXdata') {
                    const signal = nxSignalName(child);
                    const ds = signal && child.get(signal);
                    const shape = isDataset(ds) ? Array.from(ds.shape).map(Number)
                        : isExternalLink(ds) ? null : undefined;
                    if (signal && shape !== undefined && (!shape || (shape.length >= 1 && shape.length <= 4))) {
                        found.push({ path: childPath, signal, shape, isDefault: childPath === defaultPath });
                    }
                } else if (depth < 3) {
                    visit(child, childPath, depth + 1);
                }
            }
        };
        visit(f, '', 0);
        found.sort((a, b) => (b.isDefault - a.isDefault));
        return found;
    }

    // External links of an NXdata group whose target files are not available.
    function unresolvedLinks(f, path) {
        const group = f.get(path);
        if (!isGroup(group)) return [];
        return group.keys().map(key => ({ key, link: group.get(key) }))
            .filter(x => isExternalLink(x.link))
            .map(x => ({ name: x.key, filename: x.link.filename, objPath: x.link.obj_path }));
    }

    // Where to place selected companion files so that HDF5 resolves the
    // external links of the main file: a relative link "300/transform.nxs"
    // needs the file at <main file's folder>/300/transform.nxs; an absolute
    // one is looked up by its file name next to the main file. files:
    // [{ name, path }] (path = relative path from a folder pick, may be '').
    // Returns { mounts: [{ at, index }], missing: [filename] }.
    function planLinkMounts(links, files) {
        const mounts = [], missing = [];
        const done = new Set();
        for (const link of links) {
            const target = String(link.filename).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
            if (done.has(target)) continue;
            done.add(target);
            const base = target.split('/').pop();
            const absolute = /^([a-z]:)?\//i.test(target);
            let matches = files.map((file, index) => ({ file, index })).filter(x => x.file.name === base);
            if (matches.length > 1) {
                const bySuffix = matches.filter(x => x.file.path &&
                    ('/' + x.file.path.replace(/\\/g, '/')).endsWith('/' + target));
                if (bySuffix.length === 1) matches = bySuffix;
            }
            if (matches.length !== 1 || (!absolute && target.split('/').includes('..'))) {
                missing.push(target);
                continue;
            }
            mounts.push({ at: absolute ? base : target, index: matches[0].index });
        }
        return { mounts, missing };
    }

    function axisNamesOf(group, signalDs, rank) {
        const raw = group.attrs && group.attrs.axes ? group.attrs.axes.value
            : signalDs.attrs && signalDs.attrs.axes ? signalDs.attrs.axes.value : null;
        let names = null;
        if (typeof raw === 'string') names = raw.split(/[:,\s]+/).filter(Boolean);
        else if (raw && (Array.isArray(raw) || ArrayBuffer.isView(raw))) names = Array.from(raw, x => textValue(x));
        if (names && names.length === rank) return names.map(n => (n === '.' ? null : n));
        // AXISNAME_indices
        const byIndex = new Array(rank).fill(null);
        for (const key of Object.keys(group.attrs || {})) {
            const m = /^(.*)_indices$/.exec(key);
            if (!m) continue;
            const idx = Number(firstValue(group.attrs[key].value));
            if (Number.isInteger(idx) && idx >= 0 && idx < rank) byIndex[idx] = m[1];
        }
        return byIndex;
    }

    // hkl or Cartesian-Q direction of an axis from its name, long_name and units.
    function classifyAxis(name, longName, units) {
        const proj = projectionVector(longName) || projectionVector(name);
        if (proj) return { frame: 'hkl', dir: proj, pure: false };
        const unit = c => [0, 1, 2].map(i => (i === c ? 1 : 0));
        const u = String(units || '').toLowerCase().replace(/\s+/g, '');
        const inverseAngstrom = /(angstrom|å|a)(\^?-1|⁻¹)|1\/(angstrom|å|a)|invangstrom/.test(u);
        const letter = String(name || '').replace(/^q_?/i, '').toLowerCase();
        if (/^[hkl]$/.test(letter) && !inverseAngstrom) return { frame: 'hkl', dir: unit('hkl'.indexOf(letter)), pure: true };
        if (/^[xyz]$/.test(letter) && (inverseAngstrom || /^q/i.test(name))) {
            return { frame: 'Q', dir: unit('xyz'.indexOf(letter)), pure: true };
        }
        const ln = /^\s*([HKL])\b/i.exec(String(longName || ''));
        if (ln) return { frame: 'hkl', dir: unit('hkl'.indexOf(ln[1].toLowerCase())), pure: true };
        return null;
    }

    function readNexusMeta(f, dataPath) {
        const parts = dataPath.split('/').filter(Boolean);
        const entries = [];
        for (let i = parts.length - 1; i >= 1; i--) entries.push('/' + parts.slice(0, i).join('/'));
        if (!entries.includes('/entry') && f.get('entry')) entries.push('/entry');
        const meta = {};
        const text = p => datasetText(f, p);
        for (const e of entries) {
            const s = e + '/sample/';
            const abc = ['a', 'b', 'c', 'alpha', 'beta', 'gamma'].map(n => firstNumber(f, s + 'unitcell_' + n));
            const six = numbersAt(f, s + 'unit_cell');
            const lengths = numbersAt(f, s + 'unit_cell_abc');
            const angles = numbersAt(f, s + 'unit_cell_alphabetagamma');
            if (!meta.cell) {
                if (abc.every(x => x !== null)) meta.cell = abc;
                else if (six && six.length >= 6) meta.cell = six.slice(0, 6);
                else if (lengths && angles && lengths.length >= 3 && angles.length >= 3) {
                    meta.cell = lengths.slice(0, 3).concat(angles.slice(0, 3));
                }
            }
            if (meta.temperature === undefined) {
                const t = firstNumber(f, s + 'temperature');
                if (t !== null) meta.temperature = t;
            }
            if (!meta.laueGroup && text(s + 'laue_group')) meta.laueGroup = text(s + 'laue_group');
            // NXsample ub_matrix: Busing-Levy, Q = 2 pi UB hkl
            if (!meta.ub) meta.ub = rows3(numbersAt(f, s + 'ub_matrix')) || undefined;
            if (!meta.spaceGroup && text(s + 'space_group')) meta.spaceGroup = text(s + 'space_group');
            if (meta.wavelength === undefined) {
                const w = firstNumber(f, e + '/instrument/monochromator/wavelength');
                if (w !== null) meta.wavelength = w;
            }
            if (!meta.radiation && text(e + '/instrument/source/probe')) {
                meta.radiation = normalizeRadiation(text(e + '/instrument/source/probe'));
            }
        }
        return meta;
    }

    // Read one NXdata group (opts.path, else the @default one) as a model.
    // hkl axes (letters, "H (r.l.u.)" or projections like "[H,H,0]") give an
    // hkl grid; Cartesian Qx/Qy/Qz axes in 1/Angstrom give axesType 'Q'.
    async function readNexusData(f, opts) {
        opts = opts || {};
        const candidates = nexusCandidates(f);
        const pick = opts.path ? candidates.find(c => c.path === opts.path) : candidates[0];
        if (!pick) throw new Error(opts.path ? `no NXdata group ${opts.path}` : 'no NXdata group with a signal found');
        const group = f.get(pick.path);
        const sig = group.get(pick.signal);
        if (isExternalLink(sig)) {
            throw new Error(`${pick.path}/${pick.signal} is stored in "${sig.filename}"; select that file ` +
                'together with this one');
        }
        const shape = Array.from(sig.shape).map(Number);
        if (shape.length > 3) {
            throw new Error(`${pick.path}/${pick.signal} is ${shape.length}-D (${shape.join(' x ')}); ` +
                'only 1- to 3-D data can be converted');
        }
        const rank = shape.length;
        const notes = [`NeXus data ${pick.path} (signal "${pick.signal}", ${shape.join(' x ')})`];
        const names = axisNamesOf(group, sig, rank);
        const axes = names.map((name, d) => {
            if (!name) throw new Error(`${pick.path}: dimension ${d} has no axis`);
            const ds = group.get(name);
            if (isExternalLink(ds)) throw new Error(`${pick.path}/${name} is stored in "${ds.filename}"`);
            if (!isDataset(ds)) throw new Error(`${pick.path}: axis "${name}" not found`);
            const longName = attributeText(ds, 'long_name');
            const kind = classifyAxis(name, longName, attributeText(ds, 'units'));
            if (!kind) {
                throw new Error(`${pick.path}: axis "${name}" is not an hkl or Q axis ` +
                    '(expected names like h/k/l, Qh/Qk/Ql, Qx/Qy/Qz or "[H,H,0]")');
            }
            const values = numbersAt(f, `${pick.path}/${name}`);
            return Object.assign({ name, longName }, kind, uniformAxis(values, shape[d], `axis ${name}`));
        });
        const frames = new Set(axes.map(a => a.frame));
        if (frames.size !== 1) throw new Error(`${pick.path}: axes mix hkl and Q`);
        const frame = axes[0].frame;

        // Model axes: h, k, l order for plain letter axes, else fastest first.
        const pure = axes.every(a => a.pure) && new Set(axes.map(a => a.dir.indexOf(1))).size === rank;
        let axisOfDim = pure ? axes.map(a => a.dir.indexOf(1)) : axes.map((_, d) => rank - 1 - d);
        if (rank < 3) {
            const free = [0, 1, 2].filter(a => !axisOfDim.includes(a));
            axisOfDim = axisOfDim.concat(free.slice(0, 3 - rank));
        }
        const padded = shape.slice();
        while (padded.length < 3) padded.push(1);
        const fullDims = [1, 1, 1];
        axisOfDim.forEach((axis, d) => { fullDims[axis] = padded[d]; });
        const fullCorner = [0, 0, 0];
        const fullVectors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        axes.forEach((a, d) => {
            const axis = axisOfDim[d];
            for (let c = 0; c < 3; c++) {
                fullCorner[c] += a.dir[c] * a.first;
                fullVectors[axis][c] = fullDims[axis] > 1 ? a.dir[c] * a.step : 0;
            }
        });
        const box = rank === 3 ? readBox(fullDims, fullCorner, fullVectors, opts, notes, frame === 'Q' ? 'Q' : 'hkl') : null;
        const read = await readPermuted(sig, `${pick.path}/${pick.signal}`, axisOfDim, opts, box);
        const values = read.values;
        const { dims, corner, vectors } = boxedGrid(box, fullDims, fullCorner, fullVectors);
        if (axes.some(a => a.edges)) notes.push('axes hold bin edges; grid points are the bin centres');

        // opts.sigma: the uncertainties, NeXus style ("errors" or "<signal>_errors").
        let sigma;
        const errorName = ['errors', `${pick.signal}_errors`].find(n => isDataset(group.get(n)) &&
            sameShape(Array.from(group.get(n).shape).map(Number), shape));
        if (opts.sigma && errorName) {
            sigma = (await readPermuted(group.get(errorName), `${pick.path}/${errorName}`, axisOfDim, { tick: opts.tick }, box)).values;
            notes.push(`uncertainties read from "${errorName}"`);
        }
        const weights = group.get('weights');
        if (isDataset(weights) && sameShape(Array.from(weights.shape).map(Number), shape)) {
            const w = (await readPermuted(weights, `${pick.path}/weights`, axisOfDim, { tick: opts.tick }, box)).values;
            let zero = 0;
            for (let i = 0; i < values.length; i++) {
                if (w[i] > 0) {
                    values[i] /= w[i];
                    if (sigma) sigma[i] /= w[i];
                } else {
                    values[i] = NaN;
                    zero++;
                }
            }
            notes.push('signal divided by "weights"' + (zero ? `; ${zero} voxels with zero weight set to NaN` : ''));
        }

        const meta = readNexusMeta(f, pick.path);
        let lengths = [1, 1, 1], angles = [90, 90, 90];
        if (meta.cell && meta.cell[0] > 0 && meta.cell[1] > 0 && meta.cell[2] > 0) {
            lengths = meta.cell.slice(0, 3);
            angles = meta.cell.slice(3, 6);
        } else if (frame === 'hkl') {
            notes.push('no unit cell found in the file; supply the parent cell');
        }
        if (meta.wavelength !== undefined) notes.push(`wavelength ${meta.wavelength} Angstrom`);
        if (meta.temperature !== undefined) notes.push(`temperature ${meta.temperature} K`);
        if (meta.laueGroup) notes.push(`Laue group ${meta.laueGroup}`);
        if (/symm/i.test(pick.path)) notes.push('the data are symmetrized (NXrefine symm_transform)');
        const missing = countNonFinite(values);
        if (missing) notes.push(`${missing} of ${values.length} voxels hold no data (NaN)`);
        return {
            dims, corner, vectors, values, sigma, cellLengths: lengths, cellAngles: angles,
            radiation: meta.radiation || 'unknown', axes: pickAxes(vectors, dims),
            axesType: frame === 'Q' ? 'Q' : 'hkl', notes, nexusPath: pick.path, ub: meta.ub,
        };
    }

    // ------------------------------------------------------------- old text .dat

    // Text readers are line-driven so the same parser takes a whole string or a
    // byte stream. onLine may return false to stop early.
    function forEachTextLine(text, onLine) {
        let start = 0;
        while (start < text.length) {
            let end = text.indexOf('\n', start);
            if (end < 0) end = text.length;
            if (onLine(text.slice(start, end)) === false) return;
            start = end + 1;
        }
    }

    // opts: { size (bytes, for progress), progress, tick } as for HDF5 reads.
    async function forEachStreamLine(stream, opts, onLine) {
        opts = opts || {};
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let carry = '', bytes = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                const text = carry + decoder.decode(value, { stream: true });
                let start = 0, end;
                while ((end = text.indexOf('\n', start)) >= 0) {
                    if (onLine(text.slice(start, end)) === false) {
                        await reader.cancel();
                        return;
                    }
                    start = end + 1;
                }
                carry = text.slice(start);
                if (opts.progress && opts.size) opts.progress(Math.min(1, bytes / opts.size));
                if (opts.tick) await opts.tick();
            }
            const rest = carry + decoder.decode();
            if (rest) onLine(rest);
        } catch (e) {
            try {
                await reader.cancel();
            } catch (_) {
                // already closed
            }
            throw e;
        } finally {
            reader.releaseLock();
        }
    }

    // Solve M x = R for x (M is m x m, R is m x c) by Gauss-Jordan elimination.
    function solveLinear(M, R) {
        const m = M.length;
        const A = M.map((row, i) => row.concat(R[i]));
        for (let col = 0; col < m; col++) {
            let piv = col;
            for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
            if (!(Math.abs(A[piv][col]) > 0)) return null;
            [A[col], A[piv]] = [A[piv], A[col]];
            for (let r = 0; r < m; r++) {
                if (r === col) continue;
                const factor = A[r][col] / A[col][col];
                for (let c = col; c < A[r].length; c++) A[r][c] -= factor * A[col][c];
            }
        }
        return A.map((row, i) => row.slice(m).map(x => x / row[i]));
    }

    // Header "npoints nsec" (experimental input) or "npoints nsec scale offset"
    // (RMCProfile *_calc.dat output), then rows "i j k (qx qy qz)*nsec I".
    // Rows are read as a token stream, so a row may wrap over lines. The
    // result keeps the geometry in cartesian Q: qCorner is Q at pixel
    // (1,1,1) and qVectors[axis] the Q step per pixel; toHklModel applies
    // the cell. Pixels missing from the file become NaN.
    // opts.amplitudes: an RMCProfile _aver_amp_calc.dat / _total_amp_calc.dat
    // (no header; per row i j k, a Q triplet and Re Im per symmetry section):
    // the value is |A|^2 averaged over the sections, from the first
    // permutation block. opts.frame 'hkl': the coordinates are hkl (the
    // _hkl.dat variant) rather than Q.
    function datParser(opts) {
        opts = opts || {};
        const amplitudes = !!opts.amplitudes;
        let header = null, npoints = 0, perRow = 0, nsec = 0, nrows = 0, cap = 0, permutations = 0;
        let pix = null, vals = null, row = [];
        const ensure = n => {
            if (n <= cap) return;
            cap = Math.max(n, cap * 2, 65536);
            const p = new Int32Array(3 * cap), v = new Float64Array(cap);
            if (pix) {
                p.set(pix);
                v.set(vals);
            }
            pix = p;
            vals = v;
        };
        const dims = [0, 0, 0];
        const special = [null, null, null, null];     // Q at (1,1,1) (2,1,1) (1,2,1) (1,1,2)
        const xx = new Float64Array(16), xq = new Float64Array(12);   // least-squares sums
        const notes = [];
        let datHeader = null;

        function takeRow(tok) {
            if (amplitudes) ensure(nrows + 1);
            else if (nrows >= npoints) return;
            const i = parseInt(tok[0], 10), j = parseInt(tok[1], 10), k = parseInt(tok[2], 10);
            if (!(i >= 1 && j >= 1 && k >= 1)) throw new Error('pixel coordinates must be positive');
            const qx = num(tok[3]), qy = num(tok[4]), qz = num(tok[5]);
            pix[3 * nrows] = i; pix[3 * nrows + 1] = j; pix[3 * nrows + 2] = k;
            if (amplitudes) {
                let sum = 0;
                for (let s = 0; s < nsec; s++) {
                    const re = num(tok[3 + 3 * nsec + 2 * s]), im = num(tok[4 + 3 * nsec + 2 * s]);
                    sum += re * re + im * im;
                }
                vals[nrows++] = sum / nsec;
            } else {
                vals[nrows++] = num(tok[perRow - 1]);
            }
            if (i > dims[0]) dims[0] = i;
            if (j > dims[1]) dims[1] = j;
            if (k > dims[2]) dims[2] = k;
            if (i + j + k <= 4) {
                const slot = i === 1 && j === 1 && k === 1 ? 0 : i === 2 ? 1 : j === 2 ? 2 : k === 2 ? 3 : -1;
                if (slot >= 0) special[slot] = [qx, qy, qz];
            }
            const x = [i - 1, j - 1, k - 1, 1], q = [qx, qy, qz];
            for (let a = 0; a < 4; a++) {
                for (let b = 0; b < 4; b++) xx[a * 4 + b] += x[a] * x[b];
                for (let c = 0; c < 3; c++) xq[a * 3 + c] += x[a] * q[c];
            }
        }

        function line(text) {
            const t = text.trim();
            if (!t) return;
            if (amplitudes) {
                if (/^ipermutation\s*=/i.test(t)) {
                    permutations++;
                    return;
                }
                if (permutations > 1) return;          // the first permutation only
                const cols = t.split(/\s+/);
                if (!perRow) {
                    nsec = (cols.length - 3) / 5;
                    if (!Number.isInteger(nsec) || nsec < 1) {
                        throw new Error(`RMCProfile amplitude file: ${cols.length} columns is not i j k + 5 per symmetry section`);
                    }
                    perRow = cols.length;
                    header = ['amplitudes'];
                }
                if (cols.length !== perRow) throw new Error(`RMCProfile amplitude file: a row has ${cols.length} columns, expected ${perRow}`);
                takeRow(cols);
                return;
            }
            const tokens = t.split(/\s+/);
            if (!header) {
                if (tokens.length < 2 || tokens.length > 4 || tokens.some(s => !Number.isFinite(num(s)))) {
                    throw new Error('old-format .dat: unrecognized header line (expected "npoints nsec" ' +
                        'or "npoints nsec scale offset")');
                }
                header = tokens;
                npoints = parseInt(tokens[0], 10);
                nsec = parseInt(tokens[1], 10);
                if (!(npoints > 0) || !(nsec >= 1)) throw new Error('bad npoints/nsec header');
                perRow = 3 + 3 * nsec + 1;
                pix = new Int32Array(3 * npoints);
                vals = new Float64Array(npoints);
                if (tokens.length > 2) {
                    datHeader = { scale: num(tokens[2]), offset: tokens.length > 3 ? num(tokens[3]) : 0 };
                    notes.push(`RMCProfile calculation header: scale = ${datHeader.scale}, offset = ` +
                        `${datHeader.offset}; intensities are kept as stored`);
                }
                return;
            }
            if (!row.length && tokens.length === perRow) {
                takeRow(tokens);
                return;
            }
            for (const s of tokens) {
                row.push(s);
                if (row.length === perRow) {
                    takeRow(row);
                    row = [];
                }
            }
        }

        function geometry() {
            const need = [0, 1, 2].filter(a => dims[a] > 1);
            if (special[0] && need.every(a => special[a + 1])) {
                return {
                    qCorner: special[0],
                    qVectors: [0, 1, 2].map(a => dims[a] > 1
                        ? special[a + 1].map((x, c) => x - special[0][c]) : [0, 0, 0]),
                };
            }
            // Q is affine in the pixel indices: fit it to every row.
            const idx = need.concat([3]);
            const M = idx.map(a => idx.map(b => xx[a * 4 + b]));
            const R = idx.map(a => [0, 1, 2].map(c => xq[a * 3 + c]));
            const sol = solveLinear(M, R);
            if (!sol) throw new Error('old-format .dat: the rows do not define a 3-D grid');
            const qVectors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            need.forEach((a, n) => { qVectors[a] = sol[n]; });
            notes.push('pixel (1,1,1) or a neighbour is missing; grid geometry fitted to all rows');
            return { qCorner: sol[sol.length - 1], qVectors };
        }

        function finish() {
            if (!header) throw new Error('old-format .dat: empty file');
            if (amplitudes) {
                npoints = nrows;
                notes.push(`|A|^2 of RMCProfile amplitudes, averaged over ${nsec} symmetry section${nsec === 1 ? '' : 's'}` +
                    (permutations > 1 ? `; the first of ${permutations} permutations` : ''));
            }
            if (nrows < npoints) {
                throw new Error(`old-format data file is truncated (${nrows} of ${npoints} rows)`);
            }
            const [nh, nk, nl] = dims;
            const total = nh * nk * nl;
            if (total < npoints) throw new Error('old-format .dat: some pixels appear more than once');
            const values = new Float64Array(total);
            if (total > npoints) {
                values.fill(NaN);
                notes.push(`${total - npoints} of the ${total} grid points are missing from the file; set to NaN`);
            }
            for (let n = 0; n < npoints; n++) {
                values[((pix[3 * n + 2] - 1) * nk + (pix[3 * n + 1] - 1)) * nh + (pix[3 * n] - 1)] = vals[n];
            }
            const g = geometry();
            if (opts.frame === 'hkl') notes.push('the coordinates are hkl (r.l.u.), read without a Q conversion');
            return {
                frame: opts.frame === 'hkl' ? 'hkl' : 'q', source: 'dat', dims: dims.slice(), values,
                qCorner: g.qCorner, qVectors: g.qVectors,
                nsecOriginal: nsec, datHeader, notes,
            };
        }

        return { line, finish };
    }

    // Parse an old-format .dat text; returns an hkl model with the parent cell.
    function parseOldDat(text, parentCell) {
        const parser = datParser();
        forEachTextLine(text, parser.line);
        return toHklModel(parser.finish(), parentCell);
    }

    // Stream an old-format .dat; returns the grid in Q (see datParser).
    async function readOldDatStream(stream, opts) {
        const parser = datParser(opts);
        await forEachStreamLine(stream, opts, parser.line);
        return parser.finish();
    }

    // Mirrors set_axes_from_increment_vectors.
    function pickAxes(vectors, dims) {
        const axes = [1, 2, 3];
        for (let axis = 0; axis < 3; axis++) {
            if (dims[axis] > 1) {
                let best = -1, comp = axis;
                for (let cIdx = 0; cIdx < 3; cIdx++) {
                    if (Math.abs(vectors[axis][cIdx]) > best) {
                        best = Math.abs(vectors[axis][cIdx]);
                        comp = cIdx;
                    }
                }
                axes[axis] = comp + 1;
            }
        }
        for (let axis = 0; axis < 3; axis++)
            for (let other = axis + 1; other < 3; other++)
                if (dims[axis] > 1 && dims[other] > 1 && axes[axis] === axes[other]) return [1, 2, 3];
        return axes;
    }

    // The text formats hold Q-space grids; direct-space (uvw) data such as a
    // 3D-ΔPDF go only to the HDF5 formats.
    function checkWritable(model, format) {
        if (model.axesType === 'uvw' && (format === 'dat' || format === 'vtk' || format === 'hkl')) {
            const name = { dat: 'the old .dat format', vtk: 'legacy VTK', hkl: 'an hkl list' }[format];
            throw new Error(`these are direct-space 3D-ΔPDF data (u, v, w axes), and ${name} holds only ` +
                'Q-space grids; write unified HDF5, Yell, .npz, .vti or a CCP4/MRC map instead');
        }
        if (format === 'mrc' && model.axesType !== 'uvw') {
            throw new Error('CCP4/MRC maps hold direct-space grids (a 3D-ΔPDF), and these data are in ' +
                'reciprocal space; write .vti, .npz or HDF5 instead');
        }
    }

    // Non-finite intensities are written as 0.0: RMCProfile treats I = 0 as a
    // masked point (excluded from chi^2), while a literal NaN would poison it.
    // opts.frame 'hkl': write hkl (r.l.u.) instead of Q (the _hkl.dat
    // variant). opts.sections: hkl operations (3x3, acting on hkl columns);
    // each row then lists the coordinates of every image, the first being
    // the identity, as RMCProfile's symmetry sections (nsec = their count).
    function* writeOldDatChunks(model, cell, linesPerChunk, opts) {
        opts = opts || {};
        checkWritable(model, 'dat');
        const hkl = opts.frame === 'hkl';
        const B = hkl ? null : reciprocalBasis(cellToLattice(cell.lengths, cell.angles));
        const ops = opts.sections && opts.sections.length ? opts.sections : [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
        const [nh, nk, nl] = model.dims;
        const chunkSize = Math.max(1, Number(linesPerChunk) || 16384);
        let out = [`${nh * nk * nl} ${ops.length}`];
        for (let k = 0; k < nl; k++) {
            for (let j = 0; j < nk; j++) {
                for (let i = 0; i < nh; i++) {
                    const p = [0, 1, 2].map(c =>
                        model.corner[c] + i * model.vectors[0][c] + j * model.vectors[1][c] + k * model.vectors[2][c]);
                    const raw = model.values[(k * nk + j) * nh + i];
                    const v = Number.isFinite(raw) ? raw : 0;
                    let row = `${i + 1} ${j + 1} ${k + 1}`;
                    for (const G of ops) {
                        const g = [0, 1, 2].map(r => G[r][0] * p[0] + G[r][1] * p[1] + G[r][2] * p[2]);
                        const x = hkl ? g : hklToQ(B, g);
                        row += ` ${x[0].toExponential(16)} ${x[1].toExponential(16)} ${x[2].toExponential(16)}`;
                    }
                    out.push(`${row} ${v.toExponential(16)}`);
                    if (out.length >= chunkSize) {
                        yield out.join('\n') + '\n';
                        out = [];
                    }
                }
            }
        }
        if (out.length) yield out.join('\n') + '\n';
    }

    function writeOldDat(model, cell) {
        // Kept for callers that need one string. The browser UI uses the
        // chunk iterator so large grids never exceed JavaScript's string limit.
        return Array.from(writeOldDatChunks(model, cell)).join('');
    }

    // ------------------------------------------------------------- hkl lists

    // "h k l I [sigma]" rows: Spinteract's _xtal_data_NN.txt and
    // _xtal_fit_NN.txt, Scatty's scatty_data_01.txt and *_sc_list.txt. The
    // rows are points of a grid, possibly with holes (masked points left
    // out). With twins, Spinteract rows carry more hkl triplets before I and
    // sigma; the first triplet is used.
    function hklListParser() {
        let cap = 1 << 16, n = 0, ncol = 0;
        let H = new Float64Array(cap), K = new Float64Array(cap), L = new Float64Array(cap);
        let I = new Float64Array(cap), E = new Float64Array(cap);
        const grow = () => {
            cap *= 2;
            const g = a => { const b = new Float64Array(cap); b.set(a); return b; };
            H = g(H); K = g(K); L = g(L); I = g(I); E = g(E);
        };
        function line(text) {
            const t = text.trim();
            if (!t || t[0] === '#' || t[0] === '!') return;
            const tok = t.split(/\s+/);
            if (!ncol) {
                ncol = tok.length;
                if (ncol < 4) throw new Error(`hkl list: expected "h k l I [sigma]" rows, found ${ncol} columns`);
            }
            if (tok.length !== ncol) throw new Error(`hkl list: row ${n + 1} has ${tok.length} columns, the first had ${ncol}`);
            if (n === cap) grow();
            const hasSigma = ncol === 5 || (ncol > 5 && (ncol - 2) % 3 === 0);
            H[n] = num(tok[0]);
            K[n] = num(tok[1]);
            L[n] = num(tok[2]);
            I[n] = num(tok[hasSigma ? ncol - 2 : ncol - 1]);
            E[n] = hasSigma ? num(tok[ncol - 1]) : NaN;
            n++;
        }
        function finish() {
            if (!n) throw new Error('hkl list: no data rows');
            const hasSigma = ncol === 5 || (ncol > 5 && (ncol - 2) % 3 === 0);
            return {
                source: 'hkl', frame: 'hkl', n,
                h: H.subarray(0, n), k: K.subarray(0, n), l: L.subarray(0, n), values: I.subarray(0, n),
                sigma: hasSigma ? E.subarray(0, n) : null, twins: ncol > 5 ? (ncol - 2) / 3 : 1,
            };
        }
        return { line, finish };
    }

    function parseHklList(text) {
        const parser = hklListParser();
        forEachTextLine(text, parser.line);
        return parser.finish();
    }

    async function readHklListStream(stream, opts) {
        const parser = hklListParser();
        await forEachStreamLine(stream, opts, parser.line);
        return parser.finish();
    }

    // Whether text (the head of a file) looks like an hkl list: its first two
    // data rows are numbers, four or more of them, the same count in both
    // (an old-format .dat starts with a 2- or 4-number header instead).
    function isHklList(head) {
        const rows = head.split(/\r?\n/).map(x => x.trim()).filter(x => x && x[0] !== '#' && x[0] !== '!').slice(0, 2);
        if (rows.length < 2) return false;
        const cols = rows.map(r => r.split(/\s+/));
        return cols[0].length >= 4 && cols[0].length === cols[1].length &&
            cols.every(c => c.every(x => Number.isFinite(num(x)) || /^[-+]?nan$/i.test(x)));
    }

    // 3DSCalculator's .dat export: "# h k l intensity", then an hkl list
    // (l fastest).
    const is3dsCalculatorDat = head => /^\s*#\s*h\s+k\s+l\s+intensity\s*$/im.test(head.split(/\r?\n/, 1)[0]);

    // 3DSCalculator's .json export (keys in its order: ..., shape, hAxis, ...).
    const is3dsCalculatorJson = head => /^\s*\{/.test(head) && /"shape"\s*:/.test(head) && /"hAxis"\s*:/.test(head);

    // 3DSCalculator's .json export: shape [nh, nk, nl], the hAxis/kAxis/lAxis
    // coordinates, Bq (Q = [h, k, l] * Bq, 1/Angstrom with 2*pi, parent cell)
    // and the intensity with l fastest (NaN saved as null). The cell comes
    // from the metric of Bq, so 3DSCalculator's c-along-z frame does not
    // matter. opts.crop as for the HDF5 readers.
    function read3dsCalculatorJson(text, opts) {
        const p = JSON.parse(text);
        if (!Array.isArray(p.shape) || !Array.isArray(p.intensity) || !Array.isArray(p.hAxis)) {
            throw new Error('not a 3DSCalculator .json export (no shape, hAxis and intensity)');
        }
        const dims = p.shape.map(Number);
        const n = dims[0] * dims[1] * dims[2];
        if (p.intensity.length !== n) throw new Error(`3DSCalculator .json: ${p.intensity.length} intensities for a ${dims.join(' x ')} grid`);
        const notes = [];
        const corner = [0, 0, 0], vectors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        [p.hAxis, p.kAxis, p.lAxis].forEach((axis, a) => {
            if (!Array.isArray(axis) || axis.length !== dims[a]) throw new Error(`3DSCalculator .json: axis ${'hkl'[a]} does not match the shape`);
            corner[a] = Number(axis[0]);
            if (dims[a] < 2) return;
            const step = (axis[dims[a] - 1] - axis[0]) / (dims[a] - 1);
            if (axis.some((x, i) => Math.abs(x - (axis[0] + i * step)) > 1e-6 * Math.max(1e-12, Math.abs(step)))) {
                throw new Error(`3DSCalculator .json: the ${'hkl'[a]} axis is not evenly spaced`);
            }
            vectors[a][a] = step;
        });
        let cellLengths = [1, 1, 1], cellAngles = [90, 90, 90];
        if (Array.isArray(p.Bq) && p.Bq.length === 3) {
            // reciprocal metric from the rows of Bq, then the direct cell
            const t = 4 * Math.PI * Math.PI;
            const Gs = [0, 1, 2].map(i => [0, 1, 2].map(j => (p.Bq[i][0] * p.Bq[j][0] + p.Bq[i][1] * p.Bq[j][1] + p.Bq[i][2] * p.Bq[j][2]) / t));
            const G = invert3x3(Gs);
            cellLengths = [0, 1, 2].map(i => Math.sqrt(G[i][i]));
            const ang = (i, j) => Math.acos(Math.max(-1, Math.min(1, G[i][j] / (cellLengths[i] * cellLengths[j])))) / DEG;
            cellAngles = [ang(1, 2), ang(0, 2), ang(0, 1)];
            if (Array.isArray(p.cellDeg) && Array.isArray(p.supercell)) {
                const parent = p.cellDeg.slice(0, 3).map((x, i) => x / p.supercell[i]);
                if (parent.some((x, i) => Math.abs(x - cellLengths[i]) > 1e-4 * x)) {
                    notes.push(`the supercell over its dimensions (${parent.map(x => +x.toFixed(5)).join(' ')}) differs from the cell of Bq`);
                }
            }
            notes.push(`cell ${cellLengths.map(x => +x.toFixed(6)).join(' ')} ${cellAngles.map(x => +x.toFixed(4)).join(' ')} from Bq`);
        } else {
            notes.push('no Bq in the file, so no cell: supply one for Q-space output');
        }
        const flat = Float64Array.from(p.intensity, x => (x === null ? NaN : Number(x)));
        let values = lFastestToHFastest(flat, dims[0], dims[1], dims[2], false);
        let grid = { dims, corner, vectors: vectors.map((v, a) => (dims[a] > 1 ? v : [0, 0, 0])) };
        const box = readBox(grid.dims, grid.corner, grid.vectors, opts, notes, 'hkl');
        if (box) {
            values = cutBox(values, dims, box);
            grid = boxedGrid(box, grid.dims, grid.corner, grid.vectors);
        }
        if (p.backend) notes.push(`3DSCalculator ${p.backend === 'data' ? 'loaded data' : 'calculation'}` +
            (p.sourceFile ? ` from ${p.sourceFile}` : ''));
        return {
            dims: grid.dims, corner: grid.corner, vectors: grid.vectors, values, cellLengths, cellAngles,
            radiation: normalizeRadiation(p.options && p.options.radiation), axes: pickAxes(grid.vectors, grid.dims),
            axesType: 'hkl', notes,
        };
    }

    // The grid of an hkl list: from a grid config ({ corner, vectors, dims },
    // as parseGridConfig gives) or, without one, the axis-aligned grid its
    // coordinates span. Points off the grid are an error; grid points
    // without a row are NaN.
    function hklListModel(list, grid) {
        const notes = [];
        let dims, corner, vectors;
        if (grid) {
            ({ dims, corner, vectors } = grid);
            notes.push('grid from the config');
        } else {
            corner = [0, 0, 0];
            vectors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            dims = [1, 1, 1];
            [list.h, list.k, list.l].forEach((col, c) => {
                const seen = new Set();
                for (let i = 0; i < col.length; i++) seen.add(Math.round(col[i] * 1e6));
                const u = Array.from(seen).sort((a, b) => a - b).map(x => x / 1e6);
                corner[c] = u[0];
                if (u.length < 2) return;
                let step = Infinity;
                for (let i = 1; i < u.length; i++) step = Math.min(step, u[i] - u[i - 1]);
                step = Math.round(step * 1e6) / 1e6;
                const n = Math.round((u[u.length - 1] - u[0]) / step) + 1;
                if (u.some(x => Math.abs((x - u[0]) / step - Math.round((x - u[0]) / step)) > 1e-3) || n > 20000) {
                    throw new Error(`hkl list: the ${'hkl'[c]} values are not evenly spaced; the grid axes may not ` +
                        'run along h, k and l - load the Spinteract or Scatty config as the grid config');
                }
                dims[c] = n;
                vectors[c][c] = step;
            });
            notes.push('grid inferred from the hkl values (axes along h, k, l)');
        }
        const total = dims[0] * dims[1] * dims[2];
        if (total > 5e8) throw new Error(`hkl list: the grid would hold ${total} points`);
        // Columns are the step vectors; a single-point axis gets a unit vector
        // perpendicular to the others, so the matrix stays invertible.
        const cols = vectors.map((v, a) => (dims[a] > 1 && v.some(x => x !== 0) ? v.slice() : null));
        for (let a = 0; a < 3; a++) {
            if (cols[a]) continue;
            const others = cols.filter(Boolean);
            let n = others.length === 2 ? cross(others[0], others[1])
                : others.length === 1 ? cross(others[0], Math.abs(others[0][0]) < 0.9 * Math.hypot(...others[0]) ? [1, 0, 0] : [0, 1, 0])
                    : [0, 1, 2].map(c => (c === a ? 1 : 0));
            const len = Math.hypot(n[0], n[1], n[2]);
            cols[a] = n.map(x => x / len);
        }
        const Minv = invert3x3([0, 1, 2].map(r => [cols[0][r], cols[1][r], cols[2][r]]));
        const values = new Float64Array(total).fill(NaN);
        const sigma = list.sigma ? new Float64Array(total).fill(NaN) : undefined;
        let off = 0, dup = 0;
        for (let i = 0; i < list.n; i++) {
            const d = [list.h[i] - corner[0], list.k[i] - corner[1], list.l[i] - corner[2]];
            const f = [0, 1, 2].map(r => Minv[r][0] * d[0] + Minv[r][1] * d[1] + Minv[r][2] * d[2]);
            const j = f.map(Math.round);
            if (f.some((x, a) => Math.abs(x - j[a]) > 1e-3) || j.some((x, a) => x < 0 || x >= dims[a])) {
                off++;
                continue;
            }
            const at = (j[2] * dims[1] + j[1]) * dims[0] + j[0];
            if (values[at] === values[at]) dup++;
            values[at] = list.values[i];
            if (sigma) sigma[at] = list.sigma[i];
        }
        if (off) throw new Error(`hkl list: ${off} of ${list.n} points are off the grid ${dims.join(' x ')}`);
        if (dup) notes.push(`${dup} rows repeat a grid point; the last one is kept`);
        const empty = total - list.n + dup;
        if (empty) notes.push(`${empty} of ${total} grid points have no row (NaN)`);
        if (list.twins > 1) notes.push(`rows hold ${list.twins} twin hkl triplets; the first is used`);
        if (!list.sigma) notes.push('no uncertainties in the file (4 columns)');
        return {
            dims, corner, vectors: vectors.map((v, a) => (dims[a] > 1 ? v : [0, 0, 0])), values, sigma,
            cellLengths: [1, 1, 1], cellAngles: [90, 90, 90], radiation: 'unknown',
            axes: pickAxes(vectors, dims), axesType: 'hkl', notes,
        };
    }

    function invert3x3(M) {
        const [a, b, c] = M[0], [d, e, f] = M[1], [g, h, i] = M[2];
        const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
        const det = a * A + b * B + c * C;
        if (Math.abs(det) < 1e-300) throw new Error('hkl list: singular grid');
        return [[A / det, (c * h - b * i) / det, (b * f - c * e) / det],
            [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
            [C / det, (b * g - a * h) / det, (a * e - b * d) / det]];
    }

    // Rows "h k l I sigma" for the voxels with data (masked ones are left
    // out, as Spinteract and Scatty skip them anyway). sigma comes from the
    // model; without it every row gets 1. Rows whose sigma is not a positive
    // number are left out too (Scatty stops on sigma <= 1e-8). report
    // receives { written, noSigma, badSigma } at the end.
    function* writeHklListChunks(model, report, rowsPerChunk) {
        checkWritable(model, 'hkl');
        const [nh, nk, nl] = model.dims, v = model.values, sg = model.sigma;
        const chunk = Math.max(1, Number(rowsPerChunk) || 16384);
        const fmt = x => {
            const t = x.toFixed(8).replace(/\.?0+$/, '');
            return t === '-0' ? '0' : t;
        };
        let out = [], written = 0, badSigma = 0;
        for (let il = 0, i = 0; il < nl; il++) {
            for (let ik = 0; ik < nk; ik++) {
                for (let ih = 0; ih < nh; ih++, i++) {
                    const x = v[i];
                    if (x !== x || !Number.isFinite(x)) continue;
                    let e = 1;
                    if (sg) {
                        e = sg[i];
                        if (!(e > 1e-8)) {
                            badSigma++;
                            continue;
                        }
                    }
                    const hkl = [0, 1, 2].map(c => model.corner[c] + ih * model.vectors[0][c] + ik * model.vectors[1][c] + il * model.vectors[2][c]);
                    out.push(`${fmt(hkl[0])} ${fmt(hkl[1])} ${fmt(hkl[2])} ${x.toPrecision(9)} ${e.toPrecision(6)}`);
                    written++;
                    if (out.length >= chunk) {
                        yield out.join('\n') + '\n';
                        out = [];
                    }
                }
            }
        }
        if (out.length) yield out.join('\n') + '\n';
        if (report) report({ written, noSigma: !sg, badSigma });
    }

    // The grid as a Spinteract (ORIGIN + full-extent axes, n points) or Scatty
    // (CENTRE + half-extent axes, 2p + 1 points) config snippet.
    function hklConfigSnippet(model, target) {
        const f = x => String(+x.toFixed(8));
        const names = ['X_AXIS', 'Y_AXIS', 'Z_AXIS'];
        const lines = [];
        if (target === 'scatty') {
            const centre = [0, 1, 2].map(c => model.corner[c] + model.vectors.reduce((acc, v, a) => acc + v[c] * (model.dims[a] - 1) / 2, 0));
            lines.push(`CENTRE ${centre.map(f).join(' ')}`);
            for (let a = 0; a < 3; a++) {
                const p = (model.dims[a] - 1) / 2;
                const half = model.vectors[a].map(x => x * p);
                lines.push(`${names[a]} ${half.map(f).join(' ')} ${Number.isInteger(p) ? p : Math.floor(p)}`);
            }
            if (model.dims.some(n => n % 2 === 0)) lines.push('# note: Scatty grids have an odd number of points per axis; this one has an even count');
        } else {
            lines.push(`ORIGIN ${model.corner.map(f).join(' ')}`);
            for (let a = 0; a < 3; a++) {
                const full = model.vectors[a].map(x => x * (model.dims[a] - 1));
                lines.push(`${names[a]} ${full.map(f).join(' ')} ${model.dims[a]}`);
            }
        }
        return lines.join('\n');
    }

    // ------------------------------------------------------------- Scatty VTK

    function isVtk(text) {
        return /^#\s*vtk/i.test(text.trimStart());
    }

    // Line 2 of a legacy VTK file is a free-text title.
    function vtkTitle(text) {
        const a = text.indexOf('\n');
        if (a < 0) return '';
        let b = text.indexOf('\n', a + 1);
        if (b < 0) b = text.length;
        return text.slice(a + 1, b).trim();
    }

    // 'hkl' when ORIGIN/SPACING are in reciprocal-lattice units (3DSCalculator
    // "... (HKL grid)", Scatty "... supercell Bragg peaks"), otherwise 'q'.
    function vtkFrame(text) {
        return /\(HKL grid\)|supercell Bragg peaks/i.test(vtkTitle(text)) ? 'hkl' : 'q';
    }

    // Grid behind Scatty / Spinteract Q-space VTK output, from the program's
    // config file (keywords matched as the Fortran readers do):
    //   Scatty      CENTRE c; X_AXIS v p -> 2p+1 points from c - v to c + v,
    //               one point for a zero vector; corner = c - (vx + vy + vz)
    //   Spinteract  ORIGIN o (the corner); X_AXIS v n -> n points spanning v;
    //               one ORIGIN/X/Y/Z_AXIS set per single-crystal data set
    function parseGridConfig(text) {
        const found = { CENTRE: [], ORIGIN: [], X_AXIS: [], Y_AXIS: [], Z_AXIS: [] };
        let customFrame = false;
        for (const line of text.split(/\r?\n/)) {
            if (/HKL_TO_[XYZ]/.test(line)) customFrame = true;
            for (const key of Object.keys(found)) {
                const m = new RegExp(key + '\\s+(.*)$').exec(line);
                if (m) found[key].push(m[1].trim().split(/[\s,]+/).map(Number));
            }
        }
        const axisKeys = ['X_AXIS', 'Y_AXIS', 'Z_AXIS'];
        if (!axisKeys.some(k => found[k].length)) {
            throw new Error('grid config: no X_AXIS, Y_AXIS or Z_AXIS line found');
        }
        const program = found.ORIGIN.length ? 'spinteract' : 'scatty';
        const nsets = program === 'spinteract'
            ? Math.max(found.ORIGIN.length, ...axisKeys.map(k => found[k].length)) : 1;
        const grids = [];
        for (let set = 0; set < nsets; set++) {
            // Scatty keeps the last occurrence of a keyword; Spinteract counts them.
            const pick = key => program === 'spinteract' ? found[key][set] : found[key][found[key].length - 1];
            const base = pick(program === 'spinteract' ? 'ORIGIN' : 'CENTRE') || [0, 0, 0];
            const axes = axisKeys.map(k => pick(k) || [0, 0, 0, 0]);
            const numbers = base.slice(0, 3).concat(...axes.map(a => a.slice(0, 4)));
            if (numbers.length < 15 || numbers.some(x => !Number.isFinite(x))) {
                throw new Error('grid config: CENTRE/ORIGIN need 3 numbers and each axis 3 numbers plus a point count');
            }
            const corner = base.slice(0, 3);
            const dims = [], vectors = [];
            axes.forEach(a => {
                const v = a.slice(0, 3);
                const nonzero = v.some(x => Math.abs(x) > 1e-12);
                const n = !nonzero ? 1 : program === 'scatty' ? 2 * Math.round(a[3]) + 1 : Math.max(1, Math.round(a[3]));
                dims.push(n);
                if (program === 'scatty') {
                    for (let c = 0; c < 3; c++) corner[c] -= v[c];
                    vectors.push(n > 1 ? v.map(x => 2 * x / (n - 1)) : [0, 0, 0]);
                } else {
                    vectors.push(n > 1 ? v.map(x => x / (n - 1)) : [0, 0, 0]);
                }
            });
            grids.push({ dims, corner, vectors });
        }
        return { program, grids, customFrame };
    }

    // Legacy ASCII STRUCTURED_POINTS: line 1 "# vtk ...", line 2 a free-text
    // title, then keywords up to LOOKUP_TABLE and the values, x fastest (the
    // internal h-fastest order). Returns the grid in the file's own frame.
    // opts.binary: the header of a BINARY file; takeBinary reads the values.
    function vtkParser(opts) {
        const binary = !!(opts && opts.binary);
        let lineNo = 0, title = '', dims = null, origin = null, spacing = null, scalarType = 'float';
        let values = null, n = 0, npoints = 0;

        function line(text) {
            if (values) {
                const t = text.trim();
                if (!t) return;
                for (const s of t.split(/\s+/)) {
                    if (n >= npoints) return false;
                    values[n++] = num(s);
                }
                return n < npoints;
            }
            lineNo++;
            if (lineNo === 1) {
                if (!/^#\s*vtk/i.test(text.trim())) throw new Error('not a VTK file');
                return;
            }
            if (lineNo === 2) {
                title = text.trim();
                return;
            }
            const tok = text.trim().split(/\s+/);
            const key = (tok[0] || '').toUpperCase();
            if (key === 'BINARY' && !binary) throw new Error('binary VTK: read the whole file with readVtkBinary');
            if (key === 'SCALARS') scalarType = (tok[2] || 'float').toLowerCase();
            if (key === 'DATASET' && (tok[1] || '').toUpperCase() !== 'STRUCTURED_POINTS') {
                throw new Error('only STRUCTURED_POINTS VTK is supported');
            }
            if (key === 'DIMENSIONS') dims = tok.slice(1, 4).map(Number);
            if (key === 'ORIGIN') origin = tok.slice(1, 4).map(Number);
            if (key === 'SPACING' || key === 'ASPECT_RATIO') spacing = tok.slice(1, 4).map(Number);
            if (key === 'LOOKUP_TABLE') {
                if (!dims || !origin || !spacing) {
                    throw new Error('VTK header is missing DIMENSIONS/ORIGIN/SPACING/LOOKUP_TABLE');
                }
                if (dims.some(d => !(d >= 1))) throw new Error('bad VTK dimensions');
                npoints = dims[0] * dims[1] * dims[2];
                values = new Float64Array(npoints);
            }
        }

        function finish() {
            if (!values) throw new Error('VTK header is missing DIMENSIONS/ORIGIN/SPACING/LOOKUP_TABLE');
            if (n < npoints) throw new Error(`VTK data is truncated (${n} of ${npoints} values)`);
            return {
                frame: /\(HKL grid\)|supercell Bragg peaks/i.test(title) ? 'hkl' : 'q',
                source: 'vtk', title, dims, values, origin, spacing, notes: [],
            };
        }

        // Big-endian float or double values from byte `at` of u.
        function takeBinary(u, at) {
            const size = scalarType === 'double' ? 8 : 4;
            if (scalarType !== 'float' && scalarType !== 'double') throw new Error(`binary VTK: ${scalarType} scalars are not supported`);
            const have = Math.floor((u.length - at) / size);
            if (have < npoints) throw new Error(`VTK data is truncated (${have} of ${npoints} values)`);
            const dv = new DataView(u.buffer, u.byteOffset + at, npoints * size);
            for (let i = 0; i < npoints; i++) values[i] = size === 8 ? dv.getFloat64(8 * i, false) : dv.getFloat32(4 * i, false);
            n = npoints;
        }

        return { line, finish, takeBinary, started: () => !!values };
    }

    // Legacy BINARY STRUCTURED_POINTS, as writeVtkChunks writes it with
    // opts.binary (ParaView's legacy writer too): the whole file's bytes.
    function readVtkBinary(bytes) {
        const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const parser = vtkParser({ binary: true });
        let at = 0;
        while (!parser.started() && at < u.length) {
            let end = u.indexOf(10, at);
            if (end < 0) end = u.length;
            parser.line(String.fromCharCode.apply(null, u.subarray(at, Math.min(end, at + 4096))).replace(/\r$/, ''));
            at = end + 1;
        }
        if (parser.started()) parser.takeBinary(u, at);
        return parser.finish();
    }

    // A legacy VTK header that declares BINARY data.
    const isBinaryVtk = head => isVtk(head) && /^\s*BINARY\s*$/im.test(head.split('LOOKUP_TABLE')[0]);

    async function readVtkStream(stream, opts) {
        const parser = vtkParser();
        await forEachStreamLine(stream, opts, parser.line);
        return parser.finish();
    }

    // opts.frame: 'q' | 'hkl' (default: from the title line).
    // opts.grid:  { dims, corner, vectors } from parseGridConfig, for Q-space
    //             files whose grid axes are not along cartesian x, y, z.
    // opts.customFrame: the config redefines the cartesian frame (HKL_TO_X...).
    function parseVtk(text, parentCell, opts) {
        const parser = vtkParser();
        forEachTextLine(text, parser.line);
        const grid = parser.finish();
        if (opts && opts.frame) grid.frame = opts.frame;
        return toHklModel(grid, parentCell, opts);
    }

    // Turn a grid from datParser/vtkParser into an hkl model. Q-frame grids
    // need the parent cell; opts as for parseVtk.
    function toHklModel(grid, parentCell, opts) {
        opts = opts || {};
        const dims = grid.dims;
        const notes = (grid.notes || []).slice();
        const diagonal = step => [0, 1, 2].map(axis => {
            const v = [0, 0, 0];
            if (dims[axis] > 1) v[axis] = step[axis];
            return v;
        });
        let corner, vectors;
        if (grid.frame === 'hkl' && grid.source === 'dat') {
            corner = grid.qCorner.slice();
            vectors = grid.qVectors.map(v => v.slice());
        } else if (grid.frame === 'hkl') {
            corner = grid.origin.slice();
            vectors = diagonal(grid.spacing);
            notes.push(`VTK "${grid.title}" stores ORIGIN/SPACING in reciprocal-lattice units; ` +
                'read without a Q conversion');
        } else {
            if (!parentCell) {
                throw new Error(grid.source === 'vtk' ? 'Q-space VTK input needs the parent cell'
                    : 'old-format .dat input needs the parent cell');
            }
            const A = cellToLattice(parentCell.lengths, parentCell.angles);
            if (grid.source === 'dat') {
                corner = qToHkl(A, grid.qCorner);
                vectors = grid.qVectors.map(v => qToHkl(A, v));
            } else if (opts.grid) {
                const cfg = opts.grid;
                if (cfg.dims.some((d, i) => d !== dims[i])) {
                    throw new Error(`grid config describes ${cfg.dims.join(' x ')} points but the VTK ` +
                        `has ${dims.join(' x ')}`);
                }
                corner = cfg.corner.slice();
                vectors = cfg.vectors.map(v => v.slice());
                if (opts.customFrame) {
                    notes.push('the config redefines the cartesian frame (HKL_TO_X/Y/Z); ' +
                        'VTK ORIGIN/SPACING were not cross-checked');
                } else {
                    // The header is written with 6 decimals (3f12.6).
                    const B = reciprocalBasis(A);
                    const off = (a, b) => Math.abs(a - b) > 5e-6 + 2e-5 * Math.abs(b);
                    const q0 = hklToQ(B, corner);
                    const qStep = vectors.map(v => Math.hypot(...hklToQ(B, v)));
                    if (q0.some((x, i) => off(x, grid.origin[i])) ||
                        qStep.some((x, i) => dims[i] > 1 && off(x, grid.spacing[i]))) {
                        notes.push('warning: VTK ORIGIN/SPACING differ from the grid config at this cell ' +
                            `(expected ORIGIN ${q0.map(x => x.toFixed(6)).join(' ')}, SPACING ` +
                            `${qStep.map(x => x.toFixed(6)).join(' ')}); check the config and the cell`);
                    }
                }
            } else {
                corner = qToHkl(A, grid.origin);
                vectors = diagonal(grid.spacing).map(q => q.every(x => x === 0) ? q : qToHkl(A, q));
                notes.push('VTK stores no axis directions: grid axes assumed along cartesian x, y, z. ' +
                    'For Scatty/Spinteract grids with rotated axes (e.g. X_AXIS 6 6 0), load the config file');
            }
        }
        const cell = parentCell || { lengths: [1, 1, 1], angles: [90, 90, 90] };
        const model = {
            dims: dims.slice(), corner, vectors, values: grid.values,
            cellLengths: cell.lengths.slice(), cellAngles: cell.angles.slice(),
            radiation: 'unknown', axes: pickAxes(vectors, dims), notes,
        };
        if (grid.source === 'dat') {
            model.nsecOriginal = grid.nsecOriginal;
            model.datHeader = grid.datHeader;
        }
        return model;
    }

    // Axis-aligned, ascending Q grid for STRUCTURED_POINTS.
    function vtkGeometry(model, cell) {
        const B = reciprocalBasis(cellToLattice(cell.lengths, cell.angles));
        const origin = hklToQ(B, model.corner);
        const spacing = [0, 0, 0];
        for (let axis = 0; axis < 3; axis++) {
            if (model.dims[axis] <= 1) continue;
            const q = hklToQ(B, model.vectors[axis]);
            const len = Math.hypot(q[0], q[1], q[2]);
            for (let comp = 0; comp < 3; comp++) {
                if (comp !== axis && Math.abs(q[comp]) > 1e-6 * Math.max(1e-12, len)) {
                    throw new Error('grid axes are not aligned with cartesian x/y/z in Q; ' +
                        'VTK STRUCTURED_POINTS cannot represent this grid');
                }
            }
            if (q[axis] <= 0) {
                throw new Error('grid step along axis ' + (axis + 1) + ' is not positive in Q; ' +
                    'VTK STRUCTURED_POINTS needs an ascending grid');
            }
            spacing[axis] = q[axis];
        }
        return { origin, spacing };
    }

    // Legacy VTK readers do not parse NaN; empty points are 0 as in Scatty.
    // opts.binary: big-endian float32 after the header instead of ASCII.
    function* writeVtkChunks(model, cell, valuesPerChunk, opts) {
        checkWritable(model, 'vtk');
        if (opts && opts.binary) {
            yield* writeVtkBinaryChunks(model, cell);
            return;
        }
        const { origin, spacing } = vtkGeometry(model, cell);
        const [nh, nk, nl] = model.dims;
        yield [
            '# vtk DataFile Version 2.0',
            'TITLE diffuse scattering',
            'ASCII',
            'DATASET STRUCTURED_POINTS',
            `DIMENSIONS ${nh} ${nk} ${nl}`,
            'ORIGIN ' + origin.map(x => x.toExponential(16)).join(' '),
            'SPACING ' + spacing.map(x => x.toExponential(16)).join(' '),
            `POINT_DATA ${nh * nk * nl}`,
            'SCALARS diffuse_scattering float',
            'LOOKUP_TABLE default',
        ].join('\n') + '\n';
        const chunkSize = Math.max(1, Number(valuesPerChunk) || 65536);
        let out = [];
        for (let n = 0; n < model.values.length; n++) {
            const v = model.values[n];
            out.push((Number.isFinite(v) ? v : 0).toExponential(16));
            if (out.length >= chunkSize) {
                yield out.join('\n') + '\n';
                out = [];
            }
        }
        if (out.length) yield out.join('\n') + '\n';
    }

    function* writeVtkBinaryChunks(model, cell) {
        const { origin, spacing } = vtkGeometry(model, cell);
        const [nh, nk, nl] = model.dims;
        yield [
            '# vtk DataFile Version 2.0', 'TITLE diffuse scattering', 'BINARY', 'DATASET STRUCTURED_POINTS',
            `DIMENSIONS ${nh} ${nk} ${nl}`, 'ORIGIN ' + origin.map(x => x.toExponential(9)).join(' '),
            'SPACING ' + spacing.map(x => x.toExponential(9)).join(' '), `POINT_DATA ${nh * nk * nl}`,
            'SCALARS diffuse_scattering float', 'LOOKUP_TABLE default', '',
        ].join('\n');
        const n = model.values.length, per = 1 << 20;
        for (let i = 0; i < n; i += per) {
            const m = Math.min(per, n - i), out = new Uint8Array(4 * m), dv = new DataView(out.buffer);
            for (let j = 0; j < m; j++) {
                const x = model.values[i + j];
                dv.setFloat32(4 * j, x === x && Number.isFinite(x) ? x : 0, false);
            }
            yield out;
        }
        yield '\n';
    }

    function writeVtk(model, cell) {
        return Array.from(writeVtkChunks(model, cell)).join('');
    }

    // ----------------------------------------------------------------- writers

    // h5wasm stores 'S' strings as UTF-8, sized in bytes.
    function fixedStr(s) {
        const t = String(s);
        return { data: [t], shape: [1], dtype: 'S' + Math.max(1, new TextEncoder().encode(t).length) };
    }

    function axisNames(model) {
        const basis = model.axesType === 'uvw' ? ['u', 'v', 'w'] : ['h', 'k', 'l'];
        return [0, 1, 2].map(a => basis[(model.axes[a] || a + 1) - 1]);
    }

    // The data_type labels of the unified contract, as DiffuseCode's
    // unified_write_data spells them: reciprocal-space intensities, or a
    // 3D-ΔPDF in direct (Patterson) space.
    function dataTypeLabels(model) {
        const direct = model.axesType === 'uvw';
        return {
            style: direct ? 'single_pdf' : 'single_diffraction',
            axes: direct ? 'uvw' : 'hkl',
            content: direct ? model.content || '3d-delta-pdf' : 'intensity',
            space: direct ? 'patterson' : 'reciprocal',
            symmetrized: model.symmetrized || 'none',
        };
    }

    // /entry/process (NXprocess): what was done to the data. The recipe sits
    // in an NXnote as JSON (to load and rerun) with a readable step list.
    // process: { program, recipe, description }.
    function writeProcess(entry, process) {
        const p = entry.create_group('process');
        p.create_attribute('NX_class', 'NXprocess');
        const text = (g, name, s) => g.create_dataset(Object.assign({ name }, fixedStr(s)));
        text(p, 'program', process.program || '3DSConvert');
        text(p, 'date', new Date().toISOString());
        const note = p.create_group('recipe');
        note.create_attribute('NX_class', 'NXnote');
        text(note, 'type', 'application/json');
        text(note, 'description', process.description || 'processing recipe');
        text(note, 'data', JSON.stringify(process.recipe));
    }

    const DIRECT_WRITE_BYTES = 64 * 1048576;

    // HDF5 dtype for the data array. precision 'float64' | 'float32'; any
    // other value keeps the model's own precision.
    function outputDtype(model, precision) {
        if (precision === 'float32') return '<f';
        if (precision === 'float64') return '<d';
        return model.values instanceof Float32Array ? '<f' : '<d';
    }

    // Write model.values as a 3-D dataset: order 'hFastest' stores C dims
    // [nl,nk,nh] (the model's own layout), 'lFastest' C dims [nh,nk,nl].
    // Data up to opts.directWriteBytes go out in one call; larger arrays are
    // written plane by plane into a chunked dataset, so no transposed copy of
    // the whole volume is built. opts: { dtype, compression (gzip level),
    // directWriteBytes, tick }.
    async function writeVolume(group, name, model, order, opts, progress) {
        const [nh, nk, nl] = model.dims;
        const Arr = opts.dtype === '<f' ? Float32Array : Float64Array;
        const shape = order === 'hFastest' ? [nl, nk, nh] : [nh, nk, nl];
        const planeLen = shape[1] * shape[2];
        const values = model.values;
        const fillPlane = order === 'hFastest'
            ? (i, out) => out.set(values.subarray(i * planeLen, (i + 1) * planeLen))
            : (ih, out) => {
                for (let ik = 0; ik < nk; ik++)
                    for (let il = 0; il < nl; il++) out[ik * nl + il] = values[(il * nk + ik) * nh + ih];
            };
        const planeBytes = planeLen * Arr.BYTES_PER_ELEMENT;
        const direct = opts.directWriteBytes === undefined ? DIRECT_WRITE_BYTES : opts.directWriteBytes;
        const gzip = opts.compression ? { compression: 'gzip', compression_opts: opts.compression } : {};
        if (shape[0] * planeBytes <= direct) {
            let data;
            if (order === 'hFastest' && values instanceof Arr) {
                data = values;
            } else {
                data = new Arr(shape[0] * planeLen);
                for (let i = 0; i < shape[0]; i++) fillPlane(i, data.subarray(i * planeLen, (i + 1) * planeLen));
            }
            const spec = { name, data, shape, dtype: opts.dtype };
            if (opts.compression) {
                // About 1 MiB per chunk.
                const planes = Math.min(shape[0], Math.max(1, Math.floor(1048576 / planeBytes)));
                Object.assign(spec, { chunks: [planes, shape[1], shape[2]] }, gzip);
            }
            group.create_dataset(spec);
            if (progress) progress(1);
            return;
        }
        const ds = group.create_dataset(Object.assign({
            name, data: new Arr(0), shape: [0, shape[1], shape[2]], maxshape: shape,
            chunks: [1, shape[1], shape[2]], dtype: opts.dtype,
        }, gzip));
        const plane = new Arr(planeLen);
        for (let i = 0; i < shape[0]; i++) {
            fillPlane(i, plane);
            ds.resize([i + 1, shape[1], shape[2]]);
            ds.write_slice([[i, i + 1]], plane);
            if (progress) progress((i + 1) / shape[0]);
            if (opts.tick) await opts.tick();
        }
    }

    function volumeOptions(model, opts) {
        return {
            dtype: outputDtype(model, opts.precision),
            compression: Number(opts.compression) || 0,
            directWriteBytes: opts.directWriteBytes,
            tick: opts.tick,
        };
    }

    // meta: { creationMethod, authorName, experiment, process (see
    // writeProcess) }. opts: { precision, layout ('both' | 'entry'),
    // compression (gzip level, 0 = none), tick, progress, directWriteBytes }.
    async function writeUnifiedData(f, model, cell, meta, opts) {
        meta = meta || {};
        opts = opts || {};
        if (model.axesType && model.axesType !== 'hkl' && model.axesType !== 'uvw') {
            throw new Error('unified writer requires hkl or uvw axes; convert Q axes with modelAxesToHkl first');
        }
        const names = axisNames(model);
        const type = dataTypeLabels(model);
        const today = new Date().toISOString().slice(0, 10);
        const method = meta.creationMethod || 'RMCProfile web format converter';
        const author = meta.authorName || 'RMCProfile';
        const radiation = model.radiation && model.radiation !== '' ? model.radiation : 'unknown';
        const both = opts.layout !== 'entry';
        const vol = volumeOptions(model, opts);
        const part = k => fraction => { if (opts.progress) opts.progress((k + fraction) / (both ? 2 : 1)); };

        // ---- /scattering/data (NXdata compatibility layout) ----
        if (both) {
            f.create_attribute('audit_conform_dict_name', UNIFIED_DATA_DICTIONARY);
            f.create_attribute('audit_conform_dict_version', '0.0.0');
            f.create_attribute('audit_creation_date', today);
            f.create_attribute('audit_creation_method', method);
            f.create_attribute('audit_author_name', author);
            f.create_attribute('default', 'scattering');

            const scat = f.create_group('scattering');
            scat.create_attribute('NX_class', 'NXentry');
            scat.create_attribute('default', 'data');
            const sd = scat.create_group('data');
            sd.create_attribute('NX_class', 'NXdata');
            sd.create_attribute('signal', 'data');
            sd.create_attribute('axes', names, [3], 'S1');
            sd.create_attribute('indices_abs', 0, [], '<i');
            sd.create_attribute('indices_ord', 1, [], '<i');
            sd.create_attribute('indices_top', 2, [], '<i');
            sd.create_attribute('radiation', radiation);
            sd.create_attribute('space', type.space);
            sd.create_attribute('content', type.content);
            sd.create_attribute('dimension', Math.max(1, model.dims.filter(d => d > 1).length), [], '<i');
            sd.create_attribute('data_type_experiment', meta.experiment || 'unknown');
            sd.create_attribute('data_type_style', type.style);
            sd.create_attribute('data_type_axes', type.axes);
            sd.create_attribute('data_type_with_bragg', 'unknown');
            sd.create_attribute('data_type_symmetrized', type.symmetrized);
            sd.create_attribute('data_type_number', 'real');
            sd.create_attribute('data_rad_symbol', 'unknown');

            sd.create_dataset({ name: 'lower_limits', data: model.corner, shape: [3], dtype: '<d' });
            const sv = new Float64Array(9);
            for (let axis = 0; axis < 3; axis++)
                for (let comp = 0; comp < 3; comp++) sv[axis * 3 + comp] = model.vectors[axis][comp];
            sd.create_dataset({ name: 'step_vectors', data: sv, shape: [3, 3], dtype: '<d' });
            sd.create_dataset({ name: 'data_axes', data: Int32Array.from(model.axes), shape: [3], dtype: '<i' });
            for (let axis = 0; axis < 3; axis++) {
                const comp = model.axes[axis] - 1;
                const vals = new Float64Array(model.dims[axis]);
                for (let i = 0; i < vals.length; i++) vals[i] = model.corner[comp] + i * model.vectors[axis][comp];
                sd.create_dataset({ name: names[axis], data: vals, shape: [vals.length], dtype: '<d' });
            }
            await writeVolume(sd, 'data', model, 'hFastest', vol, part(0));
            sd.create_dataset({ name: 'unit_cell_lengths', data: cell.lengths, shape: [3], dtype: '<d' });
            sd.create_dataset({ name: 'unit_cell_angles', data: cell.angles, shape: [3], dtype: '<d' });
            sd.create_dataset({ name: 'data_rad_length', data: [0, 0, 0], shape: [3], dtype: '<d' });
        }

        // ---- /entry/data (current common RMCProfile/DISCUS contract) ----
        const entry = f.create_group('entry');
        const ed = entry.create_group('data');
        const eds = (name, spec) => ed.create_dataset(Object.assign({ name }, spec));
        eds('unit_cell_lengths', { data: cell.lengths, shape: [3], dtype: '<d' });
        eds('unit_cell_angles', { data: cell.angles, shape: [3], dtype: '<d' });
        eds('symmetry_space_group_name_H-M', fixedStr('P 1'));
        eds('space_group_origin', { data: [1], shape: [1], dtype: '<i' });
        eds('symmetry_space_group_abc', fixedStr('abc'));
        eds('space_group_symop_number', { data: [1], shape: [1], dtype: '<i' });
        eds('space_group_symop_operation_mat', {
            data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], shape: [3, 4, 1], dtype: '<d',
        });
        eds('data_type_experiment', fixedStr(meta.experiment || 'unknown'));
        eds('data_type_style', fixedStr(type.style));
        eds('data_type_axes', fixedStr(type.axes));
        eds('data_type_content', fixedStr(type.content));
        eds('data_type_reciprocal', fixedStr(type.space));
        eds('data_type_with_bragg', fixedStr('unknown'));
        eds('data_type_symmetrized', fixedStr(type.symmetrized));
        eds('data_type_number', fixedStr('real'));
        eds('data_radiation', fixedStr(radiation));
        eds('data_rad_symbol', fixedStr('unknown'));
        eds('data_rad_length', { data: [0, 0, 0], shape: [3], dtype: '<d' });
        eds('data_dimension', { data: Int32Array.from(model.dims), shape: [3], dtype: '<i' });
        eds('data_axes', { data: Int32Array.from(model.axes), shape: [3], dtype: '<i' });
        eds('data_corner', { data: model.corner, shape: [3], dtype: '<d' });
        const iv = new Float64Array(9);
        for (let axis = 0; axis < 3; axis++)
            for (let comp = 0; comp < 3; comp++) iv[comp * 3 + axis] = model.vectors[axis][comp];
        eds('data_increment_vector', { data: iv, shape: [3, 3], dtype: '<d' });
        await writeVolume(ed, 'data_values', model, 'lFastest', vol, part(both ? 1 : 0));
        eds('audit_conform_dict_name', fixedStr(UNIFIED_DATA_DICTIONARY));
        eds('audit_conform_dict_version', fixedStr('0.0.0'));
        eds('audit_creation_date', fixedStr(today));
        eds('audit_creation_method', fixedStr(method));
        eds('audit_author_name', fixedStr(author));
        if (meta.process) writeProcess(entry, meta.process);
    }

    // opts as for writeUnifiedData (layout does not apply).
    async function writeYell(f, model, cell, opts) {
        opts = opts || {};
        if (model.axesType && model.axesType !== 'hkl' && model.axesType !== 'uvw') {
            throw new Error('Yell writer requires hkl or uvw axes; convert Q axes with modelAxesToHkl first');
        }
        f.create_dataset({ name: 'format', data: ['Yell 1.0'], shape: [1], dtype: 'S8' });
        f.create_dataset({ name: 'is_direct', data: [model.axesType === 'uvw' ? 1 : 0], shape: [1], dtype: '<b' });
        f.create_dataset({ name: 'lower_limits', data: model.corner, shape: [3], dtype: '<d' });
        f.create_dataset({
            name: 'step_sizes',
            data: [model.vectors[0][0], model.vectors[1][1], model.vectors[2][2]],
            shape: [3], dtype: '<d',
        });
        f.create_dataset({ name: 'step_sizes_abs', data: model.vectors[0], shape: [3], dtype: '<d' });
        f.create_dataset({ name: 'step_sizes_ord', data: model.vectors[1], shape: [3], dtype: '<d' });
        f.create_dataset({ name: 'step_sizes_top', data: model.vectors[2], shape: [3], dtype: '<d' });
        f.create_dataset({
            name: 'unit_cell',
            data: cell.lengths.concat(cell.angles), shape: [6], dtype: '<d',
        });
        await writeVolume(f, 'data', model, 'lFastest', volumeOptions(model, opts), opts.progress);
    }

    // ------------------------------------------------- NumPy, VTK XML, CCP4/MRC

    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }
    const asBytes = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

    // A .npy file (format 1.0): C-order array with the given shape.
    function npyBytes(array, shape) {
        const descr = array instanceof Float32Array ? '<f4' : array instanceof Int32Array ? '<i4' : '<f8';
        let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
        const total = 10 + header.length + 1;
        header += ' '.repeat((64 - total % 64) % 64) + '\n';
        const out = new Uint8Array(10 + header.length + array.byteLength);
        out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);          // \x93NUMPY 1.0
        new DataView(out.buffer).setUint16(8, header.length, true);
        for (let i = 0; i < header.length; i++) out[10 + i] = header.charCodeAt(i);
        out.set(asBytes(array), 10 + header.length);
        return out;
    }

    // An uncompressed ZIP archive of named byte arrays (under 4 GiB).
    function zipStore(files) {
        const enc = new TextEncoder();
        const parts = [], central = [];
        let offset = 0;
        for (const [name, data] of files) {
            const nm = enc.encode(name), crc = crc32(data);
            const local = new Uint8Array(30 + nm.length), lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, data.length, true);
            lv.setUint32(22, data.length, true);
            lv.setUint16(26, nm.length, true);
            local.set(nm, 30);
            const dir = new Uint8Array(46 + nm.length), dv = new DataView(dir.buffer);
            dv.setUint32(0, 0x02014b50, true);
            dv.setUint16(4, 20, true);
            dv.setUint16(6, 20, true);
            dv.setUint32(16, crc, true);
            dv.setUint32(20, data.length, true);
            dv.setUint32(24, data.length, true);
            dv.setUint16(28, nm.length, true);
            dv.setUint32(42, offset, true);
            dir.set(nm, 46);
            parts.push(local, data);
            central.push(dir);
            offset += local.length + data.length;
            if (offset > 0xfffffffe) throw new Error('the .npz archive would exceed 4 GB; use HDF5 output');
        }
        const size = central.reduce((a, d) => a + d.length, 0);
        const end = new Uint8Array(22), ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, files.length, true);
        ev.setUint16(10, files.length, true);
        ev.setUint32(12, size, true);
        ev.setUint32(16, offset, true);
        return new Blob(parts.concat(central, [end]));
    }

    // NumPy .npz: values (and sigma) as C-order [nl, nk, nh] arrays - the
    // first grid axis varies fastest - with the grid and the cell beside them.
    // np.load(f)['values'][l, k, h]; hkl = corner + h*step_vectors[0] + ...
    function writeNpz(model, cell, opts) {
        opts = opts || {};
        const [nh, nk, nl] = model.dims;
        const Arr = outputDtype(model, opts.precision) === '<f' ? Float32Array : Float64Array;
        const cast = a => (a instanceof Arr ? a : Arr.from(a));
        const f64 = a => Float64Array.from(a);
        const files = [['values.npy', npyBytes(cast(model.values), [nl, nk, nh])]];
        if (model.sigma) files.push(['sigma.npy', npyBytes(cast(model.sigma), [nl, nk, nh])]);
        files.push(['corner.npy', npyBytes(f64(model.corner), [3])]);
        files.push(['step_vectors.npy', npyBytes(f64(model.vectors.flat()), [3, 3])]);
        files.push(['unit_cell.npy', npyBytes(f64(cell.lengths.concat(cell.angles)), [6])]);
        const meta = {
            creator: '3DSConvert', axes: model.axesType === 'uvw' ? 'uvw' : 'hkl', content: model.content || 'intensity',
            order: 'values[i2, i1, i0]: i0 (along step_vectors[0]) varies fastest',
            coordinate: 'corner + i0*step_vectors[0] + i1*step_vectors[1] + i2*step_vectors[2]',
            unit_cell: 'a b c (Angstrom) alpha beta gamma (degrees)', symmetrized: model.symmetrized || 'none',
            radiation: model.radiation || 'unknown',
        };
        files.push(['metadata.json', new TextEncoder().encode(JSON.stringify(meta, null, 1) + '\n')]);
        return zipStore(files);
    }

    // Read one written by writeNpz (or np.savez with the same names).
    // opts.crop as for the HDF5 readers.
    function readNpz(bytes, opts) {
        const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
        let end = -1;
        for (let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
        }
        if (end < 0) throw new Error('.npz: not a ZIP archive');
        const count = dv.getUint16(end + 10, true);
        let at = dv.getUint32(end + 16, true);
        const members = {};
        const dec = new TextDecoder();
        for (let n = 0; n < count; n++) {
            if (dv.getUint32(at, true) !== 0x02014b50) throw new Error('.npz: damaged central directory');
            const method = dv.getUint16(at + 10, true), size = dv.getUint32(at + 20, true);
            const nameLen = dv.getUint16(at + 28, true), extra = dv.getUint16(at + 30, true), comment = dv.getUint16(at + 32, true);
            const local = dv.getUint32(at + 42, true);
            const name = dec.decode(u.subarray(at + 46, at + 46 + nameLen));
            const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
            members[name] = { method, data: u.subarray(start, start + size) };
            at += 46 + nameLen + extra + comment;
        }
        const npy = name => {
            const m = members[name];
            if (!m) return null;
            if (m.method !== 0) throw new Error(`.npz: ${name} is compressed (np.savez_compressed); save with np.savez`);
            const d = m.data, hl = d[8] | (d[9] << 8), header = dec.decode(d.subarray(10, 10 + hl));
            const descr = /'descr':\s*'([<>|]?)([a-z])(\d+)'/.exec(header);
            const shape = /'shape':\s*\(([^)]*)\)/.exec(header)[1].split(',').map(x => x.trim()).filter(Boolean).map(Number);
            if (/'fortran_order':\s*True/.test(header)) throw new Error(`.npz: ${name} is in Fortran order`);
            if (!descr || descr[1] === '>' || descr[2] !== 'f' || !['4', '8'].includes(descr[3])) {
                throw new Error(`.npz: ${name} must be little-endian float32 or float64`);
            }
            const body = new Uint8Array(d.subarray(10 + hl));      // a copy, aligned (Buffer.slice would share memory)
            return { values: descr[3] === '4' ? new Float32Array(body.buffer) : new Float64Array(body.buffer), shape };
        };
        const v = npy('values.npy');
        if (!v) throw new Error('.npz: no "values" array');
        const shape = v.shape.slice();
        if (shape.length > 3) throw new Error(`.npz: "values" has ${shape.length} dimensions, expected up to 3`);
        while (shape.length < 3) shape.unshift(1);
        const dims = [shape[2], shape[1], shape[0]];
        if (v.values.length !== dims[0] * dims[1] * dims[2]) throw new Error('.npz: "values" is shorter than its shape');
        const corner = npy('corner.npy'), steps = npy('step_vectors.npy'), cellArr = npy('unit_cell.npy');
        const notes = [];
        if (!corner || !steps) notes.push('no corner/step_vectors in the archive: unit steps from 0 assumed');
        const vec = steps ? Array.from(steps.values) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const meta = members['metadata.json'] ? JSON.parse(dec.decode(members['metadata.json'].data)) : {};
        const sig = npy('sigma.npy');
        if (sig && sig.values.length !== v.values.length) throw new Error('.npz: "sigma" and "values" differ in size');
        const c = cellArr ? Array.from(cellArr.values) : [1, 1, 1, 90, 90, 90];
        const axesType = meta.axes === 'uvw' ? 'uvw' : 'hkl';
        let grid = {
            dims, corner: corner ? Array.from(corner.values) : [0, 0, 0],
            vectors: [0, 1, 2].map(a => (dims[a] > 1 ? vec.slice(3 * a, 3 * a + 3) : [0, 0, 0])),
        };
        let values = v.values, sigma = sig ? sig.values : undefined;
        const box = readBox(grid.dims, grid.corner, grid.vectors, opts, notes, axesType);
        if (box) {
            values = cutBox(values, dims, box);
            if (sigma) sigma = cutBox(sigma, dims, box);
            grid = boxedGrid(box, grid.dims, grid.corner, grid.vectors);
        }
        return {
            dims: grid.dims, corner: grid.corner, vectors: grid.vectors,
            values, sigma, cellLengths: c.slice(0, 3), cellAngles: c.slice(3, 6),
            radiation: normalizeRadiation(meta.radiation), axes: pickAxes(grid.vectors, grid.dims), axesType,
            content: axesType === 'uvw' ? meta.content : undefined,
            symmetrized: meta.symmetrized && meta.symmetrized !== 'none' ? meta.symmetrized : undefined, notes,
        };
    }

    // The part of an h-fastest volume inside an index box.
    function cutBox(values, dims, box) {
        const d = boxDims(box), out = new values.constructor(d[0] * d[1] * d[2]);
        let o = 0;
        for (let k = box[2][0]; k <= box[2][1]; k++) {
            for (let j = box[1][0]; j <= box[1][1]; j++) {
                const base = (k * dims[1] + j) * dims[0];
                out.set(values.subarray(base + box[0][0], base + box[0][1] + 1), o);
                o += d[0];
            }
        }
        return out;
    }

    // The grid's physical frame for VTK and maps: Q (1/Angstrom) for hkl
    // data with a real cell, Cartesian Angstrom for direct-space (uvw) data,
    // else plain hkl. Returns { origin, axes (3 Cartesian step vectors), unit }.
    function physicalGrid(model, cell) {
        const real = cell && !isUnitMetric(cell.lengths, cell.angles);
        let map = x => x, unit = 'r.l.u.';
        if (real && model.axesType === 'uvw') {
            const A = cellToLattice(cell.lengths, cell.angles);
            map = x => [0, 1, 2].map(r => A[r][0] * x[0] + A[r][1] * x[1] + A[r][2] * x[2]);
            unit = 'Angstrom';
        } else if (real) {
            const B = reciprocalBasis(cellToLattice(cell.lengths, cell.angles));
            map = x => hklToQ(B, x);
            unit = '1/Angstrom';
        }
        return { origin: map(model.corner), axes: model.vectors.map(map), unit };
    }

    // VTK XML ImageData (.vti) with a Direction matrix, so sheared or rotated
    // grids keep their geometry (ParaView 5.10 and later read Direction).
    // Values (and sigma) as inline base64 binary; yields text chunks.
    function* writeVtiChunks(model, cell, opts) {
        opts = opts || {};
        const { origin, axes, unit } = physicalGrid(model, cell);
        const [nh, nk, nl] = model.dims;
        const len = v => Math.hypot(v[0], v[1], v[2]);
        const dirs = axes.map((v, a) => (model.dims[a] > 1 && len(v) > 0 ? v.map(x => x / len(v)) : null));
        // a single-point axis gets a direction perpendicular to the others
        for (let a = 0; a < 3; a++) {
            if (dirs[a]) continue;
            const others = dirs.filter(Boolean);
            const n = others.length === 2 ? cross(others[0], others[1]) : [0, 1, 2].map(c => (c === a ? 1 : 0));
            dirs[a] = n.map(x => x / (len(n) || 1));
        }
        const spacing = axes.map((v, a) => (model.dims[a] > 1 ? len(v) : 1));
        const f = x => (Math.abs(x) < 1e-15 ? '0' : x.toPrecision(15));
        const direction = [0, 1, 2].map(r => [0, 1, 2].map(c => f(dirs[c][r])).join(' ')).join(' ');
        const type = outputDtype(model, opts.precision) === '<f' ? 'Float32' : 'Float64';
        const Arr = type === 'Float32' ? Float32Array : Float64Array;
        const extent = `0 ${nh - 1} 0 ${nk - 1} 0 ${nl - 1}`;
        yield '<?xml version="1.0"?>\n' +
            `<!-- 3DSConvert: ${model.axesType === 'uvw' ? '3D-ΔPDF' : 'diffuse scattering'}, axes in ${unit} -->\n` +
            '<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt64">\n' +
            `  <ImageData WholeExtent="${extent}" Origin="${origin.map(f).join(' ')}" Spacing="${spacing.map(f).join(' ')}" Direction="${direction}">\n` +
            `    <Piece Extent="${extent}">\n      <PointData Scalars="values">\n`;
        const arrays = [['values', model.values]].concat(model.sigma ? [['sigma', model.sigma]] : []);
        for (const [name, src] of arrays) {
            yield `        <DataArray type="${type}" Name="${name}" format="binary">`;
            const data = src instanceof Arr ? src : Arr.from(src);
            const head = new Uint8Array(8);
            new DataView(head.buffer).setBigUint64(0, BigInt(data.byteLength), true);
            const bytes = asBytes(data);
            // base64 in blocks of 3-byte multiples, the 8-byte header first
            const block = 3 * 262144;
            let carry = head;
            for (let i = 0; i < bytes.length; i += block) {
                const part = bytes.subarray(i, i + block);
                const joined = new Uint8Array(carry.length + part.length);
                joined.set(carry);
                joined.set(part, carry.length);
                const cut = i + block >= bytes.length ? joined.length : joined.length - joined.length % 3;
                yield base64(joined.subarray(0, cut));
                carry = joined.slice(cut);
            }
            if (carry.length) yield base64(carry);
            yield '</DataArray>\n';
        }
        yield '      </PointData>\n    </Piece>\n  </ImageData>\n</VTKFile>\n';
    }

    function base64(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
        return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
    }

    // CCP4/MRC map (MRC2014, mode 2 float32) of a direct-space grid along the
    // lattice axes u, v, w - a 3D-ΔPDF for Chimera, Coot or PyMOL. The map
    // "cell" spans the grid (N steps of a*du etc.), so the voxel size is the
    // grid step; NXSTART etc. place the origin.
    function writeMrc(model, cell) {
        if (model.axesType !== 'uvw') throw new Error('CCP4/MRC maps are for direct-space data (a 3D-ΔPDF); these are in reciprocal space');
        const [nx, ny, nz] = model.dims;
        const step = [0, 1, 2].map(a => {
            const v = model.vectors[a];
            if (model.dims[a] > 1 && v.some((x, c) => c !== a && Math.abs(x) > 1e-9 * Math.max(...v.map(Math.abs)))) {
                throw new Error('CCP4/MRC maps need grid axes along u, v and w');
            }
            if (model.dims[a] > 1 && !(v[a] > 0)) throw new Error('CCP4/MRC maps need ascending u, v and w axes');
            return model.dims[a] > 1 ? v[a] : 1;
        });
        // the first voxel sits a whole number of steps from the origin
        const start = model.corner.map((x, a) => {
            const s = x / step[a], r = Math.round(s);
            if (Math.abs(s - r) > 1e-6 * Math.max(1, Math.abs(s))) {
                throw new Error('CCP4/MRC maps need the grid corner a whole number of steps from the origin');
            }
            return r === 0 ? 0 : r;
        });
        const values = Float32Array.from(model.values, x => (x === x ? x : 0));
        let min = Infinity, max = -Infinity, sum = 0, sq = 0;
        for (const x of values) {
            if (x < min) min = x;
            if (x > max) max = x;
            sum += x;
            sq += x * x;
        }
        const mean = sum / values.length, rms = Math.sqrt(Math.max(0, sq / values.length - mean * mean));
        const head = new ArrayBuffer(1024), dv = new DataView(head);
        const int = (w, v) => dv.setInt32(4 * w, v, true), flt = (w, v) => dv.setFloat32(4 * w, v, true);
        int(0, nx); int(1, ny); int(2, nz); int(3, 2);
        int(4, start[0]); int(5, start[1]); int(6, start[2]);
        int(7, nx); int(8, ny); int(9, nz);
        [0, 1, 2].forEach(a => flt(10 + a, [nx, ny, nz][a] * step[a] * cell.lengths[a]));
        [0, 1, 2].forEach(a => flt(13 + a, cell.angles[a]));
        int(16, 1); int(17, 2); int(18, 3);
        flt(19, min); flt(20, max); flt(21, mean);
        int(22, 1);                                   // ISPG
        int(27, 20140);                               // NVERSION
        new Uint8Array(head).set([0x4d, 0x41, 0x50, 0x20], 208);   // 'MAP '
        new Uint8Array(head).set([0x44, 0x44, 0, 0], 212);         // little-endian machine stamp
        flt(54, rms);
        int(55, 1);                                   // NLABL
        const label = '3DSConvert: 3D-ΔPDF (u, v, w grid)'.replace(/[^\x20-\x7e]/g, 'D').padEnd(80);
        for (let i = 0; i < 80; i++) new Uint8Array(head)[224 + i] = label.charCodeAt(i);
        return new Blob([new Uint8Array(head), asBytes(values)]);
    }

    // ------------------------------------------------------------ conversions

    // Parent cell for a conversion: sources.prefer ('structure' | 'manual')
    // when that source is given, else the data file's own real cell first,
    // then a structure file, then the manual entry.
    function resolveCell(model, sources) {
        sources = sources || {};
        if (sources.prefer === 'manual' && sources.manual) return { cell: sources.manual, source: 'manual entry' };
        if (sources.prefer === 'structure' && sources.structure) return { cell: sources.structure, source: 'structure file' };
        if (model && model.cellLengths && !isUnitMetric(model.cellLengths, model.cellAngles)) {
            return {
                cell: { lengths: model.cellLengths.slice(), angles: model.cellAngles.slice() },
                source: 'data file',
            };
        }
        if (sources.structure) return { cell: sources.structure, source: 'structure file' };
        if (sources.manual) return { cell: sources.manual, source: 'manual entry' };
        return null;
    }

    // Decide everything about a conversion before writing. input is { model }
    // (HDF5 data) or { grid } (text data, see toHklModel); params: { format,
    // structure, manual, radiation, grid, customFrame }. Returns { model,
    // cell, cellSource, logs } or throws when the output cannot be written.
    function planConversion(input, params) {
        const logs = [];
        const text = params.format === 'dat' || params.format === 'vtk';
        let model, resolved;
        if (input.grid && input.grid.frame === 'q') {
            resolved = resolveCell(null, { structure: params.structure, manual: params.manual, prefer: params.cellPrefer });
            if (!resolved) {
                throw new Error((input.grid.source === 'vtk' ? 'Q-space VTK' : 'old-format .dat') +
                    ' input needs a structure file or a manual parent cell');
            }
            model = toHklModel(input.grid, resolved.cell, { grid: params.grid, customFrame: params.customFrame });
            if (model.nsecOriginal > 1) {
                logs.push(`Note: input has ${model.nsecOriginal} symmetry sections; section 1 Q coordinates used.`);
            }
        } else {
            model = input.grid ? toHklModel(input.grid, null) : input.model;
            resolved = resolveCell(model, { structure: params.structure, manual: params.manual, prefer: params.cellPrefer });
            if (!resolved) {
                if (text) {
                    throw new Error('data file stores the unit metric - supply a structure file or a manual parent cell');
                }
                resolved = {
                    cell: { lengths: model.cellLengths.slice(), angles: model.cellAngles.slice() },
                    source: 'data file (unit metric, passed through)',
                };
            }
        }
        model = Object.assign({}, model);
        if (params.radiation) model.radiation = params.radiation;
        if (model.axesType === 'Q') {
            const ub = params.ub || model.ub || null;
            if (!ub && isUnitMetric(resolved.cell.lengths, resolved.cell.angles)) {
                throw new Error('Q-axis data need a real parent cell (or a UB matrix) to convert Q to hkl');
            }
            model = modelAxesToHkl(model, resolved.cell, ub);
            logs.push(ub ? `Converted Cartesian Q axes to hkl with the ${params.ub ? 'typed' : "file's"} UB matrix (hkl = (2π UB)⁻¹ Q).`
                : 'Converted Cartesian Q axes to hkl using the selected parent cell (a along x).');
        }
        checkWritable(model, params.format);
        if (text && isUnitMetric(resolved.cell.lengths, resolved.cell.angles)) {
            throw new Error('cannot write ' + params.format + ' with a unit-metric cell - supply a ' +
                'structure file or a manual parent cell');
        }
        return { model, cell: resolved.cell, cellSource: resolved.source, logs };
    }

    // Approximate output size in bytes; an upper bound when compressing.
    function estimateOutputBytes(model, format, opts) {
        opts = opts || {};
        const n = model.dims[0] * model.dims[1] * model.dims[2];
        const item = outputDtype(model, opts.precision) === '<f' ? 4 : 8;
        if (format === 'unified') return n * item * (opts.layout === 'entry' ? 1 : 2) + 65536;
        if (format === 'yell') return n * item + 16384;
        if (format === 'dat') {
            // "i j k qx qy qz I" with 17 significant digits per number, three
            // more coordinates per extra symmetry section.
            const digits = model.dims.reduce((s, d) => s + String(d).length, 0);
            return n * (digits + (3 * (opts.nsec || 1) + 1) * 23 + 4);
        }
        if (format === 'vtk') return opts.binary ? n * 4 + 512 : n * 23 + 512;
        if (format === 'hkl') return n * 62;
        if (format === 'npz') return n * item * (model.sigma ? 2 : 1) + 4096;
        if (format === 'vti') return Math.ceil(n * item * (model.sigma ? 2 : 1) * 4 / 3) + 4096;
        if (format === 'mrc') return n * 4 + 1024;
        return 0;
    }

    function isHdf5Signature(bytes) {
        const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return u.length >= 4 && u[0] === 0x89 && u[1] === 0x48 && u[2] === 0x44 && u[3] === 0x46;
    }

    return {
        cellToLattice, latticeToCell, reciprocalBasis, hklToQ, qToHkl, isUnitMetric, modelAxesToHkl,
        parseRmc6f, readUnifiedStructure, isHdf5Signature,
        detectH5Kind, unsupportedKindMessage, readUnifiedData, readYell,
        readMantidMD, readNexusData, nexusCandidates, unresolvedLinks, planLinkMounts, projectionVector,
        parseOldDat, readOldDatStream, writeOldDat, writeOldDatChunks, countNonFinite,
        isVtk, vtkFrame, parseGridConfig, parseVtk, readVtkStream, writeVtk, writeVtkChunks,
        isHklList, parseHklList, readHklListStream, hklListModel, writeHklListChunks, hklConfigSnippet,
        writeNpz, readNpz, writeVtiChunks, writeMrc, crc32, readVtkBinary, isBinaryVtk, readRspace3d, readSubhklCell,
        is3dsCalculatorDat, is3dsCalculatorJson, read3dsCalculatorJson,
        toHklModel, resolveCell, planConversion, checkWritable, estimateOutputBytes, outputDtype,
        writeUnifiedData, writeYell,
    };
}));
