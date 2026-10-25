// Run: node --test kenteken-scanner/tests/plate.test.js
const test = require('node:test');
const assert = require('node:assert');
const Plate = require('../plate.js');

test('format puts dashes per sidecode', () => {
  assert.strictEqual(Plate.format('gx434r'), 'GX-434-R');
  assert.strictEqual(Plate.format('12ABC3'), '12-ABC-3');
  assert.strictEqual(Plate.format('X999XX'), 'X-999-XX');
  assert.strictEqual(Plate.format('1KBB23'), '1-KBB-23');
});

test('isValid rejects wrong lengths and shapes', () => {
  assert.ok(Plate.isValid('GX-434-R'));
  assert.ok(!Plate.isValid('GX434'));
  assert.ok(!Plate.isValid('123456'));
});

test('candidates reads clean OCR output', () => {
  assert.strictEqual(Plate.candidates('GX-434-R')[0], 'GX434R');
});

test('candidates drops the NL country strip', () => {
  assert.strictEqual(Plate.candidates('NL GX-434-R\n')[0], 'GX434R');
  assert.strictEqual(Plate.candidates('NLGX434R')[0], 'GX434R');
});

test('candidates fixes letter and digit confusions', () => {
  assert.strictEqual(Plate.candidates('GX-43A-R')[0], 'GX434R');
  assert.strictEqual(Plate.candidates('8-KBB-23')[0], '8KBB23');
  assert.strictEqual(Plate.candidates('5S-ABC-1')[0], '55ABC1');
});

test('candidates returns nothing for noise', () => {
  assert.deepStrictEqual(Plate.candidates(''), []);
  assert.deepStrictEqual(Plate.candidates('---'), []);
});
