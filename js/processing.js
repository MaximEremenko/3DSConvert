/*
 * Processing steps for diffuse-scattering models (see js/converter.js for
 * the model): crop, resample, rebin, masks, scaling, backgrounds,
 * combination with other volumes and Laue symmetrization. A recipe is plain
 * JSON so it can be saved, reloaded and recorded with the output:
 *
 *   { "version": 1, "steps": [ { "op": "crop", "h": [-6, 6] }, ... ] }
 *
 * Steps never modify their input model; NaN marks masked or missing voxels.
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
        const out = newValues(model, dims[0] * dims[1] * dims[2]);
        let n = 0;
        for (let il = lo[2]; il <= hi[2]; il++)
            for (let ik = lo[1]; ik <= hi[1]; ik++) {
                const base = (il * nk + ik) * nh;
                for (let ih = lo[0]; ih <= hi[0]; ih++) out[n++] = model.values[base + ih];
            }
        const corner = [0, 1, 2].map(c => model.corner[c] + lo[0] * model.vectors[0][c] +
            lo[1] * model.vectors[1][c] + lo[2] * model.vectors[2][c]);
        return withValues(model, out, { dims, corner, vectors: model.vectors.map((v, a) => (dims[a] > 1 ? v.slice() : [0, 0, 0])) });
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

    // The operations of a Laue group acting on hkl: R^T for every direct-space
    // operation R (the reciprocal action R^-T runs over the same set).
    function laueOperations(name) {
        const gens = LAUE_GENERATORS[name];
        if (!gens) throw new Error(`unknown Laue group ${name} (use one of ${LAUE_GROUPS.join(', ')})`);
        const all = gens.concat([[[-1, 0, 0], [0, -1, 0], [0, 0, -1]]]);
        const key = M => M.flat().join(',');
        const found = new Map([[key([[1, 0, 0], [0, 1, 0], [0, 0, 1]]), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]]]);
        let frontier = [...found.values()];
        while (frontier.length) {
            const next = [];
            for (const A of frontier) {
                for (const G of all) {
                    const P = mulMM(A, G);
                    const k = key(P);
                    if (!found.has(k)) {
                        found.set(k, P);
                        next.push(P);
                    }
                }
            }
            frontier = next;
        }
        return [...found.values()].map(transpose);
    }

    // ------------------------------------------------------------------ steps

    const DEFAULTS = {
        maskBragg: { shape: 'box', centring: 'P' },
        maskRange: {},
        scale: { factor: 1, offset: 0 },
        backgroundShells: { percentile: 0, smooth: 0 },
        combine: { scale: 1 },
        clip: { below: 0, to: 0 },
        symmetrize: { mode: 'average', expand: false },
        deltaPdf: { taper: 0, engine: 'cpu' },
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
        const out = newValues(model, dims[0] * dims[1] * dims[2]);
        let n = 0;
        for (let il = 0; il < dims[2]; il++) {
            const l = axes[2].min + il * axes[2].size;
            for (let ik = 0; ik < dims[1]; ik++) {
                const k = axes[1].min + ik * axes[1].size;
                for (let ih = 0; ih < dims[0]; ih++) out[n++] = sample(axes[0].min + ih * axes[0].size, k, l);
            }
            if (ctx.tick) await ctx.tick();
        }
        const vectors = [[axes[0].size, 0, 0], [0, axes[1].size, 0], [0, 0, axes[2].size]];
        return withValues(model, out, { dims, corner: axes.map(a => a.min), vectors, axes: [1, 2, 3] });
    }

    function stepRebin(model, step) {
        const f = step.factors.map(x => Math.max(1, Math.round(x)));
        const dims = model.dims.map((n, a) => Math.max(1, Math.floor(n / f[a])));
        const [nh, nk] = model.dims;
        const out = newValues(model, dims[0] * dims[1] * dims[2]);
        let n = 0;
        for (let bl = 0; bl < dims[2]; bl++)
            for (let bk = 0; bk < dims[1]; bk++)
                for (let bh = 0; bh < dims[0]; bh++) {
                    let sum = 0, cnt = 0;
                    for (let il = bl * f[2]; il < (bl + 1) * f[2] && il < model.dims[2]; il++)
                        for (let ik = bk * f[1]; ik < (bk + 1) * f[1] && ik < nk; ik++)
                            for (let ih = bh * f[0]; ih < (bh + 1) * f[0] && ih < nh; ih++) {
                                const x = model.values[(il * nk + ik) * nh + ih];
                                if (x === x) {
                                    sum += x;
                                    cnt++;
                                }
                            }
                    out[n++] = cnt ? sum / cnt : NaN;
                }
        const shift = [0, 1, 2].map(c => model.vectors.reduce((s, v, a) => s + (f[a] - 1) / 2 * v[c], 0));
        return withValues(model, out, {
            dims,
            corner: model.corner.map((x, c) => x + shift[c]),
            vectors: model.vectors.map((v, a) => (dims[a] > 1 ? v.map(x => x * f[a]) : [0, 0, 0])),
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

    function stepMaskRings(model, step, ctx) {
        needCell(ctx.cell, 'a powder-ring mask');
        const rings = step.q.slice().sort((a, b) => a - b);
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

    function stepScale(model, step) {
        const values = copyValues(model);
        for (let i = 0; i < values.length; i++) values[i] = values[i] * step.factor + step.offset;
        return withValues(model, values);
    }

    // B(|Q|) as a function: constant [c], linear [a, b] (a + b Q),
    // exponential [a, b, c] (a - b c^Q) or table [[Q, B], ...] (linear, flat
    // beyond the ends).
    function backgroundCurve(kind, params) {
        if (kind === 'constant') return () => params[0];
        if (kind === 'linear') return q => params[0] + params[1] * q;
        if (kind === 'exponential') return q => params[0] - params[1] * Math.pow(params[2], q);
        if (kind === 'table') {
            const t = params.slice().sort((a, b) => a[0] - b[0]);
            return q => {
                if (q <= t[0][0]) return t[0][1];
                for (let i = 1; i < t.length; i++) {
                    if (q <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (q - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
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
        let get;
        if (sameGrid(model, other)) {
            get = i => other.values[i];
        } else {
            const sample = sampler(other);
            const at = new Float64Array(values.length);
            forEachHkl(model, (i, h, k, l) => { at[i] = sample(h, k, l); });
            get = i => at[i];
            ctx.log(`"${step.file}" is on a different grid; sampled trilinearly onto this one`);
        }
        const s = step.scale;
        const ops = {
            subtract: (x, y) => x - s * y,
            add: (x, y) => x + s * y,
            multiply: (x, y) => x * s * y,
            divide: (x, y) => (y !== 0 ? x / (s * y) : NaN),
        };
        const op = ops[step.operation];
        if (!op) throw new Error(`combine: operation must be subtract, add, multiply or divide`);
        for (let i = 0; i < values.length; i++) values[i] = op(values[i], get(i));
        return withValues(model, values);
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

    // Average over the Laue-equivalent grid points (NaN-aware). mode 'fill'
    // keeps measured values and fills only NaN voxels. expand extends the
    // grid to the symmetric images of its range (e.g. a half volume).
    async function stepSymmetrize(model, step, ctx) {
        const ops = laueOperations(step.laue);
        const M = gridMatrix(model);
        const Minv = invert3(M);
        const near = x => Math.abs(x - Math.round(x)) < 1e-6;
        // Index-space action of an operation: i' = A i + t (integers when the
        // operation maps the grid onto itself).
        const cornerIdx = (target) => mulMV(Minv, target.map((x, c) => x - model.corner[c]));
        const aligned = ops.map(G => {
            const A = mulMM(Minv, mulMM(G, M));
            return A.every(r => r.every(near)) ? A.map(r => r.map(Math.round)) : null;
        });
        const usable = aligned.filter(Boolean).length;
        if (usable < ops.length) {
            ctx.log(`${ops.length - usable} of the ${ops.length} operations do not map the grid onto itself and are skipped`);
        }
        let target = model;
        if (step.expand) {
            // Bounding box (in grid indices) of the images of the grid corners.
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            const corners = [];
            for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
                corners.push([a * (model.dims[0] - 1), b * (model.dims[1] - 1), c * (model.dims[2] - 1)]);
            }
            ops.forEach((G, g) => {
                if (!aligned[g]) return;
                for (const idx of corners) {
                    const p = mulMV(M, idx).map((x, c) => x + model.corner[c]);
                    const f = cornerIdx(mulMV(G, p));
                    f.forEach((x, a) => {
                        lo[a] = Math.min(lo[a], Math.round(x));
                        hi[a] = Math.max(hi[a], Math.round(x));
                    });
                }
            });
            const dims = [0, 1, 2].map(a => hi[a] - lo[a] + 1);
            if (dims.some((n, a) => n > 4 * model.dims[a] + 1)) throw new Error('symmetrize: the expanded grid is unreasonably large');
            const corner = [0, 1, 2].map(c => model.corner[c] + lo[0] * M[c][0] * (model.dims[0] > 1 ? 1 : 0) +
                lo[1] * M[c][1] * (model.dims[1] > 1 ? 1 : 0) + lo[2] * M[c][2] * (model.dims[2] > 1 ? 1 : 0));
            target = Object.assign({}, model, { dims, corner });
            ctx.log(`grid extended from ${model.dims.join(' x ')} to ${dims.join(' x ')}`);
        }
        const [sh, sk, sl] = model.dims;
        const [th, tk, tl] = target.dims;
        const src = model.values;
        const sum = new Float64Array(th * tk * tl), cnt = new Int32Array(th * tk * tl);
        for (let g = 0; g < ops.length; g++) {
            const A = aligned[g];
            if (!A) continue;
            const G = ops[g];
            // source index of target index j: i = Minv (G (corner_t + M j) - corner_s) = A j + t
            const t = mulMV(Minv, mulMV(G, target.corner).map((x, c) => x - model.corner[c]));
            if (!t.every(near)) continue;
            const T = t.map(Math.round);
            let n = 0;
            for (let jl = 0; jl < tl; jl++) {
                for (let jk = 0; jk < tk; jk++) {
                    let i0 = T[0] + A[0][1] * jk + A[0][2] * jl;
                    let i1 = T[1] + A[1][1] * jk + A[1][2] * jl;
                    let i2 = T[2] + A[2][1] * jk + A[2][2] * jl;
                    for (let jh = 0; jh < th; jh++, n++) {
                        if (i0 >= 0 && i0 < sh && i1 >= 0 && i1 < sk && i2 >= 0 && i2 < sl) {
                            const x = src[(i2 * sk + i1) * sh + i0];
                            if (x === x) {
                                sum[n] += x;
                                cnt[n]++;
                            }
                        }
                        i0 += A[0][0];
                        i1 += A[1][0];
                        i2 += A[2][0];
                    }
                }
            }
            if (ctx.tick) await ctx.tick();
        }
        const out = newValues(model, th * tk * tl);
        const keep = step.mode === 'fill';
        const oi = keep ? mulMV(Minv, target.corner.map((x, c) => x - model.corner[c])).map(Math.round) : null;
        let n = 0, filled = 0;
        for (let jl = 0; jl < tl; jl++)
            for (let jk = 0; jk < tk; jk++)
                for (let jh = 0; jh < th; jh++, n++) {
                    let own = NaN;
                    if (keep) {
                        const i0 = oi[0] + jh, i1 = oi[1] + jk, i2 = oi[2] + jl;
                        if (i0 >= 0 && i0 < sh && i1 >= 0 && i1 < sk && i2 >= 0 && i2 < sl) own = src[(i2 * sk + i1) * sh + i0];
                    }
                    if (own === own) out[n] = own;
                    else {
                        out[n] = cnt[n] ? sum[n] / cnt[n] : NaN;
                        if (cnt[n]) filled++;
                    }
                }
        if (keep) ctx.log(`${filled} empty voxels filled`);
        return withValues(target, out, { symmetrized: 'laue', laueGroup: step.laue });
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
    async function stepDeltaPdf(model, step, ctx) {
        if (!ctx.fft) throw new Error('the 3D-ΔPDF needs the FFT engine');
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
            dims: dims.slice(), corner, vectors, axesType: 'uvw', content: '3d-delta-pdf',
        });
        result.axes = pickAxesLike(result);
        return result;
    }

    // ------------------------------------------------------------------ recipe

    // Steps that act on hkl / |Q| and so need reciprocal-space data.
    const RECIPROCAL_ONLY = new Set(['maskBragg', 'maskRings', 'backgroundFunction', 'backgroundShells',
        'symmetrize', 'deltaPdf']);

    const STEPS = {
        crop: { run: stepCrop, fields: { h: 'range?', k: 'range?', l: 'range?' } },
        resample: { run: stepResample, fields: { h: 'axis', k: 'axis', l: 'axis' } },
        rebin: { run: stepRebin, fields: { factors: 'ints3' } },
        maskBragg: { run: stepMaskBragg, fields: { shape: 'string', size: 'positive', centring: 'string' } },
        maskRings: { run: stepMaskRings, fields: { q: 'numbers', width: 'positive' } },
        maskRange: { run: stepMaskRange, fields: { min: 'number?', max: 'number?' } },
        scale: { run: stepScale, fields: { factor: 'number', offset: 'number' } },
        backgroundFunction: { run: stepBackgroundFunction, fields: { kind: 'string', params: 'any' } },
        backgroundShells: { run: stepBackgroundShells, fields: { width: 'positive', percentile: 'number', smooth: 'number' } },
        combine: { run: stepCombine, fields: { operation: 'string', file: 'string', scale: 'number' } },
        clip: { run: stepClip, fields: { below: 'number', to: 'clipTo' } },
        symmetrize: { run: stepSymmetrize, fields: { laue: 'string', mode: 'string', expand: 'boolean' } },
        deltaPdf: { run: stepDeltaPdf, fields: { taper: 'number', engine: 'engine' } },
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
            boolean: v => typeof v === 'boolean',
            clipTo: v => v === 'nan' || finite(v),
            engine: v => v === 'cpu' || v === 'gpu',
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
            case 'maskRings': return `mask powder rings at |Q| ${step.q.join(', ')} +/- ${step.width} 1/A`;
            case 'maskRange': return `mask values outside ${step.min === undefined || step.min === null ? '-inf' : step.min}..${step.max === undefined || step.max === null ? 'inf' : step.max}`;
            case 'scale': return `scale: I * ${step.factor} + ${step.offset}`;
            case 'backgroundFunction': return `subtract ${step.kind} background ${JSON.stringify(step.params)}`;
            case 'backgroundShells': return `subtract background from |Q| shells of ${step.width} 1/A (${step.percentile ? step.percentile + 'th percentile' : 'minimum'}${step.smooth ? ', smoothed over ' + step.smooth : ''})`;
            case 'combine': return `${step.operation} "${step.file}"${step.scale !== 1 ? ' x ' + step.scale : ''}`;
            case 'clip': return `set values below ${step.below} to ${step.to}`;
            case 'symmetrize': return `symmetrize with Laue group ${step.laue} (${step.mode}${step.expand ? ', extend the grid' : ''})`;
            case 'deltaPdf': return `3D-ΔPDF by FFT on the ${step.engine === 'gpu' ? 'GPU (float32)' : 'CPU (float64)'}` +
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
            try {
                if (RECIPROCAL_ONLY.has(step.op) && current.axesType === 'uvw') {
                    throw new Error('needs reciprocal-space (hkl) data, but these are in direct space');
                }
                current = await STEPS[step.op].run(current, step, Object.assign({}, ctx, { log }));
            } catch (e) {
                if (e && e.cancelled) throw e;
                throw new Error(`step ${n + 1} (${step.op}): ${e.message}`);
            }
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

    // Shell averages of the finite values: "# Q(1/A) mean sigma_mean n".
    function* writeProfileChunks(model, cell, width) {
        if (model.axesType === 'uvw') throw new Error('a |Q| profile needs reciprocal-space data');
        needCell(cell, 'a |Q| profile');
        if (!(width > 0)) throw new Error('|Q| profile: the shell width must be positive');
        const sums = [], sq = [], cnt = [];
        forEachQ(model, cell, (i, q) => {
            const x = model.values[i];
            if (x !== x) return;
            const s = Math.floor(q / width);
            sums[s] = (sums[s] || 0) + x;
            sq[s] = (sq[s] || 0) + x * x;
            cnt[s] = (cnt[s] || 0) + 1;
        });
        let out = '# |Q| profile written by 3DSConvert: shell averages of the finite voxels\n' +
            `# shell width ${width} 1/A\n# Q(1/A) mean_I sigma_of_mean n_voxels\n`;
        for (let s = 0; s < cnt.length; s++) {
            if (!cnt[s]) continue;
            const n = cnt[s], mean = sums[s] / n;
            const variance = n > 1 ? Math.max(0, (sq[s] - n * mean * mean) / (n - 1)) : 0;
            out += `${((s + 0.5) * width).toPrecision(8)} ${mean.toPrecision(10)} ${Math.sqrt(variance / n).toPrecision(6)} ${n}\n`;
            if (out.length > 1 << 20) {
                yield out;
                out = '';
            }
        }
        if (out) yield out;
    }

    return {
        LAUE_GROUPS, laueOperations, normalizeRecipe, describeStep, applyRecipe, writeProfileChunks,
        sampler, gridMatrix,
    };
}));
