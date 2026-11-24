# Roadmap

## v1.1 - per-workspace proxy routing

The headline gap in 1.0. Each workspace will be routable through its own
SOCKS5/HTTP(S) proxy (`socks5://user:pass@host:port`), with:

- credentials stored encrypted alongside the vault
- a connection test that shows the exit IP per workspace
- a duplicate-IP warning when two workspaces share an exit address
- status dots on the sidebar tiles

The settings preview is already in the app (Workspace settings -> Network) so
the workflow is visible before the plumbing lands.

## Later

- Vault import (JSON) to pair with the existing export
- Per-workspace history management (search + clear ranges)
- Light theme
- Workspaces > 9: quick switcher (Ctrl+X style) and sidebar paging hints
- Optional per-workspace user-agent override

## Not planned

- CAPTCHA solving or bypassing - never
- Automated bulk account creation - the wizard stays a guided, human-paced
  flow
- Fingerprint spoofing (canvas, WebGL, fonts) - this is an account
  organizer, not an anti-detect toolkit
