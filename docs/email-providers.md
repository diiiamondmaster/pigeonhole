# Email providers - what signup actually asks for

Checked **November 2026** (re-researched after beta feedback). Signup
requirements drift over time; the wizard shows this same table before every
setup so the choice stays yours. If any detail here has changed, a PR or
issue is welcome.

## The two ways to get a mailbox in Pigeonhole

1. **Guided signup (the default)** - Pigeonhole preselects **Atomic Mail**
   and generates the identity; it types the signup form while you solve the
   human check. Any provider below works - the registry just starts with the
   one that asks for the least.
2. **Existing mailbox** - connect an address you already own.

> The beta.5 "instant address" mode (disposable mailboxes through the free
> mail.tm / mail.gw API) is **removed in beta.6**: their domains sit on the
> same disposable-address blocklists the big sites use, so accounts built on
> them were being refused exactly when it mattered. A real provider is the
> only address worth keeping.

## Guided-signup providers

| Provider | Phone number | Human check | Free tier | Notes |
| --- | --- | --- | --- | --- |
| **Atomic Mail** (atomicmail.io) - **the wizard default** | Not required | picture puzzle, sometimes | Unlimited storage, 10 aliases | Asks for a first name, the address and a password - nothing else. Recovery is a 12-word seed phrase you must save yourself. Works well from shared IPs - the reason it is preselected. |
| **Proton Mail** (proton.me) | Not required | CAPTCHA or alternate email | 1 address, up to 1 GB, 150 messages/day | Swiss, running since 2014. Pick the *Free* plan; recovery email/phone are optional - skip them to keep accounts unlinked. The most reliable pick through the proxy pool. |
| **Mailfence** (mailfence.com) | Not required | CAPTCHA (recovery email optional) | Free base plan, OpenPGP | Belgian, since 2013. Signups coming from shared/proxy IPs are sometimes refused - turn the workspace's proxy off for the signup. |
| **Tuta** (tuta.com) | Not required | CAPTCHA | 1 GB storage | German (formerly Tutanota). **Signups made through VPN/proxy exits are put in an approval queue ("up to 48 hours", often longer), and free accounts that sit unused are deleted.** Prefer it on a direct connection only. |

## Providers deliberately not offered

- **GMX** - registration requires a mobile number (their own support page:
  "Registration without a mobile phone number is not possible"), and signups
  from IPs outside their served countries are refused with a geo-error.
- **mail.com** - the signup form asks for a cell number and recent user
  reports say it is mandatory; beta testers were additionally blocked from
  even opening the form behind shared exits.
- **Yandex, Yahoo, Outlook.com** - phone verification is the norm there;
  Outlook also locks new accounts that "look unusual" (which every shared
  exit does).

## Why these picks

The goal is a mailbox you can actually create several of:

1. **No phone verification** - a phone number links accounts together better
  than any cookie ever will.
2. **A tolerable human check** - a CAPTCHA you solve by hand is fine; an SMS
  code is not.
3. **No dependence on your IP being clean** - Tuta queues proxy signups for
  48h+, Mailfence sometimes refuses them, mail.com/GMX hard-block. Proton and
  Atomic Mail have no such wall.

## Backup and recovery files

No-phone providers hand you recovery material at signup (Tuta's backup
container, Atomic Mail's seed phrase) and later on export. Pigeonhole now
captures download-like backups automatically and keeps them with the
workspace that owns the mailbox (workspace settings -> *Mail backup files*),
out of your Downloads folder - see the app's changelog for beta.6.

## Using the same password for every mailbox

The wizard can use one *shared password* for every account you create
(Settings -> Identities). That is a real trade-off: one password to remember,
but one leak exposes every mailbox built on it. Pigeonhole makes the choice
available and stores the password encrypted - but does not make it for you.

## Things the wizard will not do

- It never solves or bypasses CAPTCHAs.
- It does not mass-create accounts - each signup is one guided, human-paced
  flow.
- It does not rotate IP addresses mid-signup; each workspace keeps whatever
  route it has (see the free proxy pool in Settings -> Network).

## Sources

- Proton: "Create an email account without phone number verification" -
  proton.me/blog; free plan limits at proton.me/support/email-sending-limits
- Atomic Mail: atomicmail.io/free-email-without-phone-number - "Phone number:
  Not required. No phone and no backup email at signup", seed-phrase recovery
- Tuta: tuta.com/blog/anonymous-email - "no mobile number required"; same
  page: "Sometimes accounts are automatically marked for approval ... when
  you sign up via Tor or a VPN ... you will be able to start using it within
  48 hours"; Tuta support: free accounts are deleted due to inactivity
- Mailfence: blog.mailfence.com/email-without-a-phone-number - "Mailfence does
  not require one at sign-up"; beta feedback: signups behind shared IPs
  intermittently refused
- GMX: support.gmx.com/account/login-details/register.html - "Registration
  without a mobile phone number is not possible"; support.gmx.com geo-block
  message
- mail.com signup page asks for a cell number; community reports (2024+)
  indicate it is required
