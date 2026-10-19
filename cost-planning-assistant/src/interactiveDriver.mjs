/**
 * interactiveDriver.mjs — the progressive, guided interactive flow (Req 9.1).
 *
 * The state-machine logic lives behind an injectable I/O seam: `prompt(text)
 * -> Promise<string>` and `print(text) -> void`. `plan-cost.mjs` wires
 * `prompt` to `node:readline` and `print` to `console.log`; tests inject a
 * scripted fake `prompt` (a queue of answers) and a `print` that collects
 * output, so the whole state machine is testable without a TTY.
 *
 * Flow: Run_Id check (handoff to the Post_Run_Estimator if present) -> region
 * resolution -> fetch rates + show instance menu -> per step {optional
 * resource need -> recommendation (never auto-committed) -> runtime -> scatter}
 * -> repeat/add steps -> Storage_Mode preference + size -> running summary ->
 * review/correct -> compute -> render.
 */
import { parseDuration, parsePositiveInt, parsePositiveNumber, parseSize, parseChoice } from './units.mjs';
import { buildInstanceOptions } from './estimationCore.mjs';
import { recommendSmallestFit } from './instanceSpecs.mjs';

const CANCEL_WORDS = new Set(['quit', 'cancel', 'exit']);

function isCancel(answer) {
  return typeof answer === 'string' && CANCEL_WORDS.has(answer.trim().toLowerCase());
}

/** Prompt repeatedly with `parser` until a valid value or a cancel. */
async function promptUntilValid({ prompt, print, question, parser }) {
  for (;;) {
    const answer = await prompt(question);
    if (isCancel(answer)) {
      return { cancelled: true };
    }
    const result = parser(answer);
    if (typeof result === 'object' && result !== null && 'error' in result) {
      print(`  Not valid: ${result.error}. Please try again (or type "cancel").`);
      continue;
    }
    return { value: result };
  }
}

/**
 * Run the interactive driver end to end.
 *
 * @param {{
 *   region: string|null,
 *   pricingClient: {send: Function},
 *   prompt: (question:string) => Promise<string>,
 *   print: (text:string) => void,
 *   fetchRateMap: Function,
 *   instanceSpecs: object,
 *   estimate: Function,
 *   renderInstanceMenu: Function,
 *   renderRunningSummary: Function,
 *   renderEstimate: Function,
 * }} args
 * @returns {Promise<{cancelled?:boolean, handoff?:boolean, result?:object}>}
 */
