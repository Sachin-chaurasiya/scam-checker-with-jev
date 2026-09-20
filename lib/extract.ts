/**
 * Pure text preparation. No model involvement: the docs are explicit that
 * anything a regex can find should be found by a regex, not by Jev.
 */

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_SENDER_CHARS = 120;
export const MAX_HOSTS = 5;

/** Bare domains are only trusted as links when the TLD looks like a real one. */
const COMMON_TLDS = new Set([
  "com", "net", "org", "edu", "gov", "int", "mil",
  "in", "co", "uk", "us", "ca", "au", "de", "fr", "nl", "ru", "cn", "jp", "br",
  "io", "ai", "app", "dev", "me", "tv", "cc", "ly", "gl", "gd", "sh", "to",
  "xyz", "top", "info", "biz", "online", "site", "shop", "store", "space",
  "website", "click", "link", "live", "life", "world", "today", "news",
  "digital", "cloud", "page", "tech", "fun", "vip", "icu", "club", "buzz",
  "work", "win", "bid", "loan", "download", "stream", "host", "rest", "fit",
  "tk", "ml", "ga", "cf", "pw",
]);

const URL_CANDIDATE =
  /(?:https?:\/\/|www\.)[^\s<>"'`]+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'`]*)?/gi;

const TRAILING_JUNK = /[.,;:!?)\]}'"<>]+$/;

/** Never throws: bad input comes back as an empty string, not an exception. */
export function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

/** Null when the candidate is not a usable public URL. */
export function hostOf(candidate: string): string | null {
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
    // A hostname with no dot (`https://localhost`) is not a public link.
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** The TLD check is what keeps prose like `etc.Thanks` from being read as a link. */
export function extractHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const raw of text.match(URL_CANDIDATE) ?? []) {
    const candidate = raw.replace(TRAILING_JUNK, "");
    if (!candidate) continue;

    const explicit = /^(?:https?:\/\/|www\.)/i.test(candidate);
    const hasPath = candidate.includes("/");
    const host = hostOf(candidate);
    if (!host) continue;

    if (!explicit && !hasPath) {
      const tld = host.slice(host.lastIndexOf(".") + 1);
      if (!COMMON_TLDS.has(tld)) continue;
    }
    if (!hosts.includes(host)) hosts.push(host);
    if (hosts.length === MAX_HOSTS) break;
  }
  return hosts;
}
