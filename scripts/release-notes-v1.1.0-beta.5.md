# v1.1.0-beta.5

Email that just works, workspaces that stay tidy, and Google that stops
shouting at shared exits.

## Instant email addresses (the headline)

The wizard's first option is now **Get an instant address (automatic)**.
Pigeonhole creates a real, working mailbox over the free mail.tm API (with
mail.gw as automatic fallback):

- no CAPTCHA, no forms, no phone, nothing personal - one API call
- the address is saved as the workspace identity, so every fill button
  works on signup sites immediately
- the wizard shows a **live inbox**: verification mails appear as they
  arrive, expand to their text and links, and the links open in the
  workspace with one click; new mail pops a toast
- the API traffic goes out on Pigeonhole's own connection - **never through
  the workspace proxy** - so the mailbox keeps working exactly when proxied
  browsing is having a bad day

Powered by mail.tm (attribution shown in the wizard and the docs). Instant
addresses are disposable: perfect for site signups, use a real provider when
a mailbox must last years.

## Email providers re-researched (November 2026)

After beta feedback (Tuta deleting a fresh account inside 48h, mail.com
refusing the signup outright, others blocking shared IPs):

- **In: Atomic Mail** - nothing personal at signup (a first name, address,
  password), seed-phrase recovery, unlimited free storage, friendly to
  shared IPs
- **Out: mail.com and GMX** - both gate signup behind a phone number and
  refuse shared-exit signups
- **Tuta demoted with an honest warning** - VPN/proxy signups sit in a 48h+
  approval queue, and unused free accounts are deleted
- **Mailfence carries the shared-IP caveat** and the suggestion to sign up
  on a direct connection
- Proton Mail stays the recommended real provider
- All provider links re-verified; full notes in
  [docs/email-providers.md](../blob/beta/docs/email-providers.md)

## Workspaces that stay tidy

- **Numbering heals itself.** Deleting a workspace renumbers the rest to
  1..N immediately; the next workspace you create continues from N+1. No
  more "Workspace 7" when there are three.
- **Drag tiles to reorder.** Grab a tile, drop it anywhere - numbers update
  automatically (and so do Alt+N shortcuts). Right-click a tile for
  *Move up / Move down* if dragging is not your thing.

## New switch tracker

The old fading glow-trail and the proxy status dots are gone. Every tile now
carries a small bar on its right edge, in the workspace's own hue:

- the active workspace's bar is full and bright
- the tile you left fades one step for every workspace you switch through
  afterwards - recency at a glance, quiet by design

The active tile highlight now also follows every switch live. Toggle the
bars in Settings -> Appearance (*Recency switch bars*).

## Fullscreen, properly reachable

F11 works everywhere now - chrome focused or page focused - plus a
fullscreen button on the top bar and the classic View-menu entry.

## Google on shared exits (best effort)

- A new built-in **Google Consent Helper** extension auto-dismisses the
  "Before you continue" cookie wall on Google and YouTube pages (preferring
  *Reject all* - the search results work either way). Toggle it like every
  other extension.
- When Google serves the "unusual traffic" wall anyway, a pool-routed
  workspace **rotates its exit and retries once, automatically**, and says
  what it did; non-pool routes get the honest explanation with a pointer to
  the rotate control. No wall-dodging magic is claimed - this is the
  ergonomic version of what you would do by hand.

## Fixes

- Fixed a latent bug where the sidebar tile's active highlight did not
  follow a workspace switch (the highlight now moves live with the recency
  bar).
- Right-click context-menu items can now be disabled properly (used by
  Move up/Move down at the ends of the list).
- The wizard's provider list no longer mentions mail.com (whose signup page
  demands a phone and blocks many shared-IP visitors).

## For testers

- Instant-address flows are covered end-to-end against a mock mail.tm API
  (`scripts/test-beta5.mjs`: 25 checks), plus a live smoke against the real
  mail.tm service. All existing suites still pass: e2e 43, v105 20,
  inject 8, extensions 31, updater 17, pool 21 + 27.

**Full changelog:** [CHANGELOG.md](../blob/beta/CHANGELOG.md)
