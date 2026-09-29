'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, Converter, loadH5wasm, buildH5, openH5, openH5Bytes } = require('./helpers');
const { UnifiedH5 } = require(path.join(ROOT, 'js', 'unified_hdf5.js'));

// Non-cubic, sheared test grid. value(h,k,l) = 100 ih + 10 ik + il.
const nh = 3, nk = 2, nl = 4;
const corner = [-1, 0, 2];
const vectors = [[0.5, 0.1, 0], [0, 0.25, 0], [0, 0, 1]];
const expected = (ih, ik, il) => 100 * ih + 10 * ik + il;

function lFastest() {        // C order [nh,nk,nl]
    const v = new Float64Array(nh * nk * nl);
    for (let ih = 0; ih < nh; ih++)
        for (let ik = 0; ik < nk; ik++)
            for (let il = 0; il < nl; il++) v[(ih * nk + ik) * nl + il] = expected(ih, ik, il);
    return v;
}

function hFastest() {        // C order [nl,nk,nh]
    const v = new Float64Array(nh * nk * nl);
    for (let il = 0; il < nl; il++)
        for (let ik = 0; ik < nk; ik++)
            for (let ih = 0; ih < nh; ih++) v[(il * nk + ik) * nh + ih] = expected(ih, ik, il);
    return v;
}

function assertGrid(model) {
    assert.deepEqual(model.dims, [nh, nk, nl]);
    for (let il = 0; il < nl; il++)
        for (let ik = 0; ik < nk; ik++)
            for (let ih = 0; ih < nh; ih++) {
                assert.equal(model.values[(il * nk + ik) * nh + ih], expected(ih, ik, il));
            }
}

function writeEntryGroup(f, { dims, shape, values, iv }) {
    f.create_attribute('audit_conform_dict_name', 'Disorder unified data');
    const d = f.create_group('entry').create_group('data');
    d.create_dataset({ name: 'data_dimension', data: Int32Array.from(dims), shape: [3], dtype: '<i' });
    d.create_dataset({ name: 'data_values', data: values, shape, dtype: '<d' });
    d.create_dataset({ name: 'data_corner', data: corner, shape: [3], dtype: '<d' });
    d.create_dataset({ name: 'data_increment_vector', data: iv, shape: [3, 3], dtype: '<d' });
    d.create_dataset({ name: 'unit_cell_lengths', data: [5, 6, 7], shape: [3], dtype: '<d' });
    d.create_dataset({ name: 'unit_cell_angles', data: [90, 90, 90], shape: [3], dtype: '<d' });
}

const ivColumns = () => {    // data_increment_vector flat[comp*3 + axis]
    const iv = new Float64Array(9);
    for (let axis = 0; axis < 3; axis++)
        for (let comp = 0; comp < 3; comp++) iv[comp * 3 + axis] = vectors[axis][comp];
    return iv;
};

// ------------------------------------------------------------------ filters

test('data compressed with a plugin filter is refused instead of misread', async () => {
    const f = await openH5('tests/fixtures/yell_lzf.h5');
    assert.throws(() => Converter.readYell(f), /data is compressed with LZF \(filter id 32000\)/);
});

// --------------------------------------------------------------------- Yell

function yellFile(extra) {
    return buildH5(f => {
        f.create_dataset({ name: 'lower_limits', data: [-1, -2, 0], shape: [3], dtype: '<d' });
        f.create_dataset({ name: 'unit_cell', data: [5, 5, 5, 90, 90, 90], shape: [6], dtype: '<d' });
        extra(f);
    });
}

