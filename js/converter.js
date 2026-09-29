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
 *   values  Float64Array, h fastest: idx = (il*nk + ik)*nh + ih
 *   cellLengths/cellAngles: cell stored with the data (may be unit metric)
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

    function readDataset(ds, path) {
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

    function normalizeRadiation(value) {
        const text = String(value || '').trim().toLowerCase();
        if (!text) return 'unknown';
        if (/^x[-_ ]?rays?$/.test(text)) return 'xray';
        if (/^neutrons?$/.test(text)) return 'neutron';
        if (/^electrons?$/.test(text)) return 'electron';
        return text;
    }

    // C-order [nh,nk,nl] (l fastest) -> internal h-fastest layout.
    function lFastestToHFastest(flat, nh, nk, nl) {
        const values = new Float64Array(nh * nk * nl);
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

    function readUnifiedData(f) {
        const identity = validateUnifiedDictionary(f, 'data');
        let model = null;
        if (f.get('scattering/data/data')) model = readScatteringGroup(f);
        else if (f.get('entry/data/data_values')) model = readEntryGroup(f);
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

    function readScatteringGroup(f) {
        const g = 'scattering/data/';
        const group = f.get('scattering/data');
        const ds = f.get(g + 'data');
        const shape = Array.from(ds.shape || []).map(Number);
        if (shape.length !== 3) throw new Error('scattering data must be rank 3');
        const notes = [];
        const names = axisNamesAttr(group);
        const layout = scatteringLayout(f, g, group, names, shape, notes);
        const dims = layout === 'abs-fastest' ? [shape[2], shape[1], shape[0]] : shape.slice();
        const [nh, nk, nl] = dims;
        const raw = readDataset(ds, g + 'data');
        const values = layout === 'abs-fastest' ? Float64Array.from(raw) : lFastestToHFastest(raw, nh, nk, nl);

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

    function readEntryGroup(f) {
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
        const flat = readDataset(ds, g + 'data_values');
        const values = reversed ? Float64Array.from(flat) : lFastestToHFastest(flat, nh, nk, nl);
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
    // is_direct value that is neither 0 nor 1.
    function readYell(f, opts) {
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
        const values = lFastestToHFastest(readDataset(ds, 'data'), nh, nk, nl);
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

    function firstLineTokens(text) {
        let start = 0;
        while (start < text.length) {
            let end = text.indexOf('\n', start);
            if (end < 0) end = text.length;
            const line = text.slice(start, end).trim();
            if (line) return line.split(/\s+/);
            start = end + 1;
        }
        return [];
    }

    // Header "npoints nsec" (experimental input) or "npoints nsec scale offset"
    // (RMCProfile *_calc.dat output). Values are kept as stored.
    function parseOldDat(text, parentCell) {
        const A = cellToLattice(parentCell.lengths, parentCell.angles);
        const header = firstLineTokens(text);
        if (header.length < 2 || header.length > 4 || header.some(t => !Number.isFinite(num(t)))) {
            throw new Error('old-format .dat: unrecognized header line (expected "npoints nsec" ' +
                'or "npoints nsec scale offset")');
        }
        const tokens = text.trim().split(/\s+/);
        let p = header.length;
        const npoints = parseInt(header[0], 10);
        const nsec = parseInt(header[1], 10);
        if (!(npoints > 0) || !(nsec >= 1)) throw new Error('bad npoints/nsec header');
        const notes = [];
        let datHeader = null;
        if (header.length > 2) {
            datHeader = { scale: num(header[2]), offset: header.length > 3 ? num(header[3]) : 0 };
            notes.push(`RMCProfile calculation header: scale = ${datHeader.scale}, offset = ` +
                `${datHeader.offset}; intensities are kept as stored`);
        }
        const perRow = 3 + 3 * nsec + 1;
        if (tokens.length < p + npoints * perRow) throw new Error('old-format data file is truncated');

        const pix = new Int32Array(3 * npoints);
        const hklAll = new Float64Array(3 * npoints);
        const vals = new Float64Array(npoints);
        let dims = [0, 0, 0];
        for (let n = 0; n < npoints; n++) {
            const i = parseInt(tokens[p], 10), j = parseInt(tokens[p + 1], 10), k = parseInt(tokens[p + 2], 10);
            const q = [num(tokens[p + 3]), num(tokens[p + 4]), num(tokens[p + 5])];
            vals[n] = num(tokens[p + perRow - 1]);
            p += perRow;
            if (!(i >= 1 && j >= 1 && k >= 1)) throw new Error('pixel coordinates must be positive');
            pix[3 * n] = i; pix[3 * n + 1] = j; pix[3 * n + 2] = k;
            const hkl = qToHkl(A, q);
            hklAll[3 * n] = hkl[0]; hklAll[3 * n + 1] = hkl[1]; hklAll[3 * n + 2] = hkl[2];
            if (i > dims[0]) dims[0] = i;
            if (j > dims[1]) dims[1] = j;
            if (k > dims[2]) dims[2] = k;
        }
        if (dims[0] * dims[1] * dims[2] !== npoints) {
            throw new Error('old-format data does not cover a full pixel grid');
        }
        const [nh, nk, nl] = dims;
        const values = new Float64Array(npoints);
        let corner = null;
        const stepPix = [null, null, null];
        for (let n = 0; n < npoints; n++) {
            const i = pix[3 * n], j = pix[3 * n + 1], k = pix[3 * n + 2];
            values[((k - 1) * nk + (j - 1)) * nh + (i - 1)] = vals[n];
            const hkl = [hklAll[3 * n], hklAll[3 * n + 1], hklAll[3 * n + 2]];
            if (i === 1 && j === 1 && k === 1) corner = hkl;
            if (i === 2 && j === 1 && k === 1) stepPix[0] = hkl;
            if (i === 1 && j === 2 && k === 1) stepPix[1] = hkl;
            if (i === 1 && j === 1 && k === 2) stepPix[2] = hkl;
        }
        if (!corner) throw new Error('pixel (1,1,1) is missing');
        const vectors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let axis = 0; axis < 3; axis++) {
            if (dims[axis] > 1 && stepPix[axis]) {
                vectors[axis] = stepPix[axis].map((x, comp) => x - corner[comp]);
            }
        }
        return {
            dims, corner, vectors, values,
            cellLengths: parentCell.lengths.slice(), cellAngles: parentCell.angles.slice(),
            radiation: 'unknown',
            axes: pickAxes(vectors, dims),
            nsecOriginal: nsec,
            datHeader, notes,
        };
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

    // opts.frame: 'q' | 'hkl' (default: from the title line).
    // opts.grid:  { dims, corner, vectors } from parseGridConfig, for Q-space
    //             files whose grid axes are not along cartesian x, y, z.
    // opts.customFrame: the config redefines the cartesian frame (HKL_TO_X...).
    function parseVtk(text, parentCell, opts) {
        opts = opts || {};
        const frame = opts.frame || vtkFrame(text);
        const lines = text.split(/\r?\n/);
        if (!/^#\s*vtk/i.test((lines[0] || '').trim())) throw new Error('not a VTK file');
        let dims = null, origin = null, spacing = null, dataStart = -1;
        // line 1 is the version comment, line 2 is a free-text title
        for (let i = 2; i < lines.length; i++) {
            const tok = lines[i].trim().split(/\s+/);
            const key = (tok[0] || '').toUpperCase();
            if (key === 'BINARY') throw new Error('binary VTK is not supported (Scatty writes ASCII)');
            if (key === 'DATASET' && (tok[1] || '').toUpperCase() !== 'STRUCTURED_POINTS') {
                throw new Error('only STRUCTURED_POINTS VTK is supported');
            }
            if (key === 'DIMENSIONS') dims = tok.slice(1, 4).map(Number);
            if (key === 'ORIGIN') origin = tok.slice(1, 4).map(Number);
            if (key === 'SPACING' || key === 'ASPECT_RATIO') spacing = tok.slice(1, 4).map(Number);
            if (key === 'LOOKUP_TABLE') { dataStart = i + 1; break; }
        }
        if (!dims || !origin || !spacing || dataStart < 0) {
            throw new Error('VTK header is missing DIMENSIONS/ORIGIN/SPACING/LOOKUP_TABLE');
        }
        if (dims.some(d => !(d >= 1))) throw new Error('bad VTK dimensions');
        const [nh, nk, nl] = dims;
        const npoints = nh * nk * nl;
        const values = new Float64Array(npoints);
        let n = 0;
        for (let r = dataStart; r < lines.length && n < npoints; r++) {
            const t = lines[r].trim();
            if (t === '') continue;
            for (const s of t.split(/\s+/)) {
                if (n >= npoints) break;
                values[n++] = num(s);
            }
        }
        if (n < npoints) throw new Error(`VTK data is truncated (${n} of ${npoints} values)`);
        // VTK x-fastest point order equals the internal h-fastest layout, so
        // values copy through.
        const notes = [];
        let corner, vectors;
        if (frame === 'hkl') {
            corner = origin.slice();
            vectors = [0, 1, 2].map(axis => {
                const v = [0, 0, 0];
                if (dims[axis] > 1) v[axis] = spacing[axis];
                return v;
            });
            notes.push(`VTK "${vtkTitle(text)}" stores ORIGIN/SPACING in reciprocal-lattice units; ` +
                'read without a Q conversion');
        } else {
            if (!parentCell) throw new Error('Q-space VTK input needs the parent cell');
            // ORIGIN/SPACING are cartesian Q (2*pi/Angstrom).
            const A = cellToLattice(parentCell.lengths, parentCell.angles);
            if (opts.grid) {
                const grid = opts.grid;
                if (grid.dims.some((d, i) => d !== dims[i])) {
                    throw new Error(`grid config describes ${grid.dims.join(' x ')} points but the VTK ` +
                        `has ${dims.join(' x ')}`);
                }
                corner = grid.corner.slice();
                vectors = grid.vectors.map(v => v.slice());
                if (opts.customFrame) {
                    notes.push('the config redefines the cartesian frame (HKL_TO_X/Y/Z); ' +
                        'VTK ORIGIN/SPACING were not cross-checked');
                } else {
                    // The header is written with 6 decimals (3f12.6).
                    const B = reciprocalBasis(A);
                    const off = (a, b) => Math.abs(a - b) > 5e-6 + 2e-5 * Math.abs(b);
                    const q0 = hklToQ(B, corner);
                    const qStep = vectors.map(v => Math.hypot(...hklToQ(B, v)));
                    if (q0.some((x, i) => off(x, origin[i])) ||
                        qStep.some((x, i) => dims[i] > 1 && off(x, spacing[i]))) {
                        notes.push('warning: VTK ORIGIN/SPACING differ from the grid config at this cell ' +
                            `(expected ORIGIN ${q0.map(x => x.toFixed(6)).join(' ')}, SPACING ` +
                            `${qStep.map(x => x.toFixed(6)).join(' ')}); check the config and the cell`);
                    }
                }
            } else {
                corner = qToHkl(A, origin);
                vectors = [0, 1, 2].map(axis => {
                    if (dims[axis] <= 1 || spacing[axis] === 0) return [0, 0, 0];
                    const q = [0, 0, 0];
                    q[axis] = spacing[axis];
                    return qToHkl(A, q);
                });
                notes.push('VTK stores no axis directions: grid axes assumed along cartesian x, y, z. ' +
                    'For Scatty/Spinteract grids with rotated axes (e.g. X_AXIS 6 6 0), load the config file');
            }
        }
        const cell = parentCell || { lengths: [1, 1, 1], angles: [90, 90, 90] };
        return {
            dims, corner, vectors, values,
            cellLengths: cell.lengths.slice(), cellAngles: cell.angles.slice(),
            radiation: 'unknown', axes: pickAxes(vectors, dims), notes,
        };
    }

    function writeVtk(model, cell) {
        const A = cellToLattice(cell.lengths, cell.angles);
        const B = reciprocalBasis(A);
        const [nh, nk, nl] = model.dims;
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
        const out = [
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
        ];
        // Legacy VTK readers do not parse NaN; empty points are 0 as in Scatty.
        for (let n = 0; n < model.values.length; n++) {
            const v = model.values[n];
            out.push((Number.isFinite(v) ? v : 0).toExponential(16));
        }
        return out.join('\n') + '\n';
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

    function writeUnifiedData(f, model, cell, meta) {
        meta = meta || {};
        if (model.axesType && model.axesType !== 'hkl') {
            throw new Error('unified writer requires hkl axes; convert Q axes with modelAxesToHkl first');
        }
        const [nh, nk, nl] = model.dims;
        const names = axisNames(model);
        const today = new Date().toISOString().slice(0, 10);
        const method = meta.creationMethod || 'RMCProfile web format converter';
        const author = meta.authorName || 'RMCProfile';
        const radiation = model.radiation && model.radiation !== '' ? model.radiation : 'unknown';

        // ---- /scattering/data (NXdata compatibility layout) ----
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
        sd.create_dataset({ name: 'data', data: model.values, shape: [nl, nk, nh], dtype: '<d' });
        sd.create_dataset({ name: 'unit_cell_lengths', data: cell.lengths, shape: [3], dtype: '<d' });
        sd.create_dataset({ name: 'unit_cell_angles', data: cell.angles, shape: [3], dtype: '<d' });
        sd.create_dataset({ name: 'data_rad_length', data: [0, 0, 0], shape: [3], dtype: '<d' });

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
        const lv = new Float64Array(nh * nk * nl);   // l fastest
        for (let il = 0; il < nl; il++)
            for (let ik = 0; ik < nk; ik++)
                for (let ih = 0; ih < nh; ih++)
                    lv[(ih * nk + ik) * nl + il] = model.values[(il * nk + ik) * nh + ih];
        eds('data_values', { data: lv, shape: [nh, nk, nl], dtype: '<d' });
        eds('audit_conform_dict_name', fixedStr(UNIFIED_DATA_DICTIONARY));
        eds('audit_conform_dict_version', fixedStr('0.0.0'));
        eds('audit_creation_date', fixedStr(today));
        eds('audit_creation_method', fixedStr(method));
        eds('audit_author_name', fixedStr(author));
    }

    function writeYell(f, model, cell) {
        const [nh, nk, nl] = model.dims;
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
        const lv = new Float64Array(nh * nk * nl);   // l fastest, h slowest
        for (let il = 0; il < nl; il++)
            for (let ik = 0; ik < nk; ik++)
                for (let ih = 0; ih < nh; ih++)
                    lv[(ih * nk + ik) * nl + il] = model.values[(il * nk + ik) * nh + ih];
        f.create_dataset({ name: 'data', data: lv, shape: [nh, nk, nl], dtype: '<d' });
    }

    return {
        cellToLattice, latticeToCell, reciprocalBasis, hklToQ, qToHkl, isUnitMetric, modelAxesToHkl,
        parseRmc6f, readUnifiedStructure,
        detectH5Kind, readUnifiedData, readYell,
        parseOldDat, writeOldDat, writeOldDatChunks, countNonFinite,
        isVtk, vtkFrame, parseGridConfig, parseVtk, writeVtk,
        writeUnifiedData, writeYell,
    };
}));
