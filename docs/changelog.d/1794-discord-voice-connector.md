- **Discord voice channels are a join target.** `POST /bots` now accepts `platform: "discord"` with
  a `https://discord.com/channels/<server>/<channel>` link (a bare `<server>:<channel>` id also
  works), joins the voice channel, and publishes a per-speaker transcript through the same live and
  durable transcript feeds as every other platform — Discord delivers one audio stream per person,
  so speakers are labelled by name with no diarization. Enable it by running the connector with
  `docker compose --profile discord` and a `DISCORD_BOT_TOKEN` (the bot needs the privileged
  **Server Members Intent**, plus View Channels / Connect / Speak permissions), or
  `discordConnector.enabled=true` on Helm. The bot is visible in the member list: tell participants
  it is there. Recording and speaking are not available for Discord yet — asking for
  `recording_enabled` is refused, and an inherited calendar/auto-join recording policy joins
  transcript-only. See `docs/adr/0039-discord-is-a-long-lived-connector-behind-runtime-v1.md` and
  the connector README.
