import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveRegion } from '../plan-cost.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plan-cost.mjs');

describe('parseArgs (pure)', () => {
  test('parses --help', () => {
    assert.deepEqual(parseArgs(['--help']), {
      region: null,
      interactive: undefined,
      inputFile: null,
      json: false,
      help: true,
    });
  });

  test('parses -h as an alias for --help', () => {
    assert.equal(parseArgs(['-h']).help, true);
  });

  test('parses --region with a value', () => {
    assert.equal(parseArgs(['--region', 'us-west-2']).region, 'us-west-2');
  });

  test('--region with no value is an error', () => {
    assert.ok('error' in parseArgs(['--region']));
  });

  test('--input sets inputFile and turns off default interactive', () => {
    const parsed = parseArgs(['--input', 'plan.json']);
    assert.equal(parsed.inputFile, 'plan.json');
    assert.equal(parsed.interactive, false);
  });

  test('unknown flag is a usage error', () => {
    const parsed = parseArgs(['--bogus']);
    assert.ok('error' in parsed);
    assert.match(parsed.error, /Unknown option/);
  });
});

describe('resolveRegion (pure)', () => {
  test('--region flag wins over environment', () => {
    const result = resolveRegion('us-west-2', { AWS_REGION: 'us-east-1', COST_REGION: 'eu-west-1' });
    assert.deepEqual(result, { region: 'us-west-2', source: 'flag' });
  });

  test('falls back to AWS_REGION when no flag given', () => {
    const result = resolveRegion(null, { AWS_REGION: 'us-east-1' });
    assert.deepEqual(result, { region: 'us-east-1', source: 'AWS_REGION' });
  });

  test('falls back to COST_REGION when AWS_REGION is unset', () => {
    const result = resolveRegion(null, { COST_REGION: 'eu-west-1' });
    assert.deepEqual(result, { region: 'eu-west-1', source: 'COST_REGION' });
  });

  test('returns null region when nothing resolves', () => {
    const result = resolveRegion(null, {});
    assert.deepEqual(result, { region: null, source: null });
  });
});

describe('CLI --help runs offline with no AWS SDK/network', () => {
  test('exits 0 and prints usage + a worked example', async () => {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH, '--help'], {
      env: { ...process.env, AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '', AWS_PROFILE: '' },
    });
    assert.match(stdout, /plan-cost/);
    assert.match(stdout, /--region/);
    assert.match(stdout, /Examples:/);
  });

  test('works with no AWS credentials present (proves no AWS call attempted)', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT_PATH, '--help'], {
      env: { PATH: process.env.PATH }, // strip everything else, including any AWS env vars
    });
    assert.match(stdout, /plan-cost/);
    assert.doesNotMatch(stderr, /credential/i);
  });

  test('bad flag exits 2 with a clear message', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT_PATH, '--bogus']),
      (err) => {
        assert.equal(err.code, 2);
        assert.match(err.stderr, /Unknown option/);
        return true;
      },
    );
  });
});
