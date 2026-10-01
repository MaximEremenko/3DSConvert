'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Processing = require('../js/processing.js');

// Exercise the private numerical kernel without adding a production API.
const source = fs.readFileSync(path.join(__dirname, '../js/processing.js'), 'utf8');
const solverSource = source.slice(source.indexOf('    function nonNegative('), source.indexOf('    // Rings of named materials:'));
const smallSource = source.slice(source.indexOf('    function solveSmall('), source.indexOf('    // Bragg peaks near the integer'));
const sandbox = {};
vm.runInNewContext(solverSource + '\n' + smallSource + '\nthis.nnls = nonNegative;', sandbox);
const nnls = sandbox.nnls;

function checkKKT(cols, y, wt, fit, keep) {
    const residual = y.map((v, b) => cols.reduce((s, c, i) => s + fit.x[i] * c[b], 0) - v);
    for (let i = 0; i < cols.length; i++) {
        if (keep && !keep[i]) { assert.equal(fit.x[i], 0); continue; }
        const norm = cols[i].reduce((s, v, b) => s + wt[b] * v * v, 0);
        const grad = cols[i].reduce((s, v, b) => s + wt[b] * v * residual[b], 0) + 1e-10 * norm * fit.x[i];
        const scale = Math.max(1, ...y.map((v, b) => Math.abs(wt[b] * cols[i][b] * v)));
        assert.ok(fit.x[i] >= 0, `negative coefficient ${fit.x[i]}`);
        assert.ok(fit.x[i] > 1e-8 ? Math.abs(grad) < 1e-7 * scale : grad > -1e-7 * scale,
            `KKT column ${i}: x=${fit.x[i]}, gradient=${grad}`);
    }
}

test('ring NNLS reintroduces a useful column rejected by the unconstrained fit', () => {
    const cols = [[1, 0], [-1, 1]], y = [1, -2], wt = [1, 1];
    const fit = nnls(cols, y, wt);
    assert.ok(Math.abs(fit.x[0] - 1) < 1e-8);
    assert.equal(fit.x[1], 0);
    checkKKT(cols, y, wt, fit);
});

test('ring NNLS satisfies KKT for overlapping high-pass columns and unequal weights', () => {
    const cols = [[1, 0.6, -0.4, -0.8, -0.4, 0], [-0.4, 0.6, 1, 0.3, -0.8, -0.7],
        [-0.5, -0.5, 0.1, 0.9, 0.6, -0.6], [0, 0, 0, 0, 0, 0]];
    const wt = [0.3, 2, 0, 1, 4, 0.5];
    let seed = 31571;
    for (let rep = 0; rep < 30; rep++) {
        const y = wt.map(() => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return 4 * seed / 4294967296 - 2; });
        const fit = nnls(cols, y, wt);
        checkKKT(cols, y, wt, fit);
        assert.equal(fit.x[3], 0);
    }
    const keep = [true, false, true, true], y = [2, -1, 3, -2, 0, 1];
    checkKKT(cols, y, wt, nnls(cols, y, wt, keep), keep);
});

test('ring NNLS handles duplicate columns, scale changes and the explicit signed path', () => {
    const cols = [[1, 2, -1], [1, 2, -1], [-1, -2, 1]], y = [3, 6, -3], wt = [1, 0.5, 2];
    const fit = nnls(cols, y, wt);
    checkKKT(cols, y, wt, fit);
    assert.ok(Math.abs(fit.x[0] + fit.x[1] - 3) < 1e-7);
    const scaled = nnls([cols[0].map(v => v * 1e-5), cols[2].map(v => v * 1e5)], y, wt);
    assert.ok(Math.abs(scaled.x[0] * 1e-5 - 3) < 1e-7);
    assert.equal(scaled.x[1], 0);
    const signed = nnls([[1, 0], [-1, 1]], [1, -2], [1, 1], undefined, true);
    assert.ok(Math.abs(signed.x[0] + 1) < 1e-8 && Math.abs(signed.x[1] + 2) < 1e-8);
});

// Independently specified first eight fcc powder shells and multiplicities.
function fccCurve(a, B, firstHeight, s0, r) {
    const shells = [[3, 8], [4, 6], [8, 12], [11, 24], [12, 8], [16, 6], [19, 24], [20, 24]];
    const lines = shells.map(([m, mult]) => {
        const q = 2 * Math.PI * Math.sqrt(m) / a, s = Math.hypot(s0, r * q);
        return { q, s, height: mult * Math.exp(-2 * B * (q / (4 * Math.PI)) ** 2) / (q * q * s) };
    });
    return q => firstHeight / lines[0].height * lines.reduce((sum, line) => sum + line.height * Math.exp(-0.5 * ((q - line.q) / line.s) ** 2), 0);
}