export async function runInteractive({
  region,
  pricingClient,
  prompt,
  print,
  fetchRateMap,
  instanceSpecs,
  estimate,
  renderInstanceMenu,
  renderRunningSummary,
  renderEstimate,
}) {
  print(
    'Cost Planning Assistant — a pre-run, what-if cost calculator for AWS HealthOmics workflows.',
  );

  const hasRunIdAnswer = await prompt(
    'Do you already have a Run ID for a workflow that has executed or is executing? (yes/no): ',
  );
  if (isCancel(hasRunIdAnswer)) {
    print('Cancelled. No estimate was computed.');
    return { cancelled: true };
  }
  if (/^y(es)?$/i.test(hasRunIdAnswer.trim())) {
    print(
      'A measured post-run estimate is available for an executed run. ' +
        'Use the post-run estimator instead: dist-cost-estimator/estimate-run-cost.mjs ' +
        '(or the Run Detail "Estimated cost" panel in the dashboard). ' +
        'This planning assistant will not perform a pre-run what-if for that run.',
    );
    return { handoff: true };
  }

  let resolvedRegion = region;
  if (!resolvedRegion) {
    const regionResult = await promptUntilValid({
      prompt,
      print,
      question: 'What AWS region should pricing be fetched for? (e.g. us-east-1): ',
      parser: (answer) =>
        typeof answer === 'string' && answer.trim() !== '' ? answer.trim() : { error: 'A region is required' },
    });
    if (regionResult.cancelled) {
      print('Cancelled. No estimate was computed.');
      return { cancelled: true };
    }
    resolvedRegion = regionResult.value;
  }

  const rateMapResult = await fetchRateMap({ region: resolvedRegion, pricingClient });
  const instanceOptions = buildInstanceOptions(rateMapResult.rates, instanceSpecs);
  print(`\nAvailable instance options in ${resolvedRegion}:\n`);
  print(renderInstanceMenu(instanceOptions));

  const availableInstanceTypes = instanceOptions
    .filter((option) => option.rateAvailable)
    .map((option) => option.instanceType);

  const steps = [];
  let addAnotherStep = true;
  while (addAnotherStep) {
    print(`\n--- Step ${steps.length + 1} ---`);

    const label = await prompt('Step label (a short name for this step): ');
    if (isCancel(label)) {
      print('Cancelled. No estimate was computed.');
      return { cancelled: true };
    }

    const needsRecommendationAnswer = await prompt(
      'Do you want a recommendation based on a resource need (min vCPU/memory/GPU)? (yes/no): ',
    );
    if (isCancel(needsRecommendationAnswer)) {
      print('Cancelled. No estimate was computed.');
      return { cancelled: true };
    }

    let recommendedInstanceType = null;
    if (/^y(es)?$/i.test(needsRecommendationAnswer.trim())) {
      const minVcpusResult = await promptUntilValid({
        prompt,
        print,
        question: 'Minimum vCPUs needed (or 0 for no minimum): ',
        parser: (answer) => (answer.trim() === '0' ? 0 : parsePositiveNumber(answer)),
      });
      if (minVcpusResult.cancelled) {
        print('Cancelled. No estimate was computed.');
        return { cancelled: true };
      }
      const minMemoryResult = await promptUntilValid({
        prompt,
        print,
        question: 'Minimum memory (GiB) needed (or 0 for no minimum): ',
        parser: (answer) => (answer.trim() === '0' ? 0 : parsePositiveNumber(answer)),
      });
      if (minMemoryResult.cancelled) {
        print('Cancelled. No estimate was computed.');
        return { cancelled: true };
      }

      const recommendations = recommendSmallestFit(
        { minVcpus: minVcpusResult.value, minMemoryGiB: minMemoryResult.value },
        availableInstanceTypes,
      );
      if (recommendations.length === 0) {
        print('  No instance option meets that need with a currently-priced rate.');
      } else {
        recommendedInstanceType = recommendations[0];
        print(
          `  Recommendation (smallest fitting): ${recommendedInstanceType}. ` +
            'This is a recommendation only — confirm it or choose a different instance type below.',
        );
      }
    }

    const instanceTypeQuestion = recommendedInstanceType
      ? `Instance type to use [${recommendedInstanceType}] (press Enter to accept, or type another): `
      : 'Instance type to use (e.g. omics.m.large): ';

    const instanceTypeResult = await promptUntilValid({
      prompt,
      print,
      question: instanceTypeQuestion,
      parser: (answer) => {
        const trimmed = answer.trim();
        const chosen = trimmed === '' && recommendedInstanceType ? recommendedInstanceType : trimmed;
        if (!availableInstanceTypes.includes(chosen)) {
          return { error: `"${chosen}" has no published rate in this region — choose a priced instance type` };
        }
        return chosen;
      },
    });
    if (instanceTypeResult.cancelled) {
      print('Cancelled. No estimate was computed.');
      return { cancelled: true };
    }

    const runtimeResult = await promptUntilValid({
      prompt,
      print,
      question: 'Estimated per-task runtime for this step (e.g. "45m", "1.5h"): ',
      parser: parseDuration,
    });
    if (runtimeResult.cancelled) {
      print('Cancelled. No estimate was computed.');
      return { cancelled: true };
    }

    const scatterResult = await promptUntilValid({
      prompt,
      print,
      question: 'Scatter width (number of parallel tasks for this step, e.g. 1): ',
      parser: parsePositiveInt,
    });
    if (scatterResult.cancelled) {
      print('Cancelled. No estimate was computed.');
      return { cancelled: true };
    }

    steps.push({
      label: label.trim() || `step-${steps.length + 1}`,
      instanceType: instanceTypeResult.value,
      estimatedRuntimeHours: runtimeResult.value,
      scatterWidth: scatterResult.value,
    });

    print('\n' + renderRunningSummary({ steps, storage: null }));

    const addAnotherAnswer = await prompt('Add another step? (yes/no): ');
    if (isCancel(addAnotherAnswer)) {
      print('Cancelled. No estimate was computed.');
      return { cancelled: true };
    }
    addAnotherStep = /^y(es)?$/i.test(addAnotherAnswer.trim());
  }

  print(
    '\nStorage mode: STATIC is a fixed reserved capacity billed for the run duration; ' +
      'DYNAMIC is usage-based.',
  );
  const modeResult = await promptUntilValid({
    prompt,
    print,
    question: 'Preferred storage mode (STATIC or DYNAMIC): ',
    parser: (answer) => parseChoice(answer, ['STATIC', 'DYNAMIC']),
  });
  if (modeResult.cancelled) {
    print('Cancelled. No estimate was computed.');
    return { cancelled: true };
  }

  const sizeResult = await promptUntilValid({
    prompt,
    print,
    question: 'Storage size (e.g. "100GiB", "0.5TiB"): ',
    parser: parseSize,
  });
  if (sizeResult.cancelled) {
    print('Cancelled. No estimate was computed.');
    return { cancelled: true };
  }

  const runRuntimeResult = await promptUntilValid({
    prompt,
    print,
    question: "Run's overall expected wall-clock runtime, for the storage calculation (e.g. \"6h\"): ",
    parser: parseDuration,
  });
  if (runRuntimeResult.cancelled) {
    print('Cancelled. No estimate was computed.');
    return { cancelled: true };
  }

  const storage = {
    mode: modeResult.value,
    sizeGiB: sizeResult.value,
    runRuntimeHours: runRuntimeResult.value,
  };

  print('\n' + renderRunningSummary({ steps, storage }));

  const confirmAnswer = await prompt('\nCompute the estimate now? (yes/no): ');
  if (isCancel(confirmAnswer) || !/^y(es)?$/i.test(confirmAnswer.trim())) {
    print('Cancelled. No estimate was computed.');
    return { cancelled: true };
  }

  const result = estimate({ steps, storage, rateMap: rateMapResult.rates }, rateMapResult.retrievedAt);
  const merged = { ...result, region: resolvedRegion, currency: rateMapResult.currency };

  print('\n' + renderEstimate(merged));

  return { result: merged };
}
