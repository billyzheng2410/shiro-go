// Immutable official upstream files. Binaries and model weights are downloaded locally,
// never committed to this repository. SHA256 values pin the exact supported versions.
const release = (version, name, size, sha256) => Object.freeze({
  name, version, kind: 'archive', size, sha256,
  url: `https://github.com/lightvector/KataGo/releases/download/${version}/${name}`,
});

export const BINARIES = Object.freeze({
  cpu: release('v1.18.1', 'katago-v1.18.1-eigen-windows-x64.zip', 5903072, '074485cf150c38aa3bb14ac9f54f2952ffefbceb44673709bbb8a83650bf95d6'),
  cuda: release('v1.18.2', 'katago-v1.18.2-cuda12.8-cudnn9.8.0-windows-x64.zip', 10173580, '69a94227afaaf268634134805b9469f9f482760ee6c986d315d89525de0eefa2'),
});

export const MODELS = Object.freeze({
  cpu: Object.freeze({
    name: 'kata1-b10c128-s1141046784-d204142634', kind: 'model', filename: 'model.txt.gz',
    url: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz',
    size: 14466254, sha256: '3d8a24697ba25fe4da39af4c2b6bd405907b0ad8295322f5a550fa2d8fe4a2f4',
  }),
  cuda: Object.freeze({
    name: 'kata1-tf3-b11c768-s12382M-d6533M', kind: 'model', filename: 'model.bin.gz',
    url: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-tf3-b11c768-s12382M-d6533M.bin.gz',
    size: 262041254, sha256: '956c98c653825131233ca63ffe39f2a2270db957faf8650cddc8a60165b438a1',
  }),
  human: Object.freeze({
    name: 'b18c384nbt-humanv0', kind: 'model', filename: 'human-model.bin.gz',
    url: 'https://media.katagotraining.org/uploaded/networks/models_extra/b18c384nbt-humanv0.bin.gz',
    size: 99066230, sha256: '637746e44f0efe00ad1245a50aa9bbf0716efe364c43965ead97bd6835d84ab5',
  }),
});

export const CUDA_LIBRARIES = Object.freeze([
  { name: 'cuda_cudart-windows-x86_64-12.8.57-archive.zip', size: 3034859, sha256: '2c7aa62a195d79229d4381c8bd0174a30502cf3d8124c6e94ee50a7fc8a1e9f4', path: 'cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.8.57-archive.zip' },
  { name: 'libcublas-windows-x86_64-12.8.3.14-archive.zip', size: 574528660, sha256: 'a2f990cf61f0086d942632f2455727240baa9378c2e9fa2bdda56ef81f6cf8ad', path: 'libcublas/windows-x86_64/libcublas-windows-x86_64-12.8.3.14-archive.zip' },
  { name: 'cuda_nvrtc-windows-x86_64-12.8.61-archive.zip', size: 305553480, sha256: 'e43603b09f8a52d681ceb814c00b655af19da53692ab91671dabbf8071c8f93d', path: 'cuda_nvrtc/windows-x86_64/cuda_nvrtc-windows-x86_64-12.8.61-archive.zip' },
  { name: 'cudnn-windows-x86_64-9.8.0.87_cuda12-archive.zip', size: 675349654, sha256: 'd8a23705e3884b137b7e05449fb2b61bfa524e7cfc3fda80743d633f423c6ce4', path: 'cudnn/windows-x86_64/cudnn-windows-x86_64-9.8.0.87_cuda12-archive.zip', cudnn: true },
].map(item => Object.freeze({
  ...item, kind: 'archive',
  url: `https://developer.download.nvidia.com/compute/${item.cudnn ? 'cudnn' : 'cuda'}/redist/${item.path}`,
})));

export const SOURCES = Object.freeze({
  releases: 'https://github.com/lightvector/KataGo/releases',
  models: 'https://katagotraining.org/networks/',
  humanModel: 'https://katagotraining.org/extra_networks/',
  cudaManifest: 'https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.8.0.json',
  cudnnManifest: 'https://developer.download.nvidia.com/compute/cudnn/redist/redistrib_9.8.0.json',
  driverRequirements: 'https://docs.nvidia.com/cuda/archive/12.8.1/cuda-toolkit-release-notes/index.html',
});
