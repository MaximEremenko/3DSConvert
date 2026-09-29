'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, Converter, readText, maxAbsDiff, cpuFft } = require('./helpers');
const Processing = require(path.join(ROOT, 'js', 'processing.js'));

const cubic = a => ({ lengths: [a, a, a], angles: [90, 90, 90] });

// Axis-aligned hkl grid from -r to r in steps s on every axis, with values
// from fn(h, k, l).
function grid(r, s, fn, dims, corner) {
    const n = dims || [0, 1, 2].map(() => Math.round(2 * r / s) + 1);
    const model = {
        dims: n, corner: corner || n.map(m => -(m - 1) / 2 * s), vectors: [[s, 0, 0], [0, s, 0], [0, 0, s]],
        values: new Float64Array(n[0] * n[1] * n[2]), cellLengths: [4, 4, 4], cellAngles: [90, 90, 90],
        radiation: 'unknown', axes: [1, 2, 3],
    };
    let i = 0;
    for (let il = 0; il < n[2]; il++)
        for (let ik = 0; ik < n[1]; ik++)
            for (let ih = 0; ih < n[0]; ih++) {
                model.values[i++] = fn(model.corner[0] + ih * s, model.corner[1] + ik * s, model.corner[2] + il * s);
            }
    return model;
}
const value = (m, ih, ik, il) => m.values[(il * m.dims[1] + ik) * m.dims[0] + ih];
// fn(index, h, k, l) over an axis-aligned grid
const forHkl = (m, fn) => {
    let i = 0;
    for (let il = 0; il < m.dims[2]; il++)
        for (let ik = 0; ik < m.dims[1]; ik++)
            for (let ih = 0; ih < m.dims[0]; ih++, i++) {
                fn(i, m.corner[0] + ih * m.vectors[0][0], m.corner[1] + ik * m.vectors[1][1], m.corner[2] + il * m.vectors[2][2]);
            }
};
const run = (model, steps, ctx) => Processing.applyRecipe(model, { steps }, Object.assign({ cell: cubic(4) }, ctx));

test('Laue groups have the right orders and contain the inversion', () => {
    const orders = { '-1': 2, '2/m': 4, 'mmm': 8, '4/m': 8, '4/mmm': 16, '-3': 6, '-3m1': 12, '-31m': 12,
        '6/m': 12, '6/mmm': 24, 'm-3': 24, 'm-3m': 48 };
    for (const [name, order] of Object.entries(orders)) {
        const ops = Processing.laueOperations(name);
        assert.equal(ops.length, order, name);
        assert.ok(ops.some(M => M.flat().join() === '-1,0,0,0,-1,0,0,0,-1'), `${name} has -1`);
    }
    // m-3m maps (1,2,3) onto the 48 signed permutations
    const images = new Set(Processing.laueOperations('m-3m').map(M =>
        [0, 1, 2].map(r => M[r][0] * 1 + M[r][1] * 2 + M[r][2] * 3).join()));
    assert.equal(images.size, 48);
    // the hexagonal 3-fold sends (1,0,0) to (0,-1,0) or (-1,1,0) - both equivalent in -3
    const three = Processing.laueOperations('-3').map(M => [M[0][0], M[1][0], M[2][0]].join());
    assert.ok(three.includes('0,-1,0') && three.includes('-1,1,0'));
    assert.throws(() => Processing.laueOperations('432'), /unknown Laue group/);
});

test('crop keeps the hkl box and refuses grids not along h, k, l', async () => {
    const m = grid(2, 0.5, (h, k, l) => 100 * h + 10 * k + l);
    const c = await run(m, [{ op: 'crop', h: [-1, 1], l: [0, 2] }]);
    assert.deepEqual(c.dims, [5, 9, 5]);
    assert.deepEqual(c.corner, [-1, -2, 0]);
    assert.equal(value(c, 4, 0, 4), 100 * 1 + 10 * -2 + 2);
    const sheared = Object.assign({}, m, { vectors: [[0.5, 0.5, 0], [0, 0.5, 0], [0, 0, 0.5]] });
    await assert.rejects(run(sheared, [{ op: 'crop', h: [-1, 1] }]), /use "resample"/);
    await assert.rejects(run(m, [{ op: 'crop', h: [5, 6] }]), /no grid points with h in 5\.\.6/);
});

test('resample: exact on grid points, trilinear between them, NaN-aware', async () => {
    const linear = (h, k, l) => 3 * h - 2 * k + l + 7;
    const m = grid(2, 0.5, linear);
    const r = await run(m, [{ op: 'resample', h: [-1, 1, 0.25], k: [0, 0, 0], l: [-2, 2, 1] }]);
    assert.deepEqual(r.dims, [9, 1, 5]);
    for (let il = 0; il < 5; il++)
        for (let ih = 0; ih < 9; ih++) {
            assert.ok(Math.abs(value(r, ih, 0, il) - linear(-1 + ih * 0.25, 0, -2 + il)) < 1e-12);
        }
    const holed = Object.assign({}, m, { values: Float64Array.from(m.values) });
    holed.values[(4 * 9 + 4) * 9 + 4] = NaN;                  // (0, 0, 0)
    const h2 = await run(holed, [{ op: 'resample', h: [0.25, 0.25, 0], k: [0, 0, 0], l: [0, 0, 0] }]);
    assert.ok(Math.abs(h2.values[0] - linear(0.5, 0, 0)) < 1e-12, 'the finite neighbour carries the value');
    const out = await run(m, [{ op: 'resample', h: [5, 5, 0], k: [0, 0, 0], l: [0, 0, 0] }]);
    assert.ok(Number.isNaN(out.values[0]));
});

test('rebin averages blocks, skipping NaN, and centres the new corner', async () => {
    const m = grid(1.5, 0.5, h => h, [4, 1, 1]);
    m.values[1] = NaN;
    const r = await run(m, [{ op: 'rebin', factors: [2, 1, 1] }]);
    assert.deepEqual(r.dims, [2, 1, 1]);
    assert.deepEqual(Array.from(r.values), [-0.75, 0.5]);       // h = -0.75, (NaN), 0.25, 0.75
    assert.deepEqual(r.corner.map(x => +x.toFixed(12)), [-0.5, 0, 0]);
    assert.deepEqual(r.vectors[0], [1, 0, 0]);
});

