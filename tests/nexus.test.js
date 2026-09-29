'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Converter, loadH5wasm, buildH5, maxAbsDiff } = require('./helpers');
const { code, fastestFirst, at, linspace, mantidFile, nxrefineFile } = require('./nexus-fixtures');

// ------------------------------------------------------------ Mantid SaveMD

test('Mantid MDHistoWorkspace: bin edges -> centres, D0 fastest, cell and radiation', async () => {
    const f = await mantidFile({});
    assert.equal(Converter.detectH5Kind(f), 'mantid-md');
    const m = await Converter.readMantidMD(f);
    assert.deepEqual(m.dims, [4, 3, 2]);
    assert.ok(maxAbsDiff(m.corner, [-0.75, -2, 0.5]) < 1e-12);
    assert.ok(maxAbsDiff(m.vectors.flat(), [0.5, 0, 0, 0, 2, 0, 0, 0, 1]) < 1e-12);
    assert.equal(at(m, 3, 2, 1), code(3, 2, 1));
    assert.deepEqual(m.cellLengths, [4.05, 4.05, 4.05]);
    assert.equal(m.radiation, 'neutron');
    assert.equal(m.axesType, 'hkl');
    assert.match(m.notes.join('\n'), /radiation set to neutron/);
});

test('Mantid projection: W_MATRIX columns are the basis vectors', async () => {
    const f = await mantidFile({ W: [1, -1, 0, 1, 1, 0, 0, 0, 1], names: ['[H,H,0]', '[-H,H,0]', '[0,0,L]'] });
    const m = await Converter.readMantidMD(f);
    // centres: D0 -0.75 (step 0.5), D1 -2 (step 2), D2 0.5 (step 1)
    const corner = [-0.75 + 2, -0.75 - 2, 0.5];
    assert.ok(maxAbsDiff(m.corner, corner) < 1e-12);
    assert.ok(maxAbsDiff(m.vectors.flat(), [0.5, 0.5, 0, -2, 2, 0, 0, 0, 1]) < 1e-12);
    assert.match(m.notes.join('\n'), /projection from W_MATRIX: D0 = \[H,H,0\]/);
    const clash = await Converter.readMantidMD(await mantidFile({ W: [1, 0, 0, 0, 1, 0, 0, 0, 1], names: ['[H,H,0]', '[0,K,0]', '[0,0,L]'] }));
    assert.match(clash.notes.join('\n'), /W_MATRIX column 0 \(1, 0, 0\) disagrees/);
    const named = await Converter.readMantidMD(await mantidFile({ W: null, names: ['[H,H,0]', '[-H,H,0]', '[0,0,L]'] }));
    assert.ok(maxAbsDiff(named.vectors.flat(), m.vectors.flat()) < 1e-12);
});

test('Mantid: masked and infinite voxels become NaN; NaN is counted', async () => {
    const values = fastestFirst(4, 3, 2);
    values[0] = Infinity;
    values[5] = NaN;
    const mask = new Int8Array(values.length);
    mask[7] = 1;
    const m = await Converter.readMantidMD(await mantidFile({ values, mask }));
    assert.equal(Converter.countNonFinite(m.values), 3);
    for (const i of [0, 5, 7]) assert.ok(Number.isNaN(m.values[i]));
    const notes = m.notes.join('\n');
    assert.match(notes, /1 masked voxels set to NaN/);
    assert.match(notes, /1 infinite voxels/);
    assert.match(notes, /3 of 24 voxels \(12\.5%\) hold no data/);
});

test('Mantid: 2-D workspaces pad to a single layer; Q frames and 4-D data are refused', async () => {
    const flat = await Converter.readMantidMD(await mantidFile({ n: [4, 3] }));
    assert.deepEqual(flat.dims, [4, 3, 1]);
    assert.equal(at(flat, 3, 2, 0), code(3, 2, 0));
    await assert.rejects(Converter.readMantidMD(await mantidFile({ system: 2, frame: 'QSample' })),
        /Q \(sample frame\) frame; only HKL workspaces/);
    await assert.rejects(Converter.readMantidMD(await mantidFile({
        n: [2, 2, 2, 2], edges: [[0, 1], [0, 1], [0, 1], [0, 1]], names: ['a', 'b', 'c', 'd'], values: new Float64Array(16),
    })), /4 dimensions; bin it to three/);
});

test('other Mantid and raw NeXus files are recognised and explained', async () => {
    const events = await buildH5(f => f.create_group('MDEventWorkspace'));
    assert.equal(Converter.detectH5Kind(events), 'mantid-events');
    assert.match(Converter.unsupportedKindMessage('mantid-events'), /BinMD or MDNorm/);
    const ws = await buildH5(f => f.create_group('mantid_workspace_1'));
    assert.equal(Converter.detectH5Kind(ws), 'mantid-workspace');
    const raw = await buildH5(f => {
        const e = f.create_group('entry');
        e.create_attribute('NX_class', 'NXentry');
        e.create_group('bank1_events').create_attribute('NX_class', 'NXevent_data');
    });
    assert.equal(Converter.detectH5Kind(raw), 'nexus-events');
    assert.match(Converter.unsupportedKindMessage('nexus-events'), /needs data reduction/);
});

