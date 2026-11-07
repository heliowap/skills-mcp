# ADR-0007: Restart on failure, start at boot, and keep the key in an env file

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The service must come back after a crash and after a reboot. The decision-model key must stay out of the config file.
- **Decision:** The systemd unit uses `Restart=on-failure` and starts at boot. The decision-model key sits in an env file with mode 600, owned by `helio`, read through `EnvironmentFile`.
- **Consequences:** A missing or misnamed env file is silent, and the server starts without a decision model. If the listen address does not exist yet at boot, the bind fails and the unit retries every 5 seconds ([README, Run as a service](../../README.md#install-and-run)).
