# Roadmap

## v1.1 - per-workspace proxy routing + extensions

**In the 1.1.0-beta.1 pre-release (beta channel):**

- per-workspace SOCKS5/HTTP proxy routing with optional credentials (stored
  encrypted alongside the vault) and a bypass list
- the built-in extension system (Settings → Extensions) with three
  individually manageable extensions: Spell Check, Tracker Shield, History
  Guard

**Still planned for the v1.1 line:**

- a connection test that shows the exit IP per workspace
- a duplicate-IP warning when two workspaces share an exit address
- status dots on the sidebar tiles

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
