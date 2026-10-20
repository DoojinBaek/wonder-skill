// Serve CDN files (KaTeX, Pretendard) from a disk cache so each fresh browser context does not download them again.
// The first request for a URL is fetched over the network and saved; later ones, in any context or run, come from disk.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '.cache', 'cdn');
const HOSTS = /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const pending = new Map();   // one network fetch per URL even when many contexts ask at once

function keyOf(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

async function load(route, url) {
  const file = path.join(DIR, keyOf(url));
  if (fs.existsSync(file + '.json')) {
    return { meta: JSON.parse(fs.readFileSync(file + '.json', 'utf8')), body: fs.readFileSync(file) };
  }
  if (!pending.has(url)) {
    pending.set(url, (async () => {
      const res = await route.fetch();
      const body = await res.body();
      const meta = { status: res.status(), headers: { 'content-type': res.headers()['content-type'] || 'application/octet-stream', 'access-control-allow-origin': '*' } };
      if (res.ok()) {
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(file, body);
        fs.writeFileSync(file + '.json', JSON.stringify(meta));
      }
      return { meta, body };
    })().finally(() => pending.delete(url)));
  }
  return pending.get(url);
}

export async function useCdnCache(context) {
  await context.route(HOSTS, async route => {
    try {
      const { meta, body } = await load(route, route.request().url());
      await route.fulfill({ status: meta.status, headers: meta.headers, body });
    } catch (_) {
      await route.continue().catch(() => {});
    }
  });
}
