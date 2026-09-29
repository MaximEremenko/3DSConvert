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
const close = (a, b) => H.maxAbsDiff(a, b) < 1e-12;

test('a custom [0 0 1] plane through the middle is the (h k 0) grid plane; the slider moves it along l', async () => {
    await load();
    const grid = await slice({ normal: 2, index: 2 });
    const custom = await slice({ normal: 'custom', vector: [0, 0, 1] });
    assert.deepEqual([custom.x.name, custom.y.name, custom.normal.name], ['u', 'v', 't']);
    assert.deepEqual([custom.normal.text.u, custom.normal.text.v], ['[1 0 0]', '[0 1 0]']);
    assert.deepEqual([custom.width, custom.height, custom.normal.n, custom.normal.index, custom.normal.level], [5, 5, 401, 200, 0]);
    assert.deepEqual([custom.normal.from, custom.normal.to], [-1, 1]);
    assert.equal(H.maxAbsDiff(custom.values, grid.values), 0);
    assert.equal(custom.outside, null);
    // the grid plane carries the same pixel map
    assert.deepEqual(at(grid, 0, 4), [-1, -1, 0]);
    assert.deepEqual(at(grid, 4, 0), [1, 1, 0]);
    assert.ok(close(at(custom, 0, 4), [-1, -1, 0]) && close(at(custom, 4, 0), [1, 1, 0]));
    // slider position 300 of 401: t = -1 + 300 * 2 / 400 = 0.5, the l = 0.5 layer
    const up = await slice({ normal: 'custom', vector: [0, 0, 2], index: 300 });
    assert.equal(up.normal.level, 0.5);
    assert.equal(H.maxAbsDiff(up.values, (await slice({ normal: 2, index: 3 })).values), 0);
    await assert.rejects(slice({ normal: 'custom', vector: [0, 0, 0] }), /normal must be three numbers, not all 0/);
});

test('the (h h l) plane of [1 -1 0]: square pixels in hkl, v up along l, u = v x n; exact on the grid points it meets', async () => {
    await load();
    const model = await H.Converter.readUnifiedData(await H.openH5('Examples/example_unified.h5'));
    const value = (ih, ik, il) => model.values[(il * 5 + ik) * 5 + ih];
    const p = await slice({ normal: 'custom', vector: [1, -1, 0] });
    assert.deepEqual([p.normal.text.n, p.normal.text.u, p.normal.text.v], ['[1 −1 0]', '[1 1 0]', '[0 0 1]']);
    assert.ok(Math.abs(Math.hypot(...p.pixel.dx) - Math.hypot(...p.pixel.dy)) < 1e-12, 'square in h k l');
    assert.ok(Math.abs(Math.hypot(...p.pixel.dx) - 0.5) < 1e-12, 'a voxel per pixel');
    // along u = (1 1 0)/√2 the plane spans |(1 1 0)| = √2 each way: wider than high
    assert.ok(p.x.to - p.x.from > 1.3 * (p.y.to - p.y.from));
    for (const l of [1, -0.5]) {                                           // (0 0 l) lies on the grid
        const px = pixelOf(p, [0, 0, l]);
        assert.ok(px, `pixel of (0 0 ${l})`);
        assert.ok(Math.abs(p.values[px[1] * p.width + px[0]] - value(2, 2, (l + 1) / 0.5)) < 1e-4 * Math.abs(value(2, 2, (l + 1) / 0.5)));
    }
    // 3DSCalculator's layout for [1 1 0]: u = v x n points to -h
    const q = await slice({ normal: 'custom', vector: [1, 1, 0], origin: [0.5, 0, 0] });
    assert.deepEqual([q.normal.text.u, q.normal.text.v], ['[−1 1 0]', '[0 0 1]']);
    // through a chosen point: h + k = 0.5, t measured from that point
    assert.deepEqual([q.normal.level, q.normal.origin, q.normal.centre], [0, [0.5, 0, 0], [0.5, 0, 0]]);
    assert.ok(q.outside, 'the diagonal plane leaves corners outside the grid');
    const moved = await slice({ normal: 'custom', vector: [1, 1, 0], origin: [0.5, 0, 0], offset: -Math.SQRT1_2 / 2 });
    assert.ok(close(moved.normal.centre, [0.25, -0.25, 0]), 'moved by t along the unit normal');
    // pixel coordinates are x . u and x . v, wherever the plane was put
    const pa = pixelOf(q, [0.5, 0, 0]);
    assert.ok(Math.abs(q.x.from + pa[0] * (q.x.to - q.x.from) / (q.width - 1) - -0.5 * Math.SQRT1_2) < 1e-12);
});

test('Cartesian frame: square, true-angled pixels from the cell or a UB; grid planes keep their layers', async () => {
    await load();
    const hex = { lengths: [4, 4, 6], angles: [90, 90, 120] };
    const p = await slice({ normal: 'custom', vector: [0, 0, 1], frame: 'cartesian', cell: hex });
    const M = p.cartesian.M, Mv = v => [0, 1, 2].map(r => M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2]);
    const a = Mv(p.pixel.dx), b = Mv(p.pixel.dy);
    assert.ok(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) < 1e-12, 'orthogonal in Q');
    assert.ok(Math.abs(Math.hypot(...a) - Math.hypot(...b)) < 1e-12, 'square in Q');
    assert.deepEqual([p.cartesian.source, p.unit, p.y.name], ['cell', 'Å⁻¹', 'v⊥']);
    assert.ok(p.outside, 'the 120° cell turns the square hk grid into a rhombus');
    const g = await slice({ normal: 2, index: 3, frame: 'cartesian', cell: { lengths: [5.63, 5.63, 5.63], angles: [90, 90, 90] } });
    assert.deepEqual([g.normal.name, g.normal.index, g.normal.level, g.x.name, g.y.name], ['l', 3, 0.5, 'h', 'k']);
    assert.equal(H.maxAbsDiff(g.values, (await slice({ normal: 2, index: 3 })).values), 0);
    const ub = [[0, -0.25, 0], [0.25, 0, 0], [0, 0, 1 / 6]];              // a rotated cell
    const u = await slice({ normal: 'custom', vector: [0, 0, 1], frame: 'cartesian', ub });
    assert.equal(u.cartesian.source, 'UB');
});
