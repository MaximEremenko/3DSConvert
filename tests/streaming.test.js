'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    Converter, buildH5, openH5, readText, maxAbsDiff, textBlob, fileBlob,
} = require('./helpers');

const cell = Converter.parseRmc6f(readText('Examples/example_structure.rmc6f'));
const exampleDat = readText('Examples/example_diffuse3d.dat');
const exampleModel = () => openH5('Examples/example_unified.h5').then(f => Converter.readUnifiedData(f));

function sameGrid(a, b, tol) {
    assert.deepEqual(a.dims, b.dims);
    assert.equal(maxAbsDiff(a.values, b.values), 0);
    assert.ok(maxAbsDiff(a.corner, b.corner) < tol);
    assert.ok(maxAbsDiff(a.vectors.flat(), b.vectors.flat()) < tol);
}

// ------------------------------------------------------------ text streams

test('streamed .dat and VTK match the string parsers', async () => {
    const dat = Converter.toHklModel(await Converter.readOldDatStream((await fileBlob('Examples/example_diffuse3d.dat')).stream()), cell);
    sameGrid(dat, Converter.parseOldDat(exampleDat, cell), 1e-12);
    const vtkGrid = await Converter.readVtkStream((await fileBlob('Examples/example_scatty.vtk')).stream());
    assert.equal(vtkGrid.frame, 'q');
    sameGrid(Converter.toHklModel(vtkGrid, cell), Converter.parseVtk(readText('Examples/example_scatty.vtk'), cell), 1e-12);
});

test('stream readers report progress, yield, and stop on cancellation', async () => {
    const blob = textBlob(exampleDat);
    const fractions = [];
    let ticks = 0;
    await Converter.readOldDatStream(blob.stream(), {
        size: blob.size, progress: f => fractions.push(f), tick: async () => { ticks++; },
    });
    assert.ok(ticks >= 1);
    assert.equal(fractions[fractions.length - 1], 1);
    const cancel = Object.assign(new Error('cancelled'), { cancelled: true });
    await assert.rejects(Converter.readOldDatStream(blob.stream(), { tick: async () => { throw cancel; } }),
        e => e === cancel);
});

test('.dat rows may wrap over several lines', async () => {
    const lines = exampleDat.trim().split('\n');
    const wrapped = [lines[0], ...lines.slice(1).map(l => {
        const t = l.trim().split(/\s+/);
        return t.slice(0, 4).join(' ') + '\n' + t.slice(4).join(' ');
    })].join('\n');
    sameGrid(Converter.parseOldDat(wrapped, cell), Converter.parseOldDat(exampleDat, cell), 1e-12);
});

test('sparse .dat: missing pixels become NaN and the geometry is fitted', () => {
    const lines = exampleDat.trim().split('\n');
    // Drop pixel (1,1,1), (2,1,1) and a few more, then fix npoints.
    const drop = new Set(['1 1 1', '2 1 1', '3 3 3', '5 5 5']);
    const rows = lines.slice(1).filter(l => !drop.has(l.trim().split(/\s+/).slice(0, 3).join(' ')));
    const sparse = [`${rows.length} 1`, ...rows].join('\n');
    const full = Converter.parseOldDat(exampleDat, cell);
    const m = Converter.parseOldDat(sparse, cell);
    assert.deepEqual(m.dims, full.dims);
    assert.equal(Converter.countNonFinite(m.values), 4);
    assert.ok(Number.isNaN(m.values[0]));
    assert.ok(maxAbsDiff(m.corner, full.corner) < 1e-9);
    assert.ok(maxAbsDiff(m.vectors.flat(), full.vectors.flat()) < 1e-9);
    assert.match(m.notes.join('\n'), /4 of the 125 grid points are missing/);
    assert.match(m.notes.join('\n'), /geometry fitted/);
});

test('.dat with a repeated pixel is refused', () => {
    const lines = exampleDat.trim().split('\n');
    const dup = [`${lines.length} 1`, ...lines.slice(1), lines[1]].join('\n');
    assert.throws(() => Converter.parseOldDat(dup, cell), /more than once/);
});

test('truncated .dat reports how many rows it holds', () => {
    const lines = exampleDat.trim().split('\n');
    assert.throws(() => Converter.parseOldDat(lines.slice(0, 50).join('\n'), cell), /truncated \(49 of 125 rows\)/);
});

// --------------------------------------------------------------- HDF5 slabs

test('slab-wise reads give the same volume for every layout', async () => {
    const model = await exampleModel();
    const tiny = { slabBytes: 16 };              // one plane per slab
    const unifiedFile = await buildH5(f => Converter.writeUnifiedData(f, model, cell, {}));
    const scattering = await Converter.readUnifiedData(unifiedFile, tiny);
    const entryOnly = await Converter.readUnifiedData(
        await buildH5(f => Converter.writeUnifiedData(f, model, cell, {}, { layout: 'entry' })), tiny);
    const yell = await Converter.readYell(await buildH5(f => Converter.writeYell(f, model, cell)), tiny);
    for (const m of [scattering, entryOnly, yell]) sameGrid(m, model, 1e-15);
    const fractions = [];
    await Converter.readYell(await buildH5(f => Converter.writeYell(f, model, cell)),
        { slabBytes: 16, progress: f => fractions.push(f) });
    assert.equal(fractions.length, 5);
    assert.equal(fractions[4], 1);
});

