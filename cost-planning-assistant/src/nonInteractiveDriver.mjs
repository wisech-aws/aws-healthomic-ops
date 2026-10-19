/**
 * nonInteractiveDriver.mjs — the deterministic, scriptable driver that also
 * powers the LLM_Skill (Req 7.5, 9.8). Applies the SAME validation
 * (`units.mjs`) and the SAME estimation math (`estimationCore.mjs`) as the
 * interactive driver — no separate, laxer path.
 *
 * Extracted from `plan-cost.mjs` so it is directly importable/testable
 * without spawning a child process; the real CLI calls `runNonInteractive`
 * with a real injected `PricingClient`, tests call it with a fake one.
 */
import { parseDuration, parsePositiveInt, parseSize, parseChoice } from './units.mjs';
import { buildInstanceOptions } from './estimationCore.mjs';

/**
 * Validate and convert the raw JSON input shape
 * `{ region?, steps: [{label, instanceType, runtime, scatter}], storage: {mode, sizeGiB, runtimeHours?} }`
 * into the shape `estimate()` expects. Returns `{ steps, storage }` or
 * `{ error: string }` naming the first offending field.
 *
 * @param {object} inputJson
 */
export function validatePlanInput(inputJson) {
  if (inputJson === null || typeof inputJson !== 'object') {
    return { error: 'Input must be a JSON object with "steps" and "storage" fields' };
  }

  const rawSteps = inputJson.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { error: 'Field "steps" must be a non-empty array' };
  }

  const steps = [];
  for (let i = 0; i < rawSteps.length; i += 1) {
    const rawStep = rawSteps[i];
    const fieldPrefix = `steps[${i}]`;

    if (typeof rawStep?.instanceType !== 'string' || rawStep.instanceType.trim() === '') {
      return { error: `${fieldPrefix}.instanceType is required and must be a string` };
    }

    const runtimeHours = parseDuration(rawStep.runtime);
    if (typeof runtimeHours !== 'number') {
      return { error: `${fieldPrefix}.runtime: ${runtimeHours.error}` };
    }

    const scatterWidth = parsePositiveInt(rawStep.scatter);
    if (typeof scatterWidth !== 'number') {
      return { error: `${fieldPrefix}.scatter: ${scatterWidth.error}` };
    }

    steps.push({
      label: typeof rawStep.label === 'string' && rawStep.label.trim() !== '' ? rawStep.label : `step-${i + 1}`,
      instanceType: rawStep.instanceType,
      estimatedRuntimeHours: runtimeHours,
      scatterWidth,
    });
  }

  let storage = null;
  const rawStorage = inputJson.storage;
  if (rawStorage !== undefined && rawStorage !== null) {
    const mode = parseChoice(rawStorage.mode, ['STATIC', 'DYNAMIC']);
    if (typeof mode !== 'string') {
      return { error: `storage.mode: ${mode.error}` };
    }

    const sizeGiB = parseSize(
      typeof rawStorage.sizeGiB === 'number' ? String(rawStorage.sizeGiB) : rawStorage.sizeGiB,
    );
    if (typeof sizeGiB !== 'number') {
      return { error: `storage.sizeGiB: ${sizeGiB.error}` };
    }

    const runRuntimeHours = parseDuration(rawStorage.runtime);
    if (typeof runRuntimeHours !== 'number') {
      return { error: `storage.runtime: ${runRuntimeHours.error}` };
    }

    storage = { mode, sizeGiB, runRuntimeHours };
  }

  return { steps, storage };
}

/**
 * Run the non-interactive driver end to end: read input, validate, fetch the
 * rate map, compute the estimate, and render output.
 *
 * @param {{
 *   inputFile: string|null,
 *   region: string,
 *   pricingClient: {send: Function},
 *   json: boolean,
 *   fetchRateMap: Function,
 *   instanceSpecs: object,
 *   estimate: Function,
 *   renderEstimate: Function,
 *   readStdin: () => Promise<string>,
 *   readFile?: (path: string) => Promise<string>,
 * }} args
 * @returns {Promise<{exitCode:number, output:string}>}
 */
export async function runNonInteractive({
  inputFile,
  region,
  pricingClient,
  json,
  fetchRateMap,
  instanceSpecs,
  estimate,
  renderEstimate,
  readStdin,
  readFile,
}) {
  let rawText;
  try {
    if (inputFile) {
      const readFileFn = readFile ?? defaultReadFile;
      rawText = await readFileFn(inputFile);
    } else {
      rawText = await readStdin();
    }
  } catch (err) {
    return { exitCode: 2, output: `Error: could not read input (${err.message})` };
  }

  let inputJson;
  try {
    inputJson = JSON.parse(rawText);
  } catch (err) {
    return { exitCode: 2, output: `Error: input is not valid JSON (${err.message})` };
  }

  const validated = validatePlanInput(inputJson);
  if ('error' in validated) {
    return { exitCode: 2, output: `Error: ${validated.error}` };
  }

  const effectiveRegion = inputJson.region && !region ? inputJson.region : region;

  const rateMapResult = await fetchRateMap({ region: effectiveRegion, pricingClient });
  const { steps, storage } = validated;

  const result = estimate({ steps, storage, rateMap: rateMapResult.rates }, rateMapResult.retrievedAt);
  const merged = {
    ...result,
    region: effectiveRegion,
    currency: rateMapResult.currency,
    instanceOptions: buildInstanceOptions(rateMapResult.rates, instanceSpecs),
  };

  const output = json ? JSON.stringify(merged, null, 2) : renderEstimate(merged);
  return { exitCode: 0, output };
}

async function defaultReadFile(path) {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}
