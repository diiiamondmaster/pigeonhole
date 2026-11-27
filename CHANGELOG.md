# Changelog

## 1.2.0-beta.1 - 2026-11-27 (beta channel)

The beta.7 build, from the user-picked feature list - plus the sync engine
that was the custom request.

- **Cross-device sync, never backwards.** A sealed bundle (workspaces,
  identities, vault passwords, tabs, history, mail backups, settings) is
  written to a folder of your choosing and merged from it on every device.
  Per-workspace last-writer-wins + deletion tombstones mean older snapshots
  can never roll back newer data - importing a stale bundle is a no-op by
  construction. One-off export/import (full or single-workspace) rides the
  same machinery. Settings → Sync.
- **Ctrl+K tab switcher** across every workspace, jump straight to the hit.
- **Ctrl+Tab workspace cycler** (MRU order, commit-after-pause) and
  **Ctrl+1..9** tile jumps. In-workspace tab cycling moved to
  Ctrl+PageUp/PageDown.
- **Undo close tab** (Ctrl+Shift+T) with a per-workspace recently-closed
  list in the tab menu.
- **Pinned tabs**: compact, persisted, exempt from "close others".
- **Duplicate workspace**: tabs, route and group carry over; a fresh
  identity is pre-armed in the wizard on the same provider.
- **Workspace groups** in the sidebar: named, collapsible sections; file
  tiles by drag or right-click.
- **App lock**: Ctrl+Shift+L PIN lock (scrypt-hashed), idle auto-lock and
  lock-on-minimize options, unlock in place.
- **Reader view** (Ctrl+Alt+R) and **picture-in-picture** (Ctrl+Alt+P) via
  the page right-click menu.
- **Traffic meter**: approximate per-workspace byte counters in the status
  bar and network menu.
- Fixed a latent tab-persistence bug: a change in workspace B could cancel
  workspace A's still-pending tab save (shared debounce timer) - saves are
  now per-workspace.
- 207 E2E checks green (new beta.7 suite: 35 checks covering every feature
  above, including a live peer-bundle merge proving older data never wins).

## 1.1.0 - 2026-11-27 (stable)

The whole 1.1.0 line, promoted from six beta rounds to the main update
channel. From 1.0.6, in one update:

- **Per-workspace proxy routing, automatic.** Free community proxy pool with
  verification, scoring and proactive failover; or bring your own
  SOCKS5/HTTP proxy per workspace. Browsing never silently degrades.
- **Built-in extensions.** Video Speed Control, Ad Shield with levels and
  per-site pause, spell check, quick panel.
- **Email that asks for nothing personal.** The wizard walks a no-phone
  provider signup (Atomic Mail by default), generates the identity, fills
  the form; Google consent walls and unusual-traffic walls are handled
  automatically. The beta.5 disposable-address experiment was removed again
  in beta.6 - real providers only.
- **Mail backups, captured per workspace.** Backup/recovery files from your
  mail providers are recognized on download, kept out of the Downloads
  folder and stored with the workspace that owns the mailbox, including a
  legacy sweep of existing Downloads files.
- **The chrome polished.** Fullscreen that actually fills the window; the
  statusbar flush with the bottom at every zoom; a reload button that
  retries the page you wanted, not the error page; workspace trails that
  shrink and fade with your switching history - and whose length follows
  the workspace count (short trails for few workspaces, since you cannot
  be far "back" anyway); drag-to-reorder tiles with self-healing numbers.
- **The exe has its icon back.** Every zip since the build moved to the
  manual reproducible script shipped with Electron's generic icon - the
  amber pigeonhole mark and a proper version stamp are embedded into
  Pigeonhole.exe again.
- Plus: live-applied settings, page-result feedback for seamless proxy
  rotation, update self-service with staged downloads, and a 172-check
  E2E battery over the whole stack.

## 1.1.0-beta.6 - 2026-11-27 (beta channel)

Fixes for the beta feedback that piled up: the disposable-email experiment is
gone (real providers only, Atomic Mail by default), fullscreen actually
works, the bottom of the window sits where it should, the reload button
reloads the page you wanted, workspace trails shrink as well as fade, and
mail backup files now file themselves.

