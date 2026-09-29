/*
 * Processing steps for diffuse-scattering models (see js/converter.js for
 * the model): crop, resample, rebin, masks, scaling, backgrounds,
 * combination with other volumes and Laue symmetrization. A recipe is plain
 * JSON so it can be saved, reloaded and recorded with the output:
 *
 *   { "version": 1, "steps": [ { "op": "crop", "h": [-6, 6] }, ... ] }
 *
 * Steps never modify their input model; NaN marks masked or missing voxels.
 * model.sigma, when present, holds the standard uncertainty of each value;
 * steps propagate it (or drop it where it has no meaning, e.g. a 3D-ΔPDF).
 * |Q| is Cartesian in 1/Angstrom with the 2*pi convention, q = 2*pi * B * hkl.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./converter.js'));
    } else {
        root.Processing = factory(root.Converter);
        // index.html rebuilds the module inside its Web Worker from this source.
        root.ProcessingFactory = factory;
    }
}(typeof self !== 'undefined' ? self : this, function (Converter) {
    'use strict';

    const voxelCount = m => m.dims[0] * m.dims[1] * m.dims[2];

    // ---------------------------------------------------------------- geometry

    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const mulMV = (M, v) => [0, 1, 2].map(r => M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2]);
    const mulMM = (A, B) => [0, 1, 2].map(r => [0, 1, 2].map(c =>
        A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c]));
    const transpose = M => [0, 1, 2].map(r => [0, 1, 2].map(c => M[c][r]));

    function invert3(M) {
        const c0 = [M[0][0], M[1][0], M[2][0]], c1 = [M[0][1], M[1][1], M[2][1]], c2 = [M[0][2], M[1][2], M[2][2]];
        const r0 = cross(c1, c2), r1 = cross(c2, c0), r2 = cross(c0, c1);
        const det = dot(c0, r0);
        if (!(Math.abs(det) > 1e-300)) throw new Error('singular grid');
        return [r0, r1, r2].map(r => r.map(x => x / det));
    }

    // Columns are the step vectors. A single-point axis gets a unit vector
    // perpendicular to the others, so the matrix stays invertible and points
    // off the grid plane map to non-zero indices along it.
    function gridMatrix(model) {
        const cols = model.vectors.map((v, a) => (model.dims[a] > 1 && v.some(x => x !== 0) ? v.slice() : null));
        const unit = c => [0, 1, 2].map(i => (i === c ? 1 : 0));
        for (let a = 0; a < 3; a++) {
            if (cols[a]) continue;
            const others = cols.filter(Boolean);
            let n = null;
            if (others.length === 2) n = cross(others[0], others[1]);
            else if (others.length === 1) {
                const o = others[0];
                const e = [0, 1, 2].map(unit).sort((p, q) => Math.abs(dot(p, o)) - Math.abs(dot(q, o)))[0];
                n = cross(o, e);
            } else n = unit(a);
            const len = Math.hypot(n[0], n[1], n[2]);
            cols[a] = n.map(x => x / len);
        }
        return [0, 1, 2].map(r => [cols[0][r], cols[1][r], cols[2][r]]);
    }

    // 2*pi*B: hkl -> Cartesian q.
    function qMatrix(cell) {
        const B = Converter.reciprocalBasis(Converter.cellToLattice(cell.lengths, cell.angles));
        return B.map(row => row.map(x => 2 * Math.PI * x));
    }

    function needCell(cell, what) {
        if (!cell || Converter.isUnitMetric(cell.lengths, cell.angles)) {
            throw new Error(`${what} needs the parent cell (supply a structure file or a manual cell)`);
        }
    }

    // Call fn(index, h, k, l) for every voxel, in storage order.
    function forEachHkl(model, fn) {
        const [nh, nk, nl] = model.dims;
        const [va, vb, vc] = model.vectors;
        const c = model.corner;
        let n = 0;
        for (let il = 0; il < nl; il++) {
            for (let ik = 0; ik < nk; ik++) {
                let h = c[0] + ik * vb[0] + il * vc[0];
                let k = c[1] + ik * vb[1] + il * vc[1];
                let l = c[2] + ik * vb[2] + il * vc[2];
                for (let ih = 0; ih < nh; ih++) {
                    fn(n++, h, k, l);
                    h += va[0]; k += va[1]; l += va[2];
                }
            }
        }
    }

    // Call fn(index, |q|) for every voxel.
    function forEachQ(model, cell, fn) {
        const Q = qMatrix(cell);
        const q0 = mulMV(Q, model.corner);
        const [qa, qb, qc] = model.vectors.map(v => mulMV(Q, v));
        const [nh, nk, nl] = model.dims;
        let n = 0;
        for (let il = 0; il < nl; il++) {
            for (let ik = 0; ik < nk; ik++) {
                let x = q0[0] + ik * qb[0] + il * qc[0];
                let y = q0[1] + ik * qb[1] + il * qc[1];
                let z = q0[2] + ik * qb[2] + il * qc[2];
                for (let ih = 0; ih < nh; ih++) {
                    fn(n++, Math.sqrt(x * x + y * y + z * z));
                    x += qa[0]; y += qa[1]; z += qa[2];
                }
            }
        }
    }

    function withValues(model, values, changes) {
        return Object.assign({}, model, { values }, changes || {});
    }

    function copyValues(model) {
        return model.values instanceof Float32Array ? Float32Array.from(model.values) : Float64Array.from(model.values);
    }

    function newValues(model, n) {
        return model.values instanceof Float32Array ? new Float32Array(n) : new Float64Array(n);
    }

    // Sub-grid for index ranges lo..hi (inclusive) per axis.
    function subgrid(model, lo, hi) {
        const dims = [0, 1, 2].map(a => hi[a] - lo[a] + 1);
        const [nh, nk] = model.dims;
        const cut = src => {
            const out = newValues(model, dims[0] * dims[1] * dims[2]);
            let n = 0;
            for (let il = lo[2]; il <= hi[2]; il++)
                for (let ik = lo[1]; ik <= hi[1]; ik++) {
                    const base = (il * nk + ik) * nh;
                    for (let ih = lo[0]; ih <= hi[0]; ih++) out[n++] = src[base + ih];
                }
            return out;
        };
        const corner = [0, 1, 2].map(c => model.corner[c] + lo[0] * model.vectors[0][c] +
            lo[1] * model.vectors[1][c] + lo[2] * model.vectors[2][c]);
        return withValues(model, cut(model.values), {
            dims, corner, vectors: model.vectors.map((v, a) => (dims[a] > 1 ? v.slice() : [0, 0, 0])),
            sigma: model.sigma ? cut(model.sigma) : undefined,
        });
    }

    // NaN-aware trilinear sampling of `model` at hkl points. Returns a
    // function (h, k, l) -> value; a point needs neighbours carrying at least
    // half of the interpolation weight.
    function sampler(model) {
        const Minv = invert3(gridMatrix(model));
        const [nh, nk, nl] = model.dims;
        const flat = model.dims.map(n => n <= 1);
        const v = model.values;
        const c = model.corner;
        return (h, k, l) => {
            const d = [h - c[0], k - c[1], l - c[2]];
            const f = mulMV(Minv, d);
            const i0 = [0, 0, 0], w1 = [0, 0, 0];
            for (let a = 0; a < 3; a++) {
                const n = model.dims[a];
                if (flat[a]) {
                    if (Math.abs(f[a]) > 1e-6) return NaN;
                    continue;
                }
                if (f[a] < -1e-9 || f[a] > n - 1 + 1e-9) return NaN;
                let i = Math.floor(f[a]);
                if (i >= n - 1) i = n - 2;
                if (i < 0) i = 0;
                i0[a] = i;
                w1[a] = Math.min(1, Math.max(0, f[a] - i));
            }
            let sum = 0, weight = 0;
            for (let dl = 0; dl < (flat[2] ? 1 : 2); dl++)
                for (let dk = 0; dk < (flat[1] ? 1 : 2); dk++)
                    for (let dh = 0; dh < (flat[0] ? 1 : 2); dh++) {
                        const w = (flat[0] ? 1 : dh ? w1[0] : 1 - w1[0]) *
                                  (flat[1] ? 1 : dk ? w1[1] : 1 - w1[1]) *
                                  (flat[2] ? 1 : dl ? w1[2] : 1 - w1[2]);
                        if (w === 0) continue;
                        const x = v[((i0[2] + dl) * nk + (i0[1] + dk)) * nh + i0[0] + dh];
                        if (x === x) {
                            sum += w * x;
                            weight += w;
                        }
                    }
            return weight >= 0.5 ? sum / weight : NaN;
        };
    }

    function sameGrid(a, b) {
        const close = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
        return a.dims.every((n, i) => n === b.dims[i]) &&
            a.corner.every((x, i) => close(x, b.corner[i])) &&
            a.vectors.every((v, i) => v.every((x, j) => close(x, b.vectors[i][j])));
    }

    // ----------------------------------------------------------- Laue groups

    // Direct-space generators (fractional coordinates, standard settings;
    // hexagonal axes for the trigonal groups). The inversion is added to all.
    const LAUE_GENERATORS = {
        '-1': [],
        '2/m': [[[-1, 0, 0], [0, 1, 0], [0, 0, -1]]],
        'mmm': [[[-1, 0, 0], [0, -1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]]],
        '4/m': [[[0, -1, 0], [1, 0, 0], [0, 0, 1]]],
        '4/mmm': [[[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, -1, 0], [0, 0, -1]]],
        '-3': [[[0, -1, 0], [1, -1, 0], [0, 0, 1]]],
        '-3m1': [[[0, -1, 0], [1, -1, 0], [0, 0, 1]], [[1, -1, 0], [0, -1, 0], [0, 0, -1]]],
        '-31m': [[[0, -1, 0], [1, -1, 0], [0, 0, 1]], [[0, -1, 0], [-1, 0, 0], [0, 0, -1]]],
        '6/m': [[[1, -1, 0], [1, 0, 0], [0, 0, 1]]],
        '6/mmm': [[[1, -1, 0], [1, 0, 0], [0, 0, 1]], [[1, -1, 0], [0, -1, 0], [0, 0, -1]]],
        'm-3': [[[-1, 0, 0], [0, -1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
            [[0, 0, 1], [1, 0, 0], [0, 1, 0]]],
        'm-3m': [[[-1, 0, 0], [0, -1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
            [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]]],
    };
    const LAUE_GROUPS = Object.keys(LAUE_GENERATORS);

    const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const INVERSION = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
    const matrixKey = M => M.flat().join(',');

    // Every product of the generators.
    function closure(gens) {
        const found = new Map([[matrixKey(IDENTITY), IDENTITY]]);
        let frontier = [IDENTITY];
        while (frontier.length) {
            const next = [];
            for (const A of frontier) {
                for (const G of gens) {
                    const P = mulMM(A, G), k = matrixKey(P);
                    if (!found.has(k)) {
                        found.set(k, P);
                        next.push(P);
                    }
                }
            }
            frontier = next;
        }
        return [...found.values()];
    }

    // The generators acting on hkl (space 'reciprocal': R^T for every
    // direct-space operation R; R^-T runs over the same set) or on direct-
    // space coordinates such as the u, v, w of a 3D-ΔPDF ('direct': R).
    function laueGenerators(name, space) {
        const gens = LAUE_GENERATORS[name];
        if (!gens) throw new Error(`unknown Laue group ${name} (use one of ${LAUE_GROUPS.join(', ')})`);
        return gens.concat([INVERSION]).map(g => (space === 'direct' ? g : transpose(g)));
    }

    function laueOperations(name, space) {
        return closure(laueGenerators(name, space));
    }

    // Right-coset transversals down the chain of subgroups made by adding one
    // generator at a time: every operation is t1 t2 ... tm, one t from each
    // list, in exactly one way, so sums over the group can run level by level.
    function laueChain(name, space) {
        const gens = laueGenerators(name, space);
        const chain = [];
        let H = [IDENTITY];
        for (let k = 1; k <= gens.length; k++) {
            const next = closure(gens.slice(0, k));
            if (next.length === H.length) continue;
            const inH = new Set(H.map(matrixKey));
            const reps = [];
            for (const x of next) {
                if (!reps.some(t => inH.has(matrixKey(mulMM(x, invert3(t).map(r => r.map(Math.round))))))) reps.push(x);
            }
            chain.push(reps);
            H = next;
        }
        return chain;
    }

    // ------------------------------------------------------------------ steps

    const DEFAULTS = {
        maskBragg: { shape: 'box', centring: 'P' },
        maskRings: { q: [], powder: 'none' },
        maskRange: {},
        scale: { factor: 1, offset: 0, positive: false },
        backgroundShells: { percentile: 0, smooth: 0 },
        combine: { scale: 1 },
        clip: { below: 0, to: 0 },
        symmetrize: { mode: 'average', expand: true, k: 3 },
        removeRings: {
            materials: 'aluminium', radiation: 'auto', intensities: 'free', refine: 0.01, fitWidth: true, sigma0: 0.005, resolution: 0.004,
            width: 0.005, cutoff: 0.05, highPass: 6, sectors: 8, coverage: 0.25, positive: true,
        },
        backgroundDebyeWaller: { radiation: 'auto', uiso: '0.01', fit: true, scale: 1, offset: false, percentile: 5, width: 0.05 },
        correctUB: { mode: 'refine', centring: 'P', radius: 0.25, snr: 10, peaks: 300, shift: false },
        despike: { size: 1, k: 5 },
        window: { kind: 'lorch', qmax: 0 },
        maskQ: {},
        deltaPdf: { taper: 0, engine: 'cpu', fill: 0 },
        normalize: { background: '', backgroundNorm: '', scale: 1, fitScale: false, laue: 'none' },
    };

    function stepCrop(model, step) {
        const axisOf = [-1, -1, -1];
        for (let a = 0; a < 3; a++) {
            if (model.dims[a] <= 1) continue;
            const v = model.vectors[a];
            const big = Math.max(...v.map(Math.abs));
            const nz = [0, 1, 2].filter(c => Math.abs(v[c]) > 1e-9 * big);
            if (nz.length !== 1) {
                throw new Error('crop needs grid axes along h, k and l; use "resample" for this grid');
            }
            axisOf[nz[0]] = a;
        }
        const lo = [0, 0, 0], hi = model.dims.map(n => n - 1);
        ['h', 'k', 'l'].forEach((name, c) => {
            const r = step[name];
            if (!r) return;
            const [min, max] = r;
            const a = axisOf[c];
            if (a < 0) {
                const x = model.corner[c];
                if (x < min - 1e-9 || x > max + 1e-9) throw new Error(`crop: the grid has ${name} = ${x}, outside ${min}..${max}`);
                return;
            }
            const s = model.vectors[a][c], c0 = model.corner[c];
            let i0 = (min - c0) / s, i1 = (max - c0) / s;
            if (s < 0) [i0, i1] = [i1, i0];
            lo[a] = Math.max(lo[a], Math.ceil(i0 - 1e-6));
            hi[a] = Math.min(hi[a], Math.floor(i1 + 1e-6));
            if (lo[a] > hi[a]) throw new Error(`crop: no grid points with ${name} in ${min}..${max}`);
        });
        return subgrid(model, lo, hi);
    }

    // Onto the axis-aligned grid h = min..max in steps (likewise k, l).
    async function stepResample(model, step, ctx) {
        const axes = ['h', 'k', 'l'].map(name => {
            const [min, max, size] = step[name];
            const n = size > 0 ? Math.round((max - min) / size) + 1 : 1;
            if (!(n >= 1 && n <= 5000)) throw new Error(`resample: ${name} ${min}..${max} in steps of ${size} gives ${n} points`);
            return { min, size: n > 1 ? size : 0, n };
        });
        const dims = axes.map(a => a.n);
        const sample = sampler(model);
        const sampleSigma = model.sigma ? sampler(Object.assign({}, model, { values: model.sigma })) : null;
        const out = newValues(model, dims[0] * dims[1] * dims[2]);
        const sig = sampleSigma ? newValues(model, out.length) : undefined;
        let n = 0;
        for (let il = 0; il < dims[2]; il++) {
            const l = axes[2].min + il * axes[2].size;
            for (let ik = 0; ik < dims[1]; ik++) {
                const k = axes[1].min + ik * axes[1].size;
                for (let ih = 0; ih < dims[0]; ih++, n++) {
                    const h = axes[0].min + ih * axes[0].size;
                    out[n] = sample(h, k, l);
                    if (sig) sig[n] = sampleSigma(h, k, l);
                }
            }
            if (ctx.tick) await ctx.tick();
        }
        const vectors = [[axes[0].size, 0, 0], [0, axes[1].size, 0], [0, 0, axes[2].size]];
        return withValues(model, out, { dims, corner: axes.map(a => a.min), vectors, axes: [1, 2, 3], sigma: sig });
    }

    function stepRebin(model, step) {
        const f = step.factors.map(x => Math.max(1, Math.round(x)));
        const dims = model.dims.map((n, a) => Math.max(1, Math.floor(n / f[a])));
        const [nh, nk] = model.dims;
        const out = newValues(model, dims[0] * dims[1] * dims[2]);
        const sig = model.sigma ? newValues(model, out.length) : undefined;
        let n = 0;
        for (let bl = 0; bl < dims[2]; bl++)
            for (let bk = 0; bk < dims[1]; bk++)
                for (let bh = 0; bh < dims[0]; bh++, n++) {
                    let sum = 0, cnt = 0, var2 = 0;
                    for (let il = bl * f[2]; il < (bl + 1) * f[2] && il < model.dims[2]; il++)
                        for (let ik = bk * f[1]; ik < (bk + 1) * f[1] && ik < nk; ik++)
                            for (let ih = bh * f[0]; ih < (bh + 1) * f[0] && ih < nh; ih++) {
                                const at = (il * nk + ik) * nh + ih, x = model.values[at];
                                if (x === x) {
                                    sum += x;
                                    cnt++;
                                    if (sig) var2 += model.sigma[at] * model.sigma[at];
                                }
                            }
                    out[n] = cnt ? sum / cnt : NaN;
                    if (sig) sig[n] = cnt ? Math.sqrt(var2) / cnt : NaN;
                }
        const shift = [0, 1, 2].map(c => model.vectors.reduce((s, v, a) => s + (f[a] - 1) / 2 * v[c], 0));
        return withValues(model, out, {
            dims,
            corner: model.corner.map((x, c) => x + shift[c]),
            vectors: model.vectors.map((v, a) => (dims[a] > 1 ? v.map(x => x * f[a]) : [0, 0, 0])),
            sigma: sig,
        });
    }

    const CENTRING = {
        P: () => true,
        I: (h, k, l) => (h + k + l) % 2 === 0,
        F: (h, k, l) => ((h - k) % 2 === 0) && ((k - l) % 2 === 0),
        C: (h, k) => (h + k) % 2 === 0,
        A: (h, k, l) => (k + l) % 2 === 0,
        B: (h, k, l) => (h + l) % 2 === 0,
        R: (h, k, l) => ((-h + k + l) % 3 + 3) % 3 === 0,
    };

    function stepMaskBragg(model, step, ctx) {
        const allowed = CENTRING[step.centring];
        if (!allowed) throw new Error(`maskBragg: unknown centring ${step.centring}`);
        const values = copyValues(model);
        let masked = 0;
        if (step.shape === 'sphere') {
            needCell(ctx.cell, 'a spherical Bragg mask');
            const Q = qMatrix(ctx.cell);
            const r2 = step.size * step.size;
            forEachHkl(model, (i, h, k, l) => {
                const H = Math.round(h), K = Math.round(k), L = Math.round(l);
                if (!allowed(H, K, L)) return;
                const q = mulMV(Q, [h - H, k - K, l - L]);
                if (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] <= r2 && values[i] === values[i]) {
                    values[i] = NaN;
                    masked++;
                }
            });
        } else if (step.shape === 'box') {
            const s = step.size + 1e-9;
            forEachHkl(model, (i, h, k, l) => {
                const H = Math.round(h), K = Math.round(k), L = Math.round(l);
                if (Math.abs(h - H) <= s && Math.abs(k - K) <= s && Math.abs(l - L) <= s &&
                    allowed(H, K, L) && values[i] === values[i]) {
                    values[i] = NaN;
                    masked++;
                }
            });
        } else {
            throw new Error(`maskBragg: shape must be box or sphere, not ${step.shape}`);
        }
        ctx.log(`${masked} voxels masked`);
        return withValues(model, values);
    }

    // Sample-holder metals: cubic lattice and room-temperature a (Angstrom).
    const POWDER = { aluminium: { lattice: 'fcc', a: 4.0495 }, copper: { lattice: 'fcc', a: 3.6149 }, vanadium: { lattice: 'bcc', a: 3.024 } };

    // |Q| of the powder lines of `name` up to qmax: fcc lines have h, k, l all
    // odd or all even, bcc ones h + k + l even; Q = 2 pi sqrt(h^2+k^2+l^2) / a.
    function powderLines(name, a, qmax) {
        const p = POWDER[name];
        if (!p) throw new Error(`maskRings: unknown powder ${name}`);
        const A = a > 0 ? a : p.a, nmax = Math.floor((qmax * A / (2 * Math.PI)) ** 2);
        const found = new Set(), top = Math.ceil(Math.sqrt(nmax));
        for (let h = 0; h <= top; h++) for (let k = 0; k <= h; k++) for (let l = 0; l <= k; l++) {
            const n = h * h + k * k + l * l;
            if (!n || n > nmax) continue;
            if (p.lattice === 'fcc' ? h % 2 === k % 2 && k % 2 === l % 2 : (h + k + l) % 2 === 0) found.add(n);
        }
        return [...found].sort((x, y) => x - y).map(n => 2 * Math.PI * Math.sqrt(n) / A);
    }

    function stepMaskRings(model, step, ctx) {
        needCell(ctx.cell, 'a powder-ring mask');
        let qmax = 0;                                    // |Q| is largest at a corner of the grid
        const Q = qMatrix(ctx.cell), [nh, nk, nl] = model.dims;
        for (const i of [0, nh - 1]) for (const j of [0, nk - 1]) for (const k of [0, nl - 1]) {
            const hkl = [0, 1, 2].map(c => model.corner[c] + i * model.vectors[0][c] + j * model.vectors[1][c] + k * model.vectors[2][c]);
            qmax = Math.max(qmax, Math.hypot(...mulMV(Q, hkl)));
        }
        const lines = step.powder && step.powder !== 'none' ? powderLines(step.powder, step.a, qmax + step.width) : [];
        if (lines.length) ctx.log(`${lines.length} ${step.powder} lines up to |Q| ${qmax.toFixed(2)} 1/A`);
        const rings = (step.q || []).concat(lines).sort((a, b) => a - b);
        if (!rings.length) throw new Error('maskRings: no rings - give their |Q| or a powder');
        const values = copyValues(model);
        let masked = 0;
        forEachQ(model, ctx.cell, (i, q) => {
            for (const r of rings) {
                if (Math.abs(q - r) <= step.width) {
                    if (values[i] === values[i]) masked++;
                    values[i] = NaN;
                    break;
                }
                if (r > q + step.width) break;
            }
        });
        ctx.log(`${masked} voxels masked`);
        return withValues(model, values);
    }

    function stepMaskRange(model, step, ctx) {
        const values = copyValues(model);
        const lo = step.min === undefined ? -Infinity : step.min;
        const hi = step.max === undefined ? Infinity : step.max;
        let masked = 0;
        for (let i = 0; i < values.length; i++) {
            if (values[i] < lo || values[i] > hi) {
                values[i] = NaN;
                masked++;
            }
        }
        ctx.log(`${masked} voxels masked`);
        return withValues(model, values);
    }

    // I * factor + offset; `positive` then shifts the values up by 1.01 x the
    // lowest one when that is negative, so no voxel is 0 or below (RMCProfile
    // reads I = 0 as a masked point).
    function stepScale(model, step, ctx) {
        const values = copyValues(model);
        for (let i = 0; i < values.length; i++) values[i] = values[i] * step.factor + step.offset;
        if (step.positive) {
            let min = Infinity;
            for (let i = 0; i < values.length; i++) if (values[i] < min) min = values[i];
            if (min < 0) {
                const shift = -1.01 * min;
                for (let i = 0; i < values.length; i++) values[i] += shift;
                if (ctx) ctx.log(`shifted up by ${+shift.toPrecision(6)}, 1.01 x the lowest value`);
            }
        }
        let sigma = model.sigma;
        if (sigma) {
            sigma = model.sigma.slice();
            const f = Math.abs(step.factor);
            for (let i = 0; i < sigma.length; i++) sigma[i] *= f;
        }
        return withValues(model, values, { sigma });
    }

    // B(|Q|) as a function: constant [c], linear [a, b] (a + b Q),
    // exponential [a, b, c] (a - b c^Q) or table [[Q, B], ...] (linear, flat
    // beyond the ends; two rows at the same |Q| make a step there).
    function backgroundCurve(kind, params) {
        if (kind === 'constant') return () => params[0];
        if (kind === 'linear') return q => params[0] + params[1] * q;
        if (kind === 'exponential') return q => params[0] - params[1] * Math.pow(params[2], q);
        if (kind === 'table') {
            const t = params.slice().sort((a, b) => a[0] - b[0]);      // stable: a step keeps its order
            return q => {
                if (q < t[0][0]) return t[0][1];
                for (let i = 1; i < t.length; i++) {
                    if (q < t[i][0] || (q === t[i][0] && !(i + 1 < t.length && t[i + 1][0] === q))) {
                        const d = t[i][0] - t[i - 1][0];
                        return d > 0 ? t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (q - t[i - 1][0]) / d : t[i][1];
                    }
                }
                return t[t.length - 1][1];
            };
        }
        throw new Error(`background: unknown kind ${kind}`);
    }

    function subtractCurve(model, cell, curve) {
        const values = copyValues(model);
        forEachQ(model, cell, (i, q) => { values[i] -= curve(q); });
        return withValues(model, values);
    }

    function stepBackgroundFunction(model, step, ctx) {
        needCell(ctx.cell, 'an isotropic background');
        return subtractCurve(model, ctx.cell, backgroundCurve(step.kind, step.params));
    }

    // Per-shell minimum (percentile 0) or percentile of the finite values,
    // optionally smoothed over neighbouring shells, then subtracted with
    // linear interpolation between shell centres.
    function stepBackgroundShells(model, step, ctx) {
        needCell(ctx.cell, 'a background from |Q| shells');
        const w = step.width;
        const shell = new Int32Array(model.values.length).fill(-1);
        let nShells = 0;
        forEachQ(model, ctx.cell, (i, q) => {
            if (model.values[i] === model.values[i]) {
                shell[i] = Math.floor(q / w);
                if (shell[i] + 1 > nShells) nShells = shell[i] + 1;
            }
        });
        const counts = new Int32Array(nShells + 1);
        for (let i = 0; i < shell.length; i++) if (shell[i] >= 0) counts[shell[i] + 1]++;
        for (let s = 0; s < nShells; s++) counts[s + 1] += counts[s];
        const sorted = new Float64Array(counts[nShells]);
        const fill = counts.slice(0, nShells);
        for (let i = 0; i < shell.length; i++) if (shell[i] >= 0) sorted[fill[shell[i]]++] = model.values[i];
        const level = new Float64Array(nShells).fill(NaN);
        for (let s = 0; s < nShells; s++) {
            const part = sorted.subarray(counts[s], counts[s + 1]).sort();
            if (!part.length) continue;
            const p = Math.min(1, Math.max(0, step.percentile / 100)) * (part.length - 1);
            const lo = Math.floor(p);
            level[s] = part[lo] + (p - lo) * ((part[Math.min(part.length - 1, lo + 1)]) - part[lo]);
        }
        const smooth = Math.max(0, Math.round(step.smooth));
        const table = [];
        for (let s = 0; s < nShells; s++) {
            let sum = 0, cnt = 0;
            for (let t = s - smooth; t <= s + smooth; t++) {
                if (t >= 0 && t < nShells && level[t] === level[t]) {
                    sum += level[t];
                    cnt++;
                }
            }
            if (level[s] === level[s] && cnt) table.push([(s + 0.5) * w, sum / cnt]);
        }
        if (!table.length) throw new Error('background: no finite values to estimate from');
        const every = Math.max(1, Math.floor(table.length / 6));
        ctx.log('B(|Q|) at ' + table.filter((_, i) => i % every === 0)
            .map(([q, b]) => `${q.toFixed(2)}: ${b.toPrecision(4)}`).join(', '));
        return subtractCurve(model, ctx.cell, backgroundCurve('table', table));
    }

    // In-place radix-2 FFT of interleaved complex data (length a power of 2).
    function fft1(re, im, inverse) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let j = 0; j < len / 2; j++) {
                    const a = i + j, b = a + len / 2;
                    const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                    const t = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = t;
                }
            }
        }
        if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }

    // Gaussian low-pass of a profile sampled every `step`, sigma in the same
    // units, as a product in Fourier space. The straight line between the
    // end values is taken out first and the rest mirrored at the ends, so
    // nothing wraps round and a sloping profile keeps its ends.
    function lowPass(p, step, sigma) {
        const n = p.length;
        const trend = i => (n > 1 ? p[0] + (p[n - 1] - p[0]) * i / (n - 1) : p[0]);
        let L = 1;
        while (L < 2 * n) L <<= 1;
        const re = new Float64Array(L), im = new Float64Array(L);
        for (let i = 0; i < L; i++) {
            const j = i < n ? i : i < 2 * n ? 2 * n - 1 - i : -1;
            re[i] = j < 0 ? 0 : p[j] - trend(j);
        }
        fft1(re, im, false);
        const s = sigma / step;
        for (let k = 0; k < L; k++) {
            const f = Math.min(k, L - k) / L;                    // cycles per sample
            const g = Math.exp(-2 * Math.PI * Math.PI * s * s * f * f);
            re[k] *= g;
            im[k] *= g;
        }
        fft1(re, im, true);
        return Float64Array.from({ length: n }, (_, i) => re[i] + trend(i));
    }

    // Unit directions spread evenly over the sphere (a Fibonacci lattice).
    function sphereDirections(n) {
        const out = [], golden = Math.PI * (3 - Math.sqrt(5));
        for (let i = 0; i < n; i++) {
            const z = 1 - (2 * i + 1) / n, r = Math.sqrt(1 - z * z), t = golden * i;
            out.push([r * Math.cos(t), r * Math.sin(t), z]);
        }
        return out;
    }

    // |Q| of every voxel, its direction sector and |Q| bin (-1 when empty),
    // and per (sector, bin) the median of the values with its uncertainty
    // (1.2533 x 1.4826 x MAD / sqrt(n)); a bin with less than `coverage` of
    // its shell measured keeps its median but no uncertainty (it is not
    // judged). profile(s) gives { level, err } of sector s, or of whole
    // shells with s = -1. The bins are `width` wide in |Q|, or of equal width
    // du in a coordinate u(|Q|) (`coord`: { u, q, du }, q its inverse).
    function ringProfiles(model, cell, step, coord) {
        const w = step.width, nsec = Math.max(1, Math.round(step.sectors));
        const binOf = coord ? q => Math.floor(coord.u(q) / coord.du) : q => Math.floor(q / w);
        const centre = coord ? b => coord.q((b + 0.5) * coord.du) : b => (b + 0.5) * w;
        const binWidth = coord ? b => coord.q((b + 1) * coord.du) - coord.q(b * coord.du) : () => w;
        const Q = qMatrix(cell), dirs = nsec > 1 ? sphereDirections(nsec) : null;
        const N = voxelCount(model), v = model.values;
        const bin = new Int32Array(N).fill(-1), sec = nsec > 1 ? new Uint16Array(N) : null, qs = new Float32Array(N);
        const q0 = mulMV(Q, model.corner), [qa, qb, qc] = model.vectors.map(u => mulMV(Q, u));
        const [nh, nk, nl] = model.dims;
        let nb = 0, i = 0;
        for (let il = 0; il < nl; il++)
            for (let ik = 0; ik < nk; ik++)
                for (let ih = 0; ih < nh; ih++, i++) {
                    const x = q0[0] + ih * qa[0] + ik * qb[0] + il * qc[0];
                    const y = q0[1] + ih * qa[1] + ik * qb[1] + il * qc[1];
                    const z = q0[2] + ih * qa[2] + ik * qb[2] + il * qc[2];
                    const q = Math.sqrt(x * x + y * y + z * z);
                    qs[i] = q;
                    if (sec && q > 0) {
                        let best = 0, bd = -2;
                        for (let d = 0; d < nsec; d++) {
                            const c = (dirs[d][0] * x + dirs[d][1] * y + dirs[d][2] * z) / q;
                            if (c > bd) { bd = c; best = d; }
                        }
                        sec[i] = best;
                    }
                    if (v[i] === v[i]) {
                        bin[i] = binOf(q);
                        if (bin[i] + 1 > nb) nb = bin[i] + 1;
                    }
                }
        if (!nb) throw new Error('ring removal: no finite values');
        // voxels a whole shell would hold: 4 pi q^2 w over the Q volume of a
        // voxel (2 pi q w over its area for a single layer)
        const flat = [0, 1, 2].filter(a => model.dims[a] <= 1);
        const cellQ = flat.length ? Math.hypot(...cross(...[qa, qb, qc].filter((_, a) => !flat.includes(a)).slice(0, 2)))
            : Math.abs(det3([qa, qb, qc]));
        const fullShell = b => ((flat.length ? 2 * Math.PI * centre(b) : 4 * Math.PI * centre(b) ** 2) * binWidth(b)) / cellQ;
        const voxelQ = Math.min(...[qa, qb, qc].filter((_, a) => model.dims[a] > 1).map(u => Math.hypot(...u)));
        const profile = s => {
            const nsk = s < 0 ? 1 : nsec;
            const key = j => (s < 0 || !sec ? 0 : sec[j]) * nb + bin[j];
            const counts = new Int32Array(nsk * nb + 1);
            for (let j = 0; j < N; j++) if (bin[j] >= 0 && (s < 0 || !sec || sec[j] === s)) counts[key(j) + 1]++;
            for (let t = 0; t < nsk * nb; t++) counts[t + 1] += counts[t];
            const sorted = new Float32Array(counts[nsk * nb]), at = counts.slice(0, nsk * nb);
            for (let j = 0; j < N; j++) if (bin[j] >= 0 && (s < 0 || !sec || sec[j] === s)) sorted[at[key(j)]++] = v[j];
            const base = s < 0 || !sec ? 0 : s * nb, share = s < 0 ? 1 : nsec;
            const level = new Float64Array(nb).fill(NaN), err = new Float64Array(nb).fill(Infinity);
            for (let b = 0; b < nb; b++) {
                const part = sorted.subarray(counts[base + b], counts[base + b + 1]);
                if (part.length < 3) continue;
                level[b] = medianOf(part, part.length);
                if (part.length < step.coverage * fullShell(b) / share) continue;
                const dev = Float64Array.from(part, x => Math.abs(x - level[b]));
                err[b] = 1.2533 * 1.4826 * medianOf(dev, dev.length) / Math.sqrt(part.length);
            }
            return { level, err };
        };
        return { nb, nsec, qs, sec, bin, w, voxelQ, profile, centre };
    }

    // The profile with its empty bins bridged linearly (ends held), for the
    // transform; null with fewer than 8 bins holding data.
    function bridged(level) {
        const known = [];
        for (let b = 0; b < level.length; b++) if (level[b] === level[b]) known.push(b);
        if (known.length < 8) return null;
        const full = new Float64Array(level.length);
        for (let t = 0, b = 0; b < level.length; b++) {
            while (t + 1 < known.length && known[t + 1] <= b) t++;
            const lo = known[t], hi = known[Math.min(known.length - 1, t + 1)];
            full[b] = b <= lo || hi === lo ? level[lo] : level[lo] + (level[hi] - level[lo]) * (b - lo) / (hi - lo);
            if (b < known[0]) full[b] = level[known[0]];
        }
        return { full, known };
    }

    // Any ring sharper than `cutoff`: the profile is split by a Gaussian
    // low-pass in Fourier space, run again on the profile clipped to that
    // smooth part until it passes under the rings; runs of positive excess
    // that rise above four times the median's uncertainty are rings. Returns
    // the ring level per (sector, bin) and the strongest [height, |Q|].
    function sharpRings(rp, step) {
        const { nb, nsec, w } = rp, ringAt = new Float64Array(nsec * nb), strongest = [];
        for (let s = 0; s < nsec; s++) {
            const { level: p, err } = rp.profile(nsec > 1 ? s : -1);
            const br = bridged(p);
            if (!br) continue;
            const { full, known } = br;
            const typical = medianOf(Float64Array.from(known, b => Math.abs(p[b])), known.length);
            const tol = Float64Array.from(err, e => (e < Infinity ? Math.max(4 * e, 1e-3 * typical) : Infinity));
            let smooth = lowPass(full, w, step.cutoff);
            for (let it = 0; it < 12; it++) {
                const clipped = Float64Array.from(full, (x, b) => Math.min(x, smooth[b] + (tol[b] < Infinity ? tol[b] : 0)));
                smooth = lowPass(clipped, w, step.cutoff);
            }
            const r = new Float64Array(nb);
            for (let b = 0; b < nb; b++) {
                if (p[b] !== p[b]) continue;
                r[b] = p[b] - smooth[b];
                if (step.positive && r[b] < 0) r[b] = 0;
            }
            // runs of positive excess that rise above the noise are rings,
            // subtracted whole (their tails too); the rest is left
            for (let b = 0; b < nb;) {
                if (!(r[b] > 0)) {
                    b++;
                    continue;
                }
                let e = b, top = 0, qtop = 0, above = false;
                while (e < nb && r[e] > 0) {
                    if (r[e] > top) { top = r[e]; qtop = (e + 0.5) * w; }
                    if (r[e] > tol[e]) above = true;
                    e++;
                }
                for (let t = b; t < e; t++) ringAt[s * nb + t] = above ? r[t] : 0;
                if (above) strongest.push([top, qtop]);
                b = e;
            }
            if (!step.positive) {
                for (let b = 0; b < nb; b++) if (r[b] < 0 && -r[b] > tol[b]) ringAt[s * nb + b] = r[b];
            }
        }
        return { ringAt, strongest };
    }

    // Polycrystalline materials whose rings get into diffuse data: structure
    // type, elements, lattice parameters (A; room temperature unless noted)
    // and an isotropic Debye-Waller B (A^2).
    const MATERIALS = {
        aluminium: { type: 'fcc', el: ['Al'], a: 4.0495, B: 0.85 },
        copper: { type: 'fcc', el: ['Cu'], a: 3.6149, B: 0.55 },
        nickel: { type: 'fcc', el: ['Ni'], a: 3.524, B: 0.37 },
        silver: { type: 'fcc', el: ['Ag'], a: 4.0853, B: 0.72 },
        gold: { type: 'fcc', el: ['Au'], a: 4.0782, B: 0.6 },
        platinum: { type: 'fcc', el: ['Pt'], a: 3.9242, B: 0.32 },
        lead: { type: 'fcc', el: ['Pb'], a: 4.9508, B: 2.0 },
        vanadium: { type: 'bcc', el: ['V'], a: 3.024, B: 0.55 },
        niobium: { type: 'bcc', el: ['Nb'], a: 3.3004, B: 0.45 },
        iron: { type: 'bcc', el: ['Fe'], a: 2.8665, B: 0.35 },
        chromium: { type: 'bcc', el: ['Cr'], a: 2.8846, B: 0.25 },
        molybdenum: { type: 'bcc', el: ['Mo'], a: 3.147, B: 0.24 },
        tantalum: { type: 'bcc', el: ['Ta'], a: 3.3013, B: 0.3 },
        tungsten: { type: 'bcc', el: ['W'], a: 3.1652, B: 0.16 },
        titanium: { type: 'hcp', el: ['Ti'], a: 2.9508, c: 4.6855, B: 0.6 },
        zirconium: { type: 'hcp', el: ['Zr'], a: 3.2316, c: 5.1475, B: 0.5 },
        beryllium: { type: 'hcp', el: ['Be'], a: 2.2858, c: 3.5843, B: 0.4 },
        magnesium: { type: 'hcp', el: ['Mg'], a: 3.2094, c: 5.2108, B: 1.0 },
        silicon: { type: 'diamond', el: ['Si'], a: 5.431, B: 0.47 },
        germanium: { type: 'diamond', el: ['Ge'], a: 5.6579, B: 0.55 },
        graphite: { type: 'graphite', el: ['C'], a: 2.4612, c: 6.7079, B: 0.6 },
        ice: { type: 'iceIh', el: ['O', 'H'], a: 4.497, c: 7.322, B: 1.0 },
        'ice-d2o': { type: 'iceIh', el: ['O', 'D'], a: 4.497, c: 7.322, B: 1.0 },
        nacl: { type: 'rocksalt', el: ['Na', 'Cl'], a: 5.6402, B: 1.6 },
        mgo: { type: 'rocksalt', el: ['Mg', 'O'], a: 4.2112, B: 0.3 },
        caf2: { type: 'fluorite', el: ['Ca', 'F'], a: 5.4626, B: 0.5 },
        ceo2: { type: 'fluorite', el: ['Ce', 'O'], a: 5.4116, B: 0.4 },
        lab6: { type: 'lab6', el: ['La', 'B'], a: 4.15683, B: 0.3 },
    };
    const MATERIAL_ALIASES = {
        al: 'aluminium', aluminum: 'aluminium', cu: 'copper', ni: 'nickel', ag: 'silver', au: 'gold', pt: 'platinum', pb: 'lead',
        v: 'vanadium', nb: 'niobium', fe: 'iron', cr: 'chromium', mo: 'molybdenum', ta: 'tantalum', w: 'tungsten',
        ti: 'titanium', zr: 'zirconium', be: 'beryllium', mg: 'magnesium', si: 'silicon', ge: 'germanium', c: 'graphite',
        h2o: 'ice', 'ice-h2o': 'ice', d2o: 'ice-d2o',
    };
    const STRUCTURE_TYPES = ['sc', 'fcc', 'bcc', 'diamond', 'hcp', 'rocksalt', 'fluorite'];
    const HEXAGONAL_TYPES = new Set(['hcp', 'graphite', 'iceIh']);

    // "aluminium, ice": materials by name (an alias such as Al, or a name
    // then new lattice parameters: "aluminium 4.032"), or by structure type,
    // elements and lattice parameters: "fcc Al 4.05", "hcp Ti 2.95 4.69",
    // "rocksalt Na Cl 5.64".
    function parseMaterials(text) {
        const out = [];
        for (const part of String(text || '').split(/[,;]/)) {
            const tok = part.trim().split(/\s+/).filter(Boolean);
            if (!tok.length) continue;
            const nums = tok.filter(t => Number.isFinite(Number(t))).map(Number), words = tok.filter(t => !Number.isFinite(Number(t)));
            const key = words[0].toLowerCase(), name = MATERIALS[key] ? key : MATERIAL_ALIASES[key];
            let m;
            if (name && words.length === 1) {
                m = Object.assign({ name }, MATERIALS[name]);
            } else if (STRUCTURE_TYPES.includes(key) && words.length >= 2) {
                const need = key === 'rocksalt' || key === 'fluorite' ? 2 : 1;
                if (words.length - 1 !== need) throw new Error(`materials: "${part.trim()}" needs ${need} element${need > 1 ? 's' : ''}`);
                m = { name: part.trim(), type: key, el: words.slice(1), B: 0.5 };
                if (!nums.length) throw new Error(`materials: "${part.trim()}" needs its lattice parameter`);
            } else {
                throw new Error(`materials: unknown "${part.trim()}" (known: ${Object.keys(MATERIALS).join(', ')}; ` +
                    'or a structure type (sc, fcc, bcc, diamond, hcp, rocksalt, fluorite), its elements and lattice parameters)');
            }
            if (nums.length) m.a = nums[0];
            if (nums.length > 1) m.c = nums[1];
            if (HEXAGONAL_TYPES.has(m.type) && !(m.c > 0)) throw new Error(`materials: "${part.trim()}" needs a and c`);
            if (!(m.a > 0)) throw new Error(`materials: "${part.trim()}" has no valid lattice parameter`);
            m.el.forEach(atomOf);
            out.push(m);
        }
        if (!out.length) throw new Error('materials: name at least one, e.g. aluminium');
        return out;
    }

    // Atoms of the conventional cell: [element, [x, y, z], occupancy].
    function structureAtoms(m) {
        const FCC = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
        const at = (el, list, occ) => list.map(p => [el, p.map(x => ((x % 1) + 1) % 1), occ === undefined ? 1 : occ]);
        const shift = (list, d) => list.map(p => p.map((x, c) => x + d[c]));
        const [A, B] = m.el;
        switch (m.type) {
            case 'sc': return at(A, [[0, 0, 0]]);
            case 'fcc': return at(A, FCC);
            case 'bcc': return at(A, [[0, 0, 0], [0.5, 0.5, 0.5]]);
            case 'diamond': return at(A, FCC.concat(shift(FCC, [0.25, 0.25, 0.25])));
            case 'hcp': return at(A, [[1 / 3, 2 / 3, 0.25], [2 / 3, 1 / 3, 0.75]]);
            case 'rocksalt': return at(A, FCC).concat(at(B, shift(FCC, [0.5, 0, 0])));
            case 'fluorite': return at(A, FCC).concat(at(B, shift(FCC, [0.25, 0.25, 0.25]).concat(shift(FCC, [0.75, 0.75, 0.75]))));
            case 'graphite': return at(A, [[0, 0, 0.25], [0, 0, 0.75], [1 / 3, 2 / 3, 0.25], [2 / 3, 1 / 3, 0.75]]);
            case 'lab6': {
                const x = 0.1996;
                return at(A, [[0, 0, 0]]).concat(at(B, [[x, 0.5, 0.5], [1 - x, 0.5, 0.5], [0.5, x, 0.5], [0.5, 1 - x, 0.5], [0.5, 0.5, x], [0.5, 0.5, 1 - x]]));
            }
            case 'iceIh': {
                // O on 4f (z = 1/16, ideal tetrahedra) of P63/mmc; half an H
                // (or D) 1.0 A from each O along each of its four O-O bonds
                const z = 0.0625, O = [[1 / 3, 2 / 3, z], [2 / 3, 1 / 3, z + 0.5], [2 / 3, 1 / 3, -z], [1 / 3, 2 / 3, 0.5 - z]];
                const L = Converter.cellToLattice([m.a, m.a, m.c], [90, 90, 120]), toCart = f => mulMV(L, f), Li = invert3(L);
                const H = [];
                for (const p of O) {
                    for (const q of O) for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
                        const d = toCart([q[0] + i - p[0], q[1] + j - p[1], q[2] + k - p[2]]), r = Math.hypot(...d);
                        if (r > 2.4 && r < 3.1) H.push(p.map((x, c) => x + mulMV(Li, d.map(y => y / r))[c]));
                    }
                }
                return at(A, O).concat(at(B, H, 0.5));
            }
            default: throw new Error(`unknown structure type ${m.type}`);
        }
    }

    // Powder lines of a material up to qmax, for the radiation: every
    // reflection's integrated intensity m |F|^2 exp(-2W) spread over the
    // sphere of its |Q| in reciprocal space, so the line strength is
    // sum |F|^2 / (4 pi Q^2). [{ q, strength, hkl }], by |Q|.
    function materialLines(m, radiation, qmax) {
        const hex = HEXAGONAL_TYPES.has(m.type);
        const L = Converter.cellToLattice(hex ? [m.a, m.a, m.c] : [m.a, m.a, m.a], hex ? [90, 90, 120] : [90, 90, 90]);
        const Bq = Converter.reciprocalBasis(L).map(r => r.map(x => 2 * Math.PI * x));
        const atoms = structureAtoms(m).map(([el, p, occ]) => ({ atom: atomOf(el), p, occ }));
        const nmax = [0, 1, 2].map(c => Math.ceil(qmax * Math.hypot(L[0][c], L[1][c], L[2][c]) / (2 * Math.PI)));
        const lines = new Map();
        for (let h = -nmax[0]; h <= nmax[0]; h++)
            for (let k = -nmax[1]; k <= nmax[1]; k++)
                for (let l = -nmax[2]; l <= nmax[2]; l++) {
                    if (!h && !k && !l) continue;
                    const q = Math.hypot(...mulMV(Bq, [h, k, l]));
                    if (q > qmax) continue;
                    const dw = Math.exp(-m.B * (q / (4 * Math.PI)) ** 2);
                    let re = 0, im = 0;
                    for (const { atom, p, occ } of atoms) {
                        const f = occ * amplitudeOf(atom, radiation, q) * dw, ph = 2 * Math.PI * (h * p[0] + k * p[1] + l * p[2]);
                        re += f * Math.cos(ph);
                        im += f * Math.sin(ph);
                    }
                    const key = Math.round(q * 1e6);
                    const line = lines.get(key) || { q, strength: 0, hkl: [Math.abs(h), Math.abs(k), Math.abs(l)] };
                    line.strength += (re * re + im * im) / (4 * Math.PI * q * q);
                    lines.set(key, line);
                }
        const list = [...lines.values()], top = Math.max(0, ...list.map(x => x.strength));
        return list.filter(x => x.strength > 1e-6 * top).sort((x, y) => x.q - y.q);
    }

    // Line profile of a material at bin centres (or any |Q|): Gaussians of
    // unit area, width sqrt(s0^2 + (r Q)^2), at the lines' |Q| / lambda
    // (lambda: the ratio of the lattice parameter to the listed one).
    function lineCurve(lines, lambda, s0, r) {
        return q => {
            let sum = 0;
            for (const line of lines) {
                const mu = line.q / lambda, s = Math.sqrt(s0 * s0 + r * r * mu * mu), d = (q - mu) / s;
                if (d * d < 50) sum += line.strength * Math.exp(-0.5 * d * d) / (s * 2.5066282746310002);
            }
            return sum;
        };
    }

    // Least squares with non-negative coefficients for a few columns: the
    // normal equations, dropping a column whose coefficient comes out below
    // zero, until none does.
    // Columns that are zero where the weights are (lines outside the data)
    // stay out; a tiny ridge keeps nearly equal columns solvable. Returns
    // { x, M, idx }: the coefficients, and the normal matrix of the columns
    // kept.
    function nonNegative(cols, y, wt, keep) {
        const n = cols.length, x = new Array(n).fill(0);
        const dotw = (u, v) => { let s = 0; for (let b = 0; b < y.length; b++) if (wt[b]) s += wt[b] * u[b] * v[b]; return s; };
        const norms = cols.map(c => dotw(c, c)), top = Math.max(0, ...norms);
        const active = norms.map((v, i) => v > 1e-24 * top && v > 0 && (!keep || keep[i]));
        for (let round = 0; round <= n; round++) {
            const idx = [...active.keys()].filter(i => active[i]);
            if (!idx.length) return { x: x.fill(0), M: null, idx };
            const M = idx.map(i => idx.map(j => dotw(cols[i], cols[j]) + (i === j ? 1e-10 * norms[i] : 0)));
            const sol = solveSmall(M, idx.map(i => dotw(cols[i], y)));
            if (!sol) return { x: x.fill(0), M: null, idx: [] };
            x.fill(0);
            idx.forEach((i, k) => { x[i] = sol[k]; });
            const neg = idx.filter(i => !(x[i] >= 0));
            if (!neg.length) return { x, M, idx };
            for (const i of neg) active[i] = false;
        }
        return { x: x.fill(0), M: null, idx: [] };
    }

    // Rings of named materials: their lines are fitted to the high-passed
    // |Q| profile (the same Gaussian low-pass taken off the data and off
    // the model, so a smooth background and broad diffuse features drop
    // out) by non-negative, robustly reweighted least squares for the
    // scales, with one-dimensional searches for each lattice parameter
    // (within +/- `refine`) and for the width model. Per sector the scales
    // are fitted again with the lines fixed. Returns per voxel the ring
    // intensity to subtract.
    function materialRings(model, rp, step, ctx) {
        let radiation = step.radiation === 'auto' ? model.radiation : step.radiation, unknown = false;
        if (!['xray', 'neutron', 'electron'].includes(radiation)) {
            // the positions do not depend on it: every line then gets an
            // intensity of its own
            ctx.log('the radiation of the data is not known, so each line is fitted with an intensity of its own');
            radiation = 'xray';
            unknown = true;
        }
        const { nb, nsec } = rp, qmax = rp.centre(nb);
        const mats = parseMaterials(step.materials).map(m => Object.assign(m, { lines: materialLines(m, radiation, qmax * 1.05) }));
        const centres = Float64Array.from({ length: nb }, (_, b) => rp.centre(b));
        // in the profile's coordinate every line is one width wide: the
        // high-pass takes off what is broader than `highPass` line widths
        const highPass = x => {
            const lp = lowPass(x, rp.du, step.highPass);
            return Float64Array.from(x, (y, b) => y - lp[b]);
        };
        // columns of the model: one per material, or (free intensities) one
        // per group of lines closer than two widths
        const columns = (lambdas, s0, r, free, skip) => {
            const cols = [], owner = [];
            mats.forEach((m, k) => {
                if (skip && skip.has(k)) return;
                if (free) {
                    let group = [];
                    const flush = () => {
                        if (!group.length) return;
                        const curve = lineCurve(group, lambdas[k], s0, r);
                        cols.push(Float64Array.from(centres, curve));
                        owner.push([k, group]);
                        group = [];
                    };
                    for (const line of m.lines) {
                        const last = group[group.length - 1];
                        if (last && line.q / lambdas[k] - last.q / lambdas[k] > 2 * Math.hypot(s0, r * line.q)) flush();
                        group.push(line);
                    }
                    flush();
                } else {
                    cols.push(Float64Array.from(centres, lineCurve(m.lines, lambdas[k], s0, r)));
                    owner.push([k, m.lines]);
                }
            });
            return { cols, owner };
        };
        const prepared = new WeakMap();
        const fitProfile = (prof, lambdas, s0, r, free, significant, skip) => {
            if (!prepared.has(prof)) {
                const br = bridged(prof.level);
                if (br) {
                    const y = highPass(br.full), base = Float64Array.from(prof.err, e => (e < Infinity && e > 0 ? 1 / (e * e) : 0));
                    // Huber's loss, quadratic up to 5 x the robust spread of
                    // the data themselves, then linear
                    const zs = Float64Array.from([...y.keys()].filter(b => base[b]), b => Math.abs(y[b]) * Math.sqrt(base[b]));
                    const spread = zs.length ? 1.4826 * medianOf(zs, zs.length) : 1;
                    prepared.set(prof, { y, base, c: 5 * Math.max(spread, 1e-300) });
                } else {
                    prepared.set(prof, null);
                }
            }
            const pre = prepared.get(prof);
            if (!pre) return null;
            const { y, base, c: hc } = pre;
            const { cols, owner } = columns(lambdas, s0, r, free, skip);
            const hp = cols.map(highPass);
            const resid = x => Float64Array.from(y, (yb, b) => (base[b] ? (yb - hp.reduce((s, c, i) => s + x[i] * c[b], 0)) * Math.sqrt(base[b]) : NaN));
            let wt = base, fit = null, z = null;
            for (let it = 0; it < 3; it++) {
                fit = nonNegative(hp, y, wt);
                // Huber reweighting of the standardized residuals: what the
                // lines cannot explain (diffuse leakage) counts less, but
                // nothing is dropped
                z = resid(fit.x);
                wt = Float64Array.from(base, (b0, b) => (z[b] === z[b] ? b0 * Math.min(1, hc / Math.abs(z[b])) : 0));
            }
            let x = fit.x;
            if (significant && fit.M) {
                // only amplitudes above three standard errors (the reduced
                // chi-square of the reweighted fit scaling the covariance)
                let ssr = 0, used = 0;
                for (let b = 0; b < nb; b++) {
                    if (!wt[b]) continue;
                    const d = y[b] - hp.reduce((s, c, i) => s + x[i] * c[b], 0);
                    ssr += wt[b] * d * d;
                    used++;
                }
                const s2 = ssr / Math.max(1, used - fit.idx.length);
                const keep = new Array(hp.length).fill(false);
                fit.idx.forEach((i, k) => {
                    const e = new Array(fit.idx.length).fill(0);
                    e[k] = 1;
                    const col = solveSmall(fit.M, e);
                    const se = col ? Math.sqrt(Math.max(0, col[k] * s2)) : Infinity;
                    keep[i] = x[i] > 3 * se;
                });
                if (keep.some((k, i) => !k && x[i] > 0)) {
                    x = nonNegative(hp, y, wt, keep).x;
                    z = resid(x);
                }
            }
            const huber = t => (Math.abs(t) <= hc ? t * t : 2 * hc * Math.abs(t) - hc * hc);
            let loss = 0, before = 0;
            for (let b = 0; b < nb; b++) {
                if (!base[b]) continue;
                loss += huber(z[b]);
                before += huber(y[b] * Math.sqrt(base[b]));
            }
            return { x, owner, loss, before };
        };
        const whole = rp.profile(-1);
        let lambdas = mats.map(() => 1), s0 = rp.s0init, r = step.resolution;
        const objective = () => {
            const f = fitProfile(whole, lambdas, s0, r);
            return f ? f.loss : Infinity;
        };
        // a coarse scan, then golden-section search about its best point;
        // returns how much deeper the best point lies than the scan's median
        const search = (set, lo, hi, steps) => {
            let best = lo, fb = Infinity;
            const scan = new Float64Array(steps + 1);
            for (let i = 0; i <= steps; i++) {
                const t = lo + (hi - lo) * i / steps;
                set(t);
                const f = objective();
                scan[i] = f;
                if (f < fb) { fb = f; best = t; }
            }
            const mid = medianOf(Float64Array.from(scan), scan.length);
            let a = Math.max(lo, best - 2 * (hi - lo) / steps), b = Math.min(hi, best + 2 * (hi - lo) / steps);
            const g = (Math.sqrt(5) - 1) / 2;
            for (let it = 0; it < 24; it++) {
                const c = b - g * (b - a), d = a + g * (b - a);
                set(c);
                const fc = objective();
                set(d);
                const fd = objective();
                if (fc < fd) b = d; else a = c;
            }
            set((a + b) / 2);
            return mid > 0 ? (mid - Math.min(fb, objective())) / mid : 0;
        };
        // widths within a factor 3 of the ones the coordinate was made for,
        // so the high-pass cannot take the lines for background
        const qLow = Math.min(...mats.map(m => (m.lines.length ? m.lines[0].q : Infinity)).concat([qmax]));
        const sMax = 3 * rp.s0init, rMax = Math.max(3 * rp.rinit, 0.002);
        const match = mats.map(() => 1);
        // coarse to fine: the lattice parameters first with broad lines
        // (a smooth objective), then the widths, then both again
        // the two widths together (they trade off): a grid, then each refined
        const widths = () => {
            let best = [s0, r], fb = Infinity;
            for (let i = 0; i < 12; i++) {
                for (let j = 0; j < 12; j++) {
                    s0 = sMax / 9 * Math.pow(9, i / 11);
                    r = rMax * j / 11;
                    const f = objective();
                    if (f < fb) { fb = f; best = [s0, r]; }
                }
            }
            [s0, r] = best;
            search(t => { s0 = t; }, Math.max(sMax / 9, s0 / 1.5), Math.min(sMax, s0 * 1.5), 8);
            search(t => { r = t; }, Math.max(0, r - rMax / 11), Math.min(rMax, r + rMax / 11), 8);
        };
        if (step.fitWidth) s0 = 2 * rp.s0init;
        for (let round = 0; round < 2; round++) {
            if (step.refine > 0) mats.forEach((_, k) => { match[k] = search(t => { lambdas[k] = t; }, 1 - step.refine, 1 + step.refine, 40); });
            if (step.fitWidth) widths();
        }
        if (step.refine > 0) mats.forEach((_, k) => { match[k] = Math.max(match[k], search(t => { lambdas[k] = t; }, lambdas[k] - step.refine / 10, lambdas[k] + step.refine / 10, 10)); });
        const free = step.intensities === 'free' || unknown;
        let fit = fitProfile(whole, lambdas, s0, r, free, true);
        if (!fit) throw new Error('ring removal: too few |Q| bins with data to fit');
        // a material stays only when its lines explain a share of the profile
        // (2 % or more) and, when its lattice parameter was refined, the fit
        // clearly prefers that value (15 % below the median of the scan)
        const skip = new Set();
        mats.forEach((m, k) => {
            const without = fitProfile(whole, lambdas, s0, r, free, true, new Set([k]));
            const share = fit.before > 0 && without ? (without.loss - fit.loss) / fit.before : 0;
            if (share < 0.02 || (step.refine > 0 && match[k] < 0.15)) {
                skip.add(k);
                ctx.log(`${m.name}: no clear lines (they explain ${Math.round(100 * Math.max(0, share))} % of the profile` +
                    (step.refine > 0 ? `, the lattice parameter is ${Math.round(100 * match[k])} % better than elsewhere` : '') + '); left out');
            }
        });
        if (skip.size) fit = fitProfile(whole, lambdas, s0, r, free, true, skip);
        // scales of every column, per sector when asked
        const sectorScale = [];
        for (let s = 0; s < nsec; s++) {
            const f = nsec > 1 ? fitProfile(rp.profile(s), lambdas, s0, r, free, true, skip) : fit;
            sectorScale.push(f && f.x.some(t => t > 0) ? f.x : fit.x);
        }
        const gain = fit.before > 0 ? 1 - fit.loss / fit.before : 0;
        mats.forEach((m, k) => {
            if (skip.has(k)) return;
            const scale = fit.owner.reduce((s, [owner], i) => s + (owner === k ? fit.x[i] : 0), 0);
            const strongest = m.lines.slice().sort((p, q) => q.strength - p.strength).slice(0, 3)
                .map(line => `(${line.hkl.join(' ')}) ${(line.q / lambdas[k]).toFixed(3)}`).join(', ');
            ctx.log(`${m.name}: ${HEXAGONAL_TYPES.has(m.type) ? `a = ${(m.a * lambdas[k]).toFixed(4)}, c = ${(m.c * lambdas[k]).toFixed(4)}`
                : `a = ${(m.a * lambdas[k]).toFixed(4)}`} A (${((lambdas[k] - 1) * 100).toFixed(2)} %), ` +
                `${m.lines.length} lines to |Q| ${qmax.toFixed(1)} 1/A, scale ${scale.toPrecision(3)}; strongest ${strongest}`);
        });
        ctx.log(`ring width sigma = sqrt(${s0.toPrecision(3)}^2 + (${r.toPrecision(3)} Q)^2) 1/A; ` +
            `the rings account for ${Math.round(100 * gain)} % of the high-passed |Q| profile` +
            (free ? `; ${fit.owner.length} line groups with intensities of their own` : ''));
        if (!fit.x.some(t => t > 0)) ctx.log('no rings of these materials in the data; nothing subtracted');
        // at a bound of the width search: the next pass looks further
        const atLimit = step.fitWidth && (s0 > 0.97 * sMax || s0 < 1.03 * sMax / 9 || r > 0.97 * rMax);
        if (fit.owner.length === 0) return { ring: () => 0, s0, r, atLimit: false };
        // ring intensity per voxel: per sector, the fitted columns summed on
        // a fine |Q| table
        const fine = Math.max(2e-5, Math.hypot(s0, r * qLow) / 10), nf = Math.ceil(qmax * 1.05 / fine) + 2;
        const curves = fit.owner.map(([k, lines]) => lineCurve(lines, lambdas[k], s0, r));
        const colTables = curves.map(f => Float64Array.from({ length: nf }, (_, i) => f(i * fine)));
        const tables = sectorScale.map(x => Float64Array.from({ length: nf }, (_, i) => colTables.reduce((sum, t, c) => sum + x[c] * t[i], 0)));
        const ring = j => {
            const q = rp.qs[j] / fine, i0 = Math.min(nf - 2, Math.floor(q)), t = q - i0, table = tables[rp.sec ? rp.sec[j] : 0];
            return (1 - t) * table[i0] + t * table[i0 + 1];
        };
        return { ring, s0, r, atLimit };
    }

    // Powder rings removed. With materials named (aluminium, ice, "fcc Al
    // 4.05", ...), their lines are predicted from the structure and fitted
    // (see materialRings); with "any", whatever is sharper in |Q| than the
    // cutoff and rises above the noise goes (see sharpRings). The rings are
    // subtracted at their |Q| from every voxel, so anisotropic diffuse
    // scattering stays.
    function stepRemoveRings(model, step, ctx) {
        needCell(ctx.cell, 'ring removal');
        const any = String(step.materials).trim().toLowerCase() === 'any';
        const values = copyValues(model), N = values.length;
        if (any) {
            const rp = Object.assign(ringProfiles(model, ctx.cell, step, null), { du: step.width });
            const { ringAt, strongest } = sharpRings(rp, step);
            const { nb, w } = rp;
            for (let j = 0; j < N; j++) {
                if (values[j] !== values[j]) continue;
                const f = rp.qs[j] / w - 0.5, b0 = Math.max(0, Math.min(nb - 1, Math.floor(f))), b1 = Math.min(nb - 1, b0 + 1);
                const t = Math.min(1, Math.max(0, f - b0)), base = (rp.sec ? rp.sec[j] : 0) * nb;
                values[j] -= (1 - t) * ringAt[base + b0] + t * ringAt[base + b1];
            }
            strongest.sort((x, y) => y[0] - x[0]);
            const peaks = [];
            for (const [h, q] of strongest) {
                if (peaks.length >= 6) break;
                if (!peaks.some(([, p]) => Math.abs(p - q) < 3 * w)) peaks.push([h, q]);
            }
            ctx.log(peaks.length ? 'sharpest rings at |Q| ' + peaks.map(([h, q]) => `${q.toFixed(3)} (${h.toPrecision(3)})`).join(', ') + ' 1/A'
                : 'no ring sharper than the cutoff found');
        } else {
            // the profile's coordinate u = asinh(r Q / s0) / r for the line
            // width sqrt(s0^2 + (r Q)^2): linear in |Q| where the width is
            // constant, logarithmic where it grows with |Q|; bins a quarter
            // of a width. When the widths fitted in it end at a bound of
            // their search, the next pass is made for them (at most three)
            let s0 = Math.max(step.sigma0, 1e-4), r0 = step.resolution, result = null, logs = [];
            for (let pass = 0; pass < 3; pass++) {
                const a0 = s0, b0 = r0;
                const coord = {
                    u: q => (b0 > 0 ? Math.asinh(b0 * q / a0) / b0 : q / a0),
                    q: u => (b0 > 0 ? a0 / b0 * Math.sinh(b0 * u) : u * a0),
                    du: 0.25,
                };
                const rp = Object.assign(ringProfiles(model, ctx.cell, step, coord), { du: coord.du, s0init: a0, rinit: b0 });
                logs = [];
                result = materialRings(model, rp, step, Object.assign({}, ctx, { log: t => logs.push(t) }));
                if (!result.atLimit) break;
                s0 = Math.max(result.s0, 1e-4);
                r0 = result.r;
            }
            logs.forEach(t => ctx.log(t));
            for (let j = 0; j < N; j++) if (values[j] === values[j]) values[j] -= result.ring(j);
        }
        return withValues(model, values);
    }

    // ------------------------------------------------------ atom scattering

    // Per element (and D, 7Li): the X-ray form factor of Waasmaier & Kirfel
    // (1995), a1..a5 b1..b5 c in s = sin(theta)/lambda = |Q|/(4 pi); the
    // coherent neutron scattering length (10^-12 cm); the electron form
    // factor of Peng et al. (1996), a1..a5 b1..b5 in s - as 3DSCalculator
    // tabulates them.
    const ATOM_TABLE = `
H|0.413048 0.294953 0.187491 0.080701 0.023736 15.56995 32.39847 5.711404 61.88987 1.334118 0.000049|-0.3739|0.0349 0.1201 0.197 0.0573 0.1195 0.5347 3.5867 12.3471 18.9525 38.6269
He|0.732354 0.753896 0.283819 0.190003 0.039139 11.55392 4.595831 1.546299 26.46396 0.377523 0.000487|0.326|0.0317 0.0838 0.1526 0.1334 0.0164 0.2507 1.4751 4.4938 12.6646 31.1653
Li|0.974637 0.158472 0.811855 0.262416 0.790108 4.334946 0.342451 97.10297 201.3638 1.409234 0.002542|-0.19|0.075 0.2249 0.5548 1.4954 0.9354 0.3864 2.9383 15.3829 53.5545 138.7337
Be|1.533712 0.638283 0.601052 0.106139 1.118414 42.66208 0.59542 99.1065 0.15134 1.843093 0.002511|0.779|0.078 0.221 0.674 1.3867 0.6925 0.3131 2.2381 10.1517 30.9061 78.3273
B|2.085185 1.06458 1.062788 0.140515 0.641784 23.49407 1.137894 61.23898 0.114886 0.399036 0.003823|0.53|0.0909 0.2551 0.7738 1.2136 0.4606 0.2995 2.1155 8.3816 24.1292 63.1314
C|2.657506 1.078079 1.490909 -4.24107 0.713791 14.78076 0.776775 42.08684 -0.000294 0.239535 4.297983|0.6646|0.0893 0.2563 0.757 1.0487 0.3575 0.2465 1.71 6.4094 18.6113 50.2523
N|11.89378 3.277479 1.858092 0.858927 0.912985 0.000158 10.23272 30.34469 0.656065 0.217287 -11.8049|0.936|0.1022 0.3219 0.7982 0.8197 0.1715 0.2451 1.7481 6.1925 17.3894 48.1431
O|2.960427 2.508818 0.637853 0.722838 1.142756 14.18226 5.936858 0.112726 34.95848 0.39024 0.027014|0.5803|0.0974 0.2921 0.691 0.699 0.2039 0.2067 1.3815 4.6943 12.7105 32.4726
F|3.511943 2.772244 0.678385 0.915159 1.089261 10.68786 4.380466 0.093982 27.2552 0.313066 0.032557|0.5654|0.1083 0.3175 0.6487 0.5846 0.1421 0.2057 1.3439 4.2788 11.3932 28.7881
Ne|4.183749 2.905726 0.520513 1.135641 1.228065 8.175457 3.252536 0.063295 21.81391 0.224952 0.025576|0.4566|0.1269 0.3535 0.5582 0.4674 0.146 0.22 1.3779 4.0203 9.4934 23.1278
Na|4.910127 3.081783 1.262067 1.098938 0.560991 3.281434 9.119178 0.102763 132.0139 0.405878 0.079712|0.363|0.2142 0.6853 0.7692 1.6589 1.4482 0.3334 2.3446 10.083 48.3037 138.27
Mg|4.708971 1.194814 1.558157 1.170413 3.239403 4.875207 108.5061 0.111516 48.29241 1.928171 0.126842|0.5375|0.2314 0.6866 0.9677 2.1882 1.1339 0.3278 2.272 10.9241 39.2898 101.9748
Al|4.730796 2.313951 1.54198 1.117564 3.154754 3.628931 43.05117 0.09596 108.9324 1.555918 0.139509|0.3449|0.239 0.6573 1.2011 2.5586 1.2312 0.3138 2.1063 10.4163 34.4552 98.5344
Si|5.275329 3.191038 1.511514 1.356849 2.519114 2.631338 33.73073 0.081119 86.28864 1.170087 0.145073|0.41491|0.2519 0.6372 1.3795 2.5082 1.05 0.3075 2.0174 9.6746 29.3744 80.4732
P|1.950541 4.14693 1.49456 1.522042 5.729711 0.908139 27.04495 0.07128 67.52019 1.981173 0.155233|0.513|0.2548 0.6106 1.4541 2.3204 0.8477 0.2908 1.874 8.5176 24.3434 63.2996
S|6.372157 5.154568 1.473732 1.635073 1.209372 1.514347 22.09253 0.061373 55.44517 0.646925 0.154722|0.2847|0.2497 0.5628 1.3899 2.1865 0.7715 0.2681 1.6711 7.0267 19.5377 50.3888
Cl|1.446071 6.870609 6.151801 1.750347 0.634168 0.052357 1.193165 18.34342 46.3984 0.401005 0.146773|0.9577|0.2443 0.5397 1.3919 2.0197 0.6621 0.2468 1.5242 6.1537 16.6687 42.3086
Ar|7.188004 6.638454 0.45418 1.929593 1.523654 0.956221 15.33988 15.33986 39.04382 0.062409 0.265954|0.1909|0.2385 0.5017 1.3428 1.8899 0.6079 0.2289 1.3694 5.2561 14.0928 35.5361
K|8.163991 7.146945 1.07014 0.877316 1.486434 12.81632 0.808945 210.327 39.59765 0.052821 0.253614|0.367|0.4115 1.4031 2.2784 2.6742 2.2162 0.3703 3.3874 13.1029 68.9592 194.4329
Ca|8.593655 1.477324 1.436254 1.182839 7.113258 10.46064 0.041891 81.39038 169.8478 0.688098 0.196255|0.47|0.4054 1.388 2.1602 3.7532 2.2063 0.3499 3.0991 11.9608 53.9353 142.3892
Sc|1.476566 1.487278 1.600187 9.177463 7.09975 53.13102 0.035325 137.3195 9.098031 0.602102 0.157765|1.229|0.3787 1.2181 2.0594 3.2618 2.387 0.3133 2.5856 9.5813 41.7688 116.7282
Ti|9.818524 1.522646 1.703101 1.768774 7.082555 8.001879 0.029763 39.88542 120.158 0.532405 0.102473|-0.3438|0.3825 1.2598 2.0008 3.0617 2.0694 0.304 2.4863 9.2783 39.0751 109.4583
V|10.47358 1.547881 1.986381 1.865616 7.05625 7.08194 0.02604 31.90967 108.0228 0.474882 0.067744|-0.03824|0.3876 1.275 1.9109 2.8314 1.8979 0.2967 2.378 8.7981 35.9528 101.7201
Cr|11.00707 1.555477 2.985293 1.347855 7.034779 6.366281 0.023987 23.24484 105.7745 0.429369 0.06551|0.3635|0.4046 1.3696 1.8941 2.08 1.2196 0.2986 2.3958 9.1406 37.4701 113.7121
Mn|11.70954 1.733414 2.673141 2.023368 7.00318 5.59712 0.0178 21.78842 89.51791 0.383054 -0.147293|-0.373|0.3796 1.2094 1.7815 2.542 1.5937 0.2699 2.0455 7.4726 31.0604 91.5622
Fe|12.3111 1.876623 3.066177 2.070451 6.975185 5.009415 0.014461 18.74304 82.76788 0.346506 -0.304931|0.945|0.3946 1.2725 1.7031 2.314 1.4795 0.2717 2.0443 7.6007 29.9714 86.2265
Co|12.91451 2.481908 3.466894 2.106351 6.960892 4.507138 0.009126 16.43813 76.98732 0.314418 -0.936572|0.249|0.4118 1.3161 1.6493 2.193 1.283 0.2742 2.0372 7.7205 29.968 84.9383
Ni|13.52187 6.947285 3.866028 2.1359 4.284731 4.077277 0.286763 14.62263 71.96608 0.004437 -2.762697|1.03|0.386 1.1765 1.5451 2.073 1.3814 0.2478 1.766 6.3107 25.2204 74.3146
Cu|14.01419 4.784577 5.056806 1.457971 6.932996 3.73828 0.003744 13.03498 72.55479 0.265666 -3.254477|0.7718|0.4314 1.3208 1.5236 1.4671 0.8562 0.2694 1.9223 7.3474 28.9892 90.6246
Zn|14.741 6.907748 4.642337 2.191766 38.42404 3.388232 0.243315 11.90369 63.31213 0.000397 -36.91583|0.568|0.4288 1.2646 1.4472 1.8294 1.0934 0.2593 1.7998 6.75 25.586 73.5284
Ga|15.75895 6.841123 4.121016 2.714681 2.395246 3.121754 0.226057 12.4822 66.20362 0.007238 -0.847395|0.7288|0.4818 1.4032 1.6561 2.4605 1.1054 0.2825 1.9785 8.7546 32.5238 98.5523
Ge|16.54061 1.5679 3.727829 3.345098 6.785079 2.866618 0.012198 13.43216 58.86605 0.210974 0.018726|0.8185|0.4655 1.3014 1.6088 2.6998 1.3003 0.2647 1.7926 7.6071 26.5541 77.5238
As|17.02564 4.503441 3.715904 3.9372 6.790175 2.597739 0.003012 14.27212 50.438 0.193015 -2.984117|0.658|0.4517 1.2229 1.5852 2.7958 1.2638 0.2493 1.6436 6.8154 22.3681 62.039
Se|17.35407 4.653248 4.259489 4.136455 6.749163 2.349787 0.00255 15.57946 45.1812 0.177432 -3.160982|0.797|0.4477 1.1678 1.5843 2.8087 1.1956 0.2405 1.5442 6.3231 19.461 52.0233
Br|17.55057 5.411882 3.93718 3.880645 6.707793 2.119226 16.55718 0.002481 42.16401 0.162121 -2.492088|0.6795|0.4798 1.1948 1.8695 2.6953 0.8203 0.2504 1.5963 6.9653 19.8492 50.3233
Kr|17.65528 6.848105 4.171004 3.44676 6.6852 1.908231 16.60624 0.001598 39.91747 0.146896 -2.810592|0.781|0.4546 1.0993 1.7696 2.7068 0.8672 0.2309 1.4279 5.9449 16.6752 42.2243
Rb|8.123134 2.138042 6.761702 1.156051 17.67955 15.14239 33.54267 0.129372 224.1325 1.713368 1.139548|0.709|1.016 2.8528 3.5466 -7.7804 12.1148 0.4853 5.0925 25.7851 130.4515 138.6775
Sr|17.73022 9.795867 6.099763 2.620025 0.600053 1.56306 14.31087 0.120574 135.7713 0.120574 1.140251|0.702|0.6703 1.4926 3.3368 4.46 3.1501 0.319 2.2287 10.3504 52.3291 151.2216
Y|17.79204 10.25325 5.714949 3.170516 0.918251 1.429691 13.13282 0.112173 108.197 0.112173 1.131787|0.775|0.6894 1.5474 3.245 4.2126 2.9764 0.3189 2.2904 10.0062 44.0771 125.012
Zr|17.85977 10.91104 5.821115 3.512513 0.746965 1.310692 12.31929 0.104353 91.77754 0.104353 1.124859|0.716|0.6719 1.4684 3.1668 3.9557 2.892 0.3036 2.1249 8.9236 36.8458 108.2049
Nb|17.9584 12.06305 5.007015 3.287667 1.531019 1.21159 12.24669 0.098615 75.01195 0.098615 1.123452|0.7054|0.6123 1.2677 3.0348 3.3841 2.3683 0.2709 1.7683 7.2489 27.9465 98.5624
Mo|6.236218 17.98771 12.97313 3.451426 0.210899 0.09078 1.10831 11.46872 66.68415 0.09078 1.10877|0.6715|0.6773 1.4798 3.1788 3.0824 1.8384 0.292 2.0606 8.1129 30.5336 100.0658
Tc|17.84096 3.428236 1.373012 12.94736 6.335469 1.005729 41.90138 119.3205 9.781542 0.083391 1.074784|0.68|0.7082 1.6392 3.1993 3.4327 1.8711 0.2976 2.2106 8.5246 33.1456 96.6377
Ru|6.271624 17.90674 14.12327 3.746008 0.908235 0.07704 0.928222 9.555345 35.86068 123.5522 1.043992|0.703|0.6735 1.4934 3.0966 2.7254 1.5597 0.2773 1.9716 7.3249 26.6891 90.5581
Rh|6.216648 17.91974 3.854252 0.840326 15.1735 0.070789 0.856121 33.88948 121.6867 9.029517 0.995452|0.588|0.6413 1.369 2.9854 2.6952 1.5433 0.258 1.7721 6.3854 23.2549 85.1517
Pd|6.121511 4.784063 16.63168 4.318258 13.24677 0.062549 0.784031 8.751391 34.48998 0.784031 0.883099|0.591|0.5904 1.1775 2.6519 2.2875 0.8689 0.2324 1.5019 5.1591 15.5428 46.8213
Ag|6.073874 17.15544 4.173344 0.852238 17.98869 0.055333 7.896512 28.44374 110.3761 0.716809 0.756603|0.5922|0.6377 1.379 2.8294 2.3631 1.4553 0.2466 1.6974 5.7656 20.0943 76.7372
Cd|6.080986 18.01947 4.018197 1.30351 17.97467 0.04899 7.273646 29.11928 95.83121 0.661231 0.603504|0.487|0.6364 1.4247 2.7802 2.5973 1.7886 0.2407 1.6823 5.6588 20.7219 69.1109
In|6.196477 18.81618 4.050479 1.638929 17.96291 0.042072 6.695665 31.00979 103.2843 0.610714 0.333097|0.4065|0.6768 1.6589 2.774 3.1835 2.1326 0.2522 1.8545 6.2936 25.1457 84.5448
Sn|19.32517 6.281571 4.498866 1.856934 17.91732 6.118104 0.036915 32.52905 95.03719 0.565651 0.119024|0.6225|0.7224 1.961 2.7161 3.5603 1.8972 0.2651 2.0604 7.3011 27.5493 81.3349
Sb|5.394956 6.54957 19.65068 1.82782 17.86783 33.32652 0.030974 5.564929 87.13097 0.523992 -0.290506|0.557|0.7106 1.9247 2.6149 3.8322 1.8899 0.2562 1.9646 6.8852 24.7648 68.9168
Te|6.660302 6.940756 19.84701 1.557175 17.80243 33.03165 0.02575 5.065547 84.10162 0.48766 -0.806668|0.58|0.6947 1.869 2.5356 4.0013 1.8955 0.2459 1.8542 6.4411 22.173 59.2206
I|19.8845 6.736593 8.110516 1.170953 17.54872 4.628591 0.027754 31.8491 84.40639 0.46355 -0.448811|0.528|0.7047 1.9484 2.594 4.1526 1.5057 0.2455 1.8638 6.7639 21.8007 56.4395
Xe|19.97892 11.77495 9.332182 1.244749 17.7375 4.143356 0.010142 28.7962 75.28069 0.413616 -6.065902|0.492|0.6737 1.7908 2.4129 4.21 1.7058 0.2305 1.689 5.8218 18.3928 47.2496
Cs|17.41867 8.314444 10.32319 1.383834 19.87625 0.399828 0.016872 25.60583 233.3397 3.826915 -2.322802|0.542|1.2704 3.8018 5.6618 0.9205 4.8105 0.4356 4.2058 23.4342 136.7783 171.7561
Ba|19.74734 17.36848 10.46572 2.592602 11.00365 3.481823 0.371224 21.22664 173.8343 0.010719 -5.183497|0.507|0.9049 2.6076 4.8498 5.1603 4.7388 0.3066 2.4363 12.1821 54.6135 161.9978
La|19.96602 27.32965 11.01843 3.086696 17.33545 3.197408 0.003446 19.95549 141.382 0.341817 -21.74549|0.824|0.8405 2.3863 4.6139 5.1514 4.7949 0.2791 2.141 10.34 41.9148 132.0204
Ce|17.35512 43.9885 20.54665 3.13067 11.35366 0.328369 0.002047 3.088196 134.9077 18.83296 -38.38602|0.484|0.8551 2.3915 4.5772 5.0278 4.5118 0.2805 2.12 10.1808 42.0633 130.9893
Pr|21.55131 17.16173 11.90386 2.679103 9.564197 2.995675 0.312491 17.71671 152.1928 0.010468 -3.871068|0.458|0.9096 2.5313 4.5266 4.6376 4.369 0.2939 2.2471 10.8266 48.8842 147.602
Nd|17.33124 62.78392 12.1601 2.663483 22.23995 0.300269 0.00132 17.026 148.749 2.910268 -57.18984|0.769|0.8807 2.4183 4.4448 4.6858 4.1725 0.2802 2.0836 10.0357 47.4506 146.9976
Pm|17.28639 51.56016 12.47856 2.675515 22.96095 0.28662 0.00155 16.22376 143.9845 2.79648 -45.97368|1.26|0.9471 2.5463 4.3523 4.4789 3.908 0.2977 2.2276 10.5762 49.3619 145.358
Sm|23.70036 23.07221 12.77778 2.684217 17.20437 2.689539 0.003491 15.49544 139.8625 0.274536 -17.45217|0.08|0.9699 2.5837 4.2778 4.4575 3.5985 0.3003 2.2447 10.6487 50.7994 146.4179
Eu|17.1862 37.15684 13.10339 2.707246 24.41927 0.261678 0.001995 14.78736 134.8163 2.581883 -31.58669|0.722|0.8694 2.2413 3.9196 3.9694 4.5498 0.2653 1.859 8.3998 36.7397 125.7089
Gd|24.89812 17.10495 13.22258 3.266152 48.99521 2.435028 0.246961 13.99633 110.8631 0.001383 -43.50568|0.65|0.9673 2.4702 4.1148 4.4972 3.2099 0.2909 2.1014 9.7067 43.427 125.9474
Tb|25.91001 32.34414 13.76512 2.751404 17.06441 2.373912 0.002034 13.48197 125.8365 0.236916 -26.85197|0.738|0.9325 2.3673 3.8791 3.9674 3.7996 0.2761 1.9511 8.9296 41.5937 131.0122
Dy|26.67178 88.68758 14.06545 2.768497 17.06778 2.282593 0.000665 12.92023 121.9372 0.225531 -83.27983|1.69|0.9505 2.3705 3.8218 4.0471 3.4451 0.2773 1.9469 8.8862 43.0938 133.1396
Ho|27.15019 16.99982 14.05933 3.386979 46.54647 2.16966 0.215414 12.21315 100.5068 0.001211 -41.16525|0.801|0.9248 2.2428 3.6182 3.791 3.7912 0.266 1.8183 7.9655 33.1129 101.8139
Er|28.17489 82.49327 14.624 2.802756 17.01852 2.120995 0.00064 11.91526 114.5299 0.207519 -77.13522|0.779|1.0373 2.4824 3.6558 3.8925 3.0056 0.2944 2.0797 9.4156 45.8056 132.772
Tm|28.92589 76.1738 14.9047 2.814812 16.99812 2.046203 0.000656 11.46537 111.412 0.199376 -70.83981|0.707|1.0075 2.3787 3.544 3.6932 3.1759 0.2816 1.9486 8.7162 41.842 125.032
Yb|29.67676 65.62407 15.16085 2.830288 16.99785 1.97763 0.00072 11.04462 108.1392 0.19211 -60.31381|1.243|1.0347 2.3911 3.4619 3.6556 3.0052 0.2855 1.9679 8.7619 42.3304 125.6499
Lu|30.12287 15.09935 56.3149 3.54098 16.94373 1.88309 10.34276 0.00078 89.55925 0.183849 -51.04942|0.721|0.9927 2.2436 3.3554 3.7813 3.0994 0.2701 1.8073 7.8112 34.4849 103.3526
Hf|30.61703 15.14535 54.93355 4.096253 16.89616 1.795613 9.934469 0.000739 76.18971 0.175914 -49.71984|0.777|1.0295 2.2911 3.411 3.9497 2.4925 0.2761 1.8625 8.0961 34.2712 98.5295
Ta|31.06636 15.34182 49.2783 4.577665 16.82832 1.708732 9.618455 0.00076 66.3462 0.168002 -44.11903|0.691|1.019 2.2291 3.4097 3.9252 2.2679 0.2694 1.7962 7.6944 31.0942 91.1089
W|31.5079 15.6825 37.96013 4.885509 16.79211 1.629485 9.446448 0.000898 59.98067 0.160798 -32.86457|0.486|0.9853 2.1167 3.357 3.7981 2.2798 0.2569 1.6745 7.0098 26.9234 81.391
Re|31.88846 16.1171 42.3903 5.211669 16.76759 1.549238 9.233474 0.000689 54.51637 0.152815 -37.41268|0.92|0.9914 2.0858 3.4531 3.8812 1.8526 0.2548 1.6518 6.8845 26.7234 81.7215
Os|32.2103 16.67844 48.55991 5.455839 16.73553 1.473531 9.049695 0.000519 50.2102 0.145771 -43.67796|1.07|0.9813 2.0322 3.3665 3.6235 1.9741 0.2487 1.5973 6.4737 23.2817 70.9254
Ir|32.00444 1.975454 17.07011 15.93945 5.990003 1.353767 81.01417 0.128093 7.661196 26.6594 4.018893|1.06|1.0194 2.0645 3.4425 3.4914 1.6976 0.2554 1.6475 6.5966 23.2269 70.0272
Pt|31.27389 18.44544 17.06375 5.555933 1.57527 1.316992 8.797154 0.124741 40.17799 1.316997 4.050394|0.96|0.9148 1.8096 3.2134 3.2953 1.5754 0.2263 1.3813 5.3243 17.5987 60.0171
Au|16.77739 19.31716 32.97968 5.595453 10.57685 0.122737 8.62157 1.256902 38.00882 0.000601 -6.279078|0.763|0.9674 1.8916 3.3993 3.0524 1.2607 0.2358 1.4712 5.6758 18.7119 61.5286
Hg|16.83989 20.02382 28.42856 5.881564 4.714706 0.115905 8.256927 1.19525 39.24723 1.19525 4.076478|1.2692|1.0033 1.9469 3.4396 3.1548 1.418 0.2413 1.5298 5.8009 19.452 60.5753
Tl|16.63079 19.38662 32.80857 1.747191 6.356862 0.110704 7.181401 1.11973 90.66026 26.01498 4.066939|0.8776|1.0689 2.1038 3.6039 3.4927 1.8283 0.254 1.6715 6.3509 23.1531 78.7099
Pb|16.41957 32.73859 6.530247 2.342742 19.91647 0.105499 1.055049 25.02589 80.90659 6.664449 4.049824|0.9405|1.0891 2.1867 3.616 3.8031 1.8994 0.2552 1.7174 6.5131 23.917 74.7039
Bi|16.28227 32.72514 6.678302 2.69475 20.57656 0.10118 1.002287 25.71415 77.05755 6.291882 4.040914|0.8532|1.1007 2.2306 3.5689 4.1549 2.0382 0.2546 1.7351 6.4948 23.6464 70.378
Po|16.28916 32.80717 21.09516 2.505901 7.254589 0.098121 0.966265 6.046622 76.59807 28.09613 4.046556|0|1.1568 2.4353 3.6459 4.4064 1.7179 0.2648 1.8786 7.1749 25.1766 69.2821
At|16.01146 32.61555 8.113899 2.884082 21.37787 0.092639 0.904416 26.54326 68.37296 5.499512 3.995684|0|1.0909 2.1976 3.3831 4.67 2.1277 0.2466 1.6707 6.0197 20.7657 57.2663
Rn|16.07023 32.64111 21.48966 2.299218 9.480184 0.090437 0.876409 5.239687 69.18848 27.63264 4.020977|0|1.0756 2.163 3.3178 4.8852 2.0489 0.2402 1.6169 5.7644 19.4568 52.5009
Fr|16.00738 32.66383 21.59435 1.598497 11.12119 0.087031 0.840187 4.954467 199.8058 26.90511 4.003472|0|1.4282 3.5081 5.6767 4.1964 3.8946 0.3183 2.6889 13.4816 54.3866 200.8321
Ra|32.56369 21.39667 11.29809 2.834688 15.91497 0.80198 4.590666 22.75897 160.4044 0.083544 3.981773|1|1.3127 3.1243 5.2988 5.3891 5.4133 0.2887 2.2897 10.8276 43.5389 145.6109
Ac|15.91405 32.53504 21.55398 11.43339 3.612409 0.080511 0.770669 4.352206 21.38162 130.5007 3.939212|0|1.3128 3.1021 5.3385 5.9611 4.7562 0.2861 2.2509 10.5287 41.7796 128.2973
Th|15.78402 32.4549 21.84922 4.239077 11.73619 0.077067 0.735137 4.097976 109.4641 20.51214 3.922533|1.031|1.2553 2.9178 5.0862 6.1206 4.7122 0.2701 2.0636 9.3051 34.5977 107.92
Pa|32.74021 21.97368 12.9574 3.683832 15.74406 0.709545 4.050881 19.23154 117.255 0.07404 3.886066|0.91|1.3218 3.1444 5.4371 5.6444 4.0107 0.2827 2.225 10.2454 41.1162 124.4449
U|15.67928 32.82431 13.66046 3.687261 22.27943 0.071206 0.681177 18.23616 112.5 3.930325 3.854444|0.8417|1.3382 3.2043 5.4558 5.4839 3.6342 0.2838 2.2452 10.2519 41.7251 124.9023
Np|32.9999 22.63808 14.21997 3.67295 15.68324 0.657086 3.854918 17.43547 109.4645 0.068033 3.769391|1.055|1.5193 4.0053 6.5327 -0.1402 6.7489 0.3213 2.8206 14.8878 68.9103 81.7257
Pu|33.28118 23.14854 15.15376 3.031492 15.70421 0.634999 3.856168 16.84973 121.292 0.064857 3.6642|0|1.3517 3.2937 5.3213 4.6466 3.5714 0.2813 2.2418 9.9952 42.7939 132.1739
Am|33.43516 23.65726 15.57634 3.027023 15.7461 0.612785 3.792942 16.19578 117.757 0.061755 3.54116|0.83|1.2135 2.7962 4.7545 4.5731 4.4786 0.2483 1.8437 7.5421 29.3841 112.4579
Cm|15.80484 33.4808 24.1502 3.655563 15.49987 0.058619 0.59016 3.67472 100.7362 15.4083 3.39084|0|1.2937 3.11 5.0393 4.7546 3.5031 0.2638 2.0341 8.7101 35.2992 109.4972
D|0.413048 0.294953 0.187491 0.080701 0.023736 15.56995 32.39847 5.711404 61.88987 1.334118 0.000049|0.6671|0.0349 0.1201 0.197 0.0573 0.1195 0.5347 3.5867 12.3471 18.9525 38.6269
7Li|0.974637 0.158472 0.811855 0.262416 0.790108 4.334946 0.342451 97.10297 201.3638 1.409234 0.002542|-0.222|0.075 0.2249 0.5548 1.4954 0.9354 0.3864 2.9383 15.3829 53.5545 138.7337
`;
    let atomData = null;
    function atomOf(symbol) {
        if (!atomData) {
            atomData = new Map();
            for (const line of ATOM_TABLE.trim().split('\n')) {
                const [sym, x, n, e] = line.split('|');
                const nums = t => (t === '-' ? null : t.split(' ').map(Number));
                atomData.set(sym.toLowerCase(), { symbol: sym, x: nums(x), n: n === '-' ? null : Number(n), e: nums(e) });
            }
        }
        const a = atomData.get(String(symbol).trim().toLowerCase());
        if (!a) throw new Error(`unknown element "${symbol}"`);
        return a;
    }

    // The scattering amplitude of an atom at |Q| (X-ray and electron form
    // factors in electrons and Angstrom, neutron lengths in 10^-12 cm).
    function amplitudeOf(atom, radiation, q) {
        if (radiation === 'neutron') return atom.n;
        const c = radiation === 'xray' ? atom.x : atom.e;
        if (!c) throw new Error(`no ${radiation} form factor for ${atom.symbol}`);
        const s2 = (q / (4 * Math.PI)) ** 2;
        let f = radiation === 'xray' ? c[10] : 0;
        for (let i = 0; i < 5; i++) f += c[i] * Math.exp(-c[5 + i] * s2);
        return f;
    }

    // "Pb; Mg 0.333 + Nb 0.667; 3*O": sites apart by ';', each with an
    // optional count ("3*" or "3x"), its species apart by '+' or ',' with an
    // occupancy each (1 when left out; what is missing to 1 is vacancy).
    function parseSites(text) {
        const sites = [];
        for (const part of String(text || '').split(';')) {
            const t = part.trim();
            if (!t) continue;
            const m = /^(\d*\.?\d+)\s*[*x×]\s*(.+)$/i.exec(t);
            const count = m ? Number(m[1]) : 1, body = m ? m[2] : t;
            const species = body.split(/[+,]/).map(x => x.trim()).filter(Boolean).map(sp => {
                const [el, occ, extra] = sp.split(/[\s:]+/);
                const c = occ === undefined ? 1 : Number(occ);
                if (extra !== undefined || !(c >= 0 && c <= 1)) throw new Error(`composition: cannot read "${sp}" (an element and its occupancy)`);
                return { atom: atomOf(el), occ: c };
            });
            if (!(count > 0) || !species.length) throw new Error(`composition: cannot read the site "${t}"`);
            if (species.reduce((x, sp) => x + sp.occ, 0) > 1 + 1e-6) throw new Error(`composition: the occupancies of "${t}" add up to more than 1`);
            sites.push({ count, species });
        }
        if (!sites.length) throw new Error('composition: give the sites, e.g. "Pb; Mg 0.333 + Nb 0.667; 3*O"');
        return sites;
    }

    // "0.01" or "0.01, Pb 0.03, O 0.012": Uiso (A^2) for every element, and
    // per element.
    function parseUiso(text) {
        let all = NaN;
        const by = new Map();
        for (const part of String(text === undefined || text === null ? '' : text).split(/[,;]/)) {
            const t = part.trim().split(/[\s:]+/).filter(Boolean);
            if (!t.length) continue;
            if (t.length === 1 && Number.isFinite(Number(t[0]))) all = Number(t[0]);
            else if (t.length === 2 && Number.isFinite(Number(t[1]))) by.set(atomOf(t[0]).symbol.toLowerCase(), Number(t[1]));
            else throw new Error(`Uiso: cannot read "${part.trim()}"`);
        }
        return atom => {
            const key = atom.symbol.toLowerCase(), u = by.has(key) ? by.get(key) : all;
            if (!(u >= 0)) throw new Error(`Uiso: no value for ${atom.symbol}`);
            return u;
        };
    }

    // The diffuse scattering of uncorrelated disorder per formula unit, the
    // sum over sites of count x (<f^2> - <f exp(-W)>^2): compositional (Laue)
    // disorder of the species sharing a site, and thermal displacements
    // (f^2 (1 - exp(-2W)), 2W = Uiso Q^2: the intensity the Debye-Waller
    // factor takes from the Bragg peaks). Returns q -> [total, Laue part].
    function uncorrelatedCurve(sites, uiso, radiation) {
        return q => {
            let total = 0, laue = 0;
            for (const { count, species } of sites) {
                let f2 = 0, f1 = 0, f0 = 0;
                for (const { atom, occ } of species) {
                    const f = amplitudeOf(atom, radiation, q);
                    f2 += occ * f * f;
                    f1 += occ * f * Math.exp(-0.5 * uiso(atom) * q * q);
                    f0 += occ * f;
                }
                total += count * (f2 - f1 * f1);
                laue += count * (f2 - f0 * f0);
            }
            return [total, laue];
        };
    }

    // Level (a percentile of the finite values) of every |Q| shell of
    // `width` that holds data: [[q centre, level, voxels], ...].
    function shellLevels(model, cell, width, percentile) {
        const shell = new Int32Array(model.values.length).fill(-1);
        let nShells = 0;
        forEachQ(model, cell, (i, q) => {
            if (model.values[i] === model.values[i]) {
                shell[i] = Math.floor(q / width);
                if (shell[i] + 1 > nShells) nShells = shell[i] + 1;
            }
        });
        const counts = new Int32Array(nShells + 1);
        for (let i = 0; i < shell.length; i++) if (shell[i] >= 0) counts[shell[i] + 1]++;
        for (let s = 0; s < nShells; s++) counts[s + 1] += counts[s];
        const sorted = new Float64Array(counts[nShells]);
        const fill = counts.slice(0, nShells);
        for (let i = 0; i < shell.length; i++) if (shell[i] >= 0) sorted[fill[shell[i]]++] = model.values[i];
        const out = [];
        for (let s = 0; s < nShells; s++) {
            const part = sorted.subarray(counts[s], counts[s + 1]).sort();
            if (!part.length) continue;
            const p = Math.min(1, Math.max(0, percentile / 100)) * (part.length - 1);
            const lo = Math.floor(p);
            out.push([(s + 0.5) * width, part[lo] + (p - lo) * (part[Math.min(part.length - 1, lo + 1)] - part[lo]), part.length]);
        }
        return out;
    }

    // Background of uncorrelated disorder (Laue and thermal diffuse, with
    // Debye-Waller factors) for a composition, scaled to the floor of the
    // data (a low percentile of each |Q| shell, by least squares, with an
    // offset if asked) or by a given scale, and subtracted.
    function stepBackgroundDebyeWaller(model, step, ctx) {
        needCell(ctx.cell, 'a Laue and thermal background');
        const radiation = step.radiation === 'auto' ? model.radiation : step.radiation;
        if (!['xray', 'neutron', 'electron'].includes(radiation)) {
            throw new Error('the radiation of the data is not known; choose X-ray, neutron or electron');
        }
        const curve = uncorrelatedCurve(parseSites(step.composition), parseUiso(step.uiso), radiation);
        let scale = step.scale, offset = 0;
        if (step.fit) {
            const shells = shellLevels(model, ctx.cell, step.width, step.percentile).filter(s => s[2] >= 20 && s[0] > 0);
            let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
            for (const [q, level] of shells) {
                const x = curve(q)[0];
                n++;
                sx += x;
                sy += level;
                sxx += x * x;
                sxy += x * level;
            }
            if (n < 3) throw new Error('too few |Q| shells with data to fit the scale');
            if (step.offset) {
                const det = n * sxx - sx * sx;
                if (!(det > 1e-9 * n * sxx)) throw new Error('the background does not change with |Q|; fit without the offset');
                scale = (n * sxy - sx * sy) / det;
                offset = (sy - scale * sx) / n;
            } else {
                scale = sxx > 0 ? sxy / sxx : 0;
            }
            ctx.log(`scale fitted to the ${step.percentile}th percentile of ${n} |Q| shells: ${+scale.toPrecision(5)}` +
                (step.offset ? `, offset ${+offset.toPrecision(5)}` : ''));
        }
        const at = [1, 3, 6].map(q => {
            const [t, l] = curve(q);
            return `${q}: ${+(scale * t).toPrecision(4)} (Laue ${t > 0 ? Math.round(100 * l / t) : 0} %)`;
        });
        ctx.log(`${radiation} background at |Q| ${at.join(', ')} 1/A`);
        return subtractCurve(model, ctx.cell, q => scale * curve(q)[0] + offset);
    }

    // ---------------------------------------------------------- UB correction

    // Solve the n x n system M x = y (Gaussian elimination with pivoting).
    function solveSmall(M, y) {
        const n = y.length, A = M.map((row, i) => row.concat([y[i]]));
        for (let c = 0; c < n; c++) {
            let p = c;
            for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
            if (!(Math.abs(A[p][c]) > 1e-300)) return null;
            [A[c], A[p]] = [A[p], A[c]];
            for (let r = 0; r < n; r++) {
                if (r === c) continue;
                const f = A[r][c] / A[c][c];
                for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
            }
        }
        return A.map((row, i) => row[n] / row[i]);
    }

    // Bragg peaks near the integer hkl the centring allows: in a box of
    // half-width `radius` (r.l.u.) around each, the voxels above half the
    // height over the box median give an intensity-weighted centroid. Peaks
    // stand out by `snr` robust sigma of the box (1.4826 x its median
    // absolute deviation). Returns the strongest `count`: { at, hkl, height }.
    function findBraggPeaks(model, step) {
        const allowed = CENTRING[step.centring];
        if (!allowed) throw new Error(`unknown centring ${step.centring}`);
        const M = gridMatrix(model), Minv = invert3(M), [nh, nk, nl] = model.dims, v = model.values;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const i of [0, nh - 1]) for (const j of [0, nk - 1]) for (const k of [0, nl - 1]) {
            const p = mulMV(M, [i, j, k]).map((x, c) => x + model.corner[c]);
            p.forEach((x, c) => { lo[c] = Math.min(lo[c], x); hi[c] = Math.max(hi[c], x); });
        }
        const r = step.radius, peaks = [];
        const box = [], idx = [];
        for (let H = Math.ceil(lo[0]); H <= Math.floor(hi[0]); H++)
            for (let K = Math.ceil(lo[1]); K <= Math.floor(hi[1]); K++)
                for (let L = Math.ceil(lo[2]); L <= Math.floor(hi[2]); L++) {
                    if ((!H && !K && !L) || !allowed(H, K, L)) continue;
                    // the index box of the hkl box
                    const ilo = [Infinity, Infinity, Infinity], ihi = [-Infinity, -Infinity, -Infinity];
                    for (const dh of [-r, r]) for (const dk of [-r, r]) for (const dl of [-r, r]) {
                        mulMV(Minv, [H + dh - model.corner[0], K + dk - model.corner[1], L + dl - model.corner[2]]).forEach((f, a) => {
                            ilo[a] = Math.min(ilo[a], f);
                            ihi[a] = Math.max(ihi[a], f);
                        });
                    }
                    const a0 = [0, 1, 2].map(a => Math.max(0, Math.ceil(ilo[a] - 1e-9))), a1 = [0, 1, 2].map(a => Math.min(model.dims[a] - 1, Math.floor(ihi[a] + 1e-9)));
                    if (a0.some((x, a) => x > a1[a])) continue;
                    box.length = 0;
                    idx.length = 0;
                    for (let k = a0[2]; k <= a1[2]; k++)
                        for (let j = a0[1]; j <= a1[1]; j++)
                            for (let i = a0[0]; i <= a1[0]; i++) {
                                const at = (k * nk + j) * nh + i, x = v[at];
                                if (x !== x) continue;
                                const p = [0, 1, 2].map(c => model.corner[c] + M[c][0] * i + M[c][1] * j + M[c][2] * k);
                                if (Math.abs(p[0] - H) > r || Math.abs(p[1] - K) > r || Math.abs(p[2] - L) > r) continue;
                                box.push(x);
                                idx.push(i, j, k);
                            }
                    if (box.length < 27) continue;
                    const vals = Float64Array.from(box), med = medianOf(Float64Array.from(vals), vals.length);
                    const spread = 1.4826 * medianOf(Float64Array.from(vals, x => Math.abs(x - med)), vals.length);
                    let top = -Infinity;
                    for (const x of vals) top = Math.max(top, x);
                    const height = top - med;
                    if (!(height > step.snr * Math.max(spread, 1e-12 * Math.abs(med)))) continue;
                    let sw = 0;
                    const c = [0, 0, 0];
                    for (let n = 0; n < vals.length; n++) {
                        const w = vals[n] - med - 0.5 * height;
                        if (w <= 0) continue;
                        const [i, j, k] = [idx[3 * n], idx[3 * n + 1], idx[3 * n + 2]];
                        for (let a = 0; a < 3; a++) c[a] += w * (model.corner[a] + M[a][0] * i + M[a][1] * j + M[a][2] * k);
                        sw += w;
                    }
                    if (sw > 0) peaks.push({ at: c.map(x => x / sw), hkl: [H, K, L], height });
                }
        return peaks.sort((a, b) => b.height - a.height).slice(0, step.peaks);
    }

    // hkl_true = A hkl_found (+ t): least squares over the peaks, then once
    // more without those off by more than 3 x the median miss.
    function fitPeakMap(peaks, shift) {
        const solve = list => {
            const m = shift ? 4 : 3, rows = list.map(p => (shift ? p.at.concat([1]) : p.at));
            const N = Array.from({ length: m }, () => new Array(m).fill(0));
            const A = [], t = [0, 0, 0];
            for (let c = 0; c < 3; c++) {
                const y = new Array(m).fill(0);
                for (let n = 0; n < rows.length; n++) {
                    for (let a = 0; a < m; a++) {
                        y[a] += rows[n][a] * list[n].hkl[c];
                        if (c === 0) for (let b = 0; b < m; b++) N[a][b] += rows[n][a] * rows[n][b];
                    }
                }
                const x = solveSmall(N, y);
                if (!x) return null;
                A.push(x.slice(0, 3));
                if (shift) t[c] = x[3];
            }
            return { A, t };
        };
        const miss = (fit, p) => Math.hypot(...mulMV(fit.A, p.at).map((x, c) => x + fit.t[c] - p.hkl[c]));
        let fit = solve(peaks);
        if (!fit) return null;
        const d = peaks.map(p => miss(fit, p)), lim = 3 * medianOf(Float64Array.from(d), d.length);
        const kept = peaks.filter((p, n) => d[n] <= lim || lim === 0);
        if (kept.length >= (shift ? 6 : 5) && kept.length < peaks.length) fit = solve(kept) || fit;
        return Object.assign(fit, { used: kept.length, rms: Math.sqrt(kept.reduce((s, p) => s + miss(fit, p) ** 2, 0) / kept.length) });
    }

    // Put the Bragg peaks back on integer hkl: mode 'refine' fits the map
    // from where the peaks are to where they belong (linear, as a wrong UB
    // gives; with `shift`, affine); mode 'matrix' takes the UB the grid was
    // made with (`ub`, else the data's) and the right one (`ubNew`). The
    // volume is then resampled on its own grid, value(hkl) = old value at
    // A^-1 (hkl - t); the model's UB is corrected with it.
    function stepCorrectUB(model, step, ctx) {
        let A, t = [0, 0, 0];
        if (step.mode === 'matrix') {
            const old = step.ub && step.ub.length === 9 ? [step.ub.slice(0, 3), step.ub.slice(3, 6), step.ub.slice(6, 9)] : model.ub;
            if (!old) throw new Error('matrix mode needs the UB the grid was made with (the data have none)');
            if (!(step.ubNew && step.ubNew.length === 9)) throw new Error('matrix mode needs the corrected UB (9 numbers, row by row)');
            const neu = [step.ubNew.slice(0, 3), step.ubNew.slice(3, 6), step.ubNew.slice(6, 9)];
            A = mulMM(invert3(neu), old);
        } else {
            const peaks = findBraggPeaks(model, step);
            if (peaks.length < (step.shift ? 6 : 5)) {
                throw new Error(`${peaks.length} Bragg peaks found; the fit needs more (a larger search radius, a lower signal-to-noise, or no Bragg mask before this step)`);
            }
            const before = Math.sqrt(peaks.reduce((s, p) => s + p.at.reduce((x, y, c) => x + (y - p.hkl[c]) ** 2, 0), 0) / peaks.length);
            const fit = fitPeakMap(peaks, step.shift);
            if (!fit) throw new Error('the peaks do not fix the map (they lie in one plane)');
            ({ A, t } = fit);
            ctx.log(`${peaks.length} Bragg peaks, ${fit.used} used: rms miss of integer hkl ${before.toFixed(4)} -> ${fit.rms.toFixed(4)} r.l.u.`);
        }
        const fmt = x => (Math.abs(x) < 5e-7 ? '0' : x.toFixed(6));
        ctx.log(`hkl = A hkl_grid${step.shift ? ' + t' : ''}, A = [${A.map(r => r.map(fmt).join(' ')).join('; ')}]` +
            (step.shift ? `, t = [${t.map(fmt).join(' ')}]` : ''));
        const Ai = invert3(A);
        const sample = sampler(model), sampleSigma = model.sigma ? sampler(Object.assign({}, model, { values: model.sigma })) : null;
        const values = newValues(model, model.values.length), sigma = sampleSigma ? newValues(model, values.length) : undefined;
        forEachHkl(model, (i, h, k, l) => {
            const p = mulMV(Ai, [h - t[0], k - t[1], l - t[2]]);
            values[i] = sample(p[0], p[1], p[2]);
            if (sigma) sigma[i] = sampleSigma(p[0], p[1], p[2]);
        });
        const changes = { sigma };
        if (model.ub) {
            changes.ub = mulMM(model.ub, Ai);
            ctx.log(`corrected UB = [${changes.ub.map(r => r.map(x => x.toPrecision(6)).join(' ')).join('; ')}]`);
        }
        return withValues(model, values, changes);
    }

    // ------------------------------------------------- despike, window, |Q| mask

    // The k-th smallest of a[0..n) (reorders a).
    function select(a, n, k) {
        let lo = 0, hi = n - 1;
        while (lo < hi) {
            const pivot = a[(lo + hi) >> 1];
            let i = lo, j = hi;
            while (i <= j) {
                while (a[i] < pivot) i++;
                while (a[j] > pivot) j--;
                if (i <= j) {
                    const t = a[i];
                    a[i] = a[j];
                    a[j] = t;
                    i++;
                    j--;
                }
            }
            if (k <= j) hi = j;
            else if (k >= i) lo = i;
            else return a[k];
        }
        return a[k];
    }
    const quickMedian = (a, n) => (n % 2 ? select(a, n, n >> 1) : 0.5 * (select(a, n, n / 2 - 1) + select(a, n, n / 2)));

    // Spikes out: a voxel more than k robust sigma (1.4826 x the median
    // absolute deviation) from the median of its neighbourhood (3 x 3 x 3,
    // or 5 x 5 x 5 with size 2) takes that median; with k = 0 every voxel
    // does (a median filter). Empty voxels stay empty; a replaced voxel
    // loses its uncertainty.
    async function stepDespike(model, step, ctx) {
        const [nh, nk, nl] = model.dims, v = model.values, r = step.size;
        const values = copyValues(model), sigma = model.sigma ? model.sigma.slice() : undefined;
        const box = new Float64Array((2 * r + 1) ** 3), dev = new Float64Array(box.length);
        let replaced = 0, i = 0;
        for (let il = 0; il < nl; il++) {
            for (let ik = 0; ik < nk; ik++) {
                for (let ih = 0; ih < nh; ih++, i++) {
                    const x = v[i];
                    if (x !== x) continue;
                    let n = 0;
                    for (let c = Math.max(0, il - r); c <= Math.min(nl - 1, il + r); c++)
                        for (let b = Math.max(0, ik - r); b <= Math.min(nk - 1, ik + r); b++) {
                            const row = (c * nk + b) * nh;
                            for (let a = Math.max(0, ih - r); a <= Math.min(nh - 1, ih + r); a++) {
                                const y = v[row + a];
                                if (y === y) box[n++] = y;
                            }
                        }
                    if (n < 3) continue;
                    const med = quickMedian(box, n);
                    if (step.k > 0) {
                        for (let t = 0; t < n; t++) dev[t] = Math.abs(box[t] - med);
                        const lim = step.k * 1.4826 * quickMedian(dev, n);
                        if (!(Math.abs(x - med) > lim)) continue;
                    }
                    if (values[i] !== med) {
                        values[i] = med;
                        if (sigma) sigma[i] = NaN;
                        replaced++;
                    }
                }
            }
            if (ctx.tick && il % 4 === 3) await ctx.tick();
        }
        ctx.log(`${replaced} voxels ${step.k > 0 ? `beyond ${step.k} robust sigma of their neighbours ` : ''}set to the median around them`);
        return withValues(model, values, { sigma });
    }

    // The largest |Q| of a whole sphere about Q = 0 inside the grid's box
    // (0 when the box does not hold Q = 0).
    function inscribedQ(model, cell) {
        const Q = qMatrix(cell), M = gridMatrix(model), QM = mulMM(Q, M);
        const f0 = mulMV(invert3(M), model.corner.map(x => -x));       // Q = 0 in grid indices
        let best = Infinity;
        for (let a = 0; a < 3; a++) {
            if (model.dims[a] <= 1) continue;
            if (f0[a] < 0 || f0[a] > model.dims[a] - 1) return 0;
            // distance from Q = 0 to the faces index_a = 0 and dims - 1: the
            // plane's normal is row a of (QM)^-1
            const row = invert3(QM)[a], len = Math.hypot(...row);
            best = Math.min(best, f0[a] / len, (model.dims[a] - 1 - f0[a]) / len);
        }
        return best === Infinity ? 0 : best;
    }

    // A window in |Q| against truncation ripples in a 3D-ΔPDF: Lorch
    // (sin x / x, x = pi |Q| / qmax), Hann ((1 + cos(pi |Q| / qmax)) / 2),
    // Gaussian (exp(-|Q|^2 / 2 s^2), s = qmax / 3) or a sphere (1 inside);
    // voxels beyond qmax become empty (0 for the ΔPDF). qmax 0: the largest
    // sphere inside the grid.
    function stepWindow(model, step, ctx) {
        needCell(ctx.cell, 'a |Q| window');
        const qmax = step.qmax > 0 ? step.qmax : inscribedQ(model, ctx.cell);
        if (!(qmax > 0)) throw new Error('the grid does not hold |Q| = 0; give qmax');
        const f = {
            lorch: q => (q > 0 ? Math.sin(Math.PI * q / qmax) / (Math.PI * q / qmax) : 1),
            hann: q => 0.5 * (1 + Math.cos(Math.PI * q / qmax)),
            gauss: q => Math.exp(-0.5 * (3 * q / qmax) ** 2),
            sphere: () => 1,
        }[step.kind];
        const values = copyValues(model), sigma = model.sigma ? model.sigma.slice() : undefined;
        let outside = 0;
        forEachQ(model, ctx.cell, (i, q) => {
            if (q > qmax) {
                if (values[i] === values[i]) outside++;
                values[i] = NaN;
                if (sigma) sigma[i] = NaN;
                return;
            }
            const w = f(q);
            values[i] *= w;
            if (sigma) sigma[i] *= w;
        });
        ctx.log(`${step.kind} window to |Q| ${+qmax.toPrecision(5)} 1/A; ${outside} voxels beyond it emptied`);
        return withValues(model, values, { sigma });
    }

    // Voxels outside min <= |Q| <= max (1/A) become empty: the beam stop,
    // the corners of the grid.
    function stepMaskQ(model, step, ctx) {
        needCell(ctx.cell, 'a |Q| range mask');
        const lo = step.min === undefined || step.min === null ? -Infinity : step.min;
        const hi = step.max === undefined || step.max === null ? Infinity : step.max;
        const values = copyValues(model);
        let masked = 0;
        forEachQ(model, ctx.cell, (i, q) => {
            if ((q < lo || q > hi) && values[i] === values[i]) {
                values[i] = NaN;
                masked++;
            }
        });
        ctx.log(`${masked} voxels masked`);
        return withValues(model, values);
    }

    // Combine with another volume, sampled onto this grid.
    function stepCombine(model, step, ctx) {
        const other = ctx.extras && ctx.extras[step.file];
        if (!other) throw new Error(`combine: no loaded volume named "${step.file}"`);
        const values = copyValues(model);
        let get, getSigma = null;
        if (sameGrid(model, other)) {
            get = i => other.values[i];
            if (other.sigma) getSigma = i => other.sigma[i];
        } else {
            const onGrid = src => {
                const sample = sampler(Object.assign({}, other, { values: src }));
                const at = new Float64Array(values.length);
                forEachHkl(model, (i, h, k, l) => { at[i] = sample(h, k, l); });
                return at;
            };
            const at = onGrid(other.values), atSigma = other.sigma ? onGrid(other.sigma) : null;
            get = i => at[i];
            if (atSigma) getSigma = i => atSigma[i];
            ctx.log(`"${step.file}" is on a different grid; sampled trilinearly onto this one`);
        }
        const s = step.scale;
        const ops = {
            subtract: (x, y) => x - s * y,
            add: (x, y) => x + s * y,
            multiply: (x, y) => x * s * y,
            divide: (x, y) => (y !== 0 ? x / (s * y) : NaN),
        };
        // Standard uncertainties in quadrature, the other volume's too.
        const spread = {
            subtract: (x, y, sx, sy) => Math.hypot(sx, s * sy),
            add: (x, y, sx, sy) => Math.hypot(sx, s * sy),
            multiply: (x, y, sx, sy) => Math.abs(s) * Math.hypot(sx * y, x * sy),
            divide: (x, y, sx, sy) => (y !== 0 ? Math.hypot(sx / (s * y), x * sy / (s * y * y)) : NaN),
        };
        const op = ops[step.operation];
        if (!op) throw new Error(`combine: operation must be subtract, add, multiply or divide`);
        let sigma = model.sigma;
        if (model.sigma || getSigma) {
            sigma = newValues(model, values.length);
            const f = spread[step.operation];
            for (let i = 0; i < values.length; i++) {
                sigma[i] = f(model.values[i], get(i), model.sigma ? model.sigma[i] : 0, getSigma ? getSigma(i) : 0);
            }
        }
        for (let i = 0; i < values.length; i++) values[i] = op(values[i], get(i));
        return withValues(model, values, { sigma });
    }

    function stepClip(model, step, ctx) {
        const values = copyValues(model);
        const to = step.to === 'nan' ? NaN : step.to;
        let n = 0;
        for (let i = 0; i < values.length; i++) {
            if (values[i] < step.below) {
                values[i] = to;
                n++;
            }
        }
        ctx.log(`${n} voxels below ${step.below} set to ${to}`);
        return withValues(model, values);
    }

    // For each row (jk, jl) of a target grid, fn(n0, n1, idx, stride) over
    // the jh range whose source index A j + T lies inside the source grid:
    // n0..n1 are target indices, idx the source index at n0 and stride its
    // step along jh. The inner loops then need no bounds checks.
    function forEachMappedRow(sdims, tdims, A, T, fn) {
        const [sh, sk] = sdims, [th, tk, tl] = tdims;
        const d = [A[0][0], A[1][0], A[2][0]];
        const stride = (d[2] * sk + d[1]) * sh + d[0];
        const b = [0, 0, 0];
        let row = 0;
        for (let jl = 0; jl < tl; jl++) {
            for (let jk = 0; jk < tk; jk++, row += th) {
                let lo = 0, hi = th - 1;
                for (let a = 0; a < 3; a++) {
                    b[a] = T[a] + A[a][1] * jk + A[a][2] * jl;
                    if (d[a] > 0) {
                        lo = Math.max(lo, Math.ceil(-b[a] / d[a]));
                        hi = Math.min(hi, Math.floor((sdims[a] - 1 - b[a]) / d[a]));
                    } else if (d[a] < 0) {
                        lo = Math.max(lo, Math.ceil((sdims[a] - 1 - b[a]) / d[a]));
                        hi = Math.min(hi, Math.floor(-b[a] / d[a]));
                    } else if (b[a] < 0 || b[a] >= sdims[a]) {
                        hi = -1;
                    }
                }
                if (lo <= hi) fn(row + lo, row + hi, ((b[2] + d[2] * lo) * sk + (b[1] + d[1] * lo)) * sh + (b[0] + d[0] * lo), stride);
            }
        }
    }

    // Index-space action of an operation G on a grid: the voxel j maps to
    // the source index A j + T (integers when G maps grid points onto grid
    // points), and whether every voxel lands inside the grid.
    function gridAction(model, G, M, Minv, target) {
        const near = x => Math.abs(x - Math.round(x)) < 1e-6;
        const t = target || model;
        const A = mulMM(Minv, mulMM(G, M));
        const T = mulMV(Minv, mulMV(G, t.corner).map((x, c) => x - model.corner[c]));
        if (!A.every(r => r.every(near)) || !T.every(near)) return null;
        const map = { A: A.map(r => r.map(Math.round)), T: T.map(Math.round), closed: true };
        for (let a = 0; a < 8; a++) {
            const j = [a & 1, (a >> 1) & 1, (a >> 2) & 1].map((bit, k) => bit * (t.dims[k] - 1));
            const i = mulMV(map.A, j).map((x, k) => x + map.T[k]);
            if (i.some((x, k) => x < 0 || x > model.dims[k] - 1)) map.closed = false;
        }
        return map;
    }

    // How many operations of the group fix each voxel: 1 at a general
    // position, more on mirror planes and axes. Sums over the whole group
    // meet each distinct image of such a voxel that many times, which an
    // uncertainty has to undo: sigma of the mean = sqrt(m sum sigma^2) / count.
    // Per grid row an operation fixes every voxel, one voxel or none.
    function stabilizerCounts(model, laue, space) {
        const ops = laueOperations(laue, space);
        const M = gridMatrix(model), Minv = invert3(M);
        const [nh, nk, nl] = model.dims;
        const m = new Uint8Array(nh * nk * nl);
        // voxels jh in [lo, hi] with a * jh = r
        const solve = (a, r, range) => {
            if (a === 0) {
                if (r !== 0) range[1] = -1;
            } else if (r % a !== 0) {
                range[1] = -1;
            } else {
                const x = r / a;
                range[0] = Math.max(range[0], x);
                range[1] = Math.min(range[1], x);
            }
        };
        for (const G of ops) {
            const map = gridAction(model, G, M, Minv);
            if (!map) continue;
            const { A, T } = map;
            let row = 0;
            for (let jl = 0; jl < nl; jl++) {
                for (let jk = 0; jk < nk; jk++, row += nh) {
                    const range = [0, nh - 1];
                    solve(A[0][0] - 1, -(T[0] + A[0][1] * jk + A[0][2] * jl), range);
                    solve(A[1][0], jk - (T[1] + A[1][1] * jk + A[1][2] * jl), range);
                    solve(A[2][0], jl - (T[2] + A[2][1] * jk + A[2][2] * jl), range);
                    for (let jh = range[0]; jh <= range[1]; jh++) m[row + jh]++;
                }
            }
        }
        return m;
    }

    // Sums of each array over the images g.x of every voxel x under a Laue
    // group, on the model's own grid; images outside the grid add nothing.
    // When every operation maps the grid onto itself the sums run level by
    // level down the subgroup chain (11 passes instead of 48 for m-3m), else
    // operation by operation. The arrays are used as buffers and overwritten.
    // Returns { sums, skipped }.
    async function groupSums(model, laue, space, arrays, ctx, everyOperation) {
        const ops = laueOperations(laue, space);
        const M = gridMatrix(model), Minv = invert3(M);
        const maps = ops.map(G => gridAction(model, G, M, Minv));
        const skipped = maps.filter(m => !m).length;
        // dst[k][n] += src[k][idx] along a row; the common two and three
        // array cases get their own loops so each stays monomorphic.
        const adder = (dst, src) => {
            if (dst.length === 2) {
                const [d0, d1] = dst, [s0, s1] = src;
                return (n, end, idx, stride) => {
                    for (; n <= end; n++, idx += stride) {
                        d0[n] += s0[idx];
                        d1[n] += s1[idx];
                    }
                };
            }
            if (dst.length === 3) {
                const [d0, d1, d2] = dst, [s0, s1, s2] = src;
                return (n, end, idx, stride) => {
                    for (; n <= end; n++, idx += stride) {
                        d0[n] += s0[idx];
                        d1[n] += s1[idx];
                        d2[n] += s2[idx];
                    }
                };
            }
            return (n, end, idx, stride) => {
                for (let k = 0; k < dst.length; k++) {
                    const d = dst[k], sk = src[k];
                    for (let i = n, j = idx; i <= end; i++, j += stride) d[i] += sk[j];
                }
            };
        };
        if (!everyOperation && maps.every(m => m && m.closed)) {
            let cur = arrays, nxt = arrays.map(a => new a.constructor(a.length));
            for (const reps of laueChain(laue, space)) {
                for (const a of nxt) a.fill(0);
                const add = adder(nxt, cur);
                for (const G of reps) {
                    const m = gridAction(model, G, M, Minv);
                    forEachMappedRow(model.dims, model.dims, m.A, m.T, add);
                    if (ctx.tick) await ctx.tick();
                }
                [cur, nxt] = [nxt, cur];
            }
            return { sums: cur, skipped };
        }
        const sums = arrays.map(a => new a.constructor(a.length));
        const add = adder(sums, arrays);
        for (const m of maps) {
            if (!m) continue;
            forEachMappedRow(model.dims, model.dims, m.A, m.T, add);
            if (ctx.tick) await ctx.tick();
        }
        return { sums, skipped };
    }

    // Average over the Laue-equivalent grid points (NaN-aware). mode 'fill'
    // keeps measured values and fills only NaN voxels; 'median' takes the
    // median of the equivalents and 'clip' their mean without those more
    // than k robust sigma (1.4826 x the median absolute deviation) from the
    // median, so spikes and spurious peaks in one equivalent drop out.
    // expand extends the grid to the symmetric images of its range (e.g. a
    // half volume); a grid that already holds them stays as it is.
    // Direct-space data (a 3D-ΔPDF) use the operations on u, v, w. sigma
    // becomes that of the mean, sqrt(sum sigma^2) / n.
    async function stepSymmetrize(model, step, ctx) {
        const space = model.axesType === 'uvw' ? 'direct' : 'reciprocal';
        const src = model.values, sg = model.sigma;
        const N0 = src.length;
        const extended = step.expand ? expandedGrid(model, step.laue, space, ctx) : null;
        if (step.mode === 'median' || step.mode === 'clip') return robustSymmetrize(model, extended || model, step, space, ctx);
        let target = model, sum, cnt, q;
        if (!extended) {
            const x0 = new Float64Array(N0), c0 = new Uint8Array(N0), q0 = sg ? new Float64Array(N0) : null;
            for (let i = 0; i < N0; i++) {
                const x = src[i];
                if (x === x) {
                    x0[i] = x;
                    c0[i] = 1;
                    if (q0) q0[i] = sg[i] * sg[i];
                }
            }
            const { sums, skipped } = await groupSums(model, step.laue, space, q0 ? [x0, c0, q0] : [x0, c0], ctx,
                ctx.symmetrizeEveryOperation);
            if (skipped) ctx.log(`${skipped} of the operations do not map the grid onto itself and are skipped`);
            [sum, cnt, q] = sums;
        } else {
            const ops = laueOperations(step.laue, space);
            const M = gridMatrix(model), Minv = invert3(M);
            target = extended;
            const dims = target.dims;
            const Nt = dims[0] * dims[1] * dims[2];
            sum = new Float64Array(Nt);
            cnt = new Int32Array(Nt);
            q = sg ? new Float64Array(Nt) : null;
            for (const G of ops) {
                const m = gridAction(model, G, M, Minv, target);
                if (!m) continue;
                forEachMappedRow(model.dims, target.dims, m.A, m.T, (n, end, idx, stride) => {
                    for (; n <= end; n++, idx += stride) {
                        const x = src[idx];
                        if (x === x) {
                            sum[n] += x;
                            cnt[n]++;
                            if (q) q[n] += sg[idx] * sg[idx];
                        }
                    }
                });
                if (ctx.tick) await ctx.tick();
            }
        }
        const [sh, sk, sl] = model.dims;
        const [th, tk, tl] = target.dims;
        const out = newValues(model, th * tk * tl);
        const outSigma = sg ? newValues(model, out.length) : undefined;
        const mult = sg ? stabilizerCounts(target, step.laue, space) : null;
        const keep = step.mode === 'fill';
        const M = gridMatrix(model), Minv = invert3(M);
        const oi = keep ? mulMV(Minv, target.corner.map((x, c) => x - model.corner[c])).map(Math.round) : null;
        let n = 0, filled = 0;
        for (let jl = 0; jl < tl; jl++)
            for (let jk = 0; jk < tk; jk++)
                for (let jh = 0; jh < th; jh++, n++) {
                    let own = NaN, at = -1;
                    if (keep) {
                        const i0 = oi[0] + jh, i1 = oi[1] + jk, i2 = oi[2] + jl;
                        if (i0 >= 0 && i0 < sh && i1 >= 0 && i1 < sk && i2 >= 0 && i2 < sl) {
                            at = (i2 * sk + i1) * sh + i0;
                            own = src[at];
                        }
                    }
                    if (own === own) {
                        out[n] = own;
                        if (outSigma) outSigma[n] = sg[at];
                    } else {
                        out[n] = cnt[n] ? sum[n] / cnt[n] : NaN;
                        if (outSigma) outSigma[n] = cnt[n] ? Math.sqrt(q[n] * mult[n]) / cnt[n] : NaN;
                        if (cnt[n]) filled++;
                    }
                }
        if (keep) ctx.log(`${filled} empty voxels filled`);
        return withValues(target, out, { symmetrized: 'laue', laueGroup: step.laue, sigma: outSigma });
    }

    // The grid over the box of the images of this one under the group, or
    // null when that box is the grid itself (nothing to extend).
    function expandedGrid(model, laue, space, ctx) {
        const ops = laueOperations(laue, space);
        const M = gridMatrix(model), Minv = invert3(M);
        const maps = ops.map(G => gridAction(model, G, M, Minv));
        const usable = maps.filter(Boolean).length;
        if (usable < ops.length) {
            ctx.log(`${ops.length - usable} of the ${ops.length} operations do not map the grid onto itself and are skipped`);
        }
        // Bounding box (in grid indices) of the images of the grid corners.
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        ops.forEach((G, g) => {
            if (!maps[g]) return;
            for (let a = 0; a < 8; a++) {
                const idx = [a & 1, (a >> 1) & 1, (a >> 2) & 1].map((bit, k) => bit * (model.dims[k] - 1));
                const p = mulMV(M, idx).map((x, c) => x + model.corner[c]);
                mulMV(Minv, mulMV(G, p).map((x, c) => x - model.corner[c])).forEach((x, k) => {
                    lo[k] = Math.min(lo[k], Math.round(x));
                    hi[k] = Math.max(hi[k], Math.round(x));
                });
            }
        });
        // a single layer stays one: images off its plane are left out
        for (let a = 0; a < 3; a++) {
            if (model.dims[a] <= 1) lo[a] = hi[a] = 0;
        }
        if (lo.every(x => x === 0) && hi.every((x, a) => x === model.dims[a] - 1)) return null;
        const dims = [0, 1, 2].map(a => hi[a] - lo[a] + 1);
        if (dims.some((n, a) => n > 4 * model.dims[a] + 1)) throw new Error('symmetrize: the expanded grid is unreasonably large');
        const corner = [0, 1, 2].map(c => model.corner[c] + lo[0] * M[c][0] * (model.dims[0] > 1 ? 1 : 0) +
            lo[1] * M[c][1] * (model.dims[1] > 1 ? 1 : 0) + lo[2] * M[c][2] * (model.dims[2] > 1 ? 1 : 0));
        ctx.log(`grid extended from ${model.dims.join(' x ')} to ${dims.join(' x ')}`);
        return Object.assign({}, model, {
            dims, corner, vectors: model.vectors.map((v, a) => (dims[a] > 1 ? M.map(r => r[a]) : [0, 0, 0])),
        });
    }

    // Median of the first n values of a (reordered in place).
    function medianOf(a, n) {
        const part = a.subarray(0, n).sort();
        return n % 2 ? part[(n - 1) >> 1] : 0.5 * (part[n / 2 - 1] + part[n / 2]);
    }

    // mode 'median' or 'clip' of stepSymmetrize: orbit by orbit over the
    // target grid (each set of equivalent voxels once, its members counted
    // once each), from the values of the source grid.
    async function robustSymmetrize(model, target, step, space, ctx) {
        const ops = laueOperations(step.laue, space);
        const M = gridMatrix(model), Minv = invert3(M);
        const maps = ops.map(G => gridAction(target, G, M, Minv)).filter(Boolean);
        const off = mulMV(Minv, target.corner.map((x, c) => x - model.corner[c])).map(Math.round);
        const [th, tk, tl] = target.dims, [sh, sk, sl] = model.dims;
        const Nt = th * tk * tl, src = model.values, sg = model.sigma;
        const out = newValues(model, Nt), outSigma = sg ? newValues(model, Nt) : undefined;
        const orbitOf = new Int32Array(Nt);          // 1 + the orbit's first voxel, once visited
        const members = new Int32Array(maps.length), vals = new Float64Array(maps.length);
        const vs = new Float64Array(maps.length), dev = new Float64Array(maps.length), s2 = new Float64Array(maps.length);
        const k = step.k;
        let dropped = 0, n = 0;
        for (let jl = 0; jl < tl; jl++) {
            for (let jk = 0; jk < tk; jk++) {
                for (let jh = 0; jh < th; jh++, n++) {
                    if (orbitOf[n]) continue;
                    let m = 0, nv = 0;
                    for (const { A, T } of maps) {
                        const a = A[0][0] * jh + A[0][1] * jk + A[0][2] * jl + T[0];
                        const b = A[1][0] * jh + A[1][1] * jk + A[1][2] * jl + T[1];
                        const c = A[2][0] * jh + A[2][1] * jk + A[2][2] * jl + T[2];
                        if (a < 0 || a >= th || b < 0 || b >= tk || c < 0 || c >= tl) continue;
                        const t = (c * tk + b) * th + a;
                        if (orbitOf[t] === n + 1) continue;
                        orbitOf[t] = n + 1;
                        members[m++] = t;
                        const i0 = a + off[0], i1 = b + off[1], i2 = c + off[2];
                        if (i0 < 0 || i0 >= sh || i1 < 0 || i1 >= sk || i2 < 0 || i2 >= sl) continue;
                        const at = (i2 * sk + i1) * sh + i0, x = src[at];
                        if (x === x) {
                            vals[nv] = x;
                            s2[nv] = sg ? sg[at] * sg[at] : 0;
                            nv++;
                        }
                    }
                    let value = NaN, sigma = NaN;
                    if (nv) {
                        vs.set(vals.subarray(0, nv));
                        const med = medianOf(vs, nv);
                        if (step.mode === 'median') {
                            value = med;
                            if (sg) {
                                let q = 0;
                                for (let i = 0; i < nv; i++) q += s2[i];
                                sigma = 1.2533 * Math.sqrt(q) / nv;
                            }
                        } else {
                            for (let i = 0; i < nv; i++) dev[i] = Math.abs(vals[i] - med);
                            // most equal to the median: any other value is off
                            const lim = k * 1.4826 * medianOf(dev, nv) || 1e-12 * Math.max(1, Math.abs(med));
                            let sum = 0, q = 0, used = 0;
                            for (let i = 0; i < nv; i++) {
                                if (Math.abs(vals[i] - med) > lim) continue;
                                sum += vals[i];
                                q += s2[i];
                                used++;
                            }
                            dropped += nv - used;
                            value = sum / used;
                            if (sg) sigma = Math.sqrt(q) / used;
                        }
                    }
                    for (let i = 0; i < m; i++) {
                        out[members[i]] = value;
                        if (outSigma) outSigma[members[i]] = sigma;
                    }
                }
            }
            if (ctx.tick && jl % 8 === 7) await ctx.tick();
        }
        if (step.mode === 'clip') ctx.log(`${dropped} values beyond ${k} robust sigma of their equivalents left out`);
        return withValues(target, out, { symmetrized: 'laue', laueGroup: step.laue, sigma: outSigma });
    }

    // Sigma(data)/Sigma(norm) - scale * Sigma(background)/Sigma(background norm)
    // from Mantid's component volumes (MDNorm's _data, _norm, _bkg_data,
    // _bkg_norm), the sums running over the Laue-equivalent voxels when a
    // group is given, as MDNorm symmetrizes. Empty voxels count as 0 in every
    // sum; a voxel without norm is NaN. The norm sums are kept as weights, so
    // a |Q| profile averages as Sigma data / Sigma norm too.
    async function stepNormalize(model, step, ctx) {
        const volume = name => {
            const v = ctx.extras && ctx.extras[name];
            if (!v) throw new Error(`normalize: no loaded volume named "${name}"`);
            if (!sameGrid(model, v)) throw new Error(`normalize: "${name}" is not on the grid of the data`);
            return v;
        };
        const N = voxelCount(model);
        const zeroed = a => {
            const out = new Float64Array(N);
            for (let i = 0; i < N; i++) out[i] = a[i] === a[i] ? a[i] : 0;
            return out;
        };
        const squared = a => {
            const out = new Float64Array(N);
            for (let i = 0; i < N; i++) out[i] = a[i] === a[i] ? a[i] * a[i] : 0;
            return out;
        };
        const parts = [model, volume(step.norm)];
        if (step.background) parts.push(volume(step.background), volume(step.backgroundNorm));
        const arrays = parts.map(v => zeroed(v.values));
        const sigmaOf = [0, 2].filter(k => parts[k] && parts[k].sigma);
        for (const k of sigmaOf) arrays.push(squared(parts[k].sigma));
        let sums = arrays, mult = null;
        if (step.laue !== 'none') {
            const space = model.axesType === 'uvw' ? 'direct' : 'reciprocal';
            const r = await groupSums(model, step.laue, space, arrays, ctx);
            if (r.skipped) ctx.log(`${r.skipped} of the operations do not map the grid onto itself and are skipped`);
            sums = r.sums;
            if (sigmaOf.length) mult = stabilizerCounts(model, step.laue, space);
        }
        // fitScale: the scale by least squares of Sigma data / Sigma norm against
        // Sigma bkg / Sigma bkg norm over the voxels that have both (data =
        // scale * background + offset; the offset is not subtracted).
        let scale = step.scale;
        if (step.background && step.fitScale) {
            let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
            for (let i = 0; i < N; i++) {
                if (!(sums[1][i] > 0 && sums[3][i] > 0)) continue;
                const y = sums[0][i] / sums[1][i], x = sums[2][i] / sums[3][i];
                n++;
                sx += x;
                sy += y;
                sxx += x * x;
                sxy += x * y;
            }
            const det = n * sxx - sx * sx;
            if (!(n > 2 && det > 0)) throw new Error('normalize: too few voxels with both data and background to fit the scale');
            scale = (n * sxy - sx * sy) / det;
            ctx.log(`background scale fitted by least squares: ${+scale.toPrecision(6)} ` +
                `(offset ${+((sy - scale * sx) / n).toPrecision(4)}, not subtracted; ${n} voxels)`);
        }
        const values = new Float64Array(N);
        const sigma = sigmaOf.length ? new Float64Array(N) : undefined;
        let empty = 0;
        for (let i = 0; i < N; i++) {
            const n = sums[1][i];
            let v = n > 0 ? sums[0][i] / n : NaN, var2 = n > 0 && sigmaOf.includes(0) ? sums[4][i] / (n * n) : 0;
            if (step.background) {
                const bn = sums[3][i];
                v = bn > 0 ? v - scale * sums[2][i] / bn : NaN;
                if (sigmaOf.includes(2) && bn > 0) var2 += scale * scale * sums[4 + sigmaOf.indexOf(2)][i] / (bn * bn);
            }
            if (v !== v) empty++;
            values[i] = v;
            if (sigma) sigma[i] = v === v ? Math.sqrt(var2 * (mult ? mult[i] : 1)) : NaN;
        }
        ctx.log(`${empty} voxels without norm are empty`);
        const changes = { weights: sums[1], sigma };
        if (step.laue !== 'none') Object.assign(changes, { symmetrized: 'laue', laueGroup: step.laue });
        return withValues(model, values, changes);
    }

    // Gaussian smoothing, sigma in voxels along every grid axis, as a
    // normalised convolution: empty voxels neither count nor get filled.
    // Uncertainties are dropped (the smoothing correlates the voxels).
    async function stepSmooth(model, step, ctx) {
        const dims = model.dims, N = voxelCount(model), s = step.sigma;
        let v = new Float64Array(N), w = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            const x = model.values[i];
            if (x === x) {
                v[i] = x;
                w[i] = 1;
            }
        }
        const r = Math.ceil(3 * s), kern = Float64Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-0.5 * ((i - r) / s) ** 2));
        const stride = [1, dims[0], dims[0] * dims[1]];
        for (let a = 0; a < 3; a++) {
            const n = dims[a], st = stride[a];
            if (n < 2) continue;
            const v2 = new Float64Array(N), w2 = new Float64Array(N);
            for (let start = 0; start < N; start++) {
                if (Math.floor(start / st) % n !== 0) continue;          // the first voxel of each line along axis a
                for (let j = 0; j < n; j++) {
                    let sv = 0, sw = 0;
                    for (let t = Math.max(-r, -j); t <= Math.min(r, n - 1 - j); t++) {
                        const m = start + (j + t) * st, k = kern[t + r];
                        sv += k * v[m];
                        sw += k * w[m];
                    }
                    v2[start + j * st] = sv;
                    w2[start + j * st] = sw;
                }
            }
            v = v2;
            w = w2;
            if (ctx.tick) await ctx.tick();
        }
        const values = newValues(model, N);
        for (let i = 0; i < N; i++) values[i] = model.values[i] === model.values[i] && w[i] > 0 ? v[i] / w[i] : NaN;
        return withValues(model, values, { sigma: undefined });
    }

    // Empty voxels next to data take the mean of their measured neighbours,
    // one layer per pass, `passes` layers deep (see fillHoles).
    function stepFill(model, step, ctx) {
        const { values, filled } = fillHoles(model, step.passes);
        ctx.log(`${filled} empty voxels filled from their neighbours (${step.passes} passes)`);
        return withValues(model, model.values instanceof Float32Array ? Float32Array.from(values) : values);
    }

    // ------------------------------------------------------------------ 3D-ΔPDF

    // Complex input, the transform's output and the FFT library's own copies
    // take about 64 bytes per voxel.
    const MAX_FFT_VOXELS = 1 << 25;

    // Tukey window over n points: flat in the middle, cosine tapers over a
    // fraction `taper` of the length (0: none, 1: Hann).
    function tukey(n, taper) {
        const w = new Float64Array(n).fill(1);
        const m = Math.floor(Math.min(1, Math.max(0, taper)) * (n - 1) / 2);
        for (let i = 0; i < m; i++) {
            const x = 0.5 * (1 - Math.cos(Math.PI * i / m));
            w[i] = x;
            w[n - 1 - i] = x;
        }
        return w;
    }

    function det3(M) {
        return M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
               M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
               M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    }

    // P(r) = |det V| sum_n I(q_n) exp(2 pi i q_n.r): the inverse Fourier
    // transform of the diffuse intensity (3D-ΔPDF) on the direct grid
    // conjugate to this one, in lattice units (u, v, w), centred on the
    // origin. With q_n = c + V n and r_j = W j, W = V^-T diag(1/N), the sum is
    // exp(2 pi i c.r_j) times an unnormalised inverse DFT; j is centred by a
    // phase ramp on the input. NaN voxels (masked Bragg regions) count as 0.
    // ctx.fft(shape, data, 'inverse', engine) resolves to the transformed
    // interleaved complex array.
    // "Punch and fill": NaN voxels next to data take the mean of their
    // measured 6-neighbours, one layer per pass, `passes` layers deep (holes
    // such as masked Bragg regions close; the far outside stays empty).
    // Returns the filled copy of the values and how many voxels were filled.
    function fillHoles(model, passes) {
        const [nx, ny, nz] = model.dims, v = Float64Array.from(model.values);
        const plane = nx * ny;
        const around = (n, visit) => {
            const i = n % nx, j = Math.floor(n / nx) % ny, k = Math.floor(n / plane);
            if (i > 0) visit(n - 1);
            if (i < nx - 1) visit(n + 1);
            if (j > 0) visit(n - nx);
            if (j < ny - 1) visit(n + nx);
            if (k > 0) visit(n - plane);
            if (k < nz - 1) visit(n + plane);
        };
        const queued = new Uint8Array(v.length);
        let frontier = [];
        for (let n = 0; n < v.length; n++) {
            if (v[n] === v[n]) continue;
            let edge = false;
            around(n, m => { if (v[m] === v[m]) edge = true; });
            if (edge) {
                frontier.push(n);
                queued[n] = 1;
            }
        }
        let filled = 0;
        for (let pass = 0; pass < passes && frontier.length; pass++) {
            const next = new Float64Array(frontier.length);
            frontier.forEach((n, t) => {
                let sum = 0, cnt = 0;
                around(n, m => {
                    if (v[m] === v[m]) {
                        sum += v[m];
                        cnt++;
                    }
                });
                next[t] = sum / cnt;
            });
            frontier.forEach((n, t) => { v[n] = next[t]; });
            filled += frontier.length;
            const after = [];
            for (const n of frontier) {
                around(n, m => {
                    if (v[m] !== v[m] && !queued[m]) {
                        queued[m] = 1;
                        after.push(m);
                    }
                });
            }
            frontier = after;
        }
        return { values: v, filled };
    }

    async function stepDeltaPdf(model, step, ctx) {
        if (!ctx.fft) throw new Error('the 3D-ΔPDF needs the FFT engine');
        if (step.fill > 0) {
            const { values, filled } = fillHoles(model, step.fill);
            ctx.log(`${filled} empty voxels filled from their neighbours (${step.fill} passes)`);
            model = Object.assign({}, model, { values });
        }
        const dims = model.dims;
        const N = voxelCount(model);
        if (N > MAX_FFT_VOXELS) {
            throw new Error(`the grid has ${N} voxels; the in-browser FFT takes up to ${MAX_FFT_VOXELS} ` +
                '(several GB of working memory) - rebin or crop first');
        }
        const w = dims.map(n => tukey(n, step.taper));
        const s = dims.map(n => Math.floor(n / 2));
        const data = new Float64Array(2 * N);
        let i = 0, holes = 0;
        for (let n2 = 0; n2 < dims[2]; n2++)
            for (let n1 = 0; n1 < dims[1]; n1++)
                for (let n0 = 0; n0 < dims[0]; n0++, i++) {
                    const v = model.values[i];
                    if (v !== v) {
                        holes++;
                        continue;
                    }
                    const a = v * w[0][n0] * w[1][n1] * w[2][n2];
                    const ph = -2 * Math.PI * (n0 * s[0] / dims[0] + n1 * s[1] / dims[1] + n2 * s[2] / dims[2]);
                    data[2 * i] = a * Math.cos(ph);
                    data[2 * i + 1] = a * Math.sin(ph);
                }
        if (holes) ctx.log(`${holes} NaN voxels counted as 0`);
        if (ctx.tick) await ctx.tick();
        const shape = dims.filter(n => n > 1);          // wgpu-fft rejects length-1 axes
        const out = shape.length ? await ctx.fft(shape, data, 'inverse', step.engine) : data;
        if (ctx.tick) await ctx.tick();

        const V = gridMatrix(model);
        const Vit = transpose(invert3(V));
        const W = [0, 1, 2].map(r => [0, 1, 2].map(c => Vit[r][c] / dims[c]));
        const vol = Math.abs(det3(V));
        const c = model.corner;
        const values = new Float64Array(N);
        let maxRe = 0, maxIm = 0;
        i = 0;
        for (let m2 = 0; m2 < dims[2]; m2++)
            for (let m1 = 0; m1 < dims[1]; m1++)
                for (let m0 = 0; m0 < dims[0]; m0++, i++) {
                    const j = [m0 - s[0], m1 - s[1], m2 - s[2]];
                    const r = mulMV(W, j);
                    const ph = 2 * Math.PI * dot(c, r);
                    const re = out[2 * i], im = out[2 * i + 1];
                    const pr = (re * Math.cos(ph) - im * Math.sin(ph)) * vol;
                    const pi = (re * Math.sin(ph) + im * Math.cos(ph)) * vol;
                    values[i] = pr;
                    if (Math.abs(pr) > maxRe) maxRe = Math.abs(pr);
                    if (Math.abs(pi) > maxIm) maxIm = Math.abs(pi);
                }
        ctx.log(`largest imaginary part ${(maxRe > 0 ? maxIm / maxRe : 0).toExponential(1)} of the real one` +
            (maxIm > 1e-6 * maxRe ? ' (the intensity is not centrosymmetric on this grid; the real part is kept)' : ''));
        const corner = mulMV(W, s.map(x => -x));
        const vectors = [0, 1, 2].map(a => (dims[a] > 1 ? [W[0][a], W[1][a], W[2][a]] : [0, 0, 0]));
        const result = withValues(model, values, {
            dims: dims.slice(), corner, vectors, axesType: 'uvw', content: '3d-delta-pdf', sigma: undefined, weights: undefined,
        });
        result.axes = pickAxesLike(result);
        return result;
    }

    // ------------------------------------------------------------------ recipe

    // Steps that act on hkl / |Q| and so need reciprocal-space data.
    const RECIPROCAL_ONLY = new Set(['maskBragg', 'maskRings', 'backgroundFunction', 'backgroundShells', 'deltaPdf', 'removeRings',
        'backgroundDebyeWaller', 'correctUB', 'window', 'maskQ']);

    const STEPS = {
        crop: { run: stepCrop, fields: { h: 'range?', k: 'range?', l: 'range?' } },
        resample: { run: stepResample, fields: { h: 'axis', k: 'axis', l: 'axis' } },
        rebin: { run: stepRebin, fields: { factors: 'ints3' } },
        correctUB: {
            run: stepCorrectUB,
            fields: {
                mode: 'ubMode', centring: 'centring', radius: 'positive', snr: 'positive', peaks: 'peakCount', shift: 'boolean',
                ub: 'matrix?', ubNew: 'matrix?',
            },
        },
        maskBragg: { run: stepMaskBragg, fields: { shape: 'string', size: 'positive', centring: 'string' } },
        maskRings: { run: stepMaskRings, fields: { q: 'numbers?', width: 'positive', powder: 'powder', a: 'number?' } },
        maskRange: { run: stepMaskRange, fields: { min: 'number?', max: 'number?' } },
        maskQ: { run: stepMaskQ, fields: { min: 'number?', max: 'number?' } },
        despike: { run: stepDespike, fields: { size: 'despikeSize', k: 'nonnegative' } },
        window: { run: stepWindow, fields: { kind: 'windowKind', qmax: 'nonnegative' } },
        removeRings: {
            run: stepRemoveRings,
            fields: {
                materials: 'any', radiation: 'radiation', intensities: 'ringIntensities', refine: 'fraction', fitWidth: 'boolean',
                sigma0: 'nonnegative', resolution: 'nonnegative', width: 'positive', cutoff: 'positive', highPass: 'positive', sectors: 'sectors', coverage: 'fraction',
                positive: 'boolean',
            },
        },
        scale: { run: stepScale, fields: { factor: 'number', offset: 'number', positive: 'boolean' } },
        smooth: { run: stepSmooth, fields: { sigma: 'positive' } },
        fill: { run: stepFill, fields: { passes: 'passes' } },
        backgroundFunction: { run: stepBackgroundFunction, fields: { kind: 'string', params: 'any' } },
        backgroundShells: { run: stepBackgroundShells, fields: { width: 'positive', percentile: 'number', smooth: 'number' } },
        backgroundDebyeWaller: {
            run: stepBackgroundDebyeWaller,
            fields: {
                radiation: 'radiation', composition: 'any', uiso: 'any', fit: 'boolean', scale: 'number', offset: 'boolean',
                percentile: 'number', width: 'positive',
            },
        },
        combine: { run: stepCombine, fields: { operation: 'string', file: 'string', scale: 'number' } },
        clip: { run: stepClip, fields: { below: 'number', to: 'clipTo' } },
        symmetrize: { run: stepSymmetrize, fields: { laue: 'string', mode: 'symMode', expand: 'boolean', k: 'positive' } },
        deltaPdf: { run: stepDeltaPdf, fields: { taper: 'number', engine: 'engine', fill: 'passes' } },
        normalize: {
            run: stepNormalize,
            fields: { norm: 'string', background: 'string?', backgroundNorm: 'string?', scale: 'number', fitScale: 'boolean', laue: 'laue?' },
        },
    };

    function checkField(kind, value, where) {
        const finite = x => typeof x === 'number' && Number.isFinite(x);
        const ok = {
            'range?': v => v === undefined || v === null || (Array.isArray(v) && v.length === 2 && v.every(finite) && v[0] <= v[1]),
            axis: v => Array.isArray(v) && v.length === 3 && v.every(finite) && v[0] <= v[1] && v[2] >= 0,
            ints3: v => Array.isArray(v) && v.length === 3 && v.every(x => Number.isInteger(x) && x >= 1),
            string: v => typeof v === 'string' && v.length > 0,
            positive: v => finite(v) && v > 0,
            number: finite,
            'number?': v => v === undefined || v === null || finite(v),
            numbers: v => Array.isArray(v) && v.length > 0 && v.every(finite),
            'numbers?': v => v === undefined || v === null || (Array.isArray(v) && v.every(finite)),
            powder: v => v === 'none' || Object.prototype.hasOwnProperty.call(POWDER, v),
            boolean: v => typeof v === 'boolean',
            clipTo: v => v === 'nan' || finite(v),
            engine: v => v === 'cpu' || v === 'gpu',
            passes: v => Number.isInteger(v) && v >= 0 && v <= 50,
            'string?': v => v === undefined || v === null || typeof v === 'string',
            'laue?': v => v === 'none' || LAUE_GROUPS.includes(v),
            symMode: v => ['average', 'fill', 'median', 'clip'].includes(v),
            sectors: v => Number.isInteger(v) && v >= 1 && v <= 256,
            fraction: v => finite(v) && v >= 0 && v <= 1,
            radiation: v => ['auto', 'xray', 'neutron', 'electron'].includes(v),
            ringIntensities: v => v === 'structure' || v === 'free',
            ubMode: v => v === 'refine' || v === 'matrix',
            despikeSize: v => v === 1 || v === 2,
            nonnegative: v => finite(v) && v >= 0,
            windowKind: v => ['lorch', 'hann', 'gauss', 'sphere'].includes(v),
            centring: v => Object.prototype.hasOwnProperty.call(CENTRING, v),
            peakCount: v => Number.isInteger(v) && v >= 5 && v <= 100000,
            'matrix?': v => v === undefined || v === null || (Array.isArray(v) && (v.length === 0 || (v.length === 9 && v.every(finite)))),
            any: v => v !== undefined,
        }[kind];
        if (!ok(value)) throw new Error(`${where}: invalid value ${JSON.stringify(value)}`);
    }

    // Check a recipe and fill in defaults; returns { version, steps }.
    function normalizeRecipe(recipe) {
        const steps = Array.isArray(recipe) ? recipe : recipe && Array.isArray(recipe.steps) ? recipe.steps : null;
        if (!steps) throw new Error('recipe: expected { "steps": [ ... ] }');
        return {
            version: 1,
            steps: steps.map((raw, n) => {
                const spec = STEPS[raw && raw.op];
                if (!spec) throw new Error(`recipe step ${n + 1}: unknown op ${raw && raw.op}`);
                const step = Object.assign({ op: raw.op }, DEFAULTS[raw.op] || {}, raw);
                for (const [key, kind] of Object.entries(spec.fields)) {
                    checkField(kind, step[key], `recipe step ${n + 1} (${raw.op}) ${key}`);
                }
                if (raw.op === 'symmetrize') laueOperations(step.laue);
                if (raw.op === 'normalize' && step.background && !step.backgroundNorm) {
                    throw new Error(`recipe step ${n + 1} (normalize): a background volume needs its norm volume`);
                }
                if (raw.op === 'backgroundFunction') backgroundCurve(step.kind, step.params);
                if (raw.op === 'removeRings' && String(step.materials).trim().toLowerCase() !== 'any') parseMaterials(step.materials);
                if (raw.op === 'backgroundDebyeWaller') {
                    const sites = parseSites(step.composition), uiso = parseUiso(step.uiso);
                    for (const site of sites) for (const sp of site.species) uiso(sp.atom);
                }
                return step;
            }),
        };
    }

    function describeStep(step) {
        const r = (name, v) => (v ? ` ${name} ${v[0]}..${v[1]}` : '');
        switch (step.op) {
            case 'crop': return 'crop' + (r('h', step.h) + r('k', step.k) + r('l', step.l) || ' (no ranges set: keeps the grid)');
            case 'resample': return 'resample onto' + ['h', 'k', 'l'].map(n => ` ${n} ${step[n][0]}..${step[n][1]} step ${step[n][2]}`).join(',');
            case 'rebin': return `rebin by ${step.factors.join(' x ')}`;
            case 'correctUB': return step.mode === 'matrix'
                ? 'correct the orientation: resample from the UB the grid was made with to the new one'
                : `put the Bragg peaks on integer hkl: fit a ${step.shift ? 'linear map and shift' : 'linear map (a UB correction)'} ` +
                  `to up to ${step.peaks} peaks (centring ${step.centring}, within ${step.radius} r.l.u., ${step.snr} sigma)`;
            case 'maskBragg': return `mask Bragg positions (${step.shape} ${step.size}${step.shape === 'sphere' ? ' 1/A' : ' r.l.u.'}, centring ${step.centring})`;
            case 'maskRings': return 'mask powder rings' + ((step.q || []).length > 6
                ? ` at ${step.q.length} |Q| from ${+Math.min(...step.q).toFixed(4)} to ${+Math.max(...step.q).toFixed(4)}`
                : (step.q || []).length ? ` at |Q| ${step.q.join(', ')}` : '') +
                (step.powder && step.powder !== 'none'
                    ? `${(step.q || []).length ? ' and' : ''} of ${step.powder} (a = ${step.a > 0 ? step.a : POWDER[step.powder].a} A)` : '') +
                ` +/- ${step.width} 1/A`;
            case 'removeRings': return String(step.materials).trim().toLowerCase() === 'any'
                ? `remove any ring sharper than ${step.cutoff} 1/A by Fourier filtering of the |Q| profile ` +
                  `(bins of ${step.width} 1/A${step.sectors > 1 ? `, ${step.sectors} direction sectors` : ''})`
                : `remove the powder rings of ${step.materials}: lines from the structure, fitted to the |Q| profile ` +
                  `high-passed at ${step.highPass} line widths (${step.intensities === 'free' ? 'free' : 'structure-factor'} intensities` +
                  `${step.refine > 0 ? `, lattice within ${+(100 * step.refine).toFixed(2)} %` : ''}${step.fitWidth ? ', widths fitted' : ''}` +
                  `${step.sectors > 1 ? `, ${step.sectors} direction sectors` : ''})`;
            case 'maskQ': return `mask |Q| outside ${step.min === undefined || step.min === null ? 0 : step.min}..${step.max === undefined || step.max === null ? 'inf' : step.max} 1/A`;
            case 'despike': return step.k > 0
                ? `despike: voxels beyond ${step.k} robust sigma of the median of their ${step.size === 2 ? '5 x 5 x 5' : '3 x 3 x 3'} neighbourhood take that median`
                : `median filter over ${step.size === 2 ? '5 x 5 x 5' : '3 x 3 x 3'} voxels`;
            case 'window': return `${step.kind} window in |Q| up to ${step.qmax > 0 ? step.qmax + ' 1/A' : 'the largest sphere in the grid'}, empty beyond`;
            case 'maskRange': return `mask values outside ${step.min === undefined || step.min === null ? '-inf' : step.min}..${step.max === undefined || step.max === null ? 'inf' : step.max}`;
            case 'scale': return `scale: I * ${step.factor} + ${step.offset}` + (step.positive ? ', then shift up to positive' : '');
            case 'smooth': return `Gaussian smoothing, sigma ${step.sigma} voxel${step.sigma === 1 ? '' : 's'} (empty voxels left out)`;
            case 'fill': return `fill empty voxels from their neighbours, ${step.passes} voxel${step.passes === 1 ? '' : 's'} deep`;
            case 'backgroundFunction': return `subtract ${step.kind} background ${JSON.stringify(step.params)}`;
            case 'backgroundDebyeWaller': return `subtract the Laue and thermal (Debye-Waller) background of ${step.composition}` +
                ` (Uiso ${step.uiso} A^2, ${step.radiation === 'auto' ? 'radiation of the data' : step.radiation}` +
                (step.fit ? `, scaled to the ${step.percentile}th percentile of |Q| shells${step.offset ? ' with an offset' : ''})` : `, x ${step.scale})`);
            case 'backgroundShells': return `subtract background from |Q| shells of ${step.width} 1/A (${step.percentile ? step.percentile + 'th percentile' : 'minimum'}${step.smooth ? ', smoothed over ' + step.smooth : ''})`;
            case 'combine': return `${step.operation} "${step.file}"${step.scale !== 1 ? ' x ' + step.scale : ''}`;
            case 'clip': return `set values below ${step.below} to ${step.to}`;
            case 'symmetrize': return `symmetrize with Laue group ${step.laue} (` +
                (step.mode === 'clip' ? `mean without values beyond ${step.k} robust sigma` : step.mode) +
                `${step.expand ? ', extend the grid' : ''})`;
            case 'normalize': return `Σdata/Σnorm with "${step.norm}"` +
                (step.background ? ` − ${step.fitScale ? 'fitted scale' : step.scale} × Σ"${step.background}"/Σ"${step.backgroundNorm}"` : '') +
                (step.laue !== 'none' ? `, summed over ${step.laue}` : '');
            case 'deltaPdf': return `3D-ΔPDF by FFT on the ${step.engine === 'gpu' ? 'GPU (float32)' : 'CPU (float64)'}` +
                (step.fill ? `, holes filled ${step.fill} voxel${step.fill === 1 ? '' : 's'} deep` : '') +
                (step.taper ? `, Tukey taper ${step.taper}` : '');
            default: return step.op;
        }
    }

    // Run a recipe. ctx: { cell, extras: { name: model }, tick, progress, log }.
    // Returns the processed model; after a symmetrize step, model.symmetrized is
    // 'laue' (the unified data_type_symmetrized label) and model.laueGroup the group.
    async function applyRecipe(model, recipe, ctx) {
        ctx = Object.assign({ log: () => {} }, ctx);
        const { steps } = normalizeRecipe(recipe);
        let current = model;
        for (let n = 0; n < steps.length; n++) {
            const step = steps[n];
            const log = text => ctx.log(`  ${text}`);
            ctx.log(`Step ${n + 1}: ${describeStep(step)}`);
            const t0 = Date.now();
            try {
                if (RECIPROCAL_ONLY.has(step.op) && current.axesType === 'uvw') {
                    throw new Error('needs reciprocal-space (hkl) data, but these are in direct space');
                }
                current = await STEPS[step.op].run(current, step, Object.assign({}, ctx, { log }));
                for (const key of ['sigma', 'weights']) {
                    if (current[key] && current[key].length !== current.values.length) current = Object.assign({}, current, { [key]: undefined });
                }
            } catch (e) {
                if (e && e.cancelled) throw e;
                throw new Error(`step ${n + 1} (${step.op}): ${e.message}`);
            }
            log(`done in ${((Date.now() - t0) / 1000).toFixed(2)} s`);
            current.axes = current.vectors.some((v, a) => current.dims[a] > 1 && v.some(Boolean))
                ? pickAxesLike(current) : current.axes;
            if (ctx.progress) ctx.progress((n + 1) / steps.length);
            if (ctx.tick) await ctx.tick();
        }
        return current;
    }

    // Dominant hkl component per grid axis (as Converter's pickAxes).
    function pickAxesLike(model) {
        const axes = [1, 2, 3];
        for (let a = 0; a < 3; a++) {
            if (model.dims[a] <= 1) continue;
            const v = model.vectors[a].map(Math.abs);
            axes[a] = v.indexOf(Math.max(...v)) + 1;
        }
        return new Set(axes.filter((x, a) => model.dims[a] > 1)).size === axes.filter((x, a) => model.dims[a] > 1).length
            ? axes : [1, 2, 3];
    }

    // ------------------------------------------------------------- |Q| profile

    // Shell averages of the finite values over |Q| shells of `width`: arrays
    // q (shell centres), mean, sigma (standard error of the mean) and n, for
    // the shells that hold data.
    function profileShells(model, cell, width) {
        if (model.axesType === 'uvw') throw new Error('a |Q| profile needs reciprocal-space data');
        needCell(cell, 'a |Q| profile');
        if (!(width > 0)) throw new Error('|Q| profile: the shell width must be positive');
        // With norm weights w (from a normalize step), the shell mean is
        // sum(w I) / sum(w) = sum(data) / sum(norm) over the shell.
        const w = model.weights && model.weights.length === model.values.length ? model.weights : null;
        const sw = [], sx = [], sxx = [], sww = [], cnt = [];
        forEachQ(model, cell, (i, q) => {
            const x = model.values[i];
            if (x !== x) return;
            const wi = w ? w[i] : 1;
            if (!(wi > 0)) return;
            const s = Math.floor(q / width);
            sw[s] = (sw[s] || 0) + wi;
            sx[s] = (sx[s] || 0) + wi * x;
            sxx[s] = (sxx[s] || 0) + wi * x * x;
            sww[s] = (sww[s] || 0) + wi * wi;
            cnt[s] = (cnt[s] || 0) + 1;
        });
        const out = { q: [], mean: [], sigma: [], n: [], weighted: !!w };
        for (let s = 0; s < cnt.length; s++) {
            if (!cnt[s]) continue;
            const n = cnt[s], mean = sx[s] / sw[s];
            // standard error with the effective number of weighted samples
            const variance = Math.max(0, sxx[s] / sw[s] - mean * mean), nEff = sw[s] * sw[s] / sww[s];
            out.q.push((s + 0.5) * width);
            out.mean.push(mean);
            out.sigma.push(nEff > 1 ? Math.sqrt(variance * nEff / (nEff - 1) / nEff) : 0);
            out.n.push(n);
        }
        return out;
    }

    // The profile as text: "# Q(1/A) mean sigma_mean n".
    function* writeProfileChunks(model, cell, width) {
        const p = profileShells(model, cell, width);
        let out = '# |Q| profile written by 3DSConvert: shell averages of the finite voxels\n' +
            `# shell width ${width} 1/A\n# Q(1/A) mean_I sigma_of_mean n_voxels\n`;
        for (let k = 0; k < p.q.length; k++) {
            out += `${p.q[k].toPrecision(8)} ${p.mean[k].toPrecision(10)} ${p.sigma[k].toPrecision(6)} ${p.n[k]}\n`;
            if (out.length > 1 << 20) {
                yield out;
                out = '';
            }
        }
        if (out) yield out;
    }

    return {
        LAUE_GROUPS, RECIPROCAL_ONLY: [...RECIPROCAL_ONLY], laueOperations, laueChain, normalizeRecipe, describeStep,
        applyRecipe, writeProfileChunks, profileShells,
        sampler, gridMatrix,
    };
}));
