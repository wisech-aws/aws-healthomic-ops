import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuration,
  parseSize,
  parsePositiveInt,
  parsePositiveNumber,
  parseChoice,
} from '../src/units.mjs';

describe('parseDuration', () => {
  test('converts minutes to hours', () => {
    assert.equal(parseDuration('90m'), 1.5);
  });
  test('converts fractional hours', () => {
    assert.equal(parseDuration('1.5h'), 1.5);
  });
  test('converts seconds to hours', () => {
    assert.equal(parseDuration('45s'), 45 / 3600);
  });
  test('converts days to hours', () => {
    assert.equal(parseDuration('2d'), 48);
  });
  test('accepts zero duration as valid', () => {
    assert.equal(parseDuration('0h'), 0);
  });
  test('rejects a bare number with no unit', () => {
    const result = parseDuration('90');
    assert.ok('error' in result);
  });
  test('rejects non-numeric input', () => {
    const result = parseDuration('abc');
    assert.ok('error' in result);
  });
  test('rejects empty input', () => {
    const result = parseDuration('');
    assert.ok('error' in result);
  });
  test('rejects an unknown unit', () => {
    const result = parseDuration('90x');
    assert.ok('error' in result);
  });
  test('is case-insensitive on unit', () => {
    assert.equal(parseDuration('90M'), 1.5);
  });
});

describe('parseSize', () => {
  test('parses GiB', () => {
    assert.equal(parseSize('100GiB'), 100);
  });
  test('parses TiB into GiB', () => {
    assert.equal(parseSize('0.5TiB'), 512);
  });
  test('defaults a bare number to GiB', () => {
    assert.equal(parseSize('100'), 100);
  });
  test('rejects non-numeric input', () => {
    const result = parseSize('abc');
    assert.ok('error' in result);
  });
  test('rejects empty input', () => {
    const result = parseSize('');
    assert.ok('error' in result);
  });
});

describe('parsePositiveInt', () => {
  test('accepts a positive integer', () => {
    assert.equal(parsePositiveInt('4'), 4);
  });
  test('rejects a non-integer', () => {
    assert.ok('error' in parsePositiveInt('4.5'));
  });
  test('rejects zero', () => {
    assert.ok('error' in parsePositiveInt('0'));
  });
  test('rejects negatives', () => {
    assert.ok('error' in parsePositiveInt('-1'));
  });
  test('rejects non-numeric', () => {
    assert.ok('error' in parsePositiveInt('abc'));
  });
});

describe('parsePositiveNumber', () => {
  test('accepts a positive fractional number', () => {
    assert.equal(parsePositiveNumber('4.5'), 4.5);
  });
  test('rejects zero', () => {
    assert.ok('error' in parsePositiveNumber('0'));
  });
  test('rejects negative', () => {
    assert.ok('error' in parsePositiveNumber('-1'));
  });
  test('rejects Infinity', () => {
    assert.ok('error' in parsePositiveNumber('Infinity'));
  });
  test('rejects non-numeric', () => {
    assert.ok('error' in parsePositiveNumber('abc'));
  });
});

describe('parseChoice', () => {
  test('matches case-insensitively and returns canonical option', () => {
    assert.equal(parseChoice('static', ['STATIC', 'DYNAMIC']), 'STATIC');
  });
  test('rejects an invalid choice, listing valid options', () => {
    const result = parseChoice('nope', ['STATIC', 'DYNAMIC']);
    assert.ok('error' in result);
    assert.match(result.error, /STATIC/);
    assert.match(result.error, /DYNAMIC/);
  });
});

describe('property: no NaN, no throw, across garbage inputs', () => {
  const garbageInputs = ['', 'abc', 'NaN', '   ', '90xyz', null, undefined, '-0-0-0'];
  const numericParsers = [parseDuration, parseSize, parsePositiveInt, parsePositiveNumber];

  for (const parser of numericParsers) {
    for (const input of garbageInputs) {
      test(`${parser.name}(${JSON.stringify(input)}) never throws and never returns NaN`, () => {
        let result;
        assert.doesNotThrow(() => {
          result = parser(input);
        });
        if (typeof result === 'number') {
          assert.ok(!Number.isNaN(result));
        } else {
          assert.ok(typeof result === 'object' && result !== null && 'error' in result);
          assert.equal(typeof result.error, 'string');
        }
      });
    }
  }
});