test('Bragg masks: boxes with centring, spheres in 1/A', async () => {
    const m = grid(1, 0.25, () => 1);
    const box = await run(m, [{ op: 'maskBragg', shape: 'box', size: 0.25, centring: 'I' }]);
    // I centring: (1,0,0) is extinct, (1,1,0) is not
    const at = (mm, h, k, l) => value(mm, (h + 1) / 0.25, (k + 1) / 0.25, (l + 1) / 0.25);
    assert.ok(Number.isNaN(at(box, 0, 0, 0)) && Number.isNaN(at(box, 0.25, 0, 0)));
    assert.equal(at(box, 1, 0, 0), 1);
    assert.ok(Number.isNaN(at(box, 1, 1, 0)));
    assert.equal(at(box, 0.5, 0, 0), 1);
    // sphere of radius 2*pi/4 * 0.3 (1/A): only points within 0.3 r.l.u. of a node (a = 4)
    const sphere = await run(m, [{ op: 'maskBragg', shape: 'sphere', size: 2 * Math.PI / 4 * 0.3, centring: 'P' }]);
    assert.ok(Number.isNaN(at(sphere, 0.25, 0, 0)));
    assert.equal(at(sphere, 0.25, 0.25, 0), 1);        // 0.354 r.l.u. away
});

test('ring mask, value mask, scale and clip', async () => {
    const m = grid(1, 0.25, (h, k, l) => Math.hypot(h, k, l));
    const q1 = 2 * Math.PI / 4;                          // |Q| of (1,0,0) for a = 4
    const rings = await run(m, [{ op: 'maskRings', q: [q1], width: 0.01 }]);
    assert.equal(Converter.countNonFinite(rings.values), 6);   // (+-1,0,0) and permutations
    const ranged = await run(m, [{ op: 'maskRange', min: 0.5, max: 1 }]);
    for (let i = 0; i < m.values.length; i++) {
        assert.equal(Number.isNaN(ranged.values[i]), m.values[i] < 0.5 || m.values[i] > 1);
    }
    const scaled = await run(m, [{ op: 'scale', factor: 2, offset: -1 }, { op: 'clip', below: 0, to: 'nan' }]);
    assert.equal(Converter.countNonFinite(scaled.values), m.values.filter(x => 2 * x - 1 < 0).length);
});

test('isotropic backgrounds: function and |Q|-shell estimate', async () => {
    const a = 4, s = 2 * Math.PI / a;
    const m = grid(2, 0.25, (h, k, l) => 5 + 2 * s * Math.hypot(h, k, l) + (h === 0.5 && k === 0 && l === 0 ? 10 : 0));
    const f = await run(m, [{ op: 'backgroundFunction', kind: 'linear', params: [5, 2] }]);
    assert.ok(Math.abs(value(f, 10, 8, 8) - 10) < 1e-9);       // h = 0.5: the only feature
    assert.ok(Math.abs(value(f, 3, 1, 6)) < 1e-9);
    const logs = [];
    const e = await run(m, [{ op: 'backgroundShells', width: 0.05, percentile: 0, smooth: 0 }], { log: t => logs.push(t) });
    const rest = Array.from(e.values).filter((_, i) => i !== (8 * 17 + 8) * 17 + 10).map(Math.abs);
    assert.ok(Math.max(...rest) < 0.2, 'shell minima follow the linear background');
    assert.ok(value(e, 10, 8, 8) > 9);
    assert.match(logs.join('\n'), /B\(\|Q\|\) at/);
    const t = await run(m, [{ op: 'backgroundFunction', kind: 'table', params: [[0, 5], [10, 5 + 20]] }]);
    assert.ok(Math.abs(value(t, 3, 1, 6)) < 1e-9);
    await assert.rejects(run(m, [{ op: 'backgroundFunction', kind: 'linear', params: [5, 2] }], { cell: cubic(1) }),
        /needs the parent cell/);
});

test('combine subtracts, divides, and samples other grids', async () => {
    const m = grid(1, 0.5, (h, k, l) => 10 + h);
    const bkg = grid(1, 0.5, () => 2);
    const extras = { bkg, norm: grid(2, 0.25, () => 4) };
    const sub = await run(m, [{ op: 'combine', operation: 'subtract', file: 'bkg', scale: 1.5 }], { extras });
    assert.ok(maxAbsDiff(sub.values, m.values.map(x => x - 3)) < 1e-12);
    const logs = [];
    const div = await run(m, [{ op: 'combine', operation: 'divide', file: 'norm' }], { extras, log: x => logs.push(x) });
    assert.ok(maxAbsDiff(div.values, m.values.map(x => x / 4)) < 1e-12);
    assert.match(logs.join('\n'), /different grid; sampled/);
    await assert.rejects(run(m, [{ op: 'combine', operation: 'subtract', file: 'nope' }], { extras }), /no loaded volume named "nope"/);
});

test('symmetrize m-3m: average, fill, and extension of a half grid', async () => {
    const f = (h, k, l) => 1 + h * h + 2 * k * k + 3 * l * l;       // not cubic: averaging mixes it
    const m = grid(1, 0.5, f);
    const avg = await run(m, [{ op: 'symmetrize', laue: 'm-3m' }]);
    assert.ok(Math.abs(value(avg, 4, 2, 2) - (1 + (1 + 2 + 3) / 3)) < 1e-12);   // (1,0,0): mean over h,k,l
    assert.equal(avg.symmetrized, 'laue');
    assert.equal(avg.laueGroup, 'm-3m');
    const holed = Object.assign({}, m, { values: Float64Array.from(m.values) });
    holed.values[(2 * 5 + 2) * 5 + 4] = NaN;                                   // (1,0,0)
    const logs = [];
    const filled = await run(holed, [{ op: 'symmetrize', laue: 'm-3m', mode: 'fill' }], { log: x => logs.push(x) });
    assert.equal(value(filled, 3, 2, 2), m.values[(2 * 5 + 2) * 5 + 3]);        // measured values kept
    // (1,0,0) was NaN: the other five images of it hold 2, 3, 3, 4, 4, each hit by 8 operations
    assert.ok(Math.abs(value(filled, 4, 2, 2) - 3.2) < 1e-12);
    assert.match(logs.join('\n'), /1 empty voxels filled/);
    // half volume l >= 0 extended to the full range with the inversion (-1)
    const half = grid(1, 0.5, (h, k, l) => 1 + h + 10 * k + 100 * l, [5, 5, 3], [-1, -1, 0]);
    const full = await run(half, [{ op: 'symmetrize', laue: '-1', expand: true }]);
    assert.deepEqual(full.dims, [5, 5, 5]);
    assert.deepEqual(full.corner, [-1, -1, -1]);
    // l = -1 comes from the inversion of l = +1: I(h,k,-1) = I(-h,-k,1); l = 0 averages the pair
    assert.equal(value(full, 4, 0, 0), 1 + -1 + 10 * 1 + 100);
    assert.equal(value(full, 2, 2, 2), 1);
});

