// Email provider registry used by the onboarding wizard.
// The "phone" field reflects the provider's current signup behaviour -
// researched November 2026 (see docs/email-providers.md for sources).
// Facts drift, so the wizard always shows this table for the user to judge.

export const PHONE_LABEL = {
  none: { label: 'No phone required', cls: 'success' },
  asked: { label: 'Phone number asked', cls: 'accent' },
  required: { label: 'Phone required', cls: 'danger' }
};

export const PROVIDERS = [
  {
    id: 'proton',
    name: 'Proton Mail',
    signupUrl: 'https://account.proton.me/signup',
    inboxUrl: 'https://mail.proton.me',
    host: 'account.proton.me',
    phone: 'none',
    humanCheck: 'CAPTCHA or alternate email',
    free: '1 address, up to 1 GB, 150 messages/day',
    notes: 'Swiss privacy provider, running since 2014. Pick the Free plan on the first screen. Account recovery details are optional.',
    domains: ['proton.me', 'protonmail.com'],
    successPatterns: [/account\.proton\.me\/u\/\d+/i, /mail\.proton\.me/i, /account\.proton\.me\/(mail|download|dashboard)/i],
    recommended: true
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
    notes: 'German privacy provider (formerly Tutanota), since 2011. Choose the Free plan. Signups from some networks are held for a short activation check.',
    domains: ['tuta.com', 'tutanota.com', 'tuta.io'],
    successPatterns: [/app\.tuta\.com\/(mail|wizard|login)/i, /app\.tuta\.com\/[a-z]{2}\/mail/i],
    recommended: true
  },
  {
    id: 'mailfence',
    name: 'Mailfence',
    signupUrl: 'https://mailfence.com/registration',
    inboxUrl: 'https://mailfence.com',
    host: 'mailfence.com',
    phone: 'none',
    humanCheck: 'none (recovery email optional)',
    free: 'Free base plan, OpenPGP',
    notes: 'Belgian secure mail since 2013. Pick a display name and login; a recovery email is recommended but optional.',
    domains: ['mailfence.com'],
    successPatterns: [/mailfence\.com\/(inbox|mail|start)/i],
    recommended: true
  },
  {
    id: 'mailcom',
    name: 'mail.com',
    signupUrl: 'https://www.mail.com/mail/create-email-account/',
    inboxUrl: 'https://www.mail.com',
    host: 'www.mail.com',
    phone: 'asked',
    humanCheck: 'CAPTCHA',
    free: '100+ domains to pick from',
    notes: 'The signup form asks for a cell number and recent user reports say it may be mandatory. Included for completeness - prefer a no-phone provider above.',
    domains: ['mail.com', 'usa.com', 'engineer.com', 'consultant.com'],
    successPatterns: [/mail\.com\/(success|welcome|mail)/i, /navigator\./i],
    recommended: false
  }
];

export function providerById(id) { return PROVIDERS.find(p => p.id === id) || null; }
export function providerByHost(host) { return PROVIDERS.find(p => host === p.host || host.endsWith('.' + p.host)) || null; }
