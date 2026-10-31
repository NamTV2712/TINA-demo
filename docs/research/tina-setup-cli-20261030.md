# TINA CLI 0.4.0 — first local installation

Implemented `tina setup` and the English TUI entry **Set up a new installation**.
The installed `~/.local/bin/tina` symlink uses this checkout and reports version 0.4.0.

## New-user path

With the source checkout, Python 3.10+, make, git, bash, openssl and a running local Docker
engine >=26 with compatible Compose:

```bash
cd /path/to/TINA
make cli-install
export PATH="$HOME/.local/bin:$PATH"
tina setup --dry-run
tina setup
```

The command checks prerequisites, resolves the base Compose configuration, checks bindings,
existing project containers/volumes/network and occupied loopback ports, then presents its target
and impact. Confirmation precedes private configuration creation and source build/start.

Fresh installs use project/image tag `tina-local`, new managed volumes and `.env.example` defaults;
another deployment's shell values and migration overlays are excluded. New administrator,
internal, flows, auth/signing, database and object-storage credentials are generated. Configuration
is linked atomically from a complete mode-0600 file; an existing file or symlink is never replaced.
Build/start/readiness/access provisioning reuse the existing deployment implementation.

After a successful platform deployment, interactive users can run the existing global ASR wizard
and host/container status verification. The endpoint and credential remain explicit user choices.
Headless `--yes --json` returns ASR instructions without prompting. Skipping ASR returns
`setup=platform_ready` and `asr_ready=false`. Failed verification returns exit 1 with platform
details; interrupted/failed deployment retains configuration/resources and prints recovery commands.

Existing installations use `doctor`, `deploy` and `asr configure`; setup refuses their config.
Custom ENV_FILE paths remain explicit in follow-up commands. Setup requires a local Unix Docker
socket and free default ports; custom ports/profiles use the existing explicit config/deploy flow.

## Verification

- Installed `tina check all --json`: CLI, graph, dataflow and contract-version all passed.
- CLI suite: **119 passed, 1 skipped, 23 subtests passed**.
- Logs: `~/Library/Logs/TINA/checks/20261030-162924-t2ii7zy4/`.
- Focused tests cover isolation from production environment, missing prerequisites/invalid names,
  remote-daemon rejection, existing resources/config/symlinks, busy ports, private atomic creation,
  cancellation/confirmation, recovery, deploy reuse and ASR verification failure.
- Real OrbStack/Compose preview and temporary configuration creation resolved **13 base services**,
  fresh private credentials, dedicated image tags and five managed volumes. No build/start ran in
  that check. The temporary configuration was removed after validation.
- Production `.env` hash and container IDs were unchanged by this check.
- Real installed TUI/PTY smoke: setup entry, refusal of existing production configuration,
  return to menu, normal exit and terminal-mode restoration passed. The initial PTY harness needed
  to drain redraw output before waiting for exit; the corrected harness passed without a product fix.
- Whitespace validation passed. Architecture description/seal and derived views were synchronized.

## Limits

No clean-machine full source build/start was performed in this change. The deployment path is
shared with the previously exercised CLI; that does not substitute for a fresh-machine acceptance
test. No inference, meeting, browser sign-in or physical audio acceptance test ran.

Setup does not install Python/Docker, native Desktop/Capture or ASR models, configure agent
subscription credentials, publish packages/images, or provide a cloud-hardened deployment.
Port/resource checks precede activation but do not reserve them against concurrent installers.
No production configuration, backend selection, container, image or data volume was changed.
