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
    async function forEachSlab(ds, path, opts, onSlab) {
        opts = opts || {};
        const shape = Array.from(ds.shape || []).map(Number);
        if (!shape.length) throw new Error(`${path} is a scalar, expected an array`);
        assertDecodable(ds, path);
        const n0 = shape[0];
        const planeLen = shape.slice(1).reduce((a, b) => a * b, 1);
        const itemBytes = Math.max(1, Number((ds.metadata || {}).size) || 8);
        const chunks = (ds.metadata || {}).chunks;
        const chunk0 = chunks && chunks.length ? Number(chunks[0]) : 0;
        const fit = Math.max(1, Math.floor((opts.slabBytes || SLAB_BYTES) / (planeLen * itemBytes)));
        const planes = Math.min(n0, chunk0 > 0 && chunk0 <= fit ? chunk0 * Math.floor(fit / chunk0) : fit);
        for (let start = 0; start < n0; start += planes) {
            const count = Math.min(planes, n0 - start);
            let values = ds.slice([[start, start + count]]);
            if (values instanceof BigInt64Array || values instanceof BigUint64Array) {
                values = Float64Array.from(values, Number);
            }
            onSlab(start, count, values);
            if (opts.progress) opts.progress((start + count) / n0);
            if (opts.tick) await opts.tick();
        }
    }

    // Dataset in C order [nh,nk,nl] (l fastest) -> h-fastest values.
    async function readLFastest(ds, path, dims, opts) {
        const [nh, nk, nl] = dims;
        const out = allocFor(ds, nh * nk * nl);
        await forEachSlab(ds, path, opts, (h0, count, slab) => {
            for (let dh = 0; dh < count; dh++) {
                const ih = h0 + dh;
                for (let ik = 0; ik < nk; ik++) {
                    const src = (dh * nk + ik) * nl;
                    for (let il = 0; il < nl; il++) out[(il * nk + ik) * nh + ih] = slab[src + il];
                }
            }
        });
        return out;
    }

    // Dataset in C order [nl,nk,nh] (h fastest): slabs copy straight in.
    async function readHFastest(ds, path, dims, opts) {
        const [nh, nk, nl] = dims;
        const out = allocFor(ds, nh * nk * nl);
        await forEachSlab(ds, path, opts, (l0, count, slab) => out.set(slab, l0 * nk * nh));
        return out;
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
        if (axesType !== 'hkl' && axesType !== 'Q') {
            throw new Error(`unified data axes are ${axesType}; this 3-D diffuse converter supports hkl or Q axes`);
        }
        return { axesType, numberType };
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

    function modelAxesToHkl(model, cell) {
        if (!model || model.axesType === 'hkl' || !model.axesType) return model;
        if (model.axesType !== 'Q') {
            throw new Error(`cannot convert ${model.axesType} axes to hkl`);
        }
        const A = cellToLattice(cell.lengths, cell.angles);
        return Object.assign({}, model, {
            corner: qToHkl(A, model.corner),
            vectors: model.vectors.map(v => qToHkl(A, v)),
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

    // ----------------------------------------------------------------- readers

    function detectH5Kind(f) {
        const dict = unifiedDictionary(f);
        if (dict === UNIFIED_STRUCTURE_DICTIONARY) return 'structure';
        if (dict === UNIFIED_DATA_DICTIONARY || dict === LEGACY_DATA_DICTIONARY) return 'unified';
        if (f.get('scattering/data/data')) return 'unified';
        if (f.get('entry/data/data_values')) return 'unified';
        if (f.get('data') && f.get('lower_limits') && f.get('unit_cell')) return 'yell';
        if (f.get('entry/data/atom_position') || f.get('entry/data/unit_cells')) return 'structure';
        return 'unknown';
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
            const comp = 'hkl'.indexOf(name.toLowerCase());
            if (comp < 0 || name.length !== 1) {
                throw new Error(`scattering/data: axis "${name}" is not h, k or l; ` +
                    'only reciprocal-space hkl grids are supported');
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
        const dims = layout === 'abs-fastest' ? [shape[2], shape[1], shape[0]] : shape.slice();
        const values = layout === 'abs-fastest'
            ? await readHFastest(ds, g + 'data', dims, opts)
            : await readLFastest(ds, g + 'data', dims, opts);

        let corner = numbersAt(f, g + 'lower_limits');
        const sv = numbersAt(f, g + 'step_vectors');
        let vectors;
        if (corner && sv && sv.length === 9) {
            vectors = [0, 1, 2].map(axis => [0, 1, 2].map(comp =>
                layout === 'abs-fastest' ? sv[axis * 3 + comp] : sv[comp * 3 + axis]));
        } else {
            ({ corner, vectors } = gridFromCoordinates(f, g, names, dims));
            notes.push(`no lower_limits/step_vectors: grid taken from the ${names.join('/')} coordinate arrays`);
        }

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
        const axes = numbersAt(f, g + 'data_axes') ||
            (names.every(n => ['h', 'k', 'l'].includes(n)) && new Set(names).size === 3
                ? names.map(n => 'hkl'.indexOf(n) + 1) : pickAxes(vectors, dims));
        const radiation = normalizeRadiation(
            attributeText(group, 'radiation') || attributeText(group, 'scattering'));
        const contract = validateDataContract(f, group, attributeText(group, 'space') || 'reciprocal');
        return {
            dims, corner, vectors, values,
            cellLengths: lengths, cellAngles: angles, radiation, axes,
            axesType: contract.axesType, numberType: contract.numberType, notes,
        };
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
        let values;
        if (reversed) {
            values = await readHFastest(ds, g + 'data_values', dims, opts);
        } else if (shape.length === 3) {
            values = await readLFastest(ds, g + 'data_values', dims, opts);
        } else {
            // Size-1 axes dropped from the stored shape: the C order is unchanged.
            const flat = readDataset(ds, g + 'data_values');
            values = lFastestToHFastest(flat, nh, nk, nl, isFloat32Dataset(ds));
        }
        const corner = numbersAt(f, g + 'data_corner', 'unified data');
        const iv = numbersAt(f, g + 'data_increment_vector', 'unified data');
        const vectors = [0, 1, 2].map(axis => [0, 1, 2].map(comp =>
            reversed ? iv[axis * 3 + comp] : iv[comp * 3 + axis]));
        const lengths = numbersAt(f, g + 'unit_cell_lengths', 'unified data');
        const angles = numbersAt(f, g + 'unit_cell_angles', 'unified data');
        const axes = numbersAt(f, g + 'data_axes') || [1, 2, 3];
        const radiation = normalizeRadiation(datasetText(f, g + 'data_radiation'));
        const reciprocal = datasetText(f, g + 'data_type_reciprocal');
        const contract = validateDataContract(f, f.get('entry/data'), reciprocal);
        return {
            dims, corner, vectors, values,
            cellLengths: lengths, cellAngles: angles, radiation, axes,
            axesType: contract.axesType, numberType: contract.numberType, notes,
        };
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
    async function readYell(f, opts) {
        opts = opts || {};
        const notes = [];
        const flag = yellDirectFlag(f);
        if (flag === 1) {
            throw new Error('Yell file holds direct-space data (is_direct = 1); only reciprocal space is supported');
        }
        if (flag !== null && flag !== 0) {
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
        // C [nh], [nh,nk] and [nh,nk,nl] share one flat order, so slabs work for all.
        const values = await readLFastest(ds, 'data', [nh, nk, nl], opts);
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
        return {
            dims: [nh, nk, nl], corner, vectors, values,
            cellLengths: cell.slice(0, 3), cellAngles: cell.slice(3, 6),
            radiation: 'unknown', axes: [1, 2, 3], notes,
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
    function datParser() {
        let header = null, npoints = 0, perRow = 0, nsec = 0, nrows = 0;
        let pix = null, vals = null, row = [];
        const dims = [0, 0, 0];
        const special = [null, null, null, null];     // Q at (1,1,1) (2,1,1) (1,2,1) (1,1,2)
        const xx = new Float64Array(16), xq = new Float64Array(12);   // least-squares sums
        const notes = [];
        let datHeader = null;

        function takeRow(tok) {
            if (nrows >= npoints) return;
            const i = parseInt(tok[0], 10), j = parseInt(tok[1], 10), k = parseInt(tok[2], 10);
            if (!(i >= 1 && j >= 1 && k >= 1)) throw new Error('pixel coordinates must be positive');
            const qx = num(tok[3]), qy = num(tok[4]), qz = num(tok[5]);
            pix[3 * nrows] = i; pix[3 * nrows + 1] = j; pix[3 * nrows + 2] = k;
            vals[nrows++] = num(tok[perRow - 1]);
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
            return {
                frame: 'q', source: 'dat', dims: dims.slice(), values,
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
        const parser = datParser();
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

    // Non-finite intensities are written as 0.0: RMCProfile treats I = 0 as a
    // masked point (excluded from chi^2), while a literal NaN would poison it.
    function* writeOldDatChunks(model, cell, linesPerChunk) {
        const A = cellToLattice(cell.lengths, cell.angles);
        const B = reciprocalBasis(A);
        const [nh, nk, nl] = model.dims;
        const chunkSize = Math.max(1, Number(linesPerChunk) || 16384);
        let out = [`${nh * nk * nl} 1`];
        for (let k = 0; k < nl; k++) {
            for (let j = 0; j < nk; j++) {
                for (let i = 0; i < nh; i++) {
                    const hkl = [0, 1, 2].map(c =>
                        model.corner[c] + i * model.vectors[0][c] + j * model.vectors[1][c] + k * model.vectors[2][c]);
                    const q = hklToQ(B, hkl);
                    const raw = model.values[(k * nk + j) * nh + i];
                    const v = Number.isFinite(raw) ? raw : 0;
                    out.push(`${i + 1} ${j + 1} ${k + 1} ${q[0].toExponential(16)} ${q[1].toExponential(16)} ${q[2].toExponential(16)} ${v.toExponential(16)}`);
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
    function vtkParser() {
        let lineNo = 0, title = '', dims = null, origin = null, spacing = null;
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
            if (key === 'BINARY') throw new Error('binary VTK is not supported (Scatty writes ASCII)');
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

        return { line, finish };
    }

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
        if (grid.frame === 'hkl') {
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
    function* writeVtkChunks(model, cell, valuesPerChunk) {
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

    function writeVtk(model, cell) {
        return Array.from(writeVtkChunks(model, cell)).join('');
    }

    // ----------------------------------------------------------------- writers

    function fixedStr(s) {
        const t = String(s);
        return { data: [t], shape: [1], dtype: 'S' + Math.max(1, t.length) };
    }

    function axisNames(model) {
        const basis = ['h', 'k', 'l'];
        return [0, 1, 2].map(a => basis[(model.axes[a] || a + 1) - 1]);
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

    // opts: { precision, layout ('both' | 'entry'), compression (gzip level,
    // 0 = none), tick, progress, directWriteBytes }.
    async function writeUnifiedData(f, model, cell, meta, opts) {
        meta = meta || {};
        opts = opts || {};
        if (model.axesType && model.axesType !== 'hkl') {
            throw new Error('unified writer requires hkl axes; convert Q axes with modelAxesToHkl first');
        }
        const names = axisNames(model);
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
            sd.create_attribute('space', 'reciprocal');
            sd.create_attribute('content', 'intensity');
            sd.create_attribute('dimension', Math.max(1, model.dims.filter(d => d > 1).length), [], '<i');
            sd.create_attribute('data_type_experiment', meta.experiment || 'unknown');
            sd.create_attribute('data_type_style', 'single_diffraction');
            sd.create_attribute('data_type_axes', 'hkl');
            sd.create_attribute('data_type_with_bragg', 'unknown');
            sd.create_attribute('data_type_symmetrized', 'none');
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
        eds('data_type_style', fixedStr('single_diffraction'));
        eds('data_type_axes', fixedStr('hkl'));
        eds('data_type_content', fixedStr('intensity'));
        eds('data_type_reciprocal', fixedStr('reciprocal'));
        eds('data_type_with_bragg', fixedStr('unknown'));
        eds('data_type_symmetrized', fixedStr('none'));
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
    }

    // opts as for writeUnifiedData (layout does not apply).
    async function writeYell(f, model, cell, opts) {
        opts = opts || {};
        f.create_dataset({ name: 'format', data: ['Yell 1.0'], shape: [1], dtype: 'S8' });
        f.create_dataset({ name: 'is_direct', data: [0], shape: [1], dtype: '<b' });
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

    // ------------------------------------------------------------ conversions

    // Parent cell for a conversion: the data file's own real cell first, then
    // a structure file, then the manual entry.
    function resolveCell(model, sources) {
        sources = sources || {};
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
            const parent = params.structure || params.manual;
            if (!parent) {
                throw new Error((input.grid.source === 'vtk' ? 'Q-space VTK' : 'old-format .dat') +
                    ' input needs a structure file or a manual parent cell');
            }
            model = toHklModel(input.grid, parent, { grid: params.grid, customFrame: params.customFrame });
            resolved = { cell: parent, source: params.structure ? 'structure file' : 'manual entry' };
            if (model.nsecOriginal > 1) {
                logs.push(`Note: input has ${model.nsecOriginal} symmetry sections; section 1 Q coordinates used.`);
            }
        } else {
            model = input.grid ? toHklModel(input.grid, null) : input.model;
            resolved = resolveCell(model, params);
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
            if (isUnitMetric(resolved.cell.lengths, resolved.cell.angles)) {
                throw new Error('Q-axis unified data needs a real parent cell to convert Q to hkl');
            }
            model = modelAxesToHkl(model, resolved.cell);
            logs.push('Converted unified Cartesian Q axes to hkl using the selected parent cell.');
        }
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
            // "i j k qx qy qz I" with 17 significant digits per number.
            const digits = model.dims.reduce((s, d) => s + String(d).length, 0);
            return n * (digits + 4 * 23 + 4);
        }
        if (format === 'vtk') return n * 23 + 512;
        return 0;
    }

    function isHdf5Signature(bytes) {
        const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return u.length >= 4 && u[0] === 0x89 && u[1] === 0x48 && u[2] === 0x44 && u[3] === 0x46;
    }

    return {
        cellToLattice, latticeToCell, reciprocalBasis, hklToQ, qToHkl, isUnitMetric, modelAxesToHkl,
        parseRmc6f, readUnifiedStructure, isHdf5Signature,
        detectH5Kind, readUnifiedData, readYell,
        parseOldDat, readOldDatStream, writeOldDat, writeOldDatChunks, countNonFinite,
        isVtk, vtkFrame, parseGridConfig, parseVtk, readVtkStream, writeVtk, writeVtkChunks,
        toHklModel, resolveCell, planConversion, estimateOutputBytes, outputDtype,
        writeUnifiedData, writeYell,
    };
}));