test('symmetrize sums down the subgroup chain exactly as over every operation', async () => {
    let seed = 3;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (const laue of ['m-3m', 'm-3', '4/mmm', 'mmm', '-1']) {
        const m = grid(1, 0.25, () => (rnd() < 0.2 ? NaN : rnd()));          // 9 x 9 x 9, holes
        for (const mode of ['average', 'fill']) {
            const chain = await run(m, [{ op: 'symmetrize', laue, mode }]);
            const every = await run(m, [{ op: 'symmetrize', laue, mode }], { symmetrizeEveryOperation: true });
            assert.equal(chain.values.length, every.values.length);
            for (let i = 0; i < every.values.length; i++) {
                const a = chain.values[i], b = every.values[i];
                assert.ok(a === b || Math.abs(a - b) < 1e-12 || (a !== a && b !== b), `${laue} ${mode} voxel ${i}: ${a} vs ${b}`);
            }
        }
    }
    const hex = grid(1, 0.5, (h, k, l) => h + 2 * k + 3 * l, [5, 5, 5]);
    for (const laue of ['6/mmm', '-3m1']) {
        const a = await run(hex, [{ op: 'symmetrize', laue, expand: false }]);
        const b = await run(hex, [{ op: 'symmetrize', laue, expand: false }], { symmetrizeEveryOperation: true });
        assert.ok(maxAbsDiff(a.values, b.values) < 1e-12, laue);
    }
    assert.equal(Processing.laueChain('m-3m', 'reciprocal').reduce((s, r) => s + r.length, 0), 11);
});

test('symmetrize works on direct-space data with the operations on u, v, w', async () => {
    // A 3D-ΔPDF of an intensity without the symmetry, then m-3m on it.
    const m = grid(1, 0.25, (h, k, l) => 1 + h + 0.3 * k * k + 0.1 * l);
    const p = await run(m, [{ op: 'deltaPdf' }, { op: 'symmetrize', laue: 'm-3m' }], { fft: cpuFft });
    assert.equal(p.axesType, 'uvw');
    assert.equal(p.laueGroup, 'm-3m');
    for (const [i, j, k] of [[5, 3, 2], [6, 4, 1], [8, 0, 3]]) {
        const v = value(p, i, j, k);
        assert.ok(Math.abs(v - value(p, j, i, k)) < 1e-9 * Math.max(1, Math.abs(v)), 'u <-> v');
        assert.ok(Math.abs(v - value(p, 8 - i, j, k)) < 1e-9 * Math.max(1, Math.abs(v)), 'u -> -u');
    }
    // The hexagonal groups act on u, v, w as R, not as R^T.
    const ops = Processing.laueOperations('6/m', 'direct'), recip = Processing.laueOperations('6/m');
    const six = ops.find(R => R[2][2] === 1 && R.flat().join() === '1,-1,0,1,0,0,0,0,1');
    assert.ok(six, 'the direct-space 6-fold');
    assert.ok(recip.some(R => R.flat().join() === '1,1,0,-1,0,0,0,0,1'), 'its transpose acts on hkl');
});

test('symmetrize on a hexagonal grid uses the 3-fold axis', async () => {
    const m = grid(1, 0.5, (h, k) => h - k, [5, 5, 1]);
    m.corner[2] = 0;
    m.cellLengths = [4, 4, 6];
    m.cellAngles = [90, 90, 120];
    const s = await run(m, [{ op: 'symmetrize', laue: '6/m' }], { cell: { lengths: [4, 4, 6], angles: [90, 90, 120] } });
    // (1,0,0), (0,1,0), (-1,1,0), (-1,0,0), (0,-1,0), (1,-1,0) average to 0
    assert.ok(Math.abs(value(s, 4, 2, 0)) < 1e-12);
});

test('recipes are checked, described and applied in order', async () => {
    assert.throws(() => Processing.normalizeRecipe({ steps: [{ op: 'crop', h: [1, 0] }] }), /step 1 \(crop\) h/);
    assert.throws(() => Processing.normalizeRecipe({ steps: [{ op: 'explode' }] }), /unknown op explode/);
    assert.throws(() => Processing.normalizeRecipe({ steps: [{ op: 'symmetrize', laue: '432' }] }), /unknown Laue group/);
    const recipe = Processing.normalizeRecipe({ steps: [{ op: 'maskBragg', size: 0.1 }, { op: 'clip' }] });
    assert.deepEqual(recipe.steps[0], { op: 'maskBragg', shape: 'box', centring: 'P', size: 0.1 });
    assert.equal(Processing.describeStep(recipe.steps[1]), 'set values below 0 to 0');
    const progress = [];
    const logs = [];
    const m = grid(1, 0.5, () => 1);
    await run(m, recipe.steps, { progress: x => progress.push(x), log: x => logs.push(x) });
    assert.deepEqual(progress, [0.5, 1]);
    assert.match(logs[0], /^Step 1: mask Bragg positions/);
    assert.equal(m.values[0], 1, 'the input model is left alone');
});

test('|Q| profile writes shell means of the finite voxels', () => {
    const m = grid(1, 0.5, (h, k, l) => Math.hypot(h, k, l));
    m.values[0] = NaN;
    const text = Array.from(Processing.writeProfileChunks(m, cubic(2 * Math.PI), 0.3)).join('');
    const rows = text.trim().split('\n').filter(l => !l.startsWith('#')).map(l => l.split(' ').map(Number));
    assert.equal(rows.reduce((s, r) => s + r[3], 0), 124);
    assert.deepEqual(rows[0], [0.15, 0, 0, 1]);                   // |Q| = |hkl| for a = 2 pi
    assert.throws(() => Array.from(Processing.writeProfileChunks(m, cubic(1), 0.5)), /needs the parent cell/);
});

