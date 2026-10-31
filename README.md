<div align="center">

<img src="assets/logodark.svg" alt="TINA logo" width="72"/>

# TINA

**Meeting bots and real-time transcription — self-hosted.**



![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)
![Source baseline](https://img.shields.io/badge/source%20baseline-0.12-informational.svg)
![Deploy](https://img.shields.io/badge/deploy-self--hosted-success.svg)

Run the complete system on infrastructure you control. TINA has no hosted API or account service.

</div>

---

## ⚡ Quickstart

Self-host the whole stack on one host, then explore it in the Terminal or drive it over the API.
Linux (Ubuntu 24.04) is the production target; a Mac with Docker Desktop works fine for a local
evaluation — everything runs in containers either way.

**Prerequisites** — Python 3, `make`, **Docker engine ≥ v26** (`make all` checks), and a transcription service.
For a guided first local installation, run `make cli-install`, add `~/.local/bin` to PATH, then
`tina setup`. See [the first-install guide](deploy/compose/bin/README.md#first-installation-cli-040).
For air-gapped use, run the self-hosted transcription unit in `deploy/transcription`. By default,
`POST /bots` **requires** STT and answers **503** when it is missing
(`make all` warns when the credentials block in `.env` is empty). Capture-only is an explicit opt-out:
`{"transcribe_enabled": false}` on the spawn (or set `TRANSCRIBE_ENABLED=false` for the deployment).



```bash
cd /path/to/TINA
make plan     # inspect project, profiles, files and volumes without changes
make all      # build required images, start/wait for Compose, provision your API key + URLs
```

For local CLI/TUI operation, run `make cli-install`, then `tina` from any directory. Use
`tina status`, `tina doctor`, or `tina deploy --dry-run` to inspect the selected deployment.
Use `tina doctor --full` for host/ASR diagnostics and `tina check all` for the CLI, graph,
dataflow and contract checks; they do not deploy or run inference.
`tina asr status`, `tina asr verify` and `tina asr configure` provide scoped ASR inspection,
connectivity checks and reviewed configuration through the existing Identity APIs.
See the [CLI guide](deploy/compose/bin/README.md#local-tina-cli--tui) before deployment commands.

When `make all` finishes it prints your key and URLs:

```text
  Terminal UI : http://localhost:13000     # the web workbench
  API gateway : http://localhost:18056     # the API
  API key     : tina_…
```

