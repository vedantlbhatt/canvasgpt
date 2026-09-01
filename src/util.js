import crypto from 'node:crypto';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", mdash: '—', ndash: '–',
  hellip: '…', times: '×', deg: '°', trade: '™', copy: '©', reg: '®',
};

/** Canvas HTML -> readable plain text. Keeps link targets, drops markup. */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => {
    const label = txt.replace(/<[^>]+>/g, '').trim();
    if (!label) return href;
    return href && !label.includes(href) ? `${label} (${href})` : label;
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|table|blockquote)>/gi, '\n');
  s = s.replace(/<\/?(td|th)\b[^>]*>/gi, '\t');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
  s = s.replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/ *\n[ \n]*/g, '\n');
  return s.trim();
}

export function hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

export const nowIso = () => new Date().toISOString();

/** Format a UTC ISO timestamp in the user's local zone for display to the model. */
export function localTime(iso, tz = process.env.USER_TZ || 'America/New_York') {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(d);
}

export function truncate(s, n) {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n) + `\n…[truncated, ${s.length - n} more chars]`;
}