test('3D-ΔPDF of a constant is an origin peak of N |det V|, real, in lattice units', async () => {
    const m = grid(1, 0.25, () => 1);                       // 9 x 9 x 9, h from -1 to 1
    const p = await run(m, [{ op: 'deltaPdf' }], { fft: cpuFft });
    assert.equal(p.axesType, 'uvw');
    assert.equal(p.content, '3d-delta-pdf');
    assert.deepEqual(p.dims, [9, 9, 9]);
    const du = 1 / (9 * 0.25);                               // conjugate step
    assert.ok(maxAbsDiff(p.vectors.flat(), [du, 0, 0, 0, du, 0, 0, 0, du]) < 1e-12);
    assert.ok(maxAbsDiff(p.corner, [-4 * du, -4 * du, -4 * du]) < 1e-12);
    assert.ok(Math.abs(value(p, 4, 4, 4) - 729 * 0.25 ** 3) < 1e-9);
    // a constant on a symmetric grid has a Dirichlet kernel: zero at the other grid points
    assert.ok(Math.abs(value(p, 5, 4, 4)) < 1e-9 && Math.abs(value(p, 0, 0, 0)) < 1e-9);
});

test('3D-ΔPDF of a plane wave peaks at +-r0; 2-D grids work', async () => {
    const n = 17, step = 0.25, du = 1 / (n * step);
    const r0 = 3 * du;
    const m = grid(2, step, h => Math.cos(2 * Math.PI * h * r0), [n, 5, 5]);
    const p = await run(m, [{ op: 'deltaPdf' }], { fft: cpuFft });
    let best = 0, at = -1;
    for (let i = 0; i < p.values.length; i++) if (p.values[i] > best) { best = p.values[i]; at = i; }
    const ih = at % n, rest = Math.floor(at / n);
    assert.equal(rest, 2 * 5 + 2);                           // on the u axis (v = w = 0)
    assert.ok(Math.abs(Math.abs(ih - 8) - 3) === 0, `peak at u index ${ih}`);
    assert.ok(Math.abs(value(p, 8 + 3, 2, 2) - value(p, 8 - 3, 2, 2)) < 1e-9, 'symmetric pair');
    const flat = grid(1, 0.25, () => 1, [9, 9, 1], [-1, -1, 0]);
    const p2 = await run(flat, [{ op: 'deltaPdf' }], { fft: cpuFft });
    assert.deepEqual(p2.dims, [9, 9, 1]);
    assert.ok(Math.abs(value(p2, 4, 4, 0) - 81 * 0.25 ** 2) < 1e-9);
});

test('3D-ΔPDF punch and fill: holes next to data take their neighbours\' mean', async () => {
    const m = grid(1, 0.25, () => 1);                                   // 9 x 9 x 9
    m.values[(4 * 9 + 4) * 9 + 4] = NaN;                                // punch the centre voxel
    m.values[(2 * 9 + 6) * 9 + 1] = NaN;
    const zero = await run(m, [{ op: 'deltaPdf' }], { fft: cpuFft });
    assert.ok(Math.abs(value(zero, 4, 4, 4) - 727 * 0.25 ** 3) < 1e-9, 'holes count as 0');
    const logs = [];
    const filled = await run(m, [{ op: 'deltaPdf', fill: 2 }], { fft: cpuFft, log: t => logs.push(t) });
    assert.ok(Math.abs(value(filled, 4, 4, 4) - 729 * 0.25 ** 3) < 1e-9, 'filled like the constant');
    assert.ok(Math.abs(value(filled, 5, 4, 4)) < 1e-9);
    assert.match(logs.join('\n'), /2 empty voxels filled from their neighbours \(2 passes\)/);
    assert.match(Processing.describeStep(Processing.normalizeRecipe({ steps: [{ op: 'deltaPdf', fill: 3 }] }).steps[0]),
        /holes filled 3 voxels deep/);
    assert.throws(() => Processing.normalizeRecipe({ steps: [{ op: 'deltaPdf', fill: 1.5 }] }), /fill/);
});

test('normalize: Σdata/Σnorm − s Σbkg/Σbkgnorm, summed over the Laue group like MDNorm', async () => {
    const data = grid(1, 0.5, h => 2 + h);                                   // 5 x 5 x 5, h, k, l from -1
    const norm = grid(1, 0.5, h => 1 + 0.5 * (h + 1));
    const extras = { norm, bkg: grid(1, 0.5, () => 3), bkgNorm: grid(1, 0.5, () => 2) };
    const plain = Object.assign({}, norm, { values: Float64Array.from(norm.values) });
    plain.values[0] = 0;                                                     // no norm there
    const steps = laue => [{ op: 'normalize', norm: 'norm', background: 'bkg', backgroundNorm: 'bkgNorm', scale: 0.5, laue }];
    const p = await run(data, steps('none'), { extras: Object.assign({}, extras, { norm: plain }) });
    assert.ok(Math.abs(value(p, 3, 2, 2) - ((2 + 0.5) / (1 + 0.5 * 1.5) - 0.5 * 3 / 2)) < 1e-12);  // (0.5, 0, 0)
    assert.ok(Number.isNaN(p.values[0]));
    assert.ok(p.weights && p.weights[1] === plain.values[1]);
    // m-3m: the orbit of (1, 0, 0) is the six axis points; data 3 + 1 + 2 x 4 = 12, norm 2 + 1 + 1.5 x 4 = 9
    const s = await run(data, steps('m-3m'), { extras });
    assert.ok(Math.abs(value(s, 4, 2, 2) - (12 / 9 - 0.5 * 18 / 12)) < 1e-12);
    assert.equal(s.laueGroup, 'm-3m');
    // the |Q| profile of normalized data averages as Σdata / Σnorm
    const prof = Processing.profileShells(p, cubic(4), 10);
    assert.equal(prof.weighted, true);
    assert.throws(() => Processing.normalizeRecipe({ steps: [{ op: 'normalize', norm: 'n', background: 'b' }] }), /needs its norm/);
    assert.match(Processing.describeStep(Processing.normalizeRecipe({ steps: steps('m-3m') }).steps[0]),
        /Σdata\/Σnorm with "norm" − 0.5 × Σ"bkg"\/Σ"bkgNorm", summed over m-3m/);
});

