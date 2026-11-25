// The notation of msgrep patterns, short: [symbol, explanation]. One list for the Help dialog of the pattern editors (components/PatternHelpDialog.jsx).
// Source: TestData\MSGrep.docx (MSGrep 1.75 manual) and TestData\MSGrep pattern matching.txt; the entries marked "ours" are conventions of our rule files.
// The spell-check (utils/patternLint.js) checks the same rules: when a rule is added there, list its notation here.

export const PATTERN_SYNTAX = [
  { title: 'Words and word sets', items: [
    ['word', 'one word. All lower case = any case; with a capital letter = exactly that case'],
    ['[a b c]', 'word set: any ONE of the words — separated by white space, never by commas or |'],
    ['[^ a b]', 'negated word set: any word EXCEPT these ("[ ^ a b]" is the same)'],
    ['"two words"', 'composite word (fixed multi-word term) — double quotes, any case'],
    ['link~', 'any form of the word: link, links, linked, linking'],
    ['"binding site"~', 'composite word in any form — only the last word varies'],
    ["','   '-'   ')'", 'a punctuation mark: ONE character in single quotes'],
    ['$NAME', 'word-set macro, may also be used inside a word set: [$BIND_V bind]'],
    ['$ANY  $WORD  $NUM', 'predefined classes: any token / any word / any number (integer below 1024)'],
  ] },
  { title: 'Entities (markup)', items: [
    ['%name', 'one marked-up entity ID{…} — always ONE token, never a word sequence'],
    ['%a(Protein)', 'in the rule head: declares %a and limits its type — Protein, SmallMol, CellObject, CellProcess, Disease, Enzyme, Treatment …'],
    ['%a(Protein, Complex)', 'several allowed types'],
    ['%a', 'later heads of the same rule just name the variable (no type again)'],
    ['ID{7113}', 'in a head: a fixed MedScan ID as the value of a slot'],
    ['each %var once', 'every head variable occurs exactly once in every alternative, and is never repeated (? * + {n}) or inside a repeated group'],
  ] },
  { title: 'Repeat (after the element)', items: [
    ['x{n}', 'exactly n times'],
    ['x{n,m}', 'from n to m times (n ≤ m)'],
    ['x{n,}', 'n times or more'],
    ['x{,m}', 'up to m times'],
    ['x?', 'optional = {0,1}'],
    ['x+', 'one or more = {1,}'],
    ['x*', 'any number, also none = {0,}'],
  ] },
  { title: 'Groups and alternatives', items: [
    ['( x y )', 'sub-pattern: repeat or alternate several elements together — ( x y )? ( x y ){0,2}'],
    ['( x y | z )', 'alternatives; their order does not matter'],
  ] },
  { title: 'Special tokens', items: [
    ['@.', 'any ONE token (word, number, punctuation, non-essential markup) — NOT a bare "."'],
    ['@.{0,3}', 'up to 3 arbitrary tokens (a gap)'],
    ['@^', 'start of the sentence / segment'],
    ['@$', 'end of the sentence / segment'],
  ] },
  { title: 'Definitions (before they are used, no %variables inside)', items: [
    ['#define $NAME [ … ]', 'word-set macro'],
    ['#define @NAME ( … )', 'sub-pattern macro; used as @NAME'],
    ['#define &NAME(@a, @b) ( … )', 'pattern function; used as &NAME(x, y) — arguments may be %variables'],
    ['name', '[_A-Za-z][_0-9A-Za-z]*, case-sensitive; $ word set, @ sub-pattern, & function'],
    ['@regulator  @target   @in  @out', 'ours: the two parameters of a pattern set, #define &SET(@regulator, @target) — @in / @out are the same two'],
  ] },
  { title: 'Rules', items: [
    ['Head { slot = %a(Type) … } : p1 | p2 ;', 'rule: output frame with its slots, then alternative patterns; the ONLY required ";" ends the rule'],
    ['Head1{…} Head2{…} : …', 'several heads for one set of patterns — they share the variables'],
    ['CONTROL { in = %a(Protein) out = %b(Disease) Effect = "positive" ControlType = "UnknownRegulation" } : &SET(%a, %b);', 'ours: a relation frame whose patterns are the pattern set &SET'],
    ['stop : … ;   block : … ;', 'stop pattern: ends a segment; block pattern: skips the whole sentence'],
    ['$ACT', 'ours: the "&" of a ConceptScan triple "subject & verb object" (-I csout rules)'],
  ] },
  { title: 'Directives and comments', items: [
    ['#include "file.msgrep"', 'insert a file (path relative to the including file)'],
    ['#pragma greedy | non-greedy', 'repeats as long as possible (default) / as short as possible'],
    ['#unmark 55554, 7113', 'treat these entity IDs as plain words'],
    ['// …', 'comment to the end of the line'],
    ['/* … */', 'block comment (not nested)'],
  ] },
];