test('Yell: rank-2 data and the step_size alias', async () => {
    const f = await yellFile(w => {
        w.create_dataset({ name: 'data', data: new Float64Array([1, 2, 3, 4, 5, 6]), shape: [2, 3], dtype: '<d' });
        w.create_dataset({ name: 'step_size', data: [0.5, 0.25, 0], shape: [3], dtype: '<d' });
        w.create_dataset({ name: 'is_direct', data: [0], shape: [1], dtype: '<b' });
    });
    const m = Converter.readYell(f);
    assert.deepEqual(m.dims, [2, 3, 1]);
    assert.deepEqual(Array.from(m.values), [1, 4, 2, 5, 3, 6]);   // C [nh,nk] -> h fastest
    assert.deepEqual(m.vectors, [[0.5, 0, 0], [0, 0.25, 0], [0, 0, 0]]);
    assert.match(m.notes.join('\n'), /2-D data read as a 2 x 3 x 1 grid/);
    assert.match(m.notes.join('\n'), /step_size/);
});

test('Yell: is_direct that is neither 0 nor 1 needs an explicit override', async () => {
    const f = await yellFile(w => {
        w.create_dataset({ name: 'data', data: new Float64Array(8).fill(1), shape: [2, 2, 2], dtype: '<d' });
        w.create_dataset({ name: 'step_sizes', data: [1, 1, 1], shape: [3], dtype: '<d' });
        w.create_dataset({ name: 'is_direct', data: [6144], shape: [], dtype: '<i' });
    });
    assert.throws(() => Converter.readYell(f),
        e => e.code === 'YELL_INVALID_IS_DIRECT' && /6144/.test(e.message));
    const m = Converter.readYell(f, { space: 'reciprocal' });
    assert.deepEqual(m.dims, [2, 2, 2]);
    assert.match(m.notes.join('\n'), /is_direct = 6144 ignored/);
});

test('Yell: is_direct = 1 (direct space) is refused even with the override', async () => {
    const f = await yellFile(w => {
        w.create_dataset({ name: 'data', data: new Float64Array(8), shape: [2, 2, 2], dtype: '<d' });
        w.create_dataset({ name: 'step_sizes', data: [1, 1, 1], shape: [3], dtype: '<d' });
        w.create_dataset({ name: 'is_direct', data: [1], shape: [], dtype: '<B' });
    });
    assert.throws(() => Converter.readYell(f, { space: 'reciprocal' }), /direct-space data/);
});

test('Yell: 64-bit is_direct = 0 reads as reciprocal space', async () => {
    const f = await yellFile(w => {
        w.create_dataset({ name: 'data', data: new Float64Array(8), shape: [2, 2, 2], dtype: '<d' });
        w.create_dataset({ name: 'step_sizes', data: [1, 1, 1], shape: [3], dtype: '<d' });
        w.create_dataset({ name: 'is_direct', data: BigInt64Array.from([0n]), shape: [], dtype: '<q' });
    });
    assert.deepEqual(Converter.readYell(f).notes, []);
});

// ------------------------------------------------------------ unified /entry

test('unified: reads /entry/data written by the shared UnifiedH5.writeData', async () => {
    const h5wasm = await loadH5wasm();
    const bytes = UnifiedH5.writeData(h5wasm, {
        dims: [nh, nk, nl], values: lFastest(), corner, vectors, cell: [5, 6, 7, 90, 90, 90],
        radiation: 'xray',
    });
    const m = Converter.readUnifiedData(await openH5Bytes(bytes));
    assertGrid(m);
    assert.deepEqual(m.corner, corner);
    assert.deepEqual(m.vectors, vectors);
    assert.equal(m.radiation, 'xray');
    assert.deepEqual(m.notes, []);
});

test('unified: data_values must match data_dimension', async () => {
    const f = await buildH5(w => writeEntryGroup(w, {
        dims: [nh, nk, nl], shape: [6, 4], values: lFastest(), iv: ivColumns(),
    }));
    assert.throws(() => Converter.readUnifiedData(f), /data_values shape 6 x 4 does not match data_dimension 3 x 2 x 4/);
});

