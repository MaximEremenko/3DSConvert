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
    const RECIPROCAL_ONLY = new Set(['maskBragg', 'maskRings', 'backgroundFunction', 'backgroundShells', 'deltaPdf']);

    const STEPS = {
        crop: { run: stepCrop, fields: { h: 'range?', k: 'range?', l: 'range?' } },
        resample: { run: stepResample, fields: { h: 'axis', k: 'axis', l: 'axis' } },
        rebin: { run: stepRebin, fields: { factors: 'ints3' } },
        maskBragg: { run: stepMaskBragg, fields: { shape: 'string', size: 'positive', centring: 'string' } },
        maskRings: { run: stepMaskRings, fields: { q: 'numbers?', width: 'positive', powder: 'powder', a: 'number?' } },
        maskRange: { run: stepMaskRange, fields: { min: 'number?', max: 'number?' } },
        scale: { run: stepScale, fields: { factor: 'number', offset: 'number', positive: 'boolean' } },
        smooth: { run: stepSmooth, fields: { sigma: 'positive' } },
        fill: { run: stepFill, fields: { passes: 'passes' } },
        backgroundFunction: { run: stepBackgroundFunction, fields: { kind: 'string', params: 'any' } },
        backgroundShells: { run: stepBackgroundShells, fields: { width: 'positive', percentile: 'number', smooth: 'number' } },
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
            case 'maskBragg': return `mask Bragg positions (${step.shape} ${step.size}${step.shape === 'sphere' ? ' 1/A' : ' r.l.u.'}, centring ${step.centring})`;
            case 'maskRings': return 'mask powder rings' + ((step.q || []).length > 6
                ? ` at ${step.q.length} |Q| from ${+Math.min(...step.q).toFixed(4)} to ${+Math.max(...step.q).toFixed(4)}`
                : (step.q || []).length ? ` at |Q| ${step.q.join(', ')}` : '') +
                (step.powder && step.powder !== 'none'
                    ? `${(step.q || []).length ? ' and' : ''} of ${step.powder} (a = ${step.a > 0 ? step.a : POWDER[step.powder].a} A)` : '') +
                ` +/- ${step.width} 1/A`;
            case 'maskRange': return `mask values outside ${step.min === undefined || step.min === null ? '-inf' : step.min}..${step.max === undefined || step.max === null ? 'inf' : step.max}`;
            case 'scale': return `scale: I * ${step.factor} + ${step.offset}` + (step.positive ? ', then shift up to positive' : '');
            case 'smooth': return `Gaussian smoothing, sigma ${step.sigma} voxel${step.sigma === 1 ? '' : 's'} (empty voxels left out)`;
            case 'fill': return `fill empty voxels from their neighbours, ${step.passes} voxel${step.passes === 1 ? '' : 's'} deep`;
            case 'backgroundFunction': return `subtract ${step.kind} background ${JSON.stringify(step.params)}`;
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
