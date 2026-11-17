import type { HostHandle } from './pool.js';

/** Most recently focused first; never-focused hosts by start time, newest first. */
export function orderByFocus<T extends Pick<HostHandle, 'state'>>(
  hosts: readonly T[],
): T[] {
  return [...hosts].sort(
    (a, b) =>
      (b.state.lastFocusedAt ?? -1) - (a.state.lastFocusedAt ?? -1) ||
      b.state.startedAt - a.state.startedAt,
  );
}

export function describeProfile(host: Pick<HostHandle, 'state'>): string {
  const { profile, browser } = host.state;
  return `${profile.label ?? profile.id} (${browser.name}, id ${profile.id})`;
}

export type ProfileResolution<T> =
  | { readonly ok: true; readonly host: T }
  | { readonly ok: false; readonly message: string };

/**
 * Pick the host for a `profile` argument (plan §5.15): absent → the most recently focused;
 * otherwise an exact profile id, then a case-insensitive label, then a browser name, each only
 * if unambiguous.
 */
export function resolveProfile<T extends Pick<HostHandle, 'state'>>(
  hosts: readonly T[],
  requested: string | undefined,
): ProfileResolution<T> {
  const ordered = orderByFocus(hosts);
  if (ordered.length === 0) {
    return { ok: false, message: 'no browser profile is connected' };
  }
  const query = requested?.trim();
  if (!query) return { ok: true, host: ordered[0] as T };
  const lower = query.toLowerCase();
  const matchers: ((host: T) => boolean)[] = [
    (h) => h.state.profile.id === query,
    (h) => h.state.profile.label?.toLowerCase() === lower,
    (h) => h.state.browser.name.toLowerCase() === lower,
  ];
  for (const matches of matchers) {
    const found = ordered.filter(matches);
    if (found.length === 1) return { ok: true, host: found[0] as T };
    if (found.length > 1) {
      return {
        ok: false,
        message: `"${query}" matches several profiles: ${found.map(describeProfile).join('; ')}. Pass a profile id.`,
      };
    }
  }
  return {
    ok: false,
    message: `no connected profile matches "${query}". Connected: ${ordered.map(describeProfile).join('; ')}.`,
  };
}
