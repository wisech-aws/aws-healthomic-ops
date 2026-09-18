import { describe, it, expect } from 'vitest';
import { parseRunParameters } from './parseRunParameters';

const obj = { input: 's3://bucket/x.csv', validate_params: false, outdir: '/mnt' };

describe('parseRunParameters (AWSJSON tolerance)', () => {
  it('returns an already-parsed object as-is', () => {
    expect(parseRunParameters(obj)).toEqual(obj);
  });

  it('parses a single JSON-encoded string', () => {
    expect(parseRunParameters(JSON.stringify(obj))).toEqual(obj);
  });

  it('parses a double-encoded string (the AWSJSON quirk that hid parameters)', () => {
    // A JSON string whose decoded value is itself a JSON string of the object.
    const doubleEncoded = JSON.stringify(JSON.stringify(obj));
    expect(parseRunParameters(doubleEncoded)).toEqual(obj);
  });

  it('returns null for null/undefined/empty', () => {
    expect(parseRunParameters(null)).toBeNull();
    expect(parseRunParameters(undefined)).toBeNull();
    expect(parseRunParameters('')).toBeNull();
  });

  it('returns null for a non-object JSON value (e.g. a bare number/string)', () => {
    expect(parseRunParameters('42')).toBeNull();
    expect(parseRunParameters(JSON.stringify('just a string'))).toBeNull();
  });

  it('returns null for unparseable garbage', () => {
    expect(parseRunParameters('not-json{')).toBeNull();
  });

  it('handles the real run 3269117 payload shape', () => {
    const wire =
      '{"input":"s3://healthomics-input-data-123456789012-us-east-1-an/nf-core-test-data/fetchngs/testdata/v1.12.0/sra_ids_test.csv","validate_params":false,"outdir":"/mnt/workflow/pubdir"}';
    expect(parseRunParameters(wire)).toEqual({
      input:
        's3://healthomics-input-data-123456789012-us-east-1-an/nf-core-test-data/fetchngs/testdata/v1.12.0/sra_ids_test.csv',
      validate_params: false,
      outdir: '/mnt/workflow/pubdir',
    });
  });
});
