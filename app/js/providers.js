// Email provider registry used by the onboarding wizard.
// The "phone" field reflects the provider's current signup behaviour,
// re-researched November 2026 (see docs/email-providers.md for sources).
// Facts drift, so the wizard always shows this table for the user to judge.
//
// v1.1.0-beta.6 notes:
// - Atomic Mail is the DEFAULT (first in the list, preselected in the
//   wizard): no phone, no recovery email, seed-phrase recovery, and it
//   tolerates shared proxy exits better than the alternatives.
// - the instant-address mode (mail.tm / mail.gw disposable API) is REMOVED:
//   its domains are on every "disposable email" blocklist, so sites refused
//   the addresses exactly when it mattered. Real providers only.
// v1.1.0-beta.5 notes:
// - mail.com and GMX removed: both now gate signup behind a phone number,
//   and signups from proxy IPs are routinely refused outright.
// - Tuta demoted: signups made through VPN/proxy exits are held for an
//   approval queue ("up to 48 hours", frequently longer) and unused free
//   accounts are deleted. Great provider, poor fit while exiting through
//   the free proxy pool.

export const PHONE_LABEL = {
  none: { label: 'No phone required', cls: 'success' },
  asked: { label: 'Phone number asked', cls: 'accent' },
  required: { label: 'Phone required', cls: 'danger' }
};

export const PROVIDERS = [
  {
    id: 'atomic',
    name: 'Atomic Mail',
    signupUrl: 'https://atomicmail.io/app/auth/sign-up',
    inboxUrl: 'https://atomicmail.io/app',
    host: 'atomicmail.io',
    phone: 'none',
    humanCheck: 'picture puzzle (sometimes)',
    free: 'Unlimited storage, 10 aliases, 25 MB attachments',
    notes: 'Encrypted provider that asks for nothing personal: a first name, the address and a password. You get a 12-word seed phrase - save it, it is the ONLY recovery method. Works well from shared IPs.',
    domains: ['atomicmail.io'],
    successPatterns: [/atomicmail\.io\/app(?!\/auth)/i, /atomicmail\.io\/app\/#/i],
    recommended: true,
    default: true
  },
  {
    id: 'proton',
    name: 'Proton Mail',
    signupUrl: 'https://account.proton.me/signup',
    inboxUrl: 'https://mail.proton.me',
    host: 'account.proton.me',
    phone: 'none',
    humanCheck: 'CAPTCHA or alternate email',
    free: '1 address, up to 1 GB, 150 messages/day',
    notes: 'Swiss privacy provider, running since 2014. Pick the Free plan on the first screen; recovery details are optional - skip them to keep accounts unlinked.',
    domains: ['proton.me', 'protonmail.com'],
    successPatterns: [/account\.proton\.me\/u\/\d+/i, /mail\.proton\.me/i, /account\.proton\.me\/(mail|download|dashboard)/i],
    recommended: true
  },
  {
    id: 'mailfence',
    name: 'Mailfence',
    signupUrl: 'https://mailfence.com/registration',
    inboxUrl: 'https://mailfence.com',
    host: 'mailfence.com',
    phone: 'none',
    humanCheck: 'CAPTCHA (recovery email optional)',
    free: 'Free base plan, OpenPGP',
    notes: 'Belgian secure mail since 2013. No phone, but it tightens up when the signup comes from a shared/proxy IP - if the form refuses you, turn this workspace\'s proxy off for the signup.',
    domains: ['mailfence.com'],
    successPatterns: [/mailfence\.com\/(inbox|mail|start)/i],
    recommended: false
  },
  {
    id: 'tuta',
    name: 'Tuta',
    signupUrl: 'https://app.tuta.com/signup',
    inboxUrl: 'https://app.tuta.com',
    host: 'app.tuta.com',
    phone: 'none',
    humanCheck: 'CAPTCHA',
    free: '1 GB storage, 1 calendar',
    notes: 'German privacy provider (formerly Tutanota). Heads-up: signups made through VPN/proxy exits are put in an approval queue that can take 48 hours or more, and free accounts that sit unused get deleted. Prefer it on a direct connection, or pick another provider while routed through the pool. Exports a backup file Pigeonhole captures for this workspace automatically.',
    domains: ['tuta.com', 'tutanota.com', 'tuta.io', 'tutamail.com', 'tutanota.de', 'keemail.me'],
    successPatterns: [/app\.tuta\.com\/(mail|wizard|login)/i, /app\.tuta\.com\/[a-z]{2}\/mail/i],
    recommended: false
  }
];

export function providerById(id) { return PROVIDERS.find(p => p.id === id) || null; }
export function providerByHost(host) { return PROVIDERS.find(p => host === p.host || host.endsWith('.' + p.host)) || null; }