// ------------------------------------------------------------ generic NXdata

test('NXdata (NXrefine-like): [Ql,Qk,Qh] points, weights, float32, cell and metadata', async () => {
    const f = await nxrefineFile();
    assert.equal(Converter.detectH5Kind(f), 'nexus');
    const m = await Converter.readNexusData(f);
    assert.deepEqual(m.dims, [5, 4, 3]);
    assert.deepEqual(m.corner, [-1, -1.5, 0]);
    assert.deepEqual(m.vectors, [[0.5, 0, 0], [0, 1, 0], [0, 0, 0.5]]);
    assert.ok(m.values instanceof Float32Array);
    assert.equal(at(m, 4, 3, 2), code(4, 3, 2) / 2);
    assert.deepEqual(m.cellLengths, [3.9, 3.9, 12.7]);
    assert.equal(m.axesType, 'hkl');
    const notes = m.notes.join('\n');
    for (const re of [/signal divided by "weights"/, /Laue group 4\/mmm/, /wavelength 0\.1665/, /temperature 300 K/]) {
        assert.match(notes, re);
    }
});

test('NXdata behind an external link: explained when missing, followed when present', async () => {
    const h5wasm = await loadH5wasm();
    const FS = h5wasm.FS;
    FS.mkdirTree('/links/scan');
    const target = new h5wasm.File('/links/scan/t.nxs', 'w');
    target.create_group('entry').create_group('data').create_dataset({
        name: 'v', data: fastestFirst(5, 4, 3, Float32Array), shape: [3, 4, 5], dtype: '<f',
    });
    target.close();
    const main = await nxrefineFile({ link: 'scan/t.nxs' });
    // buildH5 wrote the main file in the working directory, not next to scan/.
    assert.deepEqual(Converter.unresolvedLinks(main, '/entry/transform'),
        [{ name: 'data', filename: 'scan/t.nxs', objPath: '/entry/data/v' }]);
    await assert.rejects(Converter.readNexusData(main), /stored in "scan\/t\.nxs"; select that file/);
    main.close();
    const copy = h5wasm.FS.readFile(main.filename);
    FS.writeFile('/links/main.nxs', copy);
    const linked = new h5wasm.File('/links/main.nxs', 'r');
    assert.deepEqual(Converter.unresolvedLinks(linked, '/entry/transform'), []);
    const m = await Converter.readNexusData(linked);
    assert.equal(at(m, 4, 3, 2), code(4, 3, 2));
    linked.close();
});

test('planLinkMounts places companions where the links expect them', () => {
    const files = [{ name: 't.nxs', path: '' }, { name: 'other.h5', path: '' }];
    assert.deepEqual(Converter.planLinkMounts([{ filename: 'scan/t.nxs' }], files),
        { mounts: [{ at: 'scan/t.nxs', index: 0 }], missing: [] });
    assert.deepEqual(Converter.planLinkMounts([{ filename: '/data/ipts/t.nxs' }], files),
        { mounts: [{ at: 't.nxs', index: 0 }], missing: [] });
    const twins = [{ name: 't.nxs', path: 'run/f1/t.nxs' }, { name: 't.nxs', path: 'run/f2/t.nxs' }];
    assert.deepEqual(Converter.planLinkMounts([{ filename: 'f2/t.nxs' }], twins),
        { mounts: [{ at: 'f2/t.nxs', index: 1 }], missing: [] });
    assert.deepEqual(Converter.planLinkMounts([{ filename: 'f3/t.nxs' }], [twins[0], { name: 't.nxs', path: '' }]),
        { mounts: [], missing: ['f3/t.nxs'] });
    assert.deepEqual(Converter.planLinkMounts([{ filename: 'x.nxs' }], files), { mounts: [], missing: ['x.nxs'] });
});

test('legacy NeXus: dataset @signal=1 with @axes "Qh:Qk:Ql" (C order h, k, l)', async () => {
    const [nh, nk, nl] = [3, 4, 2];
    const f = await buildH5(file => {
        const e = file.create_group('entry');
        e.create_attribute('NX_class', 'NXentry');
        const d = e.create_group('data');
        d.create_attribute('NX_class', 'NXdata');
        // C order [h, k, l]: l fastest
        const v = new Float64Array(nh * nk * nl);
        for (let ih = 0; ih < nh; ih++)
            for (let ik = 0; ik < nk; ik++)
                for (let il = 0; il < nl; il++) v[(ih * nk + ik) * nl + il] = code(ih, ik, il);
        const sq = d.create_dataset({ name: 'Sq', data: v, shape: [nh, nk, nl], dtype: '<d' });
        sq.create_attribute('signal', 1, [], '<i');
        sq.create_attribute('axes', 'Qh:Qk:Ql');
        [['Qh', linspace(0, 1, nh)], ['Qk', linspace(0, 3, nk)], ['Ql', linspace(-1, 1, nl)]].forEach(([name, a]) => {
            const ds = d.create_dataset({ name, data: a, shape: [a.length], dtype: '<d' });
            ds.create_attribute('units', 'rlu');
        });
    });
    const m = await Converter.readNexusData(f);
    assert.deepEqual(m.dims, [3, 4, 2]);
    assert.equal(at(m, 2, 3, 1), code(2, 3, 1));
    assert.deepEqual(m.vectors, [[0.5, 0, 0], [0, 1, 0], [0, 0, 2]]);
    assert.match(m.notes.join('\n'), /no unit cell found/);
});

