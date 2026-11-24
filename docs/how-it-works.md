# How Pigeonhole works

A short technical walk-through of the moving parts, for contributors and the
curious.

## The stack

- **Electron 38 / Chromium 140** - the engine. Pages render exactly as in
  Chrome, including media codecs and Web APIs.
- **Zero runtime npm dependencies.** The chrome (the browser UI) is plain
  HTML/CSS/ES-module JavaScript; the main process is plain Node. `npm ls --prod`
  comes back empty.

## Workspaces are Chromium partitions

Every workspace is created as:

```
<webview partition="persist:ws-<id>" ...>
```

A `persist:` partition maps to an isolated profile directory under
`%APPDATA%/Pigeonhole/Partitions/ws-<id>` with its own cookie jar, disk cache,
localStorage, IndexedDB, service workers and HSTS list. Two workspaces can be
signed in to the same site simultaneously because they are, from the site's
point of view, two unrelated browsers on the same screen.

- **Deleting a workspace** clears the partition's storage through the session
  API and removes the profile directory from disk.
- **Tabs of inactive workspaces stay alive** (hidden webview elements keep
  running), but after an app restart webviews re-attach lazily - only when a
  workspace is first opened - so startup stays fast with many workspaces.

## The chrome renderer

`app/index.html` + `app/js/*.js` build the whole browser UI:

| Module | Responsibility |
| --- | --- |
| `tabs.js` | tab strip + webview lifecycle (partitions, nav events, error pages) |
| `sidebar.js` | numbered workspace tiles, column wrapping, collapse |
| `toolbar.js` | address bar, suggestions, find-in-page |
| `wizard.js` | the email onboarding state machine |
| `autofill.js` | the form detection / fill engine (page-world scripts) |
| `identity.js` | login/signup detection polling, offer bar, credential capture |
| `vault.js`, `modals.js` | vault drawer, settings and workspace dialogs |
| `updates.js` | toast/notification side of the self-updater |
| `state.js` | snapshot of the main-process state + a small event bus |

The renderer has **no Node access** (`contextIsolation` on, `nodeIntegration`
off). Everything it does goes through `preload.js`, which exposes a narrow
`window.pigeonhole` API over `ipcRenderer.invoke`.

## The form engine

`autofill.js` builds two page-world scripts as strings and runs them inside
the active webview with `webview.executeJavaScript` (which is not subject to
the page's CSP):

- **DETECT** walks all visible `input`/`select`/`textarea` elements, scores
  them into semantic slots (email, username, new/current password, confirm,
  first/last name, date-of-birth day/month/year, gender, security answer,
  terms checkbox) using label text, `name`/`id`, `autocomplete`, placeholder
  and ARIA attributes, and classifies the page as login or signup from the
  form's own text.
- **FILL** sets values the framework-safe way (the native `value` setter from
  the prototype + `input`/`change` events), picks date-of-birth and gender
  options in selects, splits an address into local part + domain select when
  the provider's form works that way, ticks terms boxes, and **never touches
  CAPTCHA fields**.

Provider mode (signup on an email provider) versus site mode (using the
workspace identity on any other site) differ only in which values go into
which slots.

## The internal protocol

`pigeonhole://newtab?ws=<id>` and `pigeonhole://error?...` are served by a
handler in the main process (`main/protocol.js`). The handler is registered on
the default session *and* on every workspace partition session - webviews do
not inherit the default session's protocol handlers. The new tab page is a
self-contained HTML file with the workspace's (non-secret) data injected at
serve time; page actions (navigate, open wizard, ...) travel back through a
small polled action queue instead of any privileged bridge.

## State and secrets

- One JSON document at `%APPDATA%/Pigeonhole/pigeonhole-store.json` holds
  workspaces, tabs, history, settings and the vault. Writes are debounced and
  atomic (write to `.tmp`, rename).
- Secrets (identity passwords, saved site passwords, the optional shared
  password) are encrypted at rest with Electron `safeStorage` - DPAPI on
  Windows. Where no OS keyring exists the values fall back to plain text and
  the UI says so plainly.
- The renderer only receives secrets through the explicit
  `ph:vault-secret` channel (reveal/copy); the state snapshot it gets for
  rendering never contains them.

## The self-updater

`main/updater.js` owns the whole flow; the renderer (`app/js/updates.js`)
only reacts to events and offers the two manual entry points.

- **Check:** a `GET` to `/releases/latest` on the GitHub API (Electron's
  `net` module, so the browser's proxy and certificate stack applies). The
  tag is semver-compared against `app.getVersion()`; a matching
  `Pigeonhole-x.y.z-win-x64.zip` release asset must exist.
- **Download:** streamed to `%TEMP%` with progress events - never buffered
  in memory. On completion a marker file
  (`%APPDATA%/Pigeonhole/pending-update.json`) records the zip and version,
  so a crash cannot lose the "an update is staged" fact. On the next boot the
  marker is reconciled: applied versions are cleaned up, stale-but-valid ones
  re-arm themselves.
- **Apply on quit:** `before-quit` hands the staged zip to a detached
  `cmd`/PowerShell helper that waits for the app's PID to exit, extracts the
  zip over the program folder with `Expand-Archive -Force` (five retries for
  antivirus locks), deletes the zip and - in the explicit *Restart & update*
  mode - relaunches `Pigeonhole.exe`. It logs to
  `%TEMP%\pigeonhole-update.log`.
- User data is untouched by construction: the program folder and
  `%APPDATA%/Pigeonhole` are disjoint, so an update is a pure file swap of
  the executable tree.

## Security posture

- `contextIsolation` everywhere, no Node in any renderer, no `remote`.
- A strict CSP on the chrome page (`script-src 'self'`, no inline handlers).
- Every IPC handler validates its inputs (workspace id pattern, http(s) URL
  checks, length caps); URLs from pages can only become new tabs, never
  privileged calls.
- `will-attach-webview` strips `preload`/node flags from webviews and
  enforces the `persist:ws-` partition pattern.
- `window.open` and `target=_blank` from pages open as **tabs in the same
  workspace**, never as free-floating windows.
- Internal pages carry their own restrictive CSP; data injected into the new
  tab page is escaped and page titles are stripped of markup before storage.

See also [privacy-security.md](privacy-security.md) for the user-facing story.
