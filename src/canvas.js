/**
 * Cookie-authenticated Canvas REST client.
 *
 * Georgia Tech disables personal access tokens for students, so we ride a
 * copied browser session cookie instead. Three consequences, all handled here:
 *
 *   1. Canvas prefixes JSON with `while(1);` for cookie-authed requests.
 *   2. Results paginate 10 at a time; the only cursor is the Link header.
 *   3. Many courses lock Pages/Quizzes/Files to students, so 403 and 404 are
 *      routine and must never abort a run.
 *
 * This client issues GET requests only. The cookie is never logged, never
 * included in an error message, and never leaves this module.
 */

export class CanvasSessionExpired extends Error {
  constructor() {
    super('Canvas session cookie is no longer valid.');
    this.name = 'CanvasSessionExpired';
  }
}

const WHILE1 = /^\s*while\s*\(1\);?/;

/** Strip Canvas's anti-JSON-hijacking prefix before parsing. */
export function parseCanvasJson(text) {
  return JSON.parse(String(text).replace(WHILE1, ''));
}

/** Pull the rel="next" URL out of a Link header. */
export function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (m) return m[1];
  }
  return null;
}

export class CanvasClient {
  /**
   * @param {object} opts
   * @param {string} opts.host   e.g. https://gatech.instructure.com
   * @param {string} opts.cookie raw document.cookie string from a logged-in session
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ host, cookie, log = () => {}, concurrency = 4, timeoutMs = 30000 }) {
    if (!cookie) throw new Error('No Canvas cookie configured.');
    this.host = String(host || 'https://gatech.instructure.com').replace(/\/$/, '');
    this.#cookie = cookie;
    this.log = log;
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.stats = { requests: 0, denied: 0, missing: 0, retried: 0, throttled: 0 };
  }

  /** Private so it cannot be reached from a tool, an endpoint, or a stack trace. */
  #cookie;

  #url(pathOrUrl) {
    const url = pathOrUrl.startsWith('http')
      ? new URL(pathOrUrl)
      : new URL(`/api/v1/${pathOrUrl.replace(/^\/+/, '')}`, this.host);
    if (!url.searchParams.has('per_page')) url.searchParams.set('per_page', '100');
    return url;
  }

  /** One GET. Returns {status, data, link}. Never throws on 403/404. */
  async request(pathOrUrl, { attempt = 0 } = {}) {
    const url = this.#url(pathOrUrl);
    const safeUrl = `${url.pathname}${url.search}`; // host+path only, never the cookie
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      this.stats.requests++;
      res = await fetch(url, {
        method: 'GET', // GET only. This client must never mutate Canvas.
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          Cookie: this.#cookie,
          Accept: 'application/json+canvas-string-ids, application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'CanvasGPT/0.1 (personal Canvas mirror)',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 2) {
        this.stats.retried++;
        await sleep(500 * 2 ** attempt);
        return this.request(pathOrUrl, { attempt: attempt + 1 });
      }
      throw new Error(`GET ${safeUrl} failed: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    }
    clearTimeout(timer);

    // Canvas answers an expired cookie with a 401, or by redirecting to the
    // SSO login page with a 200. Both mean the same thing.
    if (res.status === 401) throw new CanvasSessionExpired();
    if (res.status === 403) {
      const body = await res.text().catch(() => '');
      // Canvas uses 403 both for "students can't see this" and for throttling.
      if (/rate limit|throttl/i.test(body)) {
        if (attempt < 3) {
          this.stats.retried++;
          await sleep(2000 * 2 ** attempt);
          return this.request(pathOrUrl, { attempt: attempt + 1 });
        }
      }
      this.stats.denied++;
      return { status: 403, data: null, link: null };
    }
    if (res.status === 404) {
      this.stats.missing++;
      return { status: 404, data: null, link: null };
    }
    // Canvas throttles with a bare 429 as well as with the 403 handled above.
    // Without this the collection is dropped for the whole run and the resource
    // silently goes stale, counted in neither `denied` nor `missing`.
    if (res.status === 429) {
      if (attempt < 3) {
        this.stats.retried++;
        const header = res.headers.get('retry-after');
        const retryAfter = header == null ? NaN : Number(header) * 1000;
        await sleep(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 2000 * 2 ** attempt);
        return this.request(pathOrUrl, { attempt: attempt + 1 });
      }
      this.stats.throttled++;
      return { status: 429, data: null, link: null };
    }
    if (res.status >= 500 && attempt < 2) {
      this.stats.retried++;
      await sleep(1000 * 2 ** attempt);
      return this.request(pathOrUrl, { attempt: attempt + 1 });
    }
    if (!res.ok) {
      return { status: res.status, data: null, link: null };
    }

    const text = await res.text();
    const ctype = res.headers.get('content-type') || '';
    if (!/json/i.test(ctype) && /<html/i.test(text.slice(0, 400))) {
      // An HTML body on a JSON endpoint is the SSO login page.
      throw new CanvasSessionExpired();
    }
    let data;
    try {
      data = parseCanvasJson(text);
    } catch (err) {
      throw new Error(`GET ${safeUrl} returned unparseable JSON: ${err.message}`);
    }
    if (data && data.status === 'unauthenticated') throw new CanvasSessionExpired();
    return { status: res.status, data, link: nextLink(res.headers.get('link')) };
  }

  /** GET a single object. Returns null on 403/404. */
  async get(path) {
    const { data } = await this.request(path);
    return data ?? null;
  }

  /** GET a paginated collection, following rel="next" to the end. */
  async getAll(path, { max = 5000 } = {}) {
    const out = [];
    let url = path;
    let pages = 0;
    let denied = false;
    let deniedStatus = 0;
    while (url) {
      const { data, link, status } = await this.request(url);
      if (status === 403 || status === 404 || data == null) {
        // An empty array and a locked resource look identical downstream unless
        // we say so; the diff engine must not read "locked" as "deleted".
        if (pages === 0) { denied = true; deniedStatus = status; }
        break;
      }
      if (Array.isArray(data)) out.push(...data);
      else out.push(data);
      pages++;
      if (out.length >= max || pages > 200) break;
      url = link;
    }
    Object.defineProperty(out, 'denied', { value: denied, enumerable: false });
    // 403 (locked to students) and 404 (feature switched off) are different
    // stories to tell the user, so keep the code, not just the fact.
    Object.defineProperty(out, 'deniedStatus', { value: deniedStatus, enumerable: false });
    return out;
  }

  /** Run tasks with bounded concurrency, preserving input order. */
  async map(items, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  /** Cheap liveness probe. Throws CanvasSessionExpired if the cookie is dead. */
  async whoami() {
    return this.get('users/self/profile');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