- **Instant addresses removed.** The mail.tm / mail.gw disposable-mailbox
  system is gone entirely (client, IPC, wizard flow, store records). Its
  domains are on the disposable-address blocklists the big sites use, so
  accounts built on them got refused exactly when it mattered - a
  disposable mailbox defeats the point of having one. The wizard is back to
  real providers only, with **Atomic Mail preselected** as the default:
  no phone, nothing personal, seed-phrase recovery, tolerant of shared
  exits. (The provider registry keeps Proton, Mailfence and Tuta; the
  disposable record on existing workspaces is dropped on load and the
  identity email/password you saved stay.)
- **Fullscreen fixed.** A page going fullscreen (video, slides, games) used
  to stay boxed inside the content area - Chromium only sizes the guest to
  the webview element, and the chrome-hiding rules for the page-fullscreen
  state never existed. They do now: entering page fullscreen steps the whole
  chrome aside and the page takes the entire window; leaving restores the
  exact layout. F11 / the toolbar button / the View menu all still toggle
  window fullscreen.
- **The window bottom is flush again.** With Settings -> Appearance set to
  Compact or Large, the chrome is CSS-zoomed 90%/110% - but `100vh` does not
  scale with zoom, so the statusbar floated 10% above the window bottom (or
  was clipped off-screen). The app height is now compensated for the zoom
  factor, and appearance changes apply live (the settings IPC now notifies
  the chrome).
- **The reload button works after an error.** A failed load parks the tab on
  the internal error page, and the reload button was reloading that error
  page - endlessly. It now parses the failed URL back out of the error page
  and reloads the page you actually wanted.
- **Recency trails, Opera-GX style.** The bar on each workspace tile still
  marks where you have been, but now it SHRINKS as well as fades: the
  workspace you used last carries a tall bright bar in its hue, and every
  workspace you switch through after that makes it one step shorter and more
  transparent until it disappears.
