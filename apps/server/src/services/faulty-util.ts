/**
 * Pure parsers for the per-category eventlog noise suppression (notebooks) used by
 * GET /events/pc-health. Kept dependency-free so they can be unit tested without a
 * DB/native-driver load (same pattern as alerts-util.ts).
 */

export interface SuppressionSignature {
  /** Provider LIKE pattern (SQL `%` wildcards), or null = any provider. */
  provider: string | null;
  /** Exact event id, or null = any event id. */
  eventId: number | null;
}

/**
 * Parse the `faulty.notebook_ou` setting into SQL LIKE patterns matched against a
 * computer's ou_path / distinguished_name / name. Comma- or newline-separated;
 * `*` becomes `%`; a pattern with no wildcard is wrapped as a `%substring%` match.
 */
export function parseNotebookPatterns(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((p) => {
      const v = p.replace(/\*/g, '%');
      return v.includes('%') ? v : `%${v}%`;
    });
}

/**
 * Parse the `faulty.suppress_notebook` setting into signatures. Token forms
 * (using STAR for the wildcard char to keep this out of the block comment):
 *   provider-slash-eventid   e.g. NETLOGON/5719
 *   eventid                  e.g. 5719           (any provider)
 *   provider                 e.g. NetwtwSTAR     (any event id)
 *   provider-slash-STAR      e.g. NetwtwSTAR/STAR
 * STAR is a wildcard in the provider part (→ SQL `%`). Tokens that resolve to
 * "any provider AND any id", or carry a non-integer id, are dropped.
 */
export function parseSuppressionSignatures(raw: string | undefined | null): SuppressionSignature[] {
  return (raw ?? '')
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((tok): SuppressionSignature | null => {
      let provider: string | null;
      let idPart: string;
      const slash = tok.indexOf('/');
      if (slash >= 0) { provider = tok.slice(0, slash).trim(); idPart = tok.slice(slash + 1).trim(); }
      else if (/^\d+$/.test(tok)) { provider = null; idPart = tok; }
      else { provider = tok; idPart = ''; }
      const prov = !provider || provider === '*' ? null : provider.replace(/\*/g, '%');
      const eventId = !idPart || idPart === '*' ? null : Number(idPart);
      if (eventId !== null && !Number.isInteger(eventId)) return null;
      if (prov === null && eventId === null) return null;
      return { provider: prov, eventId };
    })
    .filter((x): x is SuppressionSignature => x !== null);
}