test('float32 data stay float32 through reading and writing', async () => {
    const model = await exampleModel();
    const f32 = await Converter.readYell(await buildH5(f => Converter.writeYell(f, model, cell, { precision: 'float32' })));
    assert.ok(f32.values instanceof Float32Array);
    assert.equal(maxAbsDiff(f32.values, Float32Array.from(model.values)), 0);
    const file = await buildH5(f => Converter.writeUnifiedData(f, f32, cell, {}));
    assert.equal(file.get('entry/data/data_values').dtype, '<f');
    assert.equal(file.get('scattering/data/data').dtype, '<f');
    const back = await Converter.readUnifiedData(file);
    assert.ok(back.values instanceof Float32Array);
    const f64 = await buildH5(f => Converter.writeUnifiedData(f, f32, cell, {}, { precision: 'float64' }));
    assert.equal(f64.get('entry/data/data_values').dtype, '<d');
});

// ------------------------------------------------------------------ writers

test('writer options: /entry-only layout, gzip, and plane-wise chunked output', async () => {
    const model = await exampleModel();
    const entry = await buildH5(f => Converter.writeUnifiedData(f, model, cell, {}, { layout: 'entry' }));
    assert.equal(entry.get('scattering'), null);
    assert.equal(entry.attrs.default, undefined);
    assert.equal(Converter.detectH5Kind(entry), 'unified');

    const progress = [];
    const planes = await buildH5(f => Converter.writeUnifiedData(f, model, cell, {}, {
        compression: 4, directWriteBytes: 0, progress: x => progress.push(x),
    }));
    for (const path of ['scattering/data/data', 'entry/data/data_values']) {
        const ds = planes.get(path);
        assert.deepEqual(ds.filters.map(x => x.name), ['deflate']);
        assert.deepEqual(ds.metadata.chunks, [1, 5, 5]);
    }
    assert.equal(progress[progress.length - 1], 1);
    sameGrid(await Converter.readUnifiedData(planes), model, 1e-15);

    const yellPlanes = await buildH5(f => Converter.writeYell(f, model, cell, { directWriteBytes: 0 }));
    assert.deepEqual(yellPlanes.get('data').metadata.chunks, [1, 5, 5]);
    sameGrid(await Converter.readYell(yellPlanes), model, 1e-15);

    const small = await buildH5(f => Converter.writeYell(f, model, cell, { compression: 1 }));
    assert.deepEqual(small.get('data').metadata.chunks, [5, 5, 5]);
    sameGrid(await Converter.readYell(small), model, 1e-15);
});

test('VTK output streams in chunks that join to the single-string writer', async () => {
    const model = await exampleModel();
    const chunks = Array.from(Converter.writeVtkChunks(model, cell, 7));
    assert.ok(chunks.length > 2);
    assert.equal(chunks.join(''), Converter.writeVtk(model, cell));
});

test('output size estimates are close to the real sizes', async () => {
    const model = await exampleModel();
    const dat = Converter.writeOldDat(model, cell).length;
    const vtk = Converter.writeVtk(model, cell).length;
    const near = (estimate, actual) => Math.abs(estimate - actual) / actual < 0.15;
    assert.ok(near(Converter.estimateOutputBytes(model, 'dat'), dat), `dat ${dat}`);
    assert.ok(Converter.estimateOutputBytes(model, 'vtk') >= vtk * 0.85);
    assert.equal(Converter.estimateOutputBytes(model, 'unified', { layout: 'entry', precision: 'float32' }),
        125 * 4 + 65536);
});

// ------------------------------------------------------------------ planning

test('planConversion: text grids need a cell; unit-metric data pass through to HDF5 only', async () => {
    const grid = await Converter.readOldDatStream(textBlob(exampleDat).stream());
    assert.throws(() => Converter.planConversion({ grid }, { format: 'unified' }),
        /old-format \.dat input needs a structure file or a manual parent cell/);
    const manual = { lengths: [5.63, 5.63, 5.63], angles: [90, 90, 90] };
    const plan = Converter.planConversion({ grid }, { format: 'unified', manual, radiation: 'xray' });
    assert.equal(plan.cellSource, 'manual entry');
    assert.equal(plan.model.radiation, 'xray');
    assert.deepEqual(plan.model.dims, [5, 5, 5]);
    const fromStruct = Converter.planConversion({ grid }, { format: 'dat', manual, structure: cell });
    assert.equal(fromStruct.cellSource, 'structure file');

    const model = await exampleModel();
    const unit = Object.assign({}, model, { cellLengths: [1, 1, 1], cellAngles: [90, 90, 90] });
    assert.throws(() => Converter.planConversion({ model: unit }, { format: 'vtk' }), /unit metric/);
    const passed = Converter.planConversion({ model: unit }, { format: 'yell' });
    assert.match(passed.cellSource, /unit metric, passed through/);
    const own = Converter.planConversion({ model }, { format: 'dat', manual });
    assert.equal(own.cellSource, 'data file');
});
