'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Converter, openH5, readText, maxAbsDiff } = require('./helpers');

const cell = Converter.parseRmc6f(readText('Examples/example_structure.rmc6f'));
const exampleText = readText('Examples/example_diffuse3d.dat');
const example = Converter.parseOldDat(exampleText, cell);

function replaceHeader(text, header) {
    return header + text.slice(text.indexOf('\n'));
}

test('reads the RMCProfile *_calc.dat header "npoints nsec scale offset"', () => {
    const text = replaceHeader(exampleText, '         125           1   3.125E-06       0.40992000');
    const m = Converter.parseOldDat(text, cell);
    assert.deepEqual(m.dims, example.dims);
    assert.equal(maxAbsDiff(m.values, example.values), 0);
    assert.deepEqual(m.datHeader, { scale: 3.125e-6, offset: 0.40992 });
    assert.match(m.notes.join('\n'), /scale = 0\.000003125, offset = 0\.40992/);
});

test('a plain "npoints nsec" header carries no calculation header', () => {
    assert.equal(example.datHeader, null);
    assert.deepEqual(example.notes, []);
});

test('accepts Fortran D exponents and CRLF line ends', () => {
    const text = exampleText.replace(/e([+-])/g, 'D$1').replace(/\n/g, '\r\n');
    assert.notEqual(text, exampleText);
    const m = Converter.parseOldDat(text, cell);
    assert.equal(maxAbsDiff(m.values, example.values), 0);
    assert.ok(maxAbsDiff(m.corner, example.corner) < 1e-12);
});

test('rejects an unrecognized header line', () => {
    assert.throws(() => Converter.parseOldDat(replaceHeader(exampleText, 'npoints nsec'), cell),
        /unrecognized header line/);
    assert.throws(() => Converter.parseOldDat(replaceHeader(exampleText, '125 1 1.0 0.0 7'), cell),
        /unrecognized header line/);
});

test('writes NaN and infinite intensities as 0 (RMCProfile mask value)', async () => {
    const model = Converter.readUnifiedData(await openH5('Examples/example_unified.h5'));
    const values = Float64Array.from(model.values);
    values[0] = NaN;
    values[1] = Infinity;
    values[2] = -Infinity;
    const masked = Object.assign({}, model, { values });
    assert.equal(Converter.countNonFinite(values), 3);
    const text = Converter.writeOldDat(masked, cell);
    assert.doesNotMatch(text, /NaN|Infinity/);
    const back = Converter.parseOldDat(text, cell);
    assert.deepEqual(Array.from(back.values.subarray(0, 3)), [0, 0, 0]);
    assert.equal(maxAbsDiff(back.values.subarray(3), values.subarray(3)), 0);
});