test('unified: reversed [nl,nk,nh] data_values are read when the shape tells', async () => {
    const ivRows = new Float64Array(vectors.flat());      // transposed with the data
    const f = await buildH5(w => writeEntryGroup(w, {
        dims: [nh, nk, nl], shape: [nl, nk, nh], values: hFastest(), iv: ivRows,
    }));
    const m = Converter.readUnifiedData(f);
    assertGrid(m);
    assert.deepEqual(m.vectors, vectors);
    assert.match(m.notes.join('\n'), /reversed \[nl,nk,nh\] order/);
});

// ------------------------------------------------------- unified /scattering

function scatteringFile(build) {
    return buildH5(f => {
        const d = f.create_group('scattering').create_group('data');
        d.create_attribute('NX_class', 'NXdata');
        d.create_attribute('signal', 'data');
        d.create_attribute('axes', ['h', 'k', 'l'], [3], 'S1');
        const coords = [nh, nk, nl].map((n, a) =>
            Float64Array.from({ length: n }, (_, i) => corner[a] + i * vectors[a][a]));
        ['h', 'k', 'l'].forEach((name, a) =>
            d.create_dataset({ name, data: coords[a], shape: [coords[a].length], dtype: '<d' }));
        build(f, d);
    });
}

test('unified: /scattering/data in the write_diffuse_scattering.py layout', async () => {
    const f = await scatteringFile((file, d) => {
        file.create_attribute('audit_conform_dict_name', 'Disorder scattering');
        d.create_dataset({ name: 'data', data: lFastest(), shape: [nh, nk, nl], dtype: '<d' });
        d.create_dataset({ name: 'lower_limits', data: corner, shape: [3], dtype: '<d' });
        d.create_dataset({ name: 'step_vectors', data: ivColumns(), shape: [3, 3], dtype: '<d' });
        d.create_dataset({ name: 'unit_cell_lengths', data: [5, 6, 7], shape: [3], dtype: '<d' });
        d.create_dataset({ name: 'unit_cell_angles', data: [90, 90, 90], shape: [3], dtype: '<d' });
    });
    const m = Converter.readUnifiedData(f);
    assertGrid(m);
    assert.deepEqual(m.vectors, vectors);
    assert.match(m.notes.join('\n'), /write_diffuse_scattering\.py layout/);
});

test('unified: legacy "Disorder scattering 1.0" file without lower_limits/step_vectors', async () => {
    const f = await scatteringFile((file, d) => {
        file.create_attribute('format', 'Disorder scattering 1.0');
        file.create_attribute('default', 'scattering');
        ['h', 'k', 'l'].forEach((name, i) => d.create_attribute(name + '_indices', i, [], '<i'));
        d.create_attribute('scattering', 'x-ray');
        d.create_attribute('space', 'reciprocal');
        d.create_dataset({ name: 'data', data: lFastest(), shape: [nh, nk, nl], dtype: '<d' });
        d.create_dataset({ name: 'unit_cell', data: [3.6, 3.6, 3.6, 90, 90, 90], shape: [6], dtype: '<d' });
    });
    assert.equal(Converter.detectH5Kind(f), 'unified');
    const m = Converter.readUnifiedData(f);
    assertGrid(m);
    assert.deepEqual(m.corner, corner);
    assert.deepEqual(m.vectors, [[0.5, 0, 0], [0, 0.25, 0], [0, 0, 1]]);
    assert.equal(m.radiation, 'xray');
    assert.deepEqual(m.cellLengths, [3.6, 3.6, 3.6]);
    assert.deepEqual(m.axes, [1, 2, 3]);
    assert.match(m.notes.join('\n'), /grid taken from the h\/k\/l coordinate arrays/);
});

test('unified: /scattering/data shape that fits neither layout is refused', async () => {
    const f = await scatteringFile((file, d) => {
        d.create_dataset({ name: 'data', data: lFastest(), shape: [nk, nh, nl], dtype: '<d' });
        d.create_dataset({ name: 'unit_cell', data: [3.6, 3.6, 3.6, 90, 90, 90], shape: [6], dtype: '<d' });
    });
    assert.throws(() => Converter.readUnifiedData(f), /does not match the h\/k\/l coordinate lengths 3\/2\/4/);
});
