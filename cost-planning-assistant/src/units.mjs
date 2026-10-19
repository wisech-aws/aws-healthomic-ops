/**
 * units.mjs — pure input parsing/validation utilities (no I/O).
 *
 * Every function here returns either a validated value OR an object shaped
 * `{ error: <clear message> }` — never `NaN`, never `undefined`, and never a
 * thrown exception. This powers forgiving re-prompting in the interactive
 * driver (Req 9.5) and identical validation in the non-interactive driver
 * (Req 9.8), and it is how Estimated_Runtime's stated time unit is converted
 * to hours (Req 3.3).
 */

const DURATION_UNIT_TO_HOURS = Object.freeze({
  s: 1 / 3600,
  m: 1 / 60,
  h: 1,
  d: 24,
});

const SIZE_UNIT_TO_GIB = Object.freeze({
  gib: 1,
  tib: 1024,
});

/**
 * Parse a duration string like `"90m"`, `"1.5h"`, `"45s"`, `"2d"` into hours.
 *
 * A unit suffix (`s`/`m`/`h`/`d`, case-insensitive) is REQUIRED: Requirement
 * 3.3 says the assistant must accept a stated time unit, so a bare number
 * with no unit is ambiguous and yields `{error}` rather than guessing a unit.
 * Fractional values are accepted (e.g. `"1.5h"`). Zero is a valid duration
 * (distinct from invalid input).
 *
 * @param {string} input
 * @returns {number|{error:string}} hours, or an error object.
 */
export function parseDuration(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { error: 'Duration is required (e.g. "90m", "1.5h", "45s", "2d")' };
  }
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (!match) {
    return {
      error: `Could not parse duration "${input}" — use a number with a unit: s, m, h, or d (e.g. "90m", "1.5h")`,
    };
  }
  const [, numberPart, unitPart] = match;
  const value = Number(numberPart);
  if (!Number.isFinite(value)) {
    return { error: `Could not parse duration "${input}" — invalid number` };
  }
  const unit = unitPart.toLowerCase();
  const hoursPerUnit = DURATION_UNIT_TO_HOURS[unit];
  if (hoursPerUnit === undefined) {
    return { error: `Unknown time unit "${unitPart}" — use s, m, h, or d` };
  }
  return value * hoursPerUnit;
}

/**
 * Parse a size string like `"100GiB"`, `"0.5TiB"`, or a bare number
 * (default unit GiB) into GiB.
 *
 * @param {string} input
 * @returns {number|{error:string}} GiB, or an error object.
 */
export function parseSize(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { error: 'Size is required (e.g. "100GiB", "0.5TiB", or a bare number for GiB)' };
  }
  const trimmed = input.trim();

  const bareNumberMatch = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (bareNumberMatch) {
    const value = Number(bareNumberMatch[1]);
    if (!Number.isFinite(value)) {
      return { error: `Could not parse size "${input}" — invalid number` };
    }
    return value; // default unit: GiB
  }

  const unitMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*(GiB|TiB)$/i);
  if (!unitMatch) {
    return {
      error: `Could not parse size "${input}" — use a number optionally followed by GiB or TiB (e.g. "100GiB", "0.5TiB")`,
    };
  }
  const [, numberPart, unitPart] = unitMatch;
  const value = Number(numberPart);
  if (!Number.isFinite(value)) {
    return { error: `Could not parse size "${input}" — invalid number` };
  }
  const unit = unitPart.toLowerCase();
  const gibPerUnit = SIZE_UNIT_TO_GIB[unit];
  if (gibPerUnit === undefined) {
    return { error: `Unknown size unit "${unitPart}" — use GiB or TiB` };
  }
  return value * gibPerUnit;
}

/**
 * Parse a positive integer (e.g. a Scatter_Width / task count).
 *
 * @param {string|number} input
 * @returns {number|{error:string}}
 */
export function parsePositiveInt(input) {
  if (input === '' || input === null || input === undefined) {
    return { error: 'A positive whole number is required' };
  }
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return { error: `"${input}" is not a valid number` };
  }
  if (!Number.isInteger(value)) {
    return { error: `"${input}" must be a whole number` };
  }
  if (value <= 0) {
    return { error: `"${input}" must be greater than 0` };
  }
  return value;
}

/**
 * Parse a positive finite number (e.g. a storage size, a vCPU/memory need).
 *
 * @param {string|number} input
 * @returns {number|{error:string}}
 */
export function parsePositiveNumber(input) {
  if (input === '' || input === null || input === undefined) {
    return { error: 'A positive number is required' };
  }
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return { error: `"${input}" is not a valid finite number` };
  }
  if (value <= 0) {
    return { error: `"${input}" must be greater than 0` };
  }
  return value;
}

/**
 * Match `input` against a fixed set of valid string `options`
 * (case-insensitive), returning the canonical (as-listed) option on match.
 *
 * @param {string} input
 * @param {string[]} options
 * @returns {string|{error:string}}
 */
export function parseChoice(input, options) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { error: `A choice is required — valid options: ${options.join(', ')}` };
  }
  const normalized = input.trim().toLowerCase();
  const match = options.find((option) => option.toLowerCase() === normalized);
  if (match === undefined) {
    return { error: `"${input}" is not a valid choice — valid options: ${options.join(', ')}` };
  }
  return match;
}
