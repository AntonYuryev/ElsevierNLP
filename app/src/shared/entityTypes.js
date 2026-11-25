// ── THE table of MedScan node-type ID ranges ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Node type → number of its first million: a type covers the MedScan IDs n·1,000,000 … n·1,000,000+999,999 ([NodeType-MSIDRange] of nodetype.ini, whose names are used here).
// Everything that needs a range — the Dictionary Manager (ENTITY_TYPES below), the pattern tools that read rules with in = %a(6000000) — takes it from this table.
export const NODE_TYPE_RANGES = [
  ['Protein', 0], ['SmallMol', 1], ['CellObject', 2], ['Complex', 3], ['CellProcess', 4], ['Virus', 5], ['Tissue', 6], ['Organism', 7], ['Organ', 8], ['Disease', 9],
  ['CellType', 10], ['CellLine', 11], ['FunctionalClass', 12], ['Treatment', 13], ['Enzyme', 14], ['ClinicalParameter', 15], ['MedicalProcedure', 16],
  ['GeneticVariant', 17], ['Pathogen', 18], ['MaskingTerms', 31], ['ProteinDomain', 45],
];
const FIRST_MILLION = Object.fromEntries(NODE_TYPE_RANGES);
const NODE_OF_MILLION = Object.fromEntries(NODE_TYPE_RANGES.map(([name, n]) => [n, name]));
/** { min, max } of a node type's ID range (undefined for a name that is not in the table) */
export const rangeOf = (node) => (node in FIRST_MILLION ? { min: FIRST_MILLION[node] * 1e6, max: FIRST_MILLION[node] * 1e6 + 999999 } : undefined);
/** A node type of a rule's in = / out = list: a number that starts a range (6000000) becomes the type name (Tissue); anything else is returned as it is. */
export const nodeTypeOfId = (x) => (/^\d+$/.test(x) && Number(x) % 1e6 === 0 && NODE_OF_MILLION[Number(x) / 1e6]) || x;

// ── Node types a frame's type also covers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A frame written for "Protein" (in = %a(Protein)) matches entities typed Protein, Complex and FunctionalClass: msgrep treats them as one family for the frame.
// Everything that compares the node type of an entity / relation with the types of a frame uses these helpers.
export const NODE_TYPE_COVERS = { Protein: ['Complex', 'FunctionalClass'] };
const lc = (x) => String(x).toLowerCase();
/** the type a frame is written with for an entity of type t: Complex / FunctionalClass → Protein, every other type is returned as it is */
export const frameTypeOf = (t) => { for (const [k, v] of Object.entries(NODE_TYPE_COVERS)) if (v.some(x => lc(x) === lc(t))) return k; return t; };
/** does a frame's list of node types (in = / out =) accept an entity of type t: the type itself, or one it covers */
export const typeListHas = (list, t) => (list || []).some(y => lc(y) === lc(t) || lc(y) === lc(frameTypeOf(t)));

// Entity types of the Dictionary Manager: display name, RNEF node type, URN tag and the node type (a name of the table above) that gives the ID range.
const T = (display, rnef, urnTag, node) => ({ display, rnef, urnTag, node, ...rangeOf(node) });
export const ENTITY_TYPES = [
  T('Protein/Gene',             'Protein',           'prot',         'Protein'),
  T('Small Molecules',          'SmallMol',          'smol',         'SmallMol'),
  T('Cell components',          'CellObject',        'cellobj',      'CellObject'),
  T('Protein complexes',        'Complex',           'complex',      'Complex'),
  T('Cell processes',           'CellProcesses',     'cellproc',     'CellProcess'),
  T('Virus',                    'Virus',             'virus',        'Virus'),
  T('Tissues',                  'Tissue',            'tissue',       'Tissue'),
  T('Organism',                 'Organism',          'organism',     'Organism'),
  T('Organs',                   'Organ',             'organ',        'Organ'),
  T('Diseases',                 'Diseases',          'disease',      'Disease'),
  T('Cell types',               'CellType',          'celltype',     'CellType'),
  T('Cell lines',               'CellLineName',      'cellline',     'CellLine'),
  T('Protein Functional class', 'FunctionalClass',   'protfc',       'FunctionalClass'),
  T('Treatment',                'Treatment',         'treatment',    'Treatment'),
  T('Clinical parameters',      'ClinicalParameter', 'clinpar',      'ClinicalParameter'),
  T('Medical Procedure',        'MedicalProcedure',  'medproc',      'MedicalProcedure'),
  T('Genetic variation',        'GeneticVariant',    'gv',           'GeneticVariant'),
  T('Pathogen',                 'Pathogen',          'pathogen',     'Pathogen'),
  T('Masking terms',            'MaskingTerms',      'maskingterms', 'MaskingTerms'),
  T('Protein domain',           'ProteinDomain',     'protdomain',   'ProteinDomain'),
];

// Map from RNEF node type → entity type entry
export const byRnef = Object.fromEntries(ENTITY_TYPES.map(e => [e.rnef, e]));
// Map from display name → entity type entry
export const byDisplay = Object.fromEntries(ENTITY_TYPES.map(e => [e.display, e]));

export function resolveEntityType(nameOrRnef) {
  return byDisplay[nameOrRnef] || byRnef[nameOrRnef] || null;
}

// Table that holds the entity's dictionary row (by entity type)
// celldictionary: cell lines, cell types, cell components, cell processes,
//   virus, tissues, organisms, organs, pathogens
export const ENTITY_TO_TABLE = {
  Protein:           'curnames',
  SmallMol:          'curnames',
  CellObject:        'celldictionary',
  Complex:           'curnames',
  CellProcesses:     'celldictionary',
  Virus:             'celldictionary',
  Tissue:            'celldictionary',
  Organism:          'celldictionary',
  Organ:             'celldictionary',
  Diseases:          'celldictionary',
  CellType:          'celldictionary',
  CellLineName:      'celldictionary',
  FunctionalClass:   'curnames',
  Treatment:         'curnames',
  ClinicalParameter: 'celldictionary',
  MedicalProcedure:  'curnames',
  GeneticVariant:    'curnames',
  Pathogen:          'celldictionary',
  MaskingTerms:      'curnames',
  ProteinDomain:     'curnames',
};

// Tokenization xwords table per dictionary table
// Kept for reference — prefer TABLE_XWORDS from shared/tokenizer.js (it is the single source of truth).
export const TOKENIZE_XWORDS = {
  curnames:       'xwords',
  celldictionary: 'xwords_cells',
  casdictionary:  'xwords_cas',
};
