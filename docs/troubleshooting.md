# Troubleshooting

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
