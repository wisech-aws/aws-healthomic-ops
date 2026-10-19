/**
 * Instance_Spec_Table — curated vCPU/memory/GPU specs for AWS HealthOmics
 * omics instance types (pure, no I/O).
 *
 * Transcribed from the AWS documentation "Compute and memory requirements for
 * HealthOmics tasks":
 *   https://docs.aws.amazon.com/omics/latest/dev/memory-and-compute-tasks.html
 *
 * Each omics instance type has a FIXED hardware configuration, so this table
 * is a curated constant, not a guess — it is the authoritative source for
 * vCPU/memory/GPU specs, while live price always comes from the Price_List_API
 * (see `priceList.mjs`). The two are joined by Instance_Type in
 * `estimationCore.mjs`'s `buildInstanceOptions`.
 *
 * Families:
 *   - Standard (`omics.m.*`):  4 GiB of memory per vCPU.
 *   - Compute  (`omics.c.*`):  2 GiB of memory per vCPU.
 *   - Memory   (`omics.r.*`):  8 GiB of memory per vCPU.
 *   - GPU      (`omics.g4dn.*`, `omics.g5.*`, `omics.g6.*`, `omics.g6e.*`):
 *     irregular per-size vCPU/memory/GPU specs transcribed directly from the
 *     AWS doc (NOT derived from a formula — GPU counts/memory do not follow
 *     the vCPU-ratio pattern the non-GPU families do).
 *
 * The non-GPU families share one size ladder (vCPU count by size suffix):
 *   large=2, xlarge=4, 2xlarge=8, 4xlarge=16, 8xlarge=32, 12xlarge=48,
 *   16xlarge=64, 24xlarge=96, 32xlarge=128, 48xlarge=192.
 * GPU families only go up to 24xlarge (no 32xlarge/48xlarge GPU instance is
 * documented), so those two larger sizes are intentionally omitted for GPU
 * families rather than invented.
 */

/** Memory-per-vCPU ratio (GiB) for each non-GPU family letter. */
const FAMILY_RATIO_GIB_PER_VCPU = Object.freeze({ c: 2, m: 4, r: 8 });

/** The shared non-GPU size ladder: size suffix -> vCPU count. */
const SIZE_LADDER_VCPUS = Object.freeze({
  large: 2,
  xlarge: 4,
  '2xlarge': 8,
  '4xlarge': 16,
  '8xlarge': 32,
  '12xlarge': 48,
  '16xlarge': 64,
  '24xlarge': 96,
  '32xlarge': 128,
  '48xlarge': 192,
});

/** Build the non-GPU entries for one family letter across the full size ladder. */
function buildFamilyEntries(familyLetter) {
  const ratio = FAMILY_RATIO_GIB_PER_VCPU[familyLetter];
  const entries = {};
  for (const [size, vcpus] of Object.entries(SIZE_LADDER_VCPUS)) {
    entries[`omics.${familyLetter}.${size}`] = { vcpus, memoryGiB: vcpus * ratio };
  }
  return entries;
}

/**
 * GPU family entries, transcribed verbatim from the AWS doc (irregular; no
 * formula). All omics.g6 instances use Nvidia L4 GPUs; all omics.g6e use
 * Nvidia L40s; all omics.g5 use Nvidia Tesla A10G; all omics.g4dn use Nvidia
 * Tesla T4. GPU count/memory are NOT a function of vcpus/memoryGiB.
 */
