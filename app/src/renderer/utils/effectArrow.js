// The arrow of a relation in its symbolic form (SmallMol:(a) — Regulation -+> Disease:(b)): by the Effect of the relation.
//   positive → -+>  green      negative → --|  red      anything else (unknown, none) → →  in the text colour
const ARROWS = { positive: '-+>', negative: '--|' };
const COLORS = { positive: '#a6e3a1', negative: '#f38ba8' };
export const effectArrow = (effect) => ARROWS[String(effect || '').toLowerCase()] || '→';
/** the colour of the arrow, or undefined (= inherited) when the Effect is neither positive nor negative */
export const effectColor = (effect) => COLORS[String(effect || '').toLowerCase()];