test('sigma propagates through scale, combine, rebin and symmetrize, and the ΔPDF drops it', async () => {
    const m = grid(1, 0.5, h => 10 + h);
    m.sigma = new Float64Array(125).fill(2);
    const other = grid(1, 0.5, () => 1);
    other.sigma = new Float64Array(125).fill(1.5);
    const scaled = await run(m, [{ op: 'scale', factor: -3, offset: 1 }]);
    assert.equal(scaled.sigma[7], 6);
    const diff = await run(m, [{ op: 'combine', operation: 'subtract', file: 'o', scale: 2 }], { extras: { o: other } });
    assert.ok(Math.abs(diff.sigma[7] - Math.hypot(2, 3)) < 1e-12);
    const rebinned = await run(m, [{ op: 'rebin', factors: [5, 1, 1] }]);
    assert.ok(Math.abs(rebinned.sigma[0] - Math.sqrt(5 * 4) / 5) < 1e-12);
    const sym = await run(m, [{ op: 'symmetrize', laue: 'm-3m' }]);
    assert.ok(Math.abs(sym.sigma[(2 * 5 + 2) * 5 + 4] - Math.sqrt(6 * 4) / 6) < 1e-12);  // (1,0,0): 6 members
    const cropped = await run(m, [{ op: 'crop', h: [0, 1] }]);
    assert.equal(cropped.sigma.length, cropped.values.length);
    const pdf = await run(m, [{ op: 'deltaPdf' }], { fft: cpuFft });
    assert.equal(pdf.sigma, undefined);
});

test('hkl-only steps refuse direct-space data; ΔPDF needs the FFT engine', async () => {
    const m = grid(1, 0.5, () => 1);
    const p = await run(m, [{ op: 'deltaPdf' }], { fft: cpuFft });
    await assert.rejects(Processing.applyRecipe(p, { steps: [{ op: 'maskBragg', size: 0.1 }] }, { cell: cubic(4) }),
        /needs reciprocal-space \(hkl\) data/);
    await assert.rejects(run(m, [{ op: 'deltaPdf' }]), /needs the FFT engine/);
    assert.throws(() => Processing.normalizeRecipe({ steps: [{ op: 'deltaPdf', engine: 'tpu' }] }), /engine/);
    assert.throws(() => Array.from(Processing.writeProfileChunks(p, cubic(4), 0.1)), /needs reciprocal-space/);
});

test('the example files survive a crop-mask-symmetrize recipe', async () => {
    const cell = Converter.parseRmc6f(readText('Examples/example_structure.rmc6f'));
    const model = Converter.parseOldDat(readText('Examples/example_diffuse3d.dat'), cell);
    const out = await Processing.applyRecipe(model, { steps: [
        { op: 'crop', h: [-1, 1], k: [-1, 1], l: [-0.5, 1] },
        { op: 'maskBragg', shape: 'box', size: 0.01 },
        { op: 'symmetrize', laue: 'm-3m', mode: 'fill' },
    ] }, { cell });
    assert.deepEqual(out.dims, [5, 5, 5]);                 // l -0.5..1 extended to -1..1 by default
    assert.ok(Converter.countNonFinite(out.values) < out.values.length);
    const kept = await Processing.applyRecipe(model, { steps: [
        { op: 'crop', h: [-1, 1], k: [-1, 1], l: [-0.5, 1] },
        { op: 'symmetrize', laue: 'm-3m', mode: 'fill', expand: false },
    ] }, { cell });
    assert.deepEqual(kept.dims, [5, 5, 4]);
});

test('symmetrize median and clip: a spike in one equivalent drops out; the grid extends by default', async () => {
    // 9 x 9 x 9 around 0, symmetric under m-3m, with one spike
    const m = grid(1, 0.25, (h, k, l) => 1 + h * h + k * k + l * l);
    const at = (model, h, k, l) => {
        const [nh, nk] = model.dims, f = [h, k, l].map((x, c) => Math.round((x - model.corner[c]) / model.vectors[c][c]));
        return model.values[(f[2] * nk + f[1]) * nh + f[0]];
    };
    const spiked = Object.assign({}, m, { values: Float64Array.from(m.values) });
    const i0 = (8 * 9 + 6) * 9 + 5;                                      // (0.25, 0.5, 1)
    spiked.values[i0] = 1000;
    const want = 1 + 0.0625 + 0.25 + 1;
    const avg = await run(spiked, [{ op: 'symmetrize', laue: 'm-3m', mode: 'average' }]);
    assert.ok(at(avg, 0.25, 0.5, 1) > want + 10, 'the mean spreads the spike');
    for (const mode of ['median', 'clip']) {
        const r = await run(spiked, [{ op: 'symmetrize', laue: 'm-3m', mode }]);
        for (const p of [[0.25, 0.5, 1], [-1, 0.25, -0.5], [0.5, -1, 0.25]]) assert.ok(Math.abs(at(r, ...p) - want) < 1e-12, `${mode} ${p}`);
        assert.equal(maxAbsDiff(r.values, m.values), 0, `${mode} keeps the symmetric data`);
    }
    // a half volume (h >= 0) comes back whole, holding the other half's values
    const half = await run(m, [{ op: 'crop', h: [0, 1] }]);
    const whole = await run(half, [{ op: 'symmetrize', laue: 'mmm' }]);
    assert.deepEqual(whole.dims, [9, 9, 9]);
    assert.equal(maxAbsDiff(whole.values, m.values), 0);
    const robust = await run(half, [{ op: 'symmetrize', laue: 'mmm', mode: 'clip' }]);
    assert.equal(maxAbsDiff(robust.values, m.values), 0);
});

// ---- smoothing, filling, powder lines, fitted scales, shifts

