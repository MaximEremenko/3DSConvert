'use strict';
// Preview planes of any orientation, on the page's worker core (run as the
// command-line tool runs it).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const H = require('./helpers');
const { startEngine, DiskFile } = require('../cli/3dsconvert.js');

const engine = startEngine();
test.after(() => engine.call('close', {}));
const example = path.join(H.ROOT, 'Examples', 'example_unified.h5');
const load = () => engine.call('loadData', {
    files: [new DiskFile(example)], paths: [''], yellSpace: 'auto', nexusPath: null, crop: null, readSigma: false, grid: null,
});
const slice = args => engine.call('slice', Object.assign({ stage: 'input', index: null, frame: 'grid' }, args));
// grid coordinates of plane pixel (ix, iy from the top)
const at = (p, ix, iy) => [0, 1, 2].map(c => p.pixel.origin[c] + ix * p.pixel.dx[c] + (p.height - 1 - iy) * p.pixel.dy[c]);
const pixelOf = (p, x) => {
    for (let iy = 0; iy < p.height; iy++) for (let ix = 0; ix < p.width; ix++) if (H.maxAbsDiff(at(p, ix, iy), x) < 1e-9) return [ix, iy];
    return null;
};

test('a custom [0 0 1] plane through l = 0 is the (h k 0) grid plane', async () => {
    await load();
    const grid = await slice({ normal: 2, index: 2 });
    const custom = await slice({ normal: 'custom', vector: [0, 0, 1], level: 0 });
    assert.equal(custom.normal.name, 'l');
    assert.deepEqual([custom.x.name, custom.y.name], ['[1 0 0]', '[0 1 0]']);
    assert.deepEqual([custom.width, custom.height, custom.normal.n, custom.normal.index], [5, 5, 5, 2]);
    assert.equal(H.maxAbsDiff(custom.values, grid.values), 0);
    assert.equal(custom.outside, null);
    // the grid plane carries the same pixel map
    assert.deepEqual(at(grid, 0, 4), [-1, -1, 0]);
    assert.deepEqual(at(grid, 4, 0), [1, 1, 0]);
});

test('the (h h l) plane of [1 -1 0]: exact on the grid points it meets, h + k through a pinned point', async () => {
    await load();
    const model = await H.Converter.readUnifiedData(await H.openH5('Examples/example_unified.h5'));
    const value = (ih, ik, il) => model.values[(il * 5 + ik) * 5 + ih];
    const p = await slice({ normal: 'custom', vector: [1, -1, 0], level: 0 });
    assert.equal(p.normal.name, 'h − k');
    assert.deepEqual([p.x.name, p.y.name], ['[1 1 0]', '[0 0 1]']);
    for (const [h, l] of [[0, 1], [0, -0.5]]) {                           // (0 0 l) lies on the grid
        const px = pixelOf(p, [h, h, l]);
        assert.ok(px, `pixel of (${h} ${h} ${l})`);
        const ih = (h + 1) / 0.5, il = (l + 1) / 0.5;
        assert.ok(Math.abs(p.values[px[1] * p.width + px[0]] - value(ih, ih, il)) < 1e-4 * Math.abs(value(ih, ih, il)));
    }
    const q = await slice({ normal: 'custom', vector: [1, 1, 0], point: [0.5, 0, 0] });
    assert.equal(q.normal.name, 'h + k');
    assert.equal(q.normal.level, 0.5);
    assert.ok(q.outside, 'the diagonal plane leaves corners outside the grid');
});

test('Cartesian frame: square, true-angled pixels from the cell or a UB; grid planes keep their layers', async () => {
    await load();
    const hex = { lengths: [4, 4, 6], angles: [90, 90, 120] };
    const p = await slice({ normal: 'custom', vector: [0, 0, 1], level: 0, frame: 'cartesian', cell: hex });
    const M = p.cartesian.M, Mv = v => [0, 1, 2].map(r => M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2]);
    const a = Mv(p.pixel.dx), b = Mv(p.pixel.dy);
    assert.ok(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) < 1e-12, 'orthogonal in Q');
    assert.ok(Math.abs(Math.hypot(...a) - Math.hypot(...b)) < 1e-12, 'square in Q');
    assert.equal(p.cartesian.source, 'cell');
    assert.equal(p.unit, 'Å⁻¹');
    assert.ok(p.outside, 'the 120° cell turns the square hk grid into a rhombus');
    const g = await slice({ normal: 2, index: 3, frame: 'cartesian', cell: { lengths: [5.63, 5.63, 5.63], angles: [90, 90, 90] } });
    assert.deepEqual([g.normal.name, g.normal.index, g.normal.level], ['l', 3, 0.5]);
    const ub = [[0, -0.25, 0], [0.25, 0, 0], [0, 0, 1 / 6]];              // a rotated cell
    const u = await slice({ normal: 'custom', vector: [0, 0, 1], level: 0, frame: 'cartesian', ub });
    assert.equal(u.cartesian.source, 'UB');
    await assert.rejects(slice({ normal: 'custom', vector: [0, 0, 0] }), /normal must be three numbers, not all 0/);
});
