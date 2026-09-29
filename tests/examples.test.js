'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Converter, buildH5, openH5, readText, maxAbsDiff } = require('./helpers');

const cell = Converter.parseRmc6f(readText('Examples/example_structure.rmc6f'));

test('example structure gives the 5.63 A parent cell of a 2x2x2 supercell', () => {
    assert.deepEqual(cell.lengths.map(x => +x.toFixed(9)), [5.63, 5.63, 5.63]);
    assert.deepEqual(cell.angles, [90, 90, 90]);
    assert.deepEqual(cell.supercell, [2, 2, 2]);
});

test('all example data files hold the same grid and intensities', async () => {
    const fu = await openH5('Examples/example_unified.h5');
    assert.equal(Converter.detectH5Kind(fu), 'unified');
    const unified = Converter.readUnifiedData(fu);
    const fy = await openH5('Examples/example_yell.h5');
    assert.equal(Converter.detectH5Kind(fy), 'yell');
    const yell = Converter.readYell(fy);
    const dat = Converter.parseOldDat(readText('Examples/example_diffuse3d.dat'), cell);
    const vtk = Converter.parseVtk(readText('Examples/example_scatty.vtk'), cell);

    assert.deepEqual(unified.dims, [5, 5, 5]);
    assert.deepEqual(unified.corner, [-1, -1, -1]);
    assert.deepEqual(unified.notes, []);
    for (const m of [yell, dat, vtk]) {
        assert.deepEqual(m.dims, unified.dims);
        assert.equal(maxAbsDiff(m.values, unified.values), 0);
        assert.ok(maxAbsDiff(m.corner, unified.corner) < 1e-9);
        assert.ok(maxAbsDiff(m.vectors.flat(), unified.vectors.flat()) < 1e-9);
    }
});

test('every writer round-trips the example exactly', async () => {
    const model = Converter.readUnifiedData(await openH5('Examples/example_unified.h5'));
    const viaDat = Converter.parseOldDat(Converter.writeOldDat(model, cell), cell);
    const viaVtk = Converter.parseVtk(Converter.writeVtk(model, cell), cell);
    const viaUnified = Converter.readUnifiedData(
        await buildH5(f => Converter.writeUnifiedData(f, model, cell, {})));
    const viaYell = Converter.readYell(await buildH5(f => Converter.writeYell(f, model, cell)));
    for (const m of [viaDat, viaVtk, viaUnified, viaYell]) {
        assert.deepEqual(m.dims, model.dims);
        assert.equal(maxAbsDiff(m.values, model.values), 0);
        assert.ok(maxAbsDiff(m.corner, model.corner) < 1e-12);
        assert.ok(maxAbsDiff(m.vectors.flat(), model.vectors.flat()) < 1e-12);
    }
});
