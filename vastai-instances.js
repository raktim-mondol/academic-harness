/**
 * Vast.ai compute instance catalog — maps a user-facing instance id onto the
 * marketplace GPU names used to search offers, plus the default image and
 * per-hour cost estimate.
 *
 * Unlike Runpod/Modal, Vast.ai is a marketplace: rates come from the chosen
 * offer (`dph_total`), not from a fixed catalog, so `pricePerHour` is null
 * here and the run tool reports the actual offer price.
 */

/** Official Vast.ai image with SSH support; the API resolves the auto tag. */
const DEFAULT_IMAGE = 'vastai/pytorch:@vastai-automatic-tag'

export const VASTAI_INSTANCES = [
  { id: 'rtx3090', label: 'RTX 3090', gpuNames: ['RTX_3090'], pricePerHour: null, defaultImage: DEFAULT_IMAGE },
  { id: 'rtx4090', label: 'RTX 4090', gpuNames: ['RTX_4090'], pricePerHour: null, defaultImage: DEFAULT_IMAGE },
  { id: 'l4', label: 'L4', gpuNames: ['L4'], pricePerHour: null, defaultImage: DEFAULT_IMAGE },
  { id: 'a40', label: 'A40', gpuNames: ['A40'], pricePerHour: null, defaultImage: DEFAULT_IMAGE },
  { id: 'a6000', label: 'RTX A6000', gpuNames: ['RTX_A6000'], pricePerHour: null, defaultImage: DEFAULT_IMAGE },
  { id: 'a100-80gb', label: 'A100 80GB', gpuNames: ['A100_SXM4', 'A100_PCIE'], pricePerHour: null, defaultImage: DEFAULT_IMAGE },
  { id: 'h100', label: 'H100', gpuNames: ['H100_SXM', 'H100_PCIE'], pricePerHour: null, defaultImage: DEFAULT_IMAGE },
  { id: 'h200', label: 'H200', gpuNames: ['H200'], pricePerHour: null, defaultImage: DEFAULT_IMAGE },
]

const BY_ID = new Map(VASTAI_INSTANCES.map((i) => [i.id, i]))

export const VASTAI_INSTANCE_IDS = VASTAI_INSTANCES.map((i) => i.id)
export const DEFAULT_VASTAI_INSTANCE_ID = 'rtx4090'

export function resolveVastaiInstance(id) {
  if (!id) return null
  const bare = id.startsWith('vastai:') ? id.slice('vastai:'.length) : id
  return BY_ID.get(bare) ?? null
}

/** POST /api/v0/bundles/ body. Exported for tests. */
export function buildVastSearchBody({ spec, numGpus = 1, maxPricePerHour, spot = false, limit = 8 }) {
  const body = {
    gpu_name: { in: spec.gpuNames },
    num_gpus: { eq: numGpus },
    verified: { eq: true },
    rentable: { eq: true },
    type: spot ? 'bid' : 'ondemand',
    order: [['dph_total', 'asc']],
    limit,
  }
  if (maxPricePerHour) body.dph_total = { lte: maxPricePerHour }
  return body
}

/** PUT /api/v0/asks/{offer_id}/ body. Exported for tests. */
export function buildVastCreateBody({ spec, image, diskGb, label, spotPrice, volumeId }) {
  const body = {
    image,
    disk: diskGb,
    runtype: 'ssh_direct',
    label,
    target_state: 'running',
    cancel_unavail: true,
  }
  if (spotPrice !== undefined && spotPrice !== null) body.price = spotPrice
  if (volumeId !== undefined && volumeId !== null) {
    body.volume_info = { create_new: false, volume_id: volumeId, mount_path: '/workspace' }
  }
  return body
}
