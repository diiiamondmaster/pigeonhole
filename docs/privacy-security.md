# Privacy & security

## What is stored, and where

Everything Pigeonhole knows lives on this computer, inside the app data
folder (`%APPDATA%/Pigeonhole` on Windows):

| Data | Location | Notes |
| --- | --- | --- |
| Workspaces, tabs, history, settings | `pigeonhole-store.json` | one JSON document, atomic writes |
| Browsing profiles (cookies, cache, storage) | `Partitions/ws-*` | one directory per workspace; deleted with it |
| Vault secrets (mailbox + site passwords) | inside the state file | encrypted with the OS credential store (DPAPI on Windows) via Electron `safeStorage` |

If the OS credential store is unavailable, the vault falls back to plain text
and the app tells you so in the vault panel and in Settings.

## What Pigeonhole does not do

- **No telemetry, no analytics, no crash reporting.** The app makes no
  network requests of its own - the only traffic is the pages you visit.
- **No account, no cloud sync.** Nothing leaves the machine.
- **No bundled ad-block or script injection.** Pages render with stock
  Chromium behaviour; the only code Pigeonhole runs in a page is the form
  fill you trigger (or approve) during onboarding.

## The vault

- Passwords are fetched from the main process only on demand (reveal/copy),
  never shipped with the rendering state.
- The vault can be exported to plain-text JSON (Settings -> Data & privacy)
  for backup or migration - the export warns loudly, because it contains
  passwords in the clear.
- Deleting a workspace deletes its vault entries and its browsing profile.

## Reporting a security issue

Please open a GitHub issue marked *security* (or contact the maintainer
directly if you prefer); include reproduction steps. Reports are appreciated
and credited.
