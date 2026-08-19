/** Studio Google Workspace domain(s), comma-separated. */
export function studioEmailDomains() {
  const raw = process.env.REACT_APP_STUDIO_EMAIL_DOMAINS
    || process.env.REACT_APP_STUDIO_EMAIL_DOMAIN
    || 'extendedwhanau.com';
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export function studioManagerEmail() {
  return String(process.env.REACT_APP_STUDIO_MANAGER_EMAIL || '')
    .trim()
    .toLowerCase();
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function emailDomain(email) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  if (at < 0) return '';
  return e.slice(at + 1);
}

export function isStudioEmail(email) {
  const domain = emailDomain(email);
  return Boolean(domain) && studioEmailDomains().includes(domain);
}
