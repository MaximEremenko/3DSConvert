'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Converter, readText, maxAbsDiff, vtkText } = require('./helpers');

const cubic4 = { lengths: [4, 4, 4], angles: [90, 90, 90] };
const range = n => Array.from({ length: n }, (_, i) => i + 1);

test('3DSCalculator "(HKL grid)" VTK is read in r.l.u. without a cell', () => {
    const text = vtkText('RMC diffuse intensity (HKL grid)', [3, 2, 2], [-1, 0, 0.5], [0.25, 0.5, 1], range(12));
    assert.equal(Converter.vtkFrame(text), 'hkl');
    const m = Converter.parseVtk(text, null);
    assert.deepEqual(m.corner, [-1, 0, 0.5]);
    assert.deepEqual(m.vectors, [[0.25, 0, 0], [0, 0.5, 0], [0, 0, 1]]);
    assert.deepEqual(Array.from(m.values), range(12));
    assert.ok(Converter.isUnitMetric(m.cellLengths, m.cellAngles));
});

test('Scatty supercell Bragg-peak VTK is read in r.l.u.', () => {
    const text = vtkText('TITLE diffuse scattering - supercell Bragg peaks', [3, 3, 1],
        [-0.1, -0.1, 0], [0.1, 0.1, 0.1], range(9));
    assert.equal(Converter.vtkFrame(text), 'hkl');
    const m = Converter.parseVtk(text, cubic4);
    assert.deepEqual(m.corner, [-0.1, -0.1, 0]);
    assert.deepEqual(m.vectors, [[0.1, 0, 0], [0, 0.1, 0], [0, 0, 0]]);
});

test('Scatty and 3DSConvert Q-space VTK need the parent cell', () => {
    const text = readText('Examples/example_scatty.vtk');
    assert.equal(Converter.vtkFrame(text), 'q');
    assert.throws(() => Converter.parseVtk(text, null), /parent cell/);
});

test('Scatty config: shipped hhl example gives 2p+1 points about CENTRE', () => {
    const cfg = Converter.parseGridConfig(
        'NAME hhl\nCENTRE 0 0 0\nX_AXIS 6 6 0 200\nY_AXIS 0 0 8.4853 200\nZ_AXIS 0 0 0 1\nSYMMETRY m3m');
    assert.equal(cfg.program, 'scatty');
    assert.equal(cfg.grids.length, 1);
    const g = cfg.grids[0];
    assert.deepEqual(g.dims, [401, 401, 1]);
    assert.deepEqual(g.corner, [-6, -6, -8.4853]);
    assert.ok(maxAbsDiff(g.vectors.flat(), [0.03, 0.03, 0, 0, 0, 0.0424265, 0, 0, 0]) < 1e-15);
});

// What Scatty writes for CENTRE 0 0 0, X_AXIS 1 1 0 2, Y_AXIS 0 0 1 1 on a
// cubic 4 A cell: ORIGIN is the cartesian corner, SPACING only step lengths.
function scattyRotatedCase() {
    const cfg = Converter.parseGridConfig('CENTRE 0 0 0\nX_AXIS 1 1 0 2\nY_AXIS 0 0 1 1\nZ_AXIS 0 0 0 0\n');
    const t = 2 * Math.PI / 4;
    const origin = [-t, -t, -t].map(x => x.toFixed(6));
    const spacing = [t * Math.SQRT2 / 2, t, 0].map(x => x.toFixed(6));
    const text = vtkText('TITLE diffuse scattering', [5, 3, 1], origin, spacing, range(15));
    return { cfg, text };
}

test('Scatty config supplies rotated grid axes that VTK cannot store', () => {
    const { cfg, text } = scattyRotatedCase();
    const grid = cfg.grids[0];
    assert.deepEqual(grid.dims, [5, 3, 1]);
    assert.deepEqual(grid.corner, [-1, -1, -1]);
    assert.deepEqual(grid.vectors, [[0.5, 0.5, 0], [0, 0, 1], [0, 0, 0]]);

    const naive = Converter.parseVtk(text, cubic4);
    assert.ok(Math.abs(naive.vectors[0][1]) < 1e-12, 'without the config the step lies along h only');
    assert.match(naive.notes.join('\n'), /load the config file/);

    const m = Converter.parseVtk(text, cubic4, { grid });
    assert.deepEqual(m.corner, [-1, -1, -1]);
    assert.deepEqual(m.vectors, grid.vectors);
    assert.deepEqual(Array.from(m.values), range(15));
    assert.deepEqual(m.notes, []);
});

test('grid config is cross-checked against the VTK header', () => {
    const { cfg, text } = scattyRotatedCase();
    const wrongCell = { lengths: [4.1, 4.1, 4.1], angles: [90, 90, 90] };
    const m = Converter.parseVtk(text, wrongCell, { grid: cfg.grids[0] });
    assert.match(m.notes.join('\n'), /warning: VTK ORIGIN\/SPACING differ/);
    const other = Converter.parseGridConfig('X_AXIS 1 1 0 3\nY_AXIS 0 0 1 1\n');
    assert.throws(() => Converter.parseVtk(text, cubic4, { grid: other.grids[0] }), /7 x 3 x 1 points/);
});

test('Spinteract config: ORIGIN corner, full-extent axes, one grid per data set', () => {
    const cfg = Converter.parseGridConfig([
        'ORIGIN -3.0 -3.0 -3.0', 'X_AXIS 6.0 0.0 0.0 151', 'Y_AXIS 0.0 6.0 0.0 151', 'Z_AXIS 0.0 0.0 6.0 151',
        'ORIGIN -2 -2 0', 'X_AXIS 4 4 0 5', 'Y_AXIS 0 0 2 3', 'Z_AXIS 0 0 0 1',
    ].join('\n'));
    assert.equal(cfg.program, 'spinteract');
    assert.equal(cfg.grids.length, 2);
    assert.deepEqual(cfg.grids[0].dims, [151, 151, 151]);
    assert.deepEqual(cfg.grids[0].corner, [-3, -3, -3]);
    assert.ok(Math.abs(cfg.grids[0].vectors[0][0] - 0.04) < 1e-15);
    assert.deepEqual(cfg.grids[1].dims, [5, 3, 1]);
    assert.deepEqual(cfg.grids[1].vectors, [[1, 1, 0], [0, 0, 1], [0, 0, 0]]);
});

test('grid config without axis lines is refused', () => {
    assert.throws(() => Converter.parseGridConfig('CENTRE 0 0 0\n'), /no X_AXIS/);
});

test('writeVtk writes non-finite values as 0', () => {
    const cell = Converter.parseRmc6f(readText('Examples/example_structure.rmc6f'));
    const model = Converter.parseVtk(readText('Examples/example_scatty.vtk'), cell);
    model.values[0] = NaN;
    model.values[4] = -Infinity;
    const text = Converter.writeVtk(model, cell);
    assert.doesNotMatch(text, /NaN|Infinity/);
    const back = Converter.parseVtk(text, cell);
    assert.equal(back.values[0], 0);
    assert.equal(back.values[4], 0);
});
