# Changelog

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
