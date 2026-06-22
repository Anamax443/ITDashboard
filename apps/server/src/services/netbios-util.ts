/**
 * Pure parser for `nbtstat -A <ip>` output. Kept dependency-free so it can be unit
 * tested without spawning nbtstat (same pattern as alerts-util / faulty-util).
 *
 * The node-status response gives the machine name (the "<00>" UNIQUE entry) and a
 * trailing "MAC Address = XX-XX-XX-XX-XX-XX" line. The MAC is the valuable part for
 * the active scan: it resolves a remote-subnet host's real MAC over L3 (NetBIOS),
 * which ARP (L2, router-local) can't reach. The MAC label is localized, so we match
 * the hex form anywhere and normalize to the colon/upper form RouterOS uses (so the
 * same device keys identically whether discovered via ARP or NetBIOS).
 */
export function parseNbtstat(out: string | undefined | null): { name: string | null; mac: string | null } {
  let name: string | null = null;
  let mac: string | null = null;
  for (const line of (out ?? '').split(/\r?\n/)) {
    if (!name) {
      // "   EPSONB523FE    <00>  UNIQUE      Registered" — name before <00>
      // (the status word is locale-dependent, so we don't match it). `\s*` not
      // `\s+`: a full 15-char NetBIOS name fills the column with NO padding space
      // before <00> (e.g. "BRN94DDF8306EB0<00>"), which `\s+` missed.
      const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,14})\s*<00>/i);
      if (m && m[1]) name = m[1].trim();
    }
    if (!mac) {
      const mm = line.match(/\b([0-9A-Fa-f]{2}(?:[-:][0-9A-Fa-f]{2}){5})\b/);
      if (mm && mm[1]) {
        const norm = mm[1].replace(/-/g, ':').toUpperCase();
        if (norm !== '00:00:00:00:00:00') mac = norm; // nbtstat prints zeros for no-MAC adapters
      }
    }
    if (name && mac) break;
  }
  return { name, mac };
}