test('smooth: a NaN-aware Gaussian keeps a constant, spreads a spike, leaves holes empty', async () => {
    const flat = grid(2, 0.5, () => 5);
    flat.values[10] = NaN;
    const s = await run(flat, [{ op: 'smooth', sigma: 1 }]);
    assert.ok(Number.isNaN(s.values[10]));
    assert.ok(s.values.every((x, i) => i === 10 || Math.abs(x - 5) < 1e-12), 'a constant stays constant around a hole');
    const spike = grid(2, 0.5, (h, k, l) => (h === 0 && k === 0 && l === 0 ? 1 : 0));
    const t = await run(spike, [{ op: 'smooth', sigma: 0.5 }]);
    const c = value(t, 4, 4, 4), n1 = value(t, 5, 4, 4), n2 = value(t, 6, 4, 4);
    assert.ok(c < 1 && n1 > 0 && n1 < c && n2 < n1, `${c} ${n1} ${n2}`);
    assert.ok(Math.abs(n1 / c - Math.exp(-2)) < 1e-12, 'one voxel away: exp(-1/(2 sigma^2))');
});

test('fill: empty voxels take their measured neighbours, n layers deep', async () => {
    const m = grid(2, 0.5, () => 3);
    for (const i of [60, 61, 62]) m.values[i] = NaN;                     // a short run of holes
    const f = await run(m, [{ op: 'fill', passes: 1 }]);
    assert.ok([60, 61, 62].every(i => f.values[i] === 3));
    assert.match(Processing.describeStep(Processing.normalizeRecipe({ steps: [{ op: 'fill', passes: 2 }] }).steps[0]), /2 voxels deep/);
});

test('backgroundFunction table: two rows at one |Q| make a step', async () => {
    const m = grid(2, 0.5, () => 10);
    const steps = [{ op: 'backgroundFunction', kind: 'table', params: [[0, 1], [2, 1], [2, 3], [9, 3]] }];
    const b = await run(m, steps);
    const Q = (h, k, l) => 2 * Math.PI * Math.hypot(h, k, l) / 4;
    for (let il = 0; il < 9; il++) for (let ik = 0; ik < 9; ik++) for (let ih = 0; ih < 9; ih++) {
        const q = Q(-2 + ih * 0.5, -2 + ik * 0.5, -2 + il * 0.5);
        assert.ok(Math.abs(value(b, ih, ik, il) - (10 - (q < 2 ? 1 : 3))) < 1e-9, `|Q| ${q}`);
    }
});

