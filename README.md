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

This checkout starts the configured `tina-production` deployment with Gipformer 1.5. On macOS,
start OrbStack or Docker Desktop first. You need Docker Engine 26+, Compose with `up --wait`, Python
3.10+, `make`, and the private Dotenvx key that matches this repository's encrypted config.

### 1. Clone the repository

```bash
git clone https://github.com/poor-frog/TINA-KT.git
cd TINA-KT
```

### 2. Install Dotenvx

On macOS, use the official Homebrew tap:

```bash
brew tap dotenvx/brew
brew trust dotenvx/brew
brew install dotenvx
```

Or install the CLI with npm: `npm install --global @dotenvx/dotenvx`.

### 3. Add the matching private key

Get the existing `.env.keys` file from your private password manager or secure backup and place it at
the repository root. It must contain the `DOTENV_PRIVATE_KEY` matching `deploy/compose/.env`. The
file is ignored by Git and must never be committed or pasted into documentation, shell commands, or
chat. A newly generated key will not decrypt this repository's config.

### 4. Install Gipformer model assets

```bash
python3 deploy/transcription/gipformer/install-models.py
```

The installer downloads and verifies the pinned Gipformer 1.5 and FSMN-VAD files into the ignored
`deploy/transcription/models/gipformer-fsmn` directory. The checked-in deployment config already
selects the `automation,asr,dashboard` profiles and points the bot at `http://gipformer:8000`.

### 5. Preview and start TINA

```bash
make plan     # read-only: confirm project and enabled profiles
make all      # build and start the configured stack; prints API key and URLs
```

`make all` uses the `tina-production` project and retains its database, recordings, and workspaces.
It starts Gipformer because the selected env enables the `asr` profile and supplies its endpoint and
token. The current local ports are Terminal `23000`, API gateway `28056`, and Gipformer health
`18002`.

Open Terminal after the command reports ready:

```text
  Terminal UI : http://127.0.0.1:23000
  API gateway : http://127.0.0.1:28056
```

Google OAuth credentials are already in the encrypted deployment config; on an empty database, the
first successful sign-in becomes administrator. Keep the API key printed by `make all` private.

This is the existing `tina-production` deployment, not a clean-install recipe. If you do not have
its matching private key, ask the owner for it through a secure channel. To create a separate local
instance with new volumes instead, follow the [fresh-install guide](deploy/compose/bin/README.md#first-installation-cli-040).
See the [Gipformer setup guide](deploy/transcription/gipformer/README.md) for model and service details.

