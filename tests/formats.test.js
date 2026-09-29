'use strict';
// Phase 4 formats: hkl lists, and the other readers and writers added with them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Converter, readText } = require('./helpers');

// A 4 x 3 x 2 hkl grid with values 100 ih + 10 ik + il and sigma = 1 + ih.
function sample(withSigma) {
    const dims = [4, 3, 2], values = new Float64Array(24), sigma = new Float64Array(24);
    for (let il = 0, i = 0; il < 2; il++) for (let ik = 0; ik < 3; ik++) for (let ih = 0; ih < 4; ih++, i++) {
        values[i] = 100 * ih + 10 * ik + il;
        sigma[i] = 1 + ih;
    }
    return {
        dims, corner: [-1, 0, 0.5], vectors: [[0.5, 0, 0], [0, 0.25, 0], [0, 0, 1]], values,
        sigma: withSigma ? sigma : undefined, axes: [1, 2, 3], axesType: 'hkl',
        cellLengths: [4, 4, 4], cellAngles: [90, 90, 90],
    };
}

const writeText = (model, report) => Array.from(Converter.writeHklListChunks(model, report)).join('');

test('hkl list: write, then read back onto the same grid, holes and sigma included', () => {
    const m = sample(true);
    m.values[5] = NaN;                                          // a masked voxel is left out
    let report;
    const text = writeText(m, r => { report = r; });
    assert.deepEqual(report, { written: 23, noSigma: false, badSigma: 0 });
    assert.equal(text.split('\n')[0], '-1 0 0.5 0.00000000 1.00000');
    assert.ok(Converter.isHklList(text));
    const back = Converter.hklListModel(Converter.parseHklList(text));
    assert.deepEqual(back.dims, m.dims);
    assert.deepEqual(back.corner, m.corner);
    assert.deepEqual(back.vectors, m.vectors);
    for (let i = 0; i < 24; i++) {
        if (i === 5) assert.ok(Number.isNaN(back.values[i]));
        else assert.ok(Math.abs(back.values[i] - m.values[i]) < 1e-6 && Math.abs(back.sigma[i] - m.sigma[i]) < 1e-5);
    }
    assert.match(back.notes.join('\n'), /1 of 24 grid points have no row/);
});

test('hkl list: sigma 1 when the model has none; non-positive sigma rows are left out', () => {
    let report;
    const plain = writeText(sample(false), r => { report = r; });
    assert.equal(report.noSigma, true);
    assert.ok(plain.trim().split('\n').every(row => row.endsWith(' 1.00000')));
    const m = sample(true);
    m.sigma[3] = 0;
    m.sigma[4] = NaN;
    writeText(m, r => { report = r; });
    assert.deepEqual(report, { written: 22, noSigma: false, badSigma: 2 });
    const four = Converter.parseHklList('1 2 3 4.5\n1.5 2 3 5.5\n');
    assert.equal(four.sigma, null);
    assert.match(Converter.hklListModel(four).notes.join('\n'), /no uncertainties/);
});

test('hkl list: a rotated grid is sparse on h, k, l axes; its config gives the real grid', () => {
    // points on X_AXIS 1 1 0 / Y_AXIS 0 0 1 steps, as a Spinteract config gives them
    const rows = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) rows.push(`${0.25 * i} ${0.25 * i} ${0.5 * j} ${10 * i + j} 1`);
    const list = Converter.parseHklList(rows.join('\n'));
    const inferred = Converter.hklListModel(list);
    assert.deepEqual(inferred.dims, [4, 4, 3]);                  // right hkl for each point, most voxels empty
    assert.match(inferred.notes.join('\n'), /36 of 48 grid points have no row/);
    assert.throws(() => Converter.hklListModel(Converter.parseHklList('0 0 0 1 1\n0.3 0 0 1 1\n0.5 0 0 1 1\n')), /not evenly spaced/);
    const cfg = Converter.parseGridConfig('ORIGIN 0 0 0\nX_AXIS 0.75 0.75 0 4\nY_AXIS 0 0 1 3\nZ_AXIS 0 0 0 1\n');
    const m = Converter.hklListModel(list, cfg.grids[0]);
    assert.deepEqual(m.dims, [4, 3, 1]);
    assert.equal(m.values[(2 * 4) + 3], 32);
});

test('hkl lists and old-format .dat files are told apart', () => {
    assert.equal(Converter.isHklList('125 1\n1 1 1 0.1 0.2 0.3 5\n'), false);
    assert.equal(Converter.isHklList(readText('Examples/example_diffuse3d.dat')), false);
    assert.equal(Converter.isHklList('  -2.4  -3.0  -3.0   1.604   1.0\n  -2.36 -3.0 -3.0 1.412 1.0\n'), true);
    assert.throws(() => Converter.parseHklList('1 2 3 4 5\n1 2 3\n'), /row 2 has 3 columns/);
});

test('hkl list config snippets: Spinteract ORIGIN + full axes, Scatty CENTRE + half axes', () => {
    const m = sample(false);
    m.dims = [5, 3, 1];
    m.vectors = [[0.5, 0, 0], [0, 0.25, 0], [0, 0, 0]];
    assert.equal(Converter.hklConfigSnippet(m, 'spinteract'),
        'ORIGIN -1 0 0.5\nX_AXIS 2 0 0 5\nY_AXIS 0 0.5 0 3\nZ_AXIS 0 0 0 1');
    assert.equal(Converter.hklConfigSnippet(m, 'scatty'),
        'CENTRE 0 0.25 0.5\nX_AXIS 1 0 0 2\nY_AXIS 0 0.25 0 1\nZ_AXIS 0 0 0 0');
    // the snippet reads back as the same grid
    const back = Converter.parseGridConfig(Converter.hklConfigSnippet(m, 'scatty')).grids[0];
    assert.deepEqual(back.dims, [5, 3, 1]);
    assert.deepEqual(back.corner, [-1, 0, 0.5]);
});
