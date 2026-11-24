# Email providers - what signup actually asks for

Checked **November 2026**. Signup requirements drift over time; the wizard
shows this same table before every setup so the choice stays yours. If any
detail here has changed, a PR or issue is welcome.

| Provider | Phone number | Human check | Free tier | Notes |
| --- | --- | --- | --- | --- |
| **Proton Mail** (proton.me) | Not required | CAPTCHA or alternate email | 1 address, up to 1 GB, 150 messages/day | Swiss, running since 2014. Pick the *Free* plan on the first screen; recovery email/phone are optional. |
| **Tuta** (tuta.com) | Not required | CAPTCHA | 1 GB storage | German, formerly Tutanota. Choose the *Free* plan. Signups from some networks are held briefly for an activation check. |
| **Mailfence** (mailfence.com) | Not required | None (recovery email optional) | Free base plan | Belgian, since 2013. A recovery email is recommended but not required. |
| mail.com | Asked at signup | CAPTCHA | 100+ domains | The form asks for a cell number and recent user reports say it may be mandatory. Included for completeness - prefer the three above. |
| GMX | **Required** | CAPTCHA + SMS | - | Not usable for this workflow. |

## Why these three

The goal is a mailbox you can actually create several of:

1. **No phone verification** - a phone number links accounts together better
   than any cookie ever will.
2. **A tolerable human check** - a CAPTCHA you solve by hand is fine; an SMS
   code is not.
3. **A webmail inbox** - the verification mail for the site you are signing up
   to arrives in the same workspace, one tile away.

Proton, Tuta and Mailfence currently tick all three boxes.

## Using the same password for every mailbox

The wizard can use one *shared password* for every account you create
(Settings -> Identities). That is a real trade-off: one password to remember,
but one leak exposes every mailbox built on it. Pigeonhole makes the choice
available and stores the password encrypted - but does not make it for you.

## Things the wizard will not do

- It never solves or bypasses CAPTCHAs.
- It does not mass-create accounts - each signup is one guided, human-paced
  flow.
- It does not rotate IP addresses; every workspace currently connects
  directly (per-workspace proxy routing is on the
  [roadmap](roadmap.md) for v1.1).

## Sources

- Proton: "Create an email account without phone number verification" -
  proton.me/blog (account creation flow, free plan limits, sending limits
  documented at proton.me/support/email-sending-limits)
- Tuta: tuta.com/blog/anonymous-email - "no mobile number required"
- Mailfence: blog.mailfence.com/email-without-a-phone-number - "Mailfence
  does not require one at sign-up"
- GMX: support.gmx.com/account/login-details/register.html - "Registration
  without a mobile phone number is not possible"
- mail.com signup page asks for a cell number; community reports (2024+)
  indicate it is now required