- **Mail backup files, captured per workspace.** No-phone providers hand out
  backup and recovery files (Tuta's export container, key/seed exports).
  Pigeonhole now recognizes a backup-looking download in a workspace with a
  mail identity, keeps it out of the Downloads folder, and stores it with
  that workspace (workspace settings -> *Mail backup files*, with show-in-
  folder and a manual rescan). On boot the Downloads folder is swept for
  legacy backups: files whose name ties them to exactly one current
  workspace identity are imported (marked "from Downloads"); anything that
  matches nothing - or several - is left untouched. Deleting a workspace
  removes its backups with it.
- **Bug fixes found along the way:** settings changes now apply immediately
  instead of silently waiting for a restart (settings IPC sends state
  changes); externally created workspaces render their sidebar tile right
  away; the wizard's provider step preselects cleanly.
- E2E: new `scripts/test-beta6.mjs` (42 checks) covering the Atomic default,
  the removal, the reload-after-error retry (flaky server), window-bottom
  geometry at every zoom, the trail shrink/fade ladders, both fullscreen
  modes, live backup capture (by provider host and by address), the legacy
  Downloads sweep with left-behind files, backup lifecycle, renumber/
  reorder/drag, gconsent and the guided-flow regression. The beta.5 suite
  (built around the removed instant flow) is retired; all other suites pass
  unchanged: pool 27+21, UI 43, v1.0.5 20, updater 17.

## 1.1.0-beta.5 - 2026-11-27 (beta channel)

Email that just works, workspaces that stay tidy, and Google that stops
getting in the way. The headline: you no longer have to fight any provider's
signup form - the wizard can create a real mailbox for you, automatically.

- **Instant addresses (mail.tm / mail.gw).** A new first choice in the email
  wizard: *Get an instant address (automatic)*. One API call creates a real
  working mailbox - no CAPTCHA, no forms, no phone, no personal data - and
  saves it as the workspace identity. The wizard then shows a **live inbox**:
  verification mails appear as they arrive, each one expands to its text and
  links, and links open in the workspace with one click. A new mail pops a
  toast. The API traffic goes out on Pigeonhole's own connection - never
  through the workspace proxy - so the mailbox keeps working exactly when
  proxied browsing is having a bad day. Powered by the free mail.tm service
  (mail.gw fallback), with attribution shown in the wizard and the docs.
- **Email providers re-researched and fixed (November 2026).** mail.com and
  GMX are out: both gate signup behind a phone number, and both are hostile
  to shared/proxy IPs. **Atomic Mail** is in: nothing personal at signup
  (name, address, password), seed-phrase recovery, unlimited free storage.
  Tuta is demoted with an honest warning - VPN/proxy signups sit in a 48h+
  approval queue and unused free accounts get deleted - and Mailfence carries
  the shared-IP warning. Proton stays the recommended real provider. All
  provider links re-verified.
- **Workspace numbering that heals itself.** Deleting a workspace renumbers
  the rest (1..N) immediately - no more "Workspace 7" when there are three.
  Creating after a delete continues from N+1.
- **Drag to reorder workspaces.** Grab any tile and drop it where you want
  it - numbers update automatically, as do Alt+N shortcuts and the sidebar
  order. Right-click a tile for *Move up / Move down* if dragging is not
  your thing.
- **New switch tracker.** The old glow-trail and status dots are gone. Every
  tile now carries a small bar on its right edge: full and bright on the
  active workspace (its own hue), fading one step for every workspace you
  switch through after leaving it - recency at a glance, quiet by design.
  Toggle in Settings -> Appearance (*Recency switch bars*).
- **Fullscreen, properly reachable.** F11 works everywhere now - chrome
  focused or page focused - plus a fullscreen button on the top bar and the
  classic View-menu entry. One keystroke, one click, same action.
- **Google stops shouting at shared exits (best effort).** A new built-in
  *Google Consent Helper* extension auto-dismisses the "Before you continue"
  cookie wall on Google and YouTube pages (clicking *Reject all* - the search
  results work either way). When Google serves the "unusual traffic" wall
  anyway, a pool-routed workspace rotates its exit and retries once,
  automatically, and tells you what it did; non-pool routes get the honest
  explanation with a pointer to the rotate control. No wall-dodging magic is
  claimed - this is the ergonomic version of what you would do by hand.

## 1.1.0-beta.4 - 2026-11-27 (beta channel)

The proxy pool grows up: exits are now chosen for real-world quality, watched
continuously, and swapped in the background without reloading your pages.
This is the answer to the beta feedback that exits were far away, slow, and
unreliable in actual browsing.

- **Two-tier verification.** A 204 ping only proves a proxy can answer one
  empty request. Candidates that pass it now face a *real-content check*: a
  genuine page fetch through the candidate (Cloudflare's trace endpoint by
  default), status 200 with real body bytes and working TLS. Exits that can
  only ping - the classic "fast but useless" open proxies - are marked
  **weak**, ranked last, and never assigned while a content-verified exit
  exists.
- **Quality scoring.** Every exit carries a living score (0-100+): EWMA
  latency across repeated checks, probe success history, how many refresh
  cycles it survived, measured throughput on assigned exits, and a
  real-content bonus. Assignments and rotations order by score, not by a
  single ping.
- **Geographic proximity.** Your own country is detected once a day (direct
  connection, never through a proxy) and same-country exits score +18,
  same-region +8 - so a nearby exit wins over a far one unless the far one
  is dramatically faster. The region selector gains *Smart pick (fastest +
  nearby)* and *Nearby region only*; an exact country still pins the exit.
- **The supervisor (continuous monitoring).** Every ~45s the pool re-probes
  every ASSIGNED exit plus the top standbys: latency, real-content,
  throughput, and - new - your actual page loads feed the score (every
  workspace reports load success/failure). Two consecutive failed probes, a
  broken content check, sustained page failures, or a bandwidth-starved exit
  trigger a swap.
- **Seamless transitions.** Supervisor swaps apply the new route to the
  session *without reloading any page*: already-rendered pages keep working,
  new requests leave through the better exit. A dead exit is replaced
  proactively - typically before any tab notices. When a swap happens on the
  active workspace you get a quiet toast (*Exit replaced automatically* /
  *Exit upgraded*); nothing else disturbs browsing. The reactive
  page-error watchdog stays as the last line of defence.
- **No churn without a payoff.** Quality upgrades need a free standby that
  beats the current exit by a clear margin plus an anti-flap cooldown; dead
  exits swap immediately (sharing an exit beats none). If the network itself
  is down - or a check target is - the supervisor skips the sweep rather
  than blaming the exits.
- **Wider, faster pool.** Three more public sources (Proxifly, mmpx12,
  roosterkid - free, key-less) join monosans/Geonode/ProxyScrape/TheSpeedX
  for better odds of a nearby fast exit; checks run 12-wide with tighter
  timeouts. Pool state (scores, history, your detected country) persists to
  the existing disk cache, and restored entries must re-probe alive before
  they are assignable again.
- **Settings reflect all of it.** Settings -> Network and the workspace
  Network panel now show ready/weak counts, monitoring cadence and this
  session's auto-swap count, and your detected country.
- E2E: new 21-check suite (`scripts/test-pool2.mjs`) against engineered
  fakes - a "ghost" proxy that only answers pings (never assigned, reported
  weak), a "liar" that answers every check but breaks real pages (page
  feedback degrades it, no churn without a better exit, upgrade when one
  appears), proximity ranking (nearby beats far-faster), and a proactive
  failover that provably does not reload the open page (frozen hit counter)
  while new pages work through the replacement. The original 27-check pool
  suite, the 43-check UI suite, the 20-check v1.0.5 suite and the 17-check
  updater suite all still pass.

## 1.1.0-beta.3 - 2026-11-26 (beta channel)

The free proxy pool: workspaces can exit through community proxies without
you owning one, automatically.

- **New: free proxy pool.** Pigeonhole fetches public community proxy lists
  (monosans, Geonode, ProxyScrape, TheSpeedX - free, no accounts), then
  health-checks every candidate by actually routing a probe through it. Only
  verified exits - proven TLS-capable - enter the pool, ranked by measured
  latency, with country enrichment. The pool refreshes itself in the
  background and caches to disk.
- **Automatic exits.** New workspaces get a pool exit the moment they are
  created (one click to turn off in Settings -> Network). On upgrading to
  this beta, workspaces that never had a proxy at all are routed once,
  automatically, with a notice. *Settings -> Network* can also route every
  workspace at once and shows live pool status.
- **Workspace modes.** The Network section of workspace settings becomes
  *Direct / Auto (free pool) / Custom*: Auto shows the live exit (country,
  address, latency), a *New exit* button, region preference, and the exit-IP
  test. The top bar chip reads *Auto* with the exit's country; the status
  bar spells out the auto-exit route.
- **Self-healing.** A pool exit that dies mid-session (proxy errors on a
  page) is rotated automatically and the page reloads - reliability comes
  from rotation, not from any single open proxy. Refresh drops dead exits
  from the verified pool.
- **Credentialed community proxies work**: the health check counts a 407
  challenge as "alive", and page traffic then authenticates through the
  encrypted store via Electron's login flow (E2E-proven). Chromium refuses
  credentialed SOCKS5 (it never offers the auth method), so those entries
  are skipped at parse time.
- **Honest limits.** Community exits are run by volunteers: HTTPS stays
  end-to-end encrypted, but the operator sees plain-HTTP traffic and the
  exit IP is theirs. Speed varies; the pool always prefers the fastest
  verified exits and *Test exit IP* proves what you actually got.
- E2E: 27-check pool suite against local fake SOCKS5/HTTP proxies (boot
  auto-enable, distinct exits, dead-candidate filtering, transit proofs,
  credentialed auth, rotation, auto-heal, mode switching, bulk); live smoke
  test against the real public sources (260 candidates fetched, 36 verified,
  17 countries, real exit-IP change confirmed).

## 1.1.0-beta.2 - 2026-11-26 (beta channel)

The beta that makes the 1.1 line visible: proxies are now impossible to
miss, the extension panel lives one click away, two more extensions ship
(Video Speed and Ad Shield), and the chrome itself gets Appearance settings.

- **Proxy routing, discoverable at last.** The top-bar *Direct/Proxy* chip
  and the status-bar route are now clickable menus with **Test exit IP** -
  it fetches an IP service through the workspace's own connection and shows
  the answer with the route it took, so you can prove the exit without
  guesswork. The top-bar workspace chip opens its settings, workspace tiles
  get a small dot when routed, the sidebar tooltip names the exit, and
  saving a proxy that another workspace already uses raises a
  duplicate-exit warning (they would share an IP). The workspace-settings
  Network section carries a *Test exit IP* button too. Every proxy entry
  point - the workspace chip, the net menu, and the tile right-click menu's
  new *Route through a proxy…* item - opens the settings already scrolled to
  the Network section with a short highlight, so the toggle is in view
  immediately.
- **Extensions, one click away.** A puzzle button in the top bar (or
  Ctrl+Shift+E) opens a quick panel: live toggles for every extension, the
  Ad Shield level presets, a per-site pause for the page you are on, and
  the session's blocked-ads count. Settings → Extensions keeps the full
  cards.
- **New extension: Video Speed.** A built-in Video Speed Controller:
  hover any video for the speed badge and controller (S slower, D faster,
  R reset, V show/hide, Z/X seek ±10s, G remembers a speed for that site).
  Works in every workspace, remembers per-site speeds inside each
  workspace's own profile.
- **New extension: Ad Shield.** Ad blocking with levels and a visible
  counter. *Basic* blocks tracking beacons; *Standard* removes common ad
  networks and (best effort) YouTube ad slots; *Strict* adds aggressive
  URL-pattern blocking plus cosmetic hiding. Per-page control from the
  right-click menu or the shield button; the toolbar shield shows the
  blocked count and the status bar surfaces it when non-zero.
- **History Guard removed.** The 1.1.0-beta.1 experiment is gone - history
  just works as it did before.
- **Appearance settings.** Settings → Appearance: interface scale
  (compact/normal/large), workspace tile size (small/normal/large), and the
  workspace-switch animation toggle.
- **Clearer active workspace.** A hue line under the top bar in the active
  workspace's colour, brighter active tile, and a fading switch trail on
  the tile you leave (Opera GX style; can be turned off in Appearance).
- E2E coverage: proxy routing proofs against a real local proxy (including
  the exit-IP channel), the injection suite for Video Speed / Ad Shield,
  and the extension config surface.

## 1.1.0-beta.1 - 2026-11-26 (beta channel)

The 1.1 line opens: proxy routing, the extension system, and spell check. This
is a beta: install it by turning on *Beta updates* in Settings → About.

- **Per-workspace proxy routing.** Every workspace can now exit through its
  own SOCKS5 or HTTP proxy: workspace settings → Network → *Route this
  workspace through a proxy*. Credentials are optional and stored encrypted
  like the vault; a bypass list is supported. Routing applies the moment you
  save (the open tab reloads through the new path) and survives restarts. The
  top bar and status bar show each workspace's route — a proxy-routed
  workspace gets its own exit IP, so accounts no longer share one.
- **Built-in extensions.** A new Settings → Extensions panel lists the
  features that ship inside the app; each has its own on/off switch, takes
  effect immediately and applies to every workspace. Three ship in this beta:
  - **Spell Check** (on by default): misspelled words are underlined in text
    boxes, and the right-click menu offers corrections plus *Add to
    dictionary* — in web pages and in Pigeonhole's own inputs.
  - **Tracker Shield** (on by default): blocks a conservative built-in list
    of analytics/ad beacons in every workspace. Login SDKs are never blocked.
  - **History Guard** (off by default): stops recording page visits into
    per-workspace history; the address bar and new-tab page stop suggesting
    them. Nothing already stored is deleted.
- Everything from 1.0.6 is included: the beta-updates toggle and prerelease
  semver ordering in the updater.

## 1.0.6 - 2026-11-26

The beta channel.

- **Beta updates toggle.** Settings → About now carries a "Beta updates"
  switch right next to "Check for updates". With it on, the updater includes
  releases marked as pre-release on GitHub (versions like `v1.1.0-beta.1`),
  so you can ride the 1.1 line before it goes stable. Turn it off any time
  and the next check settles back on stable releases.
- **Version comparison now understands pre-release tags.** The updater's
  version check was plain `1.2.3` numeric ordering; it now follows full
  semver ordering (`1.1.0-beta.1 > 1.0.6`, `1.1.0-beta.2 > 1.1.0-beta.1`,
  `1.1.0 > 1.1.0-beta.1`), and release assets like
  `Pigeonhole-1.1.0-beta.1-win-x64.zip` are recognized. Toasts say which
  channel an update came from.
- Everything from 1.0.5 is included unchanged.

## 1.0.5 - 2026-11-26

Wizard ergonomics and a sign-in offer.

- **The setup wizard no longer covers the signup form.** The wizard / vault
  panel used to float over the right edge of the page, hiding whatever the
  site put there (plan pickers, dropdowns, password fields) until you
  dismissed it. An open panel now reserves space: the page squeezes to the
  panel's left, so every select and input stays visible the whole way
  through a signup. Nothing to dismiss.
- **A sign-in popup.** When a site (or Google) shows a sign-in form and the
  workspace has an identity, a small pill floats over the page — "Sign in as
  <email>?" — with one-click *Fill & sign in*. No more hunting the toolbar
  button on every page. Dismissing it only sticks for that page: a fresh
  page always gets a fresh offer.
- **The workspace sidebar is exactly as wide as its tiles.** It used to
  carry ~27px of slack on every wrap column and never shrank back after
  workspaces were removed. It is now measured to the pixel from the tiles
  themselves. Collapsing the sidebar also works with a fitted width again
  (an inline-width bug let it linger open).

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
