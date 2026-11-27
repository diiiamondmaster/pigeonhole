# Troubleshooting

## An update did not apply

The updater only replaces the program folder and logs to
`%TEMP%\pigeonhole-update.log` - check it first. Common causes: no write
access to the folder the app lives in (move the app somewhere user-writable,
or extract the release zip over it by hand), antivirus locking files while
they are unpacked (the helper retries five times), or the download never
finished (quit and start the app again - it re-checks and re-downloads on
its own). Your data is never at risk in any of these: workspaces, vault and
settings live in `%APPDATA%/Pigeonhole`, which updates never touch.

## First launch shows a SmartScreen warning

The build is unsigned, so Windows shows "Windows protected your PC". Click
*More info* -> *Run anyway*. To avoid the warning entirely, build from source:
`npm install && npm run dist` on a Windows machine signs nothing either, but
locally built binaries are not flagged the same way.

## A page shows "This page could not be loaded"

The error page names the reason (name not resolved, timed out, certificate
problem, ...). The address bar keeps the failed URL - Try again reloads the
URL that actually failed. If it happens for every site, check the machine's
network/DNS.

## The wizard filled the form but the provider rejected the address

Usernames can be taken, and providers reserve some words. In the wizard,
click *Change identity*, adjust the address (or press *Next number*) and the
signup page refreshes with the new values; the domain choice stays yours.

## Autofill missed a field on a signup form

The engine matches fields by label text, name/ID, autocomplete and ARIA
attributes; some frameworks name fields nothing at all. Everything is still
editable by hand - the fill is a head start, not a lock-in. If a real-world
form fills wrong, an issue with the page URL (no credentials, please) helps
tune the heuristics.

## The offer bar ("Sign-in form detected") is annoying

Click **Ignore** once per page, or turn detection-driven offers off entirely
in Settings -> Onboarding. The *Fill identity* button in the toolbar always
stays available.

## I forgot a workspace password

Open the vault (key icon, top right), *Show password* on the identity card.
The vault export (Settings -> Data & privacy) writes everything to a
plain-text JSON file you can keep as a backup.

## Where is my data?

Settings -> Data & privacy -> *Open data folder* opens the app data directory
in Explorer. Deleting a workspace in its settings removes that workspace's
profile and vault entries from disk.

## Web pages are blank / GPU warnings in the console

Pigeonhole runs on the GPU stack Chromium picks; on very old graphics
drivers Chromium falls back to software rendering automatically. If pages
stay blank, start the app once with `Pigeonhole.exe --disable-gpu` to force
the fallback.

## My mail backup file did not land in the Downloads folder

That is the intended behaviour: downloads that look like mail backups
(Tuta containers, key/backup/restore/recovery exports) from a workspace
with a mailbox identity are stored with that workspace instead - see
workspace settings -> *Mail backup files*, where you can also open the
folder or rescan Downloads for older files. A file is only claimed when
its name ties it to a workspace (the mailbox address, or a
provider-specific extension with a single matching provider); anything
else stays in Downloads untouched.

## Pages are slow or a workspace keeps rotating exits

Auto (free pool) exits are community proxies, and their quality varies by
the hour. Pigeonhole continuously measures each exit (latency, a real
content check, throughput and your own page results) and swaps bad ones in
the background - if you see frequent *Exit replaced / Exit upgraded*
toasts, the pool around you is genuinely thin at the moment. Things to try:

- *Refresh the pool now* in Settings -> Network re-verifies everything and
  widens the candidate set.
- Pick a specific country in the workspace's Network section if a nearby
  region is thin (or *Nearby region only* if you never want far exits).
- Switch the workspace to *Direct* (your own IP) or *Custom* (your own
  proxy) when a workspace must stay reliably fast - the free pool is a
  convenience, not a service-level agreement.
- Check *usable / weak* counts in Settings -> Network: a large *weak* number
  means many candidates can ping but not carry pages right now; the app
  already refuses to assign those while real exits exist.