test('normalize: the background scale fitted by least squares', async () => {
    const x = (h, k, l) => 1 + 0.3 * h * h + 0.1 * k - 0.2 * l;       // the background ratio
    const data = grid(1, 0.5, (h, k, l) => 2.5 * x(h, k, l) + 0.7);     // = 2.5 x + 0.7, norm 1
    const extras = { norm: grid(1, 0.5, () => 1), bkg: grid(1, 0.5, (h, k, l) => 4 * x(h, k, l)), bkgNorm: grid(1, 0.5, () => 4) };
    const logs = [];
    const r = await run(data, [{ op: 'normalize', norm: 'norm', background: 'bkg', backgroundNorm: 'bkgNorm', fitScale: true }],
        { extras, log: t => logs.push(t) });
    assert.ok(r.values.every(v => Math.abs(v - 0.7) < 1e-9), 'data - 2.5 x leaves the offset');
    assert.match(logs.join('\n'), /background scale fitted by least squares: 2\.5 \(offset 0\.7/);
});

test('scale: shift up to positive (1.01 x the lowest value)', async () => {
    const m = grid(1, 0.5, (h, k, l) => h * 10);                       // from -10 to 10
    const s = await run(m, [{ op: 'scale', factor: 1, offset: 0, positive: true }]);
    assert.ok(Math.abs(Math.min(...s.values) - 0.1) < 1e-12);
    assert.ok(Math.abs(Math.max(...s.values) - 20.1) < 1e-12);
    const pos = await run(grid(1, 0.5, () => 2), [{ op: 'scale', factor: 1, offset: 0, positive: true }]);
    assert.ok(pos.values.every(v => v === 2), 'already positive: unchanged');
});

test('maskRings: aluminium powder lines from the lattice parameter', async () => {
    // a line of voxels along h in a cubic cell (a = 4.05): Al (111) sits at |Q| = 2 pi sqrt(3) / 4.0495
    const m = grid(0, 0.01, () => 1, [601, 1, 1], [0, 0, 0]);
    const cell = cubic(4.05);
    const r = await run(m, [{ op: 'maskRings', powder: 'aluminium', width: 0.01 }], { cell });
    const q111 = 2 * Math.PI * Math.sqrt(3) / 4.0495, q200 = 2 * Math.PI * 2 / 4.0495;
    const hOf = q => q * 4.05 / (2 * Math.PI);
    const at = h => r.values[Math.round(h / 0.01)];
    assert.ok(Number.isNaN(at(hOf(q111))) && Number.isNaN(at(hOf(q200))));
    assert.equal(at(hOf((q111 + q200) / 2)), 1);
    await assert.rejects(run(m, [{ op: 'maskRings', width: 0.01 }], { cell }), /no rings/);
    assert.match(Processing.describeStep(Processing.normalizeRecipe({ steps: [{ op: 'maskRings', powder: 'aluminium', width: 0.03 }] }).steps[0]),
        /of aluminium \(a = 4\.0495 A\) \+\/- 0\.03/);
});

test('removeRings: sharp rings go by Fourier filtering of the |Q| profile, the diffuse stays', async () => {
    const a = 4, n = 61, st = 2 / 30, Qof = (h, k, l) => 2 * Math.PI * Math.hypot(h, k, l) / a;
    let seed = 11;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const ring = q => 40 * Math.exp(-0.5 * ((q - 2) / 0.01) ** 2);
    const clean = grid(2, st, (h, k, l) => 10 + Qof(h, k, l) + 3 * Math.cos(Math.PI * h) * Math.cos(Math.PI * k), [n, n, n]);
    const ringed = grid(2, st, (h, k, l) => 10 + Qof(h, k, l) + 3 * Math.cos(Math.PI * h) * Math.cos(Math.PI * k) +
        ring(Qof(h, k, l)) + (rnd() - 0.5), [n, n, n]);
    const logs = [];
    const out = await run(ringed, [{ op: 'removeRings', materials: 'any', width: 0.005, cutoff: 0.05 }], { log: t => logs.push(t) });
    assert.match(logs.join(' '), /sharpest rings at \|Q\| 2\.00/);
    const excess = (m, lo, hi) => {
        let s = 0, c = 0;
        forHkl(m, (i, h, k, l) => {
            const q = Qof(h, k, l);
            if (q >= lo && q < hi) { s += m.values[i] - clean.values[i]; c++; }
        });
        return s / c;
    };
    assert.ok(excess(ringed, 1.99, 2.01) > 25);
    assert.ok(Math.abs(excess(out, 1.99, 2.01)) < 0.1 * excess(ringed, 1.99, 2.01), 'the ring is gone');
    assert.ok(Math.abs(excess(out, 2.4, 3)) < 0.1, 'the rest stays');
    // a named material takes only its own lines: aluminium has none at 2.00 1/A
    const named = [];
    const kept = await run(Object.assign({}, ringed, { radiation: 'neutron' }), [{ op: 'removeRings', materials: 'aluminium' }],
        { log: t => named.push(t) });
    assert.ok(excess(kept, 1.99, 2.01) > 25);
    assert.match(named.join(' '), /aluminium: no clear lines/);
});

test('removeRings of materials: aluminium lines from the structure, fitted and taken off; others left out', async () => {
    // neutron lines of fcc aluminium, 0.3 % larger than listed, widths sqrt(0.006^2 + (0.004 Q)^2)
    const aAl = 4.0495 * 1.003, b = 0.3449, B = 0.85, lines = [];
    for (let h = 0; h <= 8; h++) for (let k = 0; k <= h; k++) for (let l = 0; l <= k; l++) {
        if (!(h % 2 === k % 2 && k % 2 === l % 2) || !(h + k + l)) continue;
        const q = 2 * Math.PI * Math.hypot(h, k, l) / aAl, images = new Set();
        for (const [x, y, z] of [[h, k, l], [h, l, k], [k, h, l], [k, l, h], [l, h, k], [l, k, h]])
            for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) images.add([sx * x, sy * y, sz * z].join());
        lines.push([q, images.size * 16 * b * b * Math.exp(-2 * B * (q / (4 * Math.PI)) ** 2) / (4 * Math.PI * q * q)]);
    }
    const rings = q => lines.reduce((sum, [c, w]) => {
        const sg = Math.hypot(0.006, 0.004 * c);
        return sum + 40 * w * Math.exp(-0.5 * ((q - c) / sg) ** 2) / (sg * Math.sqrt(2 * Math.PI));
    }, 0);
    const a = 5, Qof = (h, k, l) => 2 * Math.PI * Math.hypot(h, k, l) / a;
    let seed = 5;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const smooth = (h, k, l) => 10 + Qof(h, k, l) + 4 * Math.cos(Math.PI * h) * Math.cos(Math.PI * k);
    const clean = grid(3, 0.1, smooth);
    const data = Object.assign(grid(3, 0.1, (h, k, l) => smooth(h, k, l) + rings(Qof(h, k, l)) + 0.5 * (rnd() - 0.5)), { radiation: 'neutron' });
    const cell = { lengths: [a, a, a], angles: [90, 90, 90] };
    const near = m => {
        let s = 0, c = 0;
        forHkl(m, (i, h, k, l) => {
            if (rings(Qof(h, k, l)) > 1) { s += Math.abs(m.values[i] - clean.values[i]); c++; }
        });
        return s / c;
    };
    const logs = [];
    const out = await Processing.applyRecipe(data, { steps: [{ op: 'removeRings', materials: 'aluminium, copper, ice' }] },
        { cell, log: t => logs.push(t) });
    const text = logs.join('\n');
    const fitted = /aluminium: a = ([\d.]+) A/.exec(text);
    assert.ok(fitted && Math.abs(Number(fitted[1]) / aAl - 1) < 5e-4, text);
    assert.match(text, /copper: no clear lines/);
    assert.match(text, /ice: no clear lines/);
    assert.ok(near(data) > 20 && near(out) < 0.05 * near(data), `${near(data)} -> ${near(out)}`);
    let far = 0, n = 0;
    forHkl(out, (i, h, k, l) => {
        if (rings(Qof(h, k, l)) < 0.01) { far += Math.abs(out.values[i] - clean.values[i]); n++; }
    });
    assert.ok(far / n < 0.2, `away from the lines ${far / n}`);
    // each line an intensity of its own does the same
    const free = await Processing.applyRecipe(data, { steps: [{ op: 'removeRings', materials: 'Al', intensities: 'free' }] }, { cell });
    assert.ok(near(free) < 0.08 * near(data));
    // a custom material, and unknown ones refused
    assert.equal(Processing.normalizeRecipe({ steps: [{ op: 'removeRings', materials: 'hcp Ti 2.95 4.69, aluminium 4.03' }] }).steps.length, 1);
    assert.throws(() => Processing.normalizeRecipe({ steps: [{ op: 'removeRings', materials: 'unobtainium' }] }), /unknown "unobtainium"/);
});

test('backgroundDebyeWaller: Laue and thermal diffuse of a composition, scaled to the floor of the data', async () => {
    // neutrons, PbO2: count x b^2 (1 - exp(-Uiso Q^2)) per site
    const bPb = 0.9405, bO = 0.5803, Qof = (h, k, l) => 2 * Math.PI * Math.hypot(h, k, l) / 4;
    const I = q => bPb * bPb * (1 - Math.exp(-0.02 * q * q)) + 2 * bO * bO * (1 - Math.exp(-0.01 * q * q));
    const m = grid(3, 0.1, (h, k, l) => 5 * I(Qof(h, k, l)) + 1);
    const logs = [];
    const out = await run(m, [{ op: 'backgroundDebyeWaller', radiation: 'neutron', composition: 'Pb; 2*O', uiso: 'Pb 0.02, O 0.01',
        percentile: 50, width: 0.02, offset: true }], { log: t => logs.push(t) });
    const fitted = /shells: ([\d.]+), offset ([\d.-]+)/.exec(logs.join(' '));
    assert.ok(Math.abs(Number(fitted[1]) - 5) < 0.02 && Math.abs(Number(fitted[2]) - 1) < 0.02, logs.join('\n'));
    let worst = 0;
    for (const x of out.values) worst = Math.max(worst, Math.abs(x));
    assert.ok(worst < 0.02, `left over ${worst}`);
    // a given scale, no fit; the Laue part of a mixed site without displacements is flat
    const flat = await run(m, [{ op: 'backgroundDebyeWaller', radiation: 'neutron', composition: 'Pb; 2*O', uiso: 'Pb 0.02, O 0.01', fit: false, scale: 5 }]);
    assert.ok(Math.abs(flat.values[0] - 1) < 1e-9 && Math.abs(flat.values[flat.values.length - 1] - 1) < 1e-9);
    await assert.rejects(run(m, [{ op: 'backgroundDebyeWaller', radiation: 'neutron', composition: 'Mg 0.5 + Nb 0.5', uiso: '0', offset: true }]),
        /does not change with \|Q\|/);
    await assert.rejects(run(m, [{ op: 'backgroundDebyeWaller', composition: 'Pb' }]), /radiation of the data is not known/);
});

