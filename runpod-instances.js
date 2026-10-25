/**
 * Runpod compute instance catalog — maps a user-facing instance id (e.g.
 * "rtx4090") onto a Runpod REST v2 GPU type (or CPU flavor) and the hourly
 * rate used to estimate compute cost. Rates are community-cloud estimates;
 * actual Runpod invoices may differ by cloud tier / data center / stock.
 */

/** Official Runpod images that start sshd when PUBLIC_KEY is set. */
const DEFAULT_GPU_IMAGE = 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04'
const DEFAULT_CPU_IMAGE = 'runpod/base:1.0.6-ubuntu2204'

export const RUNPOD_INSTANCES = [
  { id: 'cpu', label: 'CPU', gpuTypeId: null, gpuCount: 0, cpuFlavorId: 'cpu5c', vcpuCount: 2, pricePerHour: 0.06, defaultImage: DEFAULT_CPU_IMAGE, containerDiskInGb: 20 },
  { id: 'rtx4090', label: 'RTX 4090', gpuTypeId: 'NVIDIA GeForce RTX 4090', gpuCount: 1, pricePerHour: 0.44, defaultImage: DEFAULT_GPU_IMAGE, containerDiskInGb: 40 },
  { id: 'l4', label: 'L4', gpuTypeId: 'NVIDIA L4', gpuCount: 1, pricePerHour: 0.44, defaultImage: DEFAULT_GPU_IMAGE, containerDiskInGb: 40 },
  { id: 'a40', label: 'A40', gpuTypeId: 'NVIDIA A40', gpuCount: 1, pricePerHour: 0.4, defaultImage: DEFAULT_GPU_IMAGE, containerDiskInGb: 40 },
  { id: 'a6000', label: 'RTX A6000', gpuTypeId: 'NVIDIA RTX A6000', gpuCount: 1, pricePerHour: 0.49, defaultImage: DEFAULT_GPU_IMAGE, containerDiskInGb: 40 },
  { id: 'a100-80gb', label: 'A100 80GB', gpuTypeId: 'NVIDIA A100 80GB PCIe', gpuCount: 1, pricePerHour: 1.64, defaultImage: DEFAULT_GPU_IMAGE, containerDiskInGb: 50 },
  { id: 'h100', label: 'H100', gpuTypeId: 'NVIDIA H100 80GB HBM3', gpuCount: 1, pricePerHour: 2.99, defaultImage: DEFAULT_GPU_IMAGE, containerDiskInGb: 50 },
]

const BY_ID = new Map(RUNPOD_INSTANCES.map((i) => [i.id, i]))

export const RUNPOD_INSTANCE_IDS = RUNPOD_INSTANCES.map((i) => i.id)
export const DEFAULT_RUNPOD_INSTANCE_ID = 'rtx4090'

export function resolveRunpodInstance(id) {
  if (!id) return null
  const bare = id.startsWith('runpod:') ? id.slice('runpod:'.length) : id
  return BY_ID.get(bare) ?? null
}

/**
 * REST v2 create-pod body for one instance. Exported for tests: the nested
 * `gpu`/`cpu` shape and the network mount are the parts most likely to drift
 * from the OpenAPI schema.
 */
export function buildRunpodCreateBody({ spec, imageName, publicKey, cloudType, podName, volume }) {
  const body = {
    name: podName,
    image: imageName,
    disk: spec.containerDiskInGb,
    ports: ['22/tcp'],
    env: { PUBLIC_KEY: publicKey },
    startSsh: true,
    cloud: cloudType,
  }
  if (volume) {
    body.mounts = { network: [{ volumeId: volume.id, path: '/workspace' }] }
    // A network volume is data-center scoped; placement must match it.
    body.dataCenterIds = [volume.dataCenter]
  }
  if (spec.gpuTypeId) {
    body.gpu = { id: spec.gpuTypeId, count: spec.gpuCount || 1 }
  } else {
    body.cpu = { id: spec.cpuFlavorId, vcpuCount: spec.vcpuCount }
  }
  return body
}
