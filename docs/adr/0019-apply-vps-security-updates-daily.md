# ADR-0019: Apply VPS security updates daily and reboot when required

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The service runs unattended on the Ubuntu 24.04 VPS, so security updates and reboots happen without a person. The VPS clock zone is Europe/Berlin.
- **Decision:**
  - `unattended-upgrades` applies Ubuntu security updates daily. `/etc/apt/apt.conf.d/51unattended-upgrades-local` adds the origins `LP-PPA-git-core` and `Tailscale`.
  - The systemd timer `reboot-if-required.timer` (`OnCalendar=*-*-* 01:00:00 America/Sao_Paulo`) reboots the VPS only when `/run/reboot-required` exists. The timer carries its own zone, so it fires at 01:00 Brasília time all year.
  - Bun is excluded from automatic upgrades, because it follows the repo pin ([ADR-0009](0009-pin-dependencies-and-bun-exactly.md)).
- **Consequences:** A required reboot restarts the service, which starts at boot ([ADR-0007](0007-restart-on-failure-and-env-file-key.md)). Bun changes only through the [Bun upgrade process](../coding-standards.md#dependencies).
