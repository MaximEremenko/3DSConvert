'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Processing = require('../js/processing.js');

const cell = { lengths: [4, 4, 4], angles: [90, 90, 90] };
const line = { q: 2.687, s: 0.035, height: 1, name: 'aluminium' };
const makeMemo = () => ({ rings: { names: ['aluminium'], lines: [{ ...line }], s0: line.s, r: 0, voxelWidth: false } });

function fixture(clipped = false) {
    const dims = [clipped ? 21 : 61, 61, 61], st = 0.1;
    const corner = dims.map(n => -(n - 1) * st / 2), count = dims.reduce((p, n) => p * n, 1);
    const model = { dims, corner, vectors: [[st, 0, 0], [0, st, 0], [0, 0, st]], values: new Float64Array(count),
        radiation: 'neutron', axesType: 'hkl', cellLengths: cell.lengths, cellAngles: cell.angles };
    const qs = new Float64Array(count), transverse = new Float64Array(count), mask = new Float64Array(count);
    let i = 0, seed = 1731;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++, i++) {
        const h = corner[0] + x * st, k = corner[1] + y * st, l = corner[2] + z * st;
        const q = Math.PI / 2 * Math.hypot(h, k, l), t = Math.PI / 2 * Math.hypot(h, k), phi = Math.atan2(k, h);
        const angular = 1 + 0.25 * Math.cos(2 * phi) + 0.2 * (q > 0 ? l * Math.PI / (2 * q) : 0);
        qs[i] = q; transverse[i] = t;
        model.values[i] = 0.1 + 0.01 * q + 0.12 * angular * Math.exp(-0.5 * ((q - line.q) / line.s) ** 2) + 0.0001 * (rnd() - 0.5);
        mask[i] = Math.abs(h - 1.6) < 0.15 && Math.abs(k) < 0.6 ? 1 : 0;
    }
    return { model, qs, transverse, mask: { ...model, values: mask } };
}

test('partial-circle voxels are unchanged by axial, azimuthal and optional local corrections', async () => {
    const { model, qs, transverse } = fixture(true);
    for (const local of [0, 30]) {
        const out = await Processing.applyRecipe(model, { steps: [{ op: 'filterRings', axis: '0 0 1', angleStep: 3, azimuth: 4,
            bragg: 0, passes: 1, local }] }, { cell, memo: makeMemo() });
        let protectedCount = 0, corrected = 0;
        for (let i = 0; i < qs.length; i++) {
            // At this transverse radius less than three quarters of the
            // circle fits between the h boundaries, away from bin margins.
            if (transverse[i] > 2.2 && Math.abs(qs[i] - line.q) < 0.07) {
                assert.equal(out.values[i], model.values[i], `partial circle, local=${local}`);
                protectedCount++;
            }
            if (transverse[i] < 1 && Math.abs(out.values[i] - model.values[i]) > 0.001) corrected++;
        }
        assert.ok(protectedCount > 100);
        assert.ok(corrected > 50, `complete circles remain active, local=${local}: ${corrected}`);
    }
});

test('default Fourier correction ends at four widths; optional local correction reaches the fifth', async () => {
    const { model, qs } = fixture();
    const outputs = [];
    for (const local of [0, 30]) outputs.push(await Processing.applyRecipe(model,
        { steps: [{ op: 'filterRings', axis: '0 0 1', angleStep: 3, azimuth: 4, bragg: 0, passes: 1, local }] }, { cell, memo: makeMemo() }));
    let tailCount = 0, changedTail = 0;
    for (let i = 0; i < qs.length; i++) {
        const distance = Math.abs(qs[i] - line.q) / line.s;
        if (distance > 4.01) assert.equal(outputs[0].values[i], model.values[i], 'default support');
        if (distance > 5.01) assert.equal(outputs[1].values[i], model.values[i], 'optional local support');
        if (distance > 4.1 && distance < 4.8) {
            tailCount++;
            if (Math.abs(outputs[1].values[i] - model.values[i]) > 1e-10) changedTail++;
        }
    }
    assert.ok(tailCount > 100 && changedTail > 10, `local taper receives data: ${changedTail} / ${tailCount}`);
});

test('finite protected values cannot affect the filter estimate, including optional local fitting', async () => {
    const { model, mask } = fixture();
    const modified = { ...model, values: model.values.slice() };
    for (let i = 0; i < mask.values.length; i++) if (mask.values[i]) modified.values[i] += 100 + i % 17;
    const recipe = { steps: [{ op: 'filterRings', axis: '0 0 1', angleStep: 3, passes: 1, bragg: 0, local: 30, protect: 'features' }] };
    const run = input => Processing.applyRecipe(input, recipe, { cell, extras: { features: mask }, memo: makeMemo() });
    const a = await run(model), b = await run(modified);
    let changed = 0;
    for (let i = 0; i < model.values.length; i++) {
        if (mask.values[i]) {
            assert.equal(a.values[i], model.values[i]);
            assert.equal(b.values[i], modified.values[i]);
        } else {
            assert.equal(a.values[i], b.values[i], 'protected intensity is absent from the filter estimate');
            if (Math.abs(a.values[i] - model.values[i]) > 0.001) changed++;
        }
    }
    assert.ok(changed > 100, 'filter remains active outside the mask');
});
