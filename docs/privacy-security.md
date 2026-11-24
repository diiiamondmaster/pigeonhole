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

- **No telemetry, no analytics, no crash reporting.** The app makes two
  kinds of network requests of its own: none while you browse - the only
  traffic is the pages you visit - plus the built-in updater, which calls
  `api.github.com` once per launch to look for a newer release (and, when
  one exists, downloads it from GitHub's CDN). Nothing is sent along with
  the check: no identifier, no usage data, nothing about your workspaces.
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

## The updater, exactly

- **What it touches:** the program folder (where `Pigeonhole.exe` lives)
  only. An update downloads into the OS temp folder and extracts over the
  program folder after the app exits.
- **What it never touches:** `%APPDATA%/Pigeonhole` - the state file with
  workspaces, tabs, settings and the vault, and the per-workspace `Partitions`
  profiles. The new build picks all of it up as-is.
- **What it reports:** the check is a plain `GET` to
  `api.github.com/repos/diiiamondmaster/pigeonhole/releases/latest` with a
  `pigeonhole-updater` user agent. If you would rather block it, firewall
  the app or point `PH_UPDATE_API` nowhere - the app runs fine offline and
  never treats a failed check as an error you must see (manual checks do
  surface it).

## Reporting a security issue

Please open a GitHub issue marked *security* (or contact the maintainer
directly if you prefer); include reproduction steps. Reports are appreciated
and credited.
