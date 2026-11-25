// ── THE table of relation types that mean the same thing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A cartridge writes the rules of one relation under different ControlTypes (UnknownRegulation / Regulation, ExpressionControl / Expression). The main name is the one GraphExplorer shows;
// the others are what the cartridges extract. Everything that has to treat them as ONE relation takes it from here: the search of patterns, the lookup of existing pattern sets,
// the "already extracted" check, the folder / batch names of new patterns, the GraphExplorer names shown in the dialogs.
export const RELATION_SYNONYMS = [
  { main: 'Regulation', alts: ['UnknownRegulation'] },
  { main: 'Expression', alts: ['ExpressionControl'] },
];

/** lower-case main name → lower-case other names, e.g. { regulation: ['unknownregulation'] } */
export const CONTROL_ALIASES = Object.fromEntries(RELATION_SYNONYMS.map(s => [s.main.toLowerCase(), s.alts.map(a => a.toLowerCase())]));

/** the names the cartridges use → the name GraphExplorer shows, e.g. { UnknownRegulation: 'Regulation' } */
export const GRAPH_EXPLORER_NAMES = Object.fromEntries(RELATION_SYNONYMS.flatMap(s => s.alts.map(a => [a, s.main])));

/** every ControlType spelling (lower case) of the relation `name`, whichever of its names is given; a relation without synonyms gives just itself */
export function aliasGroup(name) {
  const w = String(name || '').toLowerCase();
  const s = RELATION_SYNONYMS.find(x => x.main.toLowerCase() === w || x.alts.some(a => a.toLowerCase() === w));
  return s ? [s.main.toLowerCase(), ...s.alts.map(a => a.toLowerCase())] : [w];
}

/** do the two names mean the same relation? */
export const sameRelation = (a, b) => aliasGroup(a).includes(String(b || '').toLowerCase());

/** The name of the folder / batch / output command of a relation's patterns: the main name for a relation with synonyms (UnknownRegulation → Regulation), else the name itself. */
export function folderName(rel) {
  const s = RELATION_SYNONYMS.find(x => sameRelation(x.main, rel));
  return s ? s.main : rel;
}
