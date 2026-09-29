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
        const a = await run(hex, [{ op: 'symmetrize', laue }]);
        const b = await run(hex, [{ op: 'symmetrize', laue }], { symmetrizeEveryOperation: true });
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
    assert.deepEqual(out.dims, [5, 5, 4]);
    assert.ok(Converter.countNonFinite(out.values) < out.values.length);
});