test('NXdata with Cartesian Q axes and bin edges converts to hkl with the cell', async () => {
    const f = await buildH5(file => {
        const e = file.create_group('entry');
        e.create_attribute('NX_class', 'NXentry');
        const d = e.create_group('data');
        d.create_attribute('NX_class', 'NXdata');
        d.create_attribute('signal', 'intensity');
        d.create_attribute('axes', ['Qz', 'Qy', 'Qx'], [3], 'S2');
        d.create_dataset({ name: 'intensity', data: fastestFirst(4, 3, 2), shape: [2, 3, 4], dtype: '<d' });
        [['Qx', linspace(-1, 1, 5)], ['Qy', linspace(-1.5, 1.5, 4)], ['Qz', linspace(0, 1, 3)]].forEach(([name, a]) => {
            const ds = d.create_dataset({ name, data: a, shape: [a.length], dtype: '<d' });
            ds.create_attribute('units', 'Angstrom^-1');
        });
    });
    const m = await Converter.readNexusData(f);
    assert.equal(m.axesType, 'Q');
    assert.deepEqual(m.dims, [4, 3, 2]);
    assert.ok(maxAbsDiff(m.corner, [-0.75, -1, 0.25]) < 1e-12);
    assert.match(m.notes.join('\n'), /bin edges/);
    const cell = { lengths: [2 * Math.PI, 2 * Math.PI, 2 * Math.PI], angles: [90, 90, 90] };
    const plan = Converter.planConversion({ model: m }, { format: 'unified', manual: cell });
    assert.ok(maxAbsDiff(plan.model.corner, [-0.75, -1, 0.25]) < 1e-12);   // |a*| = 1: hkl equals Q
    assert.equal(plan.model.axesType, 'hkl');
});

test('NXdata: @default wins, other groups can be picked, uneven axes are refused', async () => {
    const f = await nxrefineFile({
        extra: file => {
            const g = file.get('entry').create_group('alt');
            g.create_attribute('NX_class', 'NXdata');
            g.create_attribute('signal', 'counts');
            g.create_attribute('axes', ['l', 'k', 'h'], [3], 'S1');
            g.create_dataset({ name: 'counts', data: fastestFirst(2, 2, 2), shape: [2, 2, 2], dtype: '<d' });
            [['h', [0, 1]], ['k', [0, 1]], ['l', [0, 3]]].forEach(([n, a]) =>
                g.create_dataset({ name: n, data: a, shape: [2], dtype: '<d' }));
            const bad = file.get('entry').create_group('uneven');
            bad.create_attribute('NX_class', 'NXdata');
            bad.create_attribute('signal', 'counts');
            bad.create_attribute('axes', ['l', 'k', 'h'], [3], 'S1');
            bad.create_dataset({ name: 'counts', data: new Float64Array(27), shape: [3, 3, 3], dtype: '<d' });
            [['h', [0, 1, 2]], ['k', [0, 1, 2]], ['l', [0, 1, 5]]].forEach(([n, a]) =>
                bad.create_dataset({ name: n, data: a, shape: [3], dtype: '<d' }));
        },
    });
    const candidates = Converter.nexusCandidates(f);
    assert.deepEqual(candidates.map(c => [c.path, c.isDefault]),
        [['/entry/transform', true], ['/entry/alt', false], ['/entry/uneven', false]]);
    assert.deepEqual((await Converter.readNexusData(f)).dims, [5, 4, 3]);
    const alt = await Converter.readNexusData(f, { path: '/entry/alt' });
    assert.deepEqual(alt.vectors, [[1, 0, 0], [0, 1, 0], [0, 0, 3]]);
    await assert.rejects(Converter.readNexusData(f, { path: '/entry/uneven' }), /axis l is not evenly spaced/);
});

test('projectionVector parses Mantid dimension names', () => {
    assert.deepEqual(Converter.projectionVector('[H,H,0]'), [1, 1, 0]);
    assert.deepEqual(Converter.projectionVector('[-H,H,0]'), [-1, 1, 0]);
    assert.deepEqual(Converter.projectionVector('[0.5H,0,0]'), [0.5, 0, 0]);
    assert.deepEqual(Converter.projectionVector('[0,0,L]'), [0, 0, 1]);
    assert.equal(Converter.projectionVector('H (r.l.u.)'), null);
    assert.equal(Converter.projectionVector('[0,0,0]'), null);
});
