/**
 * Pure parser for `net view \\<host>` output — extracts SHARED PRINTERS (so USB /
 * locally-attached printers shared from a PC, which a network scan can't see by IP,
 * show up in the inventory). Dependency-free for unit testing (like alerts-util /
 * netbios-util).
 *
 * `net view` output is a fixed-ish width table; the Type column is localized
 * ("Tisk" cs / "Print" en / "Druck" de …). We avoid brittle column math by finding
 * the Type token as its own column (preceded by a 2+ space gap) and taking the
 * share name as everything before it. Only printer-type rows are returned.
 *
 * Example (cs):
 *   Název sdílené položky   Typ   Použito jako  Komentář
 *   ----------------------------------------------------------
 *   Brother HL-1110 series  Tisk                HL-1110 series
 *   Příkaz byl úspěšně dokončen.
 */
export interface SharedPrinter { name: string; comment: string | null; }

// Localized "print(er)" type words. Extend if a new locale appears on a host.
const PRINTER_TYPE = /\s{2,}(Tisk|Print|Druck|Stampa|Imprimante|Impresi\w*)\b/i;
// Footer line ("Příkaz byl úspěšně dokončen." / "The command completed successfully.")
const FOOTER = /^(P[řr]íkaz|The command)/i;

export function parseNetViewPrinters(out: string | null | undefined): SharedPrinter[] {
  const res: SharedPrinter[] = [];
  let inTable = false;
  for (const line of (out ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^-{5,}/.test(trimmed)) { inTable = true; continue; } // dashed rule starts the rows
    if (!inTable || !trimmed) continue;
    if (FOOTER.test(trimmed)) break;
    const m = PRINTER_TYPE.exec(line);
    if (!m || m.index == null) continue;
    const name = line.slice(0, m.index).trim();
    if (!name) continue;
    // After the Type word comes the (usually empty) "Used as" column then the
    // comment — best-effort, identification is the point.
    const comment = line.slice(m.index + m[0].length).trim() || null;
    res.push({ name, comment });
  }
  return res;
}
