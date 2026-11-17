# Third-party software and models

Shiro Go's application source is covered by the repository's [LICENSE](LICENSE).
That license does not replace the licenses of separately installed engines,
model weights, GPU libraries, or their dependencies. This source repository
does not include those executables, DLLs, model weights, or GPU caches.

## KataGo

The local Go engine is [KataGo](https://github.com/lightvector/KataGo), by
David J Wu (lightvector) and contributors. KataGo's own source uses the
[upstream MIT license](https://github.com/lightvector/KataGo/blob/master/LICENSE),
with separately licensed components identified in that file. Official binary
packages can include dependencies with additional notices. Keep the license
files supplied with the engine package when installing or redistributing it.
Shiro Go's installers download official release packages rather than including
an engine binary in this repository.

## Main neural network and HumanSL

The CUDA strong model is obtained from the official
[KataGo network directory](https://katagotraining.org/networks/). The optional
`b18c384nbt-humanv0.bin.gz` HumanSL model is the official
[KataGo Human SL Network](https://katagotraining.org/extra_networks/), originally
published with [KataGo v1.15.0](https://github.com/lightvector/KataGo/releases/tag/v1.15.0).

The official [KataGo Neural Network License](https://katagotraining.org/network_license/)
applies to the CUDA `kata1` main-run model and this KataGo-labeled HumanSL
model. It grants broad permissions subject to retaining its copyright and
permission notice. Downloaded models remain under that license. Models from
other contributors can have different terms; consult their own notices before
substituting or redistributing them.

The compact CPU model, `kata1-b10c128-s1141046784-d204142634`, is an imported
older g170/g170e network. Those older networks use
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), as distinguished
on the same official license page; see also the
[upstream training history](https://github.com/lightvector/KataGo/blob/master/TrainingHistory.md).
The `kata1` directory in a download URL does not by itself determine a model's
license. Copies of the KataGo and model license information are retained in
[`scripts/licenses/`](scripts/licenses/) and copied to the local installation.

HumanSL profiles simulate approximate KGS-style ranks. They are not certified
ranks, and high-dan or professional-style profiles do not guarantee the actual
strength of the players represented. HumanSL use on smaller boards is
experimental. See the [official HumanSL guide](https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md#human-sl-analysis-guide).

## NVIDIA CUDA and cuDNN

The optional NVIDIA setup downloads runtime packages directly from NVIDIA.
CUDA and cuDNN are separately licensed NVIDIA software, not part of Shiro Go's
MIT-licensed source. Their applicable terms and package notices govern their
use and any redistribution:

- [NVIDIA CUDA software license agreement](https://docs.nvidia.com/cuda/eula/index.html)
- [NVIDIA cuDNN software license agreement](https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/eula.html)

Retain the notices extracted from those packages. No NVIDIA runtime binaries
are included in this source repository. An NVIDIA driver compatible with the
selected runtime is required for CUDA execution.

## Local execution and platform scope

Automatic engine installation targets Windows x64. CUDA requires a compatible
NVIDIA GPU; the compatibility installer offers other supported local backends.
Other operating systems require a suitable native KataGo installation and
configuration; they are not covered by the Windows installer.

After installation, the application performs Go searches in a local KataGo
process. Its web interface uses same-origin local API requests and browser
storage. It loads no remote fonts, analytics, or inference service. Installation
and model downloads require internet access, and opening an external reference
link visits its respective website. No affiliation with or endorsement by
KataGo's authors or NVIDIA is implied.