const GPU_ENTRIES = Object.freeze({
  // omics.g6.* (Nvidia L4)
  'omics.g6.xlarge': { vcpus: 4, memoryGiB: 16, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g6.2xlarge': { vcpus: 8, memoryGiB: 32, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g6.4xlarge': { vcpus: 16, memoryGiB: 64, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g6.8xlarge': { vcpus: 32, memoryGiB: 128, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g6.12xlarge': { vcpus: 48, memoryGiB: 192, gpuCount: 4, gpuMemoryGiB: 96 },
  'omics.g6.16xlarge': { vcpus: 64, memoryGiB: 256, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g6.24xlarge': { vcpus: 96, memoryGiB: 384, gpuCount: 4, gpuMemoryGiB: 96 },

  // omics.g6e.* (Nvidia L40s)
  'omics.g6e.xlarge': { vcpus: 4, memoryGiB: 32, gpuCount: 1, gpuMemoryGiB: 48 },
  'omics.g6e.2xlarge': { vcpus: 8, memoryGiB: 64, gpuCount: 1, gpuMemoryGiB: 48 },
  'omics.g6e.4xlarge': { vcpus: 16, memoryGiB: 128, gpuCount: 1, gpuMemoryGiB: 48 },
  'omics.g6e.8xlarge': { vcpus: 32, memoryGiB: 256, gpuCount: 1, gpuMemoryGiB: 48 },
  'omics.g6e.12xlarge': { vcpus: 48, memoryGiB: 384, gpuCount: 4, gpuMemoryGiB: 192 },
  'omics.g6e.16xlarge': { vcpus: 64, memoryGiB: 512, gpuCount: 1, gpuMemoryGiB: 48 },
  'omics.g6e.24xlarge': { vcpus: 96, memoryGiB: 768, gpuCount: 4, gpuMemoryGiB: 192 },

  // omics.g5.* (Nvidia Tesla A10G)
  'omics.g5.xlarge': { vcpus: 4, memoryGiB: 16, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g5.2xlarge': { vcpus: 8, memoryGiB: 32, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g5.4xlarge': { vcpus: 16, memoryGiB: 64, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g5.8xlarge': { vcpus: 32, memoryGiB: 128, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g5.12xlarge': { vcpus: 48, memoryGiB: 192, gpuCount: 4, gpuMemoryGiB: 96 },
  'omics.g5.16xlarge': { vcpus: 64, memoryGiB: 256, gpuCount: 1, gpuMemoryGiB: 24 },
  'omics.g5.24xlarge': { vcpus: 96, memoryGiB: 384, gpuCount: 4, gpuMemoryGiB: 96 },

  // omics.g4dn.* (Nvidia Tesla T4)
  'omics.g4dn.xlarge': { vcpus: 4, memoryGiB: 16, gpuCount: 1, gpuMemoryGiB: 16 },
  'omics.g4dn.2xlarge': { vcpus: 8, memoryGiB: 32, gpuCount: 1, gpuMemoryGiB: 16 },
  'omics.g4dn.4xlarge': { vcpus: 16, memoryGiB: 64, gpuCount: 1, gpuMemoryGiB: 16 },
  'omics.g4dn.8xlarge': { vcpus: 32, memoryGiB: 128, gpuCount: 1, gpuMemoryGiB: 16 },
  'omics.g4dn.12xlarge': { vcpus: 48, memoryGiB: 192, gpuCount: 4, gpuMemoryGiB: 64 },
  'omics.g4dn.16xlarge': { vcpus: 64, memoryGiB: 256, gpuCount: 1, gpuMemoryGiB: 16 },
});

/**
 * The curated, frozen Instance_Spec_Table: every known omics Instance_Type ->
 * its fixed `{ vcpus, memoryGiB }` (plus `gpuCount`/`gpuMemoryGiB` for GPU
 * types). Frozen at every level so callers cannot mutate the shared table.
 */
export const INSTANCE_SPECS = Object.freeze({
  ...buildFamilyEntries('m'),
  ...buildFamilyEntries('c'),
  ...buildFamilyEntries('r'),
  ...GPU_ENTRIES,
});

// Freeze each individual spec object too (Object.freeze is shallow).
for (const spec of Object.values(INSTANCE_SPECS)) {
  Object.freeze(spec);
}

/**
 * Look up the curated spec for an Instance_Type.
 *
 * @param {string} instanceType
 * @returns {{vcpus:number, memoryGiB:number, gpuCount?:number, gpuMemoryGiB?:number}|null}
 *   The frozen spec object for a known type, or `null` for an unknown type
 *   (an explicit Unavailable_State — this function NEVER fabricates/defaults
 *   a spec for a type it does not recognize).
 */
export function getSpec(instanceType) {
  if (typeof instanceType !== 'string') {
    return null;
  }
  return INSTANCE_SPECS[instanceType] ?? null;
}

/**
 * Recommend the smallest-fitting Instance_Type(s) for a stated resource need,
 * mirroring how HealthOmics itself allocates the smallest instance that
 * accommodates the requested vCPU/memory/GPU.
 *
 * This is a RECOMMENDATION ONLY: it returns an ordered list of candidates,
 * smallest-fitting first, and never a single committed selection. The caller
 * (the CLI) must still require explicit user confirmation before treating any
 * entry as chosen (Req 2.3).
 *
 * @param {{minVcpus?:number, minMemoryGiB?:number, needsGpu?:boolean}} req
 * @param {string[]} instanceTypes - candidate instance types to consider
 *   (typically the types present in the live rate map / instance options —
 *   this function filters the given list; it does not itself enumerate every
 *   key of INSTANCE_SPECS).
 * @returns {string[]} instance types ordered smallest-fitting first; `[]`
 *   when nothing fits. Does not mutate `instanceTypes`.
 */
export function recommendSmallestFit(req = {}, instanceTypes = []) {
  const { minVcpus = 0, minMemoryGiB = 0, needsGpu = false } = req;

  const candidates = [];
  for (const instanceType of instanceTypes) {
    const spec = getSpec(instanceType);
    if (spec === null) {
      // Unknown spec -> cannot evaluate fit; exclude rather than guess.
      continue;
    }
    if (spec.vcpus < minVcpus) {
      continue;
    }
    if (spec.memoryGiB < minMemoryGiB) {
      continue;
    }
    if (needsGpu && !(spec.gpuCount > 0)) {
      continue;
    }
    candidates.push({ instanceType, vcpus: spec.vcpus, memoryGiB: spec.memoryGiB });
  }

  candidates.sort((a, b) => a.vcpus - b.vcpus || a.memoryGiB - b.memoryGiB);
  return candidates.map((c) => c.instanceType);
}