test('correctUB: Bragg peaks of a slightly wrong UB go back onto integer hkl (refined, or from the right UB)', async () => {
    // peaks drawn where a wrong UB puts them: found = A^-1 H, A a small rotation and strain
    const t = 0.8 * Math.PI / 180, A = [[Math.cos(t) * 1.005, -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0.004], [0, 0, 0.995]];
    const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    const inv = [0, 1, 2].map(r => [0, 1, 2].map(c => {
        const m = (i, j) => A[(j + 1) % 3][(i + 1) % 3] * A[(j + 2) % 3][(i + 2) % 3] - A[(j + 1) % 3][(i + 2) % 3] * A[(j + 2) % 3][(i + 1) % 3];
        return m(r, c) / det;
    }));
    const peakAt = H => [0, 1, 2].map(r => inv[r][0] * H[0] + inv[r][1] * H[1] + inv[r][2] * H[2]);
    const centres = [];
    for (let H = -3; H <= 3; H++) for (let K = -3; K <= 3; K++) for (let L = -3; L <= 3; L++) if (H || K || L) centres.push([[H, K, L], peakAt([H, K, L])]);
    const m = grid(3.5, 0.05, (h, k, l) => {
        let v = 1;
        for (const [, c] of centres) {
            const d2 = (h - c[0]) ** 2 + (k - c[1]) ** 2 + (l - c[2]) ** 2;
            if (d2 < 0.09) v += 1000 * Math.exp(-d2 / (2 * 0.06 * 0.06));
        }
        return v;
    });
    // where the strongest voxel near a Bragg position is
    const maxNear = (model, H) => {
        let best = -Infinity, at = null;
        forHkl(model, (i, h, k, l) => {
            if (Math.abs(h - H[0]) < 0.2 && Math.abs(k - H[1]) < 0.2 && Math.abs(l - H[2]) < 0.2 && model.values[i] > best) {
                best = model.values[i];
                at = [h, k, l];
            }
        });
        return at;
    };
    const off = (model, H) => Math.hypot(...maxNear(model, H).map((x, c) => x - H[c]));
    assert.ok(off(m, [3, 3, 3]) > 0.05, 'the peaks start off their places');
    const logs = [];
    const fixed = await run(m, [{ op: 'correctUB', mode: 'refine', radius: 0.2 }], { log: x => logs.push(x) });
    assert.match(logs.join('\n'), /Bragg peaks, \d+ used: rms miss of integer hkl 0\.0\d+ -> 0\.00\d/);
    for (const H of [[3, 3, 3], [-3, 2, 1], [0, 0, 3], [3, -3, -3]]) assert.ok(off(fixed, H) < 0.026, `${H}: ${off(fixed, H)}`);
    // the same from the UB the grid was made with and the right one: UB_old A^-1
    const ubOld = [[0.2, 0, 0], [0, 0.2, 0], [0, 0, 0.25]];
    const ubNew = [0, 1, 2].map(r => [0, 1, 2].map(c => ubOld[r][0] * inv[0][c] + ubOld[r][1] * inv[1][c] + ubOld[r][2] * inv[2][c]));
    const byUB = await run(Object.assign({}, m, { ub: ubOld }), [{ op: 'correctUB', mode: 'matrix', ubNew: ubNew.flat() }]);
    for (const H of [[3, 3, 3], [-3, 2, 1]]) assert.ok(off(byUB, H) < 0.026, `${H}: ${off(byUB, H)}`);
    assert.ok(maxAbsDiff(byUB.ub.flat(), ubNew.flat()) < 1e-12);
    await assert.rejects(run(m, [{ op: 'correctUB', mode: 'matrix', ubNew: ubNew.flat() }]), /made with/);
});

test('despike, |Q| window and |Q| mask', async () => {
    const m = grid(1, 0.25, (h, k, l) => 10 + h + 2 * k + 3 * l);
    const spiked = Object.assign({}, m, { values: Float64Array.from(m.values) });
    spiked.values[(4 * 9 + 4) * 9 + 4] = 500;                          // (0, 0, 0)
    spiked.values[(2 * 9 + 6) * 9 + 3] = -300;
    const logs = [];
    const clean = await run(spiked, [{ op: 'despike', size: 1, k: 5 }], { log: t => logs.push(t) });
    assert.match(logs.join(' '), /2 voxels beyond 5 robust sigma/);
    assert.equal(clean.values[(4 * 9 + 4) * 9 + 4], 10);
    assert.equal(maxAbsDiff(clean.values.filter((_, i) => i !== (2 * 9 + 6) * 9 + 3), m.values.filter((_, i) => i !== (2 * 9 + 6) * 9 + 3)), 0);
    // |Q| window: the largest sphere in -1..1 r.l.u. of a 4 A cube has |Q| = 2 pi / 4
    const ones = grid(1, 0.25, () => 1);
    const win = await run(ones, [{ op: 'window', kind: 'lorch' }], { log: t => logs.push(t) });
    assert.match(logs.join(' '), /lorch window to \|Q\| 1\.5708/);
    assert.equal(value(win, 4, 4, 4), 1);
    assert.ok(Math.abs(value(win, 6, 4, 4) - Math.sin(Math.PI / 2) / (Math.PI / 2)) < 1e-12);   // h = 0.5: half of qmax
    assert.ok(Number.isNaN(value(win, 8, 8, 8)));
    const shell = await run(ones, [{ op: 'maskQ', min: 0.5, max: 1.2 }]);
    assert.ok(Number.isNaN(value(shell, 4, 4, 4)) && value(shell, 6, 4, 4) === 1 && Number.isNaN(value(shell, 8, 4, 4)));
});