function synthetic(alHeight, cuHeight, singleNegativeSample = false, alLambda = 1) {
    const n = 81, st = 0.075, R = 3, a = 4.02, s0 = 0.02, r = 0.002;
    const al = fccCurve(4.0496 * alLambda, 0.86, alHeight, s0, r), cu = fccCurve(3.615, 0.54, cuHeight, s0, r);
    const model = { dims: [n, n, n], corner: [-R, -R, -R], vectors: [[st, 0, 0], [0, st, 0], [0, 0, st]],
        values: new Float64Array(n ** 3), radiation: 'neutron', space: 'reciprocal' };
    const truth = new Float64Array(n ** 3), qs = new Float64Array(n ** 3);
    let seed = 24681, j = 0;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++, j++) {
        const q = 2 * Math.PI / a * Math.hypot(-R + x * st, -R + y * st, -R + z * st);
        qs[j] = q;
        const sample = singleNegativeSample ? -0.12 * Math.exp(-0.5 * ((q - 2 * Math.PI * Math.sqrt(3) / 3.615) / s0) ** 2) : 0;
        truth[j] = 0.1 + 0.01 * q + sample + 0.002 * Math.sqrt(-2 * Math.log(rnd() + 1e-20)) * Math.cos(2 * Math.PI * rnd());
        model.values[j] = truth[j] + al(q) + cu(q);
    }
    return { model, truth, qs, cell: { lengths: [a, a, a], angles: [90, 90, 90] },
        step: { op: 'removeRings', materials: 'aluminium, copper', sigma0: s0, resolution: r, voxelWidth: false, fitWidth: false, sectors: 1, shift: 0 } };
}

test('removeRings automatically recovers mixed-sign materials and retains positive lines', async () => {
    const { model, truth, qs, cell, step } = synthetic(0.20, -0.12);
    const memo = {}, logs = [];
    const out = await Processing.applyRecipe(model, { steps: [step] }, { cell, memo, log: t => logs.push(t) });
    assert.ok(memo.rings.lines.some(line => line.name === 'aluminium' && line.height > 0));
    assert.ok(memo.rings.lines.some(line => line.name === 'copper' && line.height < 0));
    assert.match(logs.join('\n'), /missing materials fitted with negative-only intensities/);
    for (const q0 of [2 * Math.PI * Math.sqrt(3) / 4.0496, 2 * Math.PI * Math.sqrt(3) / 3.615]) {
        let before = 0, after = 0, count = 0;
        for (let j = 0; j < qs.length; j++) if (Math.abs(qs[j] - q0) < 0.02) {
            before += (model.values[j] - truth[j]) ** 2;
            after += (out.values[j] - truth[j]) ** 2;
            count++;
        }
        assert.ok(count > 100 && Math.sqrt(after / before) < 0.08, `Q=${q0}: residual ratio ${Math.sqrt(after / before)}`);
    }
});

test('automatic negative retry rejects noise and an isolated negative sample shell', async () => {
    for (const single of [false, true]) {
        const { model, cell, step } = synthetic(0, 0, single);
        const memo = {};
        const out = await Processing.applyRecipe(model, { steps: [step] }, { cell, memo });
        assert.equal(memo.rings.lines.length, 0, `single sample shell=${single}`);
        assert.deepEqual(out.values, model.values);
    }
});

test('final lattice refinement stays inside the requested interval', async () => {
    const { model, cell, step } = synthetic(0.20, 0, false, 1.011);
    step.materials = 'aluminium';
    const memo = {};
    await Processing.applyRecipe(model, { steps: [step] }, { cell, memo });
    assert.ok(memo.rings.lines.length >= 2, 'the near-boundary material remains detectable');
    const lambda = (2 * Math.PI * Math.sqrt(3) / 4.0496) / memo.rings.lines[0].q;
    assert.ok(lambda <= 1.01 && lambda >= 0.99, `lattice multiplier ${lambda}`);
});

test('a sector whose constrained scale is zero receives no own ring component', () => {
    const filename = path.join(__dirname, '../js/processing.js');
    const context = { module: { exports: {} }, require: require('node:module').createRequire(filename) };
    vm.runInNewContext(source.replace('LAUE_GROUPS, RECIPROCAL_ONLY:', 'materialRings, sphereDirections, LAUE_GROUPS, RECIPROCAL_ONLY:'), context);
    const internal = context.module.exports;
    const step = Processing.normalizeRecipe({ steps: [{ op: 'removeRings', materials: 'aluminium', sigma0: 0.02,
        resolution: 0, fitWidth: false, refine: 0, sectors: 8, shift: 0, voxelWidth: false }] }).steps[0];
    const nb = 1440, curve = fccCurve(4.0496, 0.86, 0.2, 0.02, 0), centre = b => 0.005 * (b + 0.5);
    const profile = sector => ({ level: Float64Array.from({ length: nb }, (_, b) =>
        0.1 + 0.01 * centre(b) + (sector === 0 ? -0.5 : 1) * curve(centre(b))), err: new Float64Array(nb).fill(0.001) });
    const rp = { nb, nsec: 8, centre, coordU: q => q / 0.02, du: 0.25, s0init: 0.02, rinit: 0,
        qs: [2 * Math.PI * Math.sqrt(3) / 4.0496], steps: [[0.02, 0, 0], [0, 0.02, 0], [0, 0, 0.02]], profile };
    const ctx = { log: () => {} }, model = { radiation: 'neutron' };
    const fit = internal.materialRings(model, rp, step, ctx);
    const whole = internal.materialRings(model, Object.assign({}, rp, { nsec: 1 }), step, ctx);
    const dirs = internal.sphereDirections(8), direction = dirs[0], kappa = 2 / (1 - Math.cos(Math.sqrt(4 * Math.PI / 8)));
    const weights = dirs.map(n => Math.exp(kappa * (n.reduce((sum, v, c) => sum + v * direction[c], 0) - 1)));
    const expected = whole.ring(0, null) * (1 - weights[0] / weights.reduce((sum, v) => sum + v, 0));
    assert.ok(Math.abs(fit.ring(0, direction) - expected) < 1e-6,
        `zero sector plus known angular blend: ${fit.ring(0, direction)} vs ${expected}`);
});
