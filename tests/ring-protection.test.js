'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Processing = require('../js/processing.js');

function fixture() {
    const n = 61, step = 0.1, values = new Float64Array(n ** 3), mask = new Float64Array(n ** 3);
    let i = 0;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++, i++) {
        const h = (x - 30) * step, k = (y - 30) * step, l = (z - 30) * step;
        const q = Math.PI / 2 * Math.hypot(h, k, l);
        values[i] = 0.2 + 0.01 * q + 0.25 * Math.exp(-0.5 * ((q - 2.68) / 0.035) ** 2) +
            0.15 * Math.exp(-0.5 * ((q - 3.10) / 0.035) ** 2) + 0.001 * Math.sin(i * 1.71);
        mask[i] = Math.abs(h - 1.6) < 0.15 && Math.abs(k) < 0.6 ? 1 : 0;
    }
    const model = { dims: [n, n, n], corner: [-3, -3, -3], vectors: [[step, 0, 0], [0, step, 0], [0, 0, step]],
        values, axesType: 'hkl', radiation: 'neutron', cellLengths: [4, 4, 4], cellAngles: [90, 90, 90] };
    return { model, mask: { ...model, values: mask }, cell: { lengths: [4, 4, 4], angles: [90, 90, 90] } };
}

test('ring protection excludes marked sample features from fitting and preserves their measured values', async () => {
    const { model, mask, cell } = fixture(), changed = { ...model, values: model.values.slice() };
    for (let i = 0; i < mask.values.length; i++) if (mask.values[i]) changed.values[i] += 100 + i % 17;
    const steps = [{ op: 'removeRings', materials: 'any', width: 0.015, cutoff: 0.08, sectors: 1, protect: 'features' }];
    const run = m => Processing.applyRecipe(m, { steps }, { cell, extras: { features: mask } });
    const [a, b] = await Promise.all([run(model), run(changed)]);
    let corrected = 0;
    for (let i = 0; i < a.values.length; i++) {
        if (mask.values[i]) {
            assert.equal(a.values[i], model.values[i]);
            assert.equal(b.values[i], changed.values[i]);
        } else {
            assert.equal(a.values[i], b.values[i], 'protected intensity must not leak into estimates');
            if (Math.abs(a.values[i] - model.values[i]) > 0.001) corrected++;
        }
    }
    assert.ok(corrected > 100, 'ring removal remains active outside protection');
    assert.ok(model.values.every(Number.isFinite), 'input was not masked in place');
});

test('ring protection validates geometry and permits complete protection', async () => {
    const { model, mask, cell } = fixture();
    const recipe = { steps: [{ op: 'filterRings', protect: 'features' }] };
    await assert.rejects(Processing.applyRecipe(model, recipe, { cell }), /no loaded protection mask/);
    await assert.rejects(Processing.applyRecipe(model, recipe, { cell, extras: { features: { ...mask, corner: [0, 0, 0] } } }), /same grid/);
    mask.values.fill(1);
    const result = await Processing.applyRecipe(model, recipe, { cell, extras: { features: mask } });
    assert.deepEqual(result.values, model.values);
});

test('local refinement is opt-in and mask names are validated', () => {
    const step = Processing.normalizeRecipe({ steps: [{ op: 'filterRings' }] }).steps[0];
    assert.equal(step.local, 0);
    assert.equal(Processing.normalizeRecipe({ steps: [{ op: 'filterRings', local: 30 }] }).steps[0].local, 30);
    assert.throws(() => Processing.normalizeRecipe({ steps: [{ op: 'filterRings', protect: 42 }] }), /protect: invalid value/);
});
