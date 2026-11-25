# Changelog

## 1.0.4 - 2026-11-25

The "1.0.3 does not start" fix.

- **Fixed the launch failure.** The 1.0.3 zip shipped a malformed `app.asar`
  archive container: the header was written by a hand-rolled packer instead
  of the official asar tool, and Electron rejects it on load - the exe
  double-clicks to nothing, with no window and no error. (Not a code bug:
  the 1.0.3 app code never even started.) The archive is now packed with
  the official `@electron/asar` tool, and every build must boot the archive
  under a real Electron runtime before it can ship.
- Everything from 1.0.3 is included unchanged: self-update, the autofill
  fixes, tab reordering.

## 1.0.3 - 2026-11-25

The update that updates itself. Pigeonhole now pulls new versions from GitHub
Releases on its own and applies them without touching user data.

- **Self-update.** On startup the app checks the GitHub Releases feed in the
  background; a newer build is downloaded silently into the temp folder and
  installs itself when you quit (or immediately via *Restart & update* -
  tabs and workspaces come back exactly as they were). Manual checks: Settings
  → About and Help → *Check for updates…*.
- **Data safety by design.** Only the program folder is replaced; workspaces,
  vault, tabs and settings live in the separate app-data folder and are
  picked up untouched. Interrupted updates are noticed and re-downloaded on
  the next launch.
- The one background network call (api.github.com) is now disclosed in the
  privacy notes; everything else stays local-first.
- Updater E2E suite added (`scripts/test-updater.mjs`, 11 checks against a
  mock GitHub API).

## 1.0.2 - 2026-11-24

The autofill and usability release.

- **Autofill now actually works on real providers.** Plan-picker screens
  (Tuta, Proton) no longer stall the engine; each step is filled as it
  appears; attempts that filled nothing no longer burn the budget.
- **Harder signup forms read correctly.** Shadow DOM and same-origin iframes
  are scanned; aria-label-only username boxes, plain-text consent checkboxes
  and set+repeat password pairs (Tuta's exact structure) are handled.
- **Tuta's domain list corrected** to the live signup page (six domains,
  `@tutamail.com` back on the menu) and the custom domain dropdown is now
  operated automatically.
- **Tab reordering:** drag tabs, or right-click for Move left / Move right;
  order persists across restarts.
- Offer-bar null button and stale-snapshot wizard no-ops fixed; E2E suite
  rebuilt to 43 checks.

## 1.0.1 - 2026-11-24

- Fixed the new-workspace wizard getting stuck at the email provider step.
- Fill-again always runs and reports what it did.

## 1.0.0 - 2026-11-24

First public release.

- Numbered, color-coded workspace tiles in a collapsible sidebar that wraps
  into new columns; every workspace is a fully isolated Chromium profile
  (cookies, cache, localStorage, IndexedDB, service workers).
- Tabs per workspace, address bar with search + history suggestions,
  find-in-page, downloads, custom right-click menus, styled network error
  pages, per-workspace new tab pages.
- Email onboarding wizard: provider comparison table (no-phone providers
  first), numbered identity generator (base handle + auto-increment with
  zero padding; human-name and word-pair styles), shared / generated /
  custom passwords, guided signup with live form autofill and signup
  completion detection.
- Form engine: heuristic field discovery with framework-safe value setting;
  provider mode splits addresses into local part + domain select; never
  touches CAPTCHAs.
- Per-workspace identity fill on detected login/signup forms; save-on-submit
  capture into a per-workspace vault; vault export (plain text, warned).
- Secrets encrypted at rest with the OS credential store (safeStorage);
  graceful plain-text fallback with a visible warning.
- Local-first: no telemetry, no accounts, no background network requests.
- Windows portable build (extract and run); per-workspace proxy routing is
  previewed in settings and arrives in v1.1.
