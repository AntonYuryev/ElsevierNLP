import React, { useEffect, useRef, useState } from 'react';
import { callLlm } from '../../shared/llm';
import { llmTargetOf } from '../../shared/llmFunctions';
import { sameRelation } from '../../shared/relationTypes';
import { effectArrow } from '../utils/effectArrow';
import FloatingDialog from './FloatingDialog';
import { applyFixes } from '../utils/patternLint';
import { chooseFrame, macroGaps, neighbourPairs, tokenWalk } from '../utils/frames';
import UsedPatternsDialog from './UsedPatternsDialog';

/**
 * "Suggest pattern" (Pipeline): the sentence is marked up but none of the cartridge's patterns extracted a relation.
 * A ConceptScan output usually holds several pseudo-sentences (the lines starting with "<"), and they can express
 * different relations. So:
 *   1. the LLM proposes a list of relations, each tied to the pseudo-sentence(s) P1…Pn it is taken from
 *      (Regulator type — Relation type → Target type; the user can tick/untick rows and change all three)
 *   2. for every ticked row the LLM designs one pattern (cartridge macros preferred) and looks for the closest existing set
 *   3. onResult(list) — the "New relation" wizard is opened one after the other, at step 4, pre-filled.
 */
const SYSTEM_GUESS = `You are an expert in MedScan / MedScan-Reader relation extraction (Elsevier Pathway Studio NLP).
You get a sentence (the line start with "msrc"), its MedScan markup (entities are written ID{ids=text}), the numbered pseudo-sentences P1..Pn (the lines of the markup that start with "<") and the relation types of one cartridge.
Extraction patterns works on both the pseudo-sentences and on the original sentence. List the relations that can be extracted from them: for each, the pseudo-sentence number(s) it comes from, the relation type, the regulator (source) node type and the target node type.
ENTITY PROXIMITY (pattern will run only on the tagged sentence, pseudo-sentence is not an input; ConceptScan pseudo-sentences are always noun-verb-noun with no markup in between and are not affected): the matcher binds @regulator and @target to the CLOSEST marked-up entities of the required node types around the pattern words. An entity of that node type sitting between the two entities you want (or between an entity and the words of the pattern) is taken instead of the farther one and cannot be skipped. So a relation can be extracted only between entities that are NEIGHBOURS in the pseudo-sentence for their node type: e.g. in "ID{primaquine} , an ID{8-aminoquinoline} , was the only anti-ID{relapse} medication … cure of ID{malaria}" primaquine → malaria is NOT extractable (8-aminoquinoline stands right after primaquine, relapse before malaria; the only extractable pair there is 8-aminoquinoline → relapse). For such a sentence propose only relations that obey this rule: choose the pair of entities that are neighbours; a relation between entities separated by another entity of the same node type goes into "skipped" with that reason.
- Pseudo-sentences with the same structure and the same node types / relation (e.g. "… & present <adjective> <Disease>") belong to ONE item, listed together in "lines".
- A pseudo-sentence that expresses another relation or other node types is a separate item.
- Do NOT skip a pseudo-sentence just because the pair of node types is new for a relation type; skip it only when no relation type of the cartridge fits its meaning. At most 6 items.
- If there are no pseudo-sentences, work on the tagged sentence (the "msrc" line of the markup, entities written ID{ids=text}): list the relations it expresses between its marked-up entities, with an empty "lines" list. The pattern for such an item is a tagged-sentence pattern (no $ACT).
Use only the node types and relation types you are given.
PROPERTIES: a relation type may have CONTROL properties (shown as "properties: Effect ∈ {…}"). For the chosen relation fill "properties" with ONE value per listed property, from the meaning of the pseudo-sentence (reduces / decreases / inhibits → Effect negative; increases / activates → positive; direction unclear → unknown; a QuantitativeType follows what is changed: level/amount → abundance, expression → expression, activity → activity). Effect takes only the listed values; for the other properties pick the value in the style of the listed ones (same wording, lower case) or, when none fits, a short new one. Use the property names exactly as listed (a property shown as "X (GraphExplorer shows it as Y)" is answered as X). Leave out a property that does not apply.
Some relation types are shown as "Name (GraphExplorer shows it as X)": the cartridge extracts them as Name, GraphExplorer renames them on import. Always answer with the cartridge name (Name), even when you think of the relation as X (e.g. a regulation of one entity by another is UnknownRegulation, an expression control is ExpressionControl).
HOW TO CHOOSE (follow in this order):
1. You get the regulator → target node-type pairs that EXISTING rules of this cartridge already cover, per relation type ("Covered pairs"). The existing rules also define the direction convention: follow it, even when the grammar of the sentence suggests the opposite (e.g. a variant of a protein associated with a disease is Disease → GeneticChange → Protein when the existing rules are Disease → Protein).
2. For a pseudo-sentence group, first look at the relation types whose existing rules already cover the pair (regulator type → target type) in that direction and pick the one that fits the meaning. This is the preferred answer.
3. If no covered relation type fits the meaning, use a relation type that fits the meaning even though its rules do not list this pair yet: the existing rules are NOT an exhaustive restriction, a new pattern may add new node types to a relation type ("no rules yet" means anything is allowed).
4. Never answer "not valid for this relation" for a node-type pair just because the rules do not list it — look at the other relation types first (e.g. FunctionalAssociation, UnknownRegulation).
5. Relation types are named by what happens, not by the wording of the sentence. Typical meanings: MolSynthesis = a molecule (or protein, treatment) produces / synthesises / forms another molecule, which includes metabolism: "X is a metabolite of Y", "Y is metabolised to X", "X is formed from Y" → regulator Y (the parent), target X (the product), Effect positive; MolTransport = a molecule is moved between places; ChemicalReaction = molecules react; Binding = molecules bind each other. Check the "Covered pairs" table before you skip: when the pair of node types of a pseudo-sentence is covered by a relation type and the meaning is close (e.g. SmallMol → SmallMol with "metabolite of" → MolSynthesis), use it instead of skipping.
Also list every pseudo-sentence you did not use in "skipped", with the reason (e.g. no suitable relation type in this cartridge for these node types).
Reply with JSON only:
{"items":[{"lines":[1,3],"relation":"<relation type>","regulator":"<node type>","target":"<node type>","properties":{"Effect":"negative"},"reason":"<the words of the sentence that state this relation, copied from the msrc line with the entities as written there (ID{ids=text}), at most 25 words — required, never empty>"}],"skipped":[{"lines":[2],"reason":"<why>"}]}`;

// a hyphen is a token of its own; a word with a hyphen must be written as a quoted phrase
// a pattern needs the relation-carrying word between the entities: once @regulator, @target, $ACT, gaps (@.{0,N}, [^$X]{0,N}) and #define lines are removed, a word / macro / quoted text must be left
const hasRelationWord = (p) => /[A-Za-z$"]/.test(String(p).replace(/^\s*#define.*$/gm, '').replace(/@regulator|@target|@in(?![\w])|@out(?![\w])|\$ACT\b|@\.(\{[^}]*\}|[*+?])?|\[\^[^\]]*\](\{[^}]*\}|[*+?])?/g, ''));
const HYPHEN_RULE ='A word with a hyphen can NOT be written as a bare word in a word set (anti-, anti-relapse: "illegal wordset element: -"). Quote it exactly as it stands in the sentence: "anti-". Text in double quotes is matched AS IS, character for character, with no tokenization. A prefix stuck to an entity in the tagged sentence (anti-ID{relapse}) is the text anti-; a macro such as $ANTI = [anti "anti -"] does NOT match it ("anti -" has a space), so write [$ANTI "anti-"] (the macro AND the quoted word) and put nothing else between that word set and @target.';
const ONCE_RULE = 'Never repeat a word that a macro of the same word set already contains: the macro definitions you are given list every word the macro accepts (including those of the macros it includes), so [$ASSOCIATE_BM relate~] is wrong when $ASSOCIATE_BM already has relate~ — write [$ASSOCIATE_BM], or drop the macro and keep only the word. A word set is either macros, or words, or macros plus words that none of them contains. Do not list two macros that overlap. Check that a macro does not bring in words of another meaning than the relation (e.g. a macro that also holds is / were).';
const LONG_RULE = 'LONG PATTERNS must exclude negation: when the pattern can span more than 10 tokens between @regulator and @target (add up the upper bounds of its gaps {0,N} and the words it requires), write every gap of 5 or more tokens as a guard that refuses negation words — [^$NOT]{0,20}, or [^$NOT $NEGSENSE]{0,20} when the relation is not Effect=negative — NOT as the free gap @.{0,20}. The guard makes sure that no negation is mentioned between the entities, so the relation is not extracted from a negated statement. Use the negation macros that the cartridge really has (look in the macro list for $NOT, $NEGSENSE or a macro whose name says negation; never invent a name); if it has none, spell the words out, e.g. [^no not nor without]{0,20}. Short gaps (up to 4 tokens) stay @.{0,N}. Example: @regulator [^$NOT]{0,20} [$BENEFIT2 $HIGHER] @.{0,4} [$ROLE] @.{0,3} [$REGULATION_ALL] @.{0,2} @target.';
const SHORT_RULE = 'Design the SHORTEST pattern that still works on the given sentence: only the words the sentence really needs between @regulator and @target (the relation-carrying verb, plus a negation guard or a word that is essential for the meaning), the tightest gaps that cover the tokens in the sentence (a gap of 2 tokens is @.{0,2}, not @.{0,10}), one word or macro per position, no optional extras, and no alternatives or words "for generality" that the sentence does not show. Do not try to anticipate other sentences: the app collects the patterns and merges them into more general ones later (a consolidation step), so a precise, minimal pattern for THIS sentence is what is wanted.';
const VERB_RULE ='EVERY pattern must have the structure ENTITY - VERB - ENTITY: @regulator, then the verb (or the noun/phrase that carries the relation, e.g. a word set such as [relate~ "lead to"] or a verb macro), then @target. A pattern without the relation-carrying word is NOT acceptable: @regulator $ACT @target, @regulator @.{0,5} @target or any pattern that only skips tokens between the entities would match every pair of entities and is rejected. $ACT is NOT a verb and NOT a verb macro: it only matches the ampersand (&) that ConceptScan puts between the parts of a pseudo-sentence, so it never replaces the verb. Write the verb itself next to it, e.g. @regulator $ACT [raise~] @target.';
// the same rule for a pattern on the tagged sentence (no pseudo-sentence, no $ACT)
const VERB_RULE_SENT = 'EVERY pattern must have the structure ENTITY - VERB - ENTITY: @regulator, then the verb (or the noun/phrase that carries the relation, e.g. a word set such as [relate~ "lead to"] or a verb macro), then @target. A pattern without the relation-carrying word is NOT acceptable: @regulator @.{0,5} @target or any pattern that only skips tokens between the entities would match every pair of entities and is rejected.';
// The short version of SYSTEM_GUESS for a small local model: the relation type must come from the "Covered pairs" table, properties only the listed ones.
const SYSTEM_GUESS_LOCAL = `You analyse one sentence for MedScan relation extraction. Reply with JSON only.
You get the sentence, its markup (entities are written ID{ids=text}), the numbered pseudo-sentences P1..Pn (noun - verb - noun triples), the node types present, the relation types of the cartridge and a table "Covered pairs".
Task: list the relations the sentence states between its marked-up entities (at most 6). For each: "lines" = the numbers of the pseudo-sentences it comes from, "relation" = relation type, "regulator" = node type of the source entity, "target" = node type of the target entity, "properties", "reason".
RULES:
1. Use only node types and relation types that are listed; copy the names exactly.
2. The regulator and target node types are those of two entities that stand in the pseudo-sentence(s) you list; the regulator acts on the target.
3. The relation type MUST be one that the table "Covered pairs" lists for exactly that regulator → target pair. Only when the table says "none" for the pair may you choose another relation type by its meaning.
4. "properties": ONLY properties that are listed for that relation type ("properties: ..."); a relation type without listed properties gets {}. Never invent a property or a value. Effect = positive (increases, activates), negative (decreases, inhibits) or unknown. For any other property use one of its listed example values, or leave it out.
5. "reason": the words of the sentence that state the relation, copied from the msrc line (at most 25 words); required.
6. Pseudo-sentences with the same structure and relation go into ONE item ("lines":[1,3]). A pseudo-sentence that fits no relation type goes into "skipped" with the reason.
Reply with JSON only:
{"items":[{"lines":[1],"relation":"<relation type>","regulator":"<node type>","target":"<node type>","properties":{},"reason":"<words of the sentence>"}],"skipped":[{"lines":[2],"reason":"<why>"}]}`;
// THE DESIGN PROMPTS: the app sends one of two, by the kind of pattern the row needs — never both in one:
//   * a ConceptScan pattern (the row has pseudo-sentences): the message holds ONLY the pseudo-sentences (no sentence, no markup), the pattern has $ACT   → SYSTEM_PATTERN_CS / SYSTEM_PATTERN_CS_LOCAL
//   * a tagged-sentence pattern (no pseudo-sentence): the message holds ONLY the tagged sentence, "$ACT" and "&" are not mentioned                     → SYSTEM_PATTERN_SENT / SYSTEM_PATTERN_SENT_LOCAL
// A small local model (llama3.1:8b …) gets the short versions (…_LOCAL): the full prompts are ~3000 tokens, which with the markup and the macros is more than the context of such a model
// (Ollama cuts an overlong prompt at its START: the instructions were lost and the model "explained" the macro list). The task is also repeated at the END of the user message (TASK_END_*).
const SYSTEM_PATTERN_SENT_LOCAL = `You write ONE kind of text: an extraction pattern for MedScan msgrep. You never explain macros and never describe the text.
The pattern works on a TAGGED SENTENCE: the original sentence in which the recognised entities are written ID{ids=text}.
Syntax:
- @regulator and @target are the two entities; both must occur once, exactly like this.
- Structure: ENTITY - RELATION WORD - ENTITY, e.g.  @regulator [raise~ increase~] @target
- [a b c] = one of the words (white space separates alternatives); a phrase must be in double quotes: [fail "fails to"]. A trailing ~ matches all inflections (raise~). Text in double quotes is matched as is.
- $NAME is a macro (a word set) of the cartridge: use the macros listed in the message, never invent a name; write words yourself only when no macro fits.
- @.{0,3} = up to 3 arbitrary tokens (gap). A bare "." is an error. [^$NOT]{0,10} = up to 10 tokens that are not $NOT.
- A word with a hyphen is a quoted word: "anti-".
- Every token between @regulator and @target (each word, each ID{...} entity) must be matched or bridged by a gap. An entity token ID{...} cannot be matched by a word macro: skip it with @.{0,N}.
- Match only the core: the words that carry the relation (and its direction: increase, decrease, no, not). Bridge dose, adjectives, numbers and other qualifiers with a gap @.{0,N}.
- Short and precise: the tightest gaps that fit the sentence, one word or macro per position.
Example (tagged sentence "ID{..disease..} raises ID{..IgE..} levels"):
@regulator [raise~] @target [level~ amount~]
Reply with THREE different candidate patterns, each in its own markdown code block, nothing else: (1) the general one, (2) a looser one (wider gaps, more words), (3) one with a different structure.`;
const SYSTEM_PATTERN_CS_LOCAL = `You write ONE kind of text: an extraction pattern for MedScan msgrep. You never explain macros and never describe the text.
The pattern works on a CONCEPTSCAN PSEUDO-SENTENCE: a normalised "noun - verb - noun" line in which every recognised entity is one token ID{ids=text} and the parts are joined by "&".
Syntax:
- @regulator and @target are the two entities; both must occur once, exactly like this.
- Structure: ENTITY - RELATION WORD - ENTITY, e.g.  @regulator [raise~ increase~] @target
- [a b c] = one of the words (white space separates alternatives); a phrase must be in double quotes: [fail "fails to"]. A trailing ~ matches all inflections (raise~). Text in double quotes is matched as is.
- $NAME is a macro (a word set) of the cartridge: use the macros listed in the message, never invent a name; write words yourself only when no macro fits.
- @.{0,3} = up to 3 arbitrary tokens (gap). A bare "." is an error. [^$NOT]{0,10} = up to 10 tokens that are not $NOT.
- A word with a hyphen is a quoted word: "anti-".
- NEVER write a bare "&": where the pseudo-sentence has "&" write $ACT (it matches that "&"). Every pattern you write contains $ACT, right after the first entity.
- Every token between @regulator and @target (each word, each ID{...} entity, the "&") must be matched or bridged by a gap. A gap [^$ACT]{0,N} cannot cross the "&": write @.{0,N} before $ACT.
- Match only the core: the words that carry the relation (and its direction: increase, decrease, no, not). Bridge dose, adjectives, numbers and other qualifiers with a gap @.{0,N}.
- Short and precise: the tightest gaps that fit the sentence, one word or macro per position.
Example (normalised sentence "ID{..disease..} & raise ID{..IgE..} levels"):
@regulator $ACT [raise~] @target [level~ amount~]
Reply with THREE different candidate patterns, each in its own markdown code block, nothing else: (1) the general one, (2) a looser one (wider gaps, more words), (3) one with a different structure.`;
const TASK_END_CS = 'TASK: write the extraction pattern for the pseudo-sentence(s) above. Reply with THREE different candidate patterns, each in its own markdown code block, no explanation and no other text. Every pattern has @regulator, $ACT (where the pseudo-sentence has "&"), a relation word (word, word set or macro) and @target.';
const TASK_END_SENT = 'TASK: write the extraction pattern for the tagged sentence above. Reply with THREE different candidate patterns, each in its own markdown code block, no explanation and no other text. Every pattern has @regulator, a relation word (word, word set or macro) and @target.';
// the tagged-sentence prompt: no pseudo-sentences, no "&", no $ACT
const SYSTEM_PATTERN_SENT = `You write extraction patterns for MedScan msgrep (.msgrep files of a cartridge). The pattern works on a TAGGED SENTENCE: the original sentence in which the recognised entities are written ID{ids=text} (every word and every ID{…} is one token). Syntax you need:
- @regulator and @target stand for the two entities (they must both occur exactly like this).
- [a b c] is an alternation of words: WHITE SPACE separates the alternatives, so a phrase of two or more words must be double-quoted ([fail "fails to" "failed to"]; [fails to] would mean the two words "fails" or "to"). Text in double quotes is matched AS IS as one literal string, with no tokenization ("anti-" matches exactly the characters anti-, "anti -" only anti, a space and a hyphen), a trailing ~ matches all inflections (raise~ = raise, raises, raised, raising), ? makes the previous item optional,
  {0,3} limits a repetition, (x | y) groups alternatives, [^$AND]{0,3} means up to 3 tokens that are not $AND.
- ${HYPHEN_RULE}
- ${VERB_RULE_SENT}
- ${ONCE_RULE}
- ${LONG_RULE}
- ${SHORT_RULE}
- ANY single token is written @. (with the @!): @.{0,3} = up to 3 arbitrary tokens, @.* = any number of tokens. A bare "." or ".{0,3}" is a syntax error ("illegal wordset element"). Use @.{0,N} / @.* for gaps, or [^$X]{0,N}.
- $NAME and @NAME are macros already defined in the cartridge (word sets); ALWAYS prefer them over spelling words out. Before you write any alternation of words, go through the macro list (definitions are given for the most relevant ones, the rest only by name) and use a macro whenever it covers the concept (e.g. $MUTATION for variants/mutations/alleles/polymorphisms, $LEVEL for levels/amount/abundance). Only write words yourself when no macro fits. A macro covers a word ONLY if the word is in its definition — definitions shown to you may be shortened; when the word you need is not visible in the definition, write it yourself next to the macro, e.g. [variant~ $MUTATION]. Do NOT drop a macro because one word of the sentence is missing from it, and do not restructure the pattern around that word: keep the macro and add the missing word inside the same brackets. The app tells the user which words should be added to which macro.
The CONTROL rule of the pattern has fixed properties (given below, e.g. Effect=negative): the pattern must express exactly that and nothing else — e.g. for Effect=negative only words of decrease / inhibition / reduction, none of the opposite meaning.
Design the pattern on the tagged sentence you are given (entities written ID{ids=text}; the words between them are what the pattern matches) — never answer that there is nothing to match.
Entities in the sentence are single tokens written ID{…}: word macros (e.g. $PATIENT, $MUTATION) can NOT match them — an entity can only be matched by @regulator / @target or skipped by a gap like @.{0,3}. Match only the plain words, and skip everything else with gaps.
THE PATTERN IS A LEFT-TO-RIGHT WALK over the tokens between @regulator and @target: it must account for EVERY token, in order (every word and every ID{…} entity is one token); bridge what is not essential with gaps @.{0,N}, counting the tokens.
ENTITY PROXIMITY: @regulator / @target match the CLOSEST marked-up entity of their node type; another entity of that type standing between them and the pattern words cannot be skipped. Design the pattern for the entities that really are neighbours for their types, even if the relation named in the task seems to link entities farther apart; if the given pair cannot be extracted for this reason, answer with the pattern for the neighbouring pair and say nothing else.
Keep the pattern general (word sets and macros, not the exact sentence), but precise enough not to over-match.
CORE MEANING ONLY: a pattern expresses the core of the relation (regulator – the word(s) that carry the relation – target) and nothing else. Words that only qualify it must NOT be turned into required words or word sets: dose / amount / degree ("lower dose", "high concentration"), adjectives and adverbs, numbers, units, time or place phrases, hedges, brackets. Bridge them with a gap @.{0,N} (N at least the number of such tokens, with a little room) so the pattern also fires when the qualifier is different or missing. Example: "ID{drug} at lower dose produces ID{effect} on Day 7" → @regulator @.{0,3} [$CAUSE $YIELD] @.{0,3} @target, NOT @regulator [$LOWER $TONE]{0,3} … (it would only fire for "lower" doses). EXCEPTION — words that decide the CONTROL properties (Effect …): a direction / polarity word that acts on the RELATION itself (increase, decrease, reduce, relieve, block, improve; negation such as "no", "not", "lack of", "fail to", "without") is part of the core: never drop it and never bridge it. Write it with the macros of the cartridge for that kind of word: use the section "Macros that existing patterns with the same properties use" first, then the macro list. The test: does the word change the direction of the relation between regulator and target? Yes → keep it as a macro. It only describes the regulator or the target → qualifier, bridge it.
Example (regulator Disease, target Complex, relation QuantitativeChange, tagged sentence "ID{..disease..} raises ID{..IgE..} levels"):
@regulator [raise~] @target [activity level~ amount~ abundance~]
Reply with THREE different candidate patterns, each in its own markdown code block, no explanation: (1) the most general pattern that still expresses the core relation, (2) a looser variant (wider gaps, more words in the word sets), (3) a variant with a different structure. Every candidate must be a complete, valid pattern.`;
// the ConceptScan prompt: the pseudo-sentences only, the pattern has $ACT
const SYSTEM_PATTERN_CS = `You write extraction patterns for MedScan msgrep (.msgrep files of a cartridge). Syntax you need:
- @regulator and @target stand for the two entities (they must both occur exactly like this).
- [a b c] is an alternation of words: WHITE SPACE separates the alternatives, so a phrase of two or more words must be double-quoted ([fail "fails to" "failed to"]; [fails to] would mean the two words "fails" or "to"). Text in double quotes is matched AS IS as one literal string, with no tokenization ("anti-" matches exactly the characters anti-, "anti -" only anti, a space and a hyphen), a trailing ~ matches all inflections (raise~ = raise, raises, raised, raising), ? makes the previous item optional,
  {0,3} limits a repetition, (x | y) groups alternatives, [^$AND]{0,3} means up to 3 tokens that are not $AND.
- ${HYPHEN_RULE}
- ${VERB_RULE}
- ${ONCE_RULE}
- ${LONG_RULE}
- ${SHORT_RULE}
- ANY single token is written @. (with the @!): @.{0,3} = up to 3 arbitrary tokens, @.* = any number of tokens. A bare "." or ".{0,3}" is a syntax error ("illegal wordset element"). Use @.{0,N} / @.* for gaps, or [^$X]{0,N}.
- $NAME and @NAME are macros already defined in the cartridge (word sets); ALWAYS prefer them over spelling words out. Before you write any alternation of words, go through the macro list (definitions are given for the most relevant ones, the rest only by name) and use a macro whenever it covers the concept (e.g. $MUTATION for variants/mutations/alleles/polymorphisms, $LEVEL for levels/amount/abundance). Only write words yourself when no macro fits. A macro covers a word ONLY if the word is in its definition — definitions shown to you may be shortened; when the word you need is not visible in the definition, write it yourself next to the macro, e.g. [variant~ $MUTATION]. Do NOT drop a macro because one word of the sentence is missing from it, and do not restructure the pattern around that word: keep the macro and add the missing word inside the same brackets, e.g. the sentence has "medication" and $TREATMENT_WORDS does not contain it → [$TREATMENT_WORDS $MOLECULE medication]. The app tells the user which words should be added to which macro.
- $ACT matches the "&" that ConceptScan puts into the normalised pseudo sentence ("< #Main ID{..} & raise ID{..} levels"). The pattern runs on the ConceptScan output, so every pattern you write contains $ACT.
NEVER write a bare "&" in a pattern — it is a syntax error ("expected &NAME"). Wherever the pseudo-sentence has "&" (between the entities or elsewhere), write $ACT.
Rules: you are given the pseudo-sentence(s) the pattern must match (normalised noun - verb - noun lines with "&" between the parts and entities written as single tokens ID{…}); write a ConceptScan pattern for them that uses $ACT where they have the "&". Design it on the pseudo-sentences only — never answer that there is nothing to match.
The CONTROL rule of the pattern has fixed properties (given below, e.g. Effect=negative): the pattern must express exactly that and nothing else — e.g. for Effect=negative only words of decrease / inhibition / reduction, none of the opposite meaning.
The pattern must match ALL the pseudo-sentences you are given (they share one structure) with the regulator and target entities of the given node types.
Entities in the pseudo-sentences are single tokens written ID{…}: word macros (e.g. $PATIENT, $MUTATION) can NOT match them — an entity can only be matched by @regulator / @target or skipped by a gap like @.{0,3}. Match only the plain words, and skip everything else with gaps.
THE PATTERN IS A LEFT-TO-RIGHT WALK over the tokens of the sentence (every word, every ID{…} and the "&" is one token). Between @regulator and @target the pattern must account for EVERY token, in order, and the "&" must be matched by $ACT at its exact position. A gap [^$ACT]{0,N} can NEVER cross the "&" (it stops in front of it), so words that stand between the entity and the "&" (e.g. "lower dose" in "ID{drug} lower dose & produce Day 7 ID{effect}") need @.{0,N}, followed by $ACT. Wrong: @regulator [^$ACT]{0,4} $CAUSE @target (the "&" is never consumed, nothing matches). Right: @regulator @.{0,4} $ACT $CAUSE [^$ACT]{0,3} @target. A user message may contain a "Token walk" line: follow it.
Keep the pattern general (word sets and macros, not the exact sentence), but precise enough not to over-match.
CORE MEANING ONLY: a pattern expresses the core of the relation (regulator – the word(s) that carry the relation – target) and nothing else. Words that only qualify it must NOT be turned into required words or word sets: dose / amount / degree ("lower dose", "high concentration"), adjectives and adverbs, numbers, units, time or place phrases, hedges, brackets. Bridge them with a gap @.{0,N} (N at least the number of such tokens, with a little room) so the pattern also fires when the qualifier is different or missing. Example: "ID{drug} lower dose & produce Day 7 ID{effect}" → @regulator @.{0,3} $ACT [$CAUSE $YIELD] @.{0,3} @target, NOT @regulator [$LOWER $TONE]{0,3} $ACT … (it would only fire for "lower" doses). EXCEPTION — words that decide the CONTROL properties (Effect …): a direction / polarity word that acts on the RELATION itself (increase, decrease, reduce, relieve, block, improve; negation such as "no", "not", "lack of", "fail to", "without") is part of the core: never drop it and never bridge it. Write it with the macros of the cartridge for that kind of word, so the pattern covers the whole family of such words and not just the one in the sentence: use the section "Macros that existing patterns with the same properties use" first, then the macro list. Example: "ID{drug} increase & relieve ID{pain}" with Effect=negative (the drug reduces the pain) → @regulator $INCREASE $ACT $RELIEVE @target (macros, not the literal words). The test: does the word change the direction of the relation between regulator and target? Yes → keep it as a macro. It only describes the regulator or the target ("lower dose", "high concentration") → qualifier, bridge it.
Example (regulator Disease, target Complex, relation QuantitativeChange, normalised sentence "ID{..disease..} & raise ID{..IgE..} levels"):
@regulator $ACT [raise~] @target [activity level~ amount~ abundance~]
Reply with THREE different candidate patterns, each in its own markdown code block, no explanation: (1) the most general pattern that still expresses the core relation, (2) a looser variant (wider gaps, more words in the word sets), (3) a variant with a different structure. Every candidate must be a complete, valid pattern.`;

// The app picks the repair prompt: ConceptScan pseudo-sentences (the row has pseudo-sentences, the pattern uses $ACT) or the tagged sentence (msrc line).
const SYSTEM_REPAIR_CS = `${HYPHEN_RULE}
${VERB_RULE}
${ONCE_RULE}
${LONG_RULE}
${SHORT_RULE}
You repair a MedScan extraction pattern that was compiled and run on the real ConceptScan output of the sentence. You get the pseudo-sentences it must match (lines starting with "<", normalised noun-verb-noun triples with an "&" between the parts and no other markup in between), the pattern and what happened (a compile error, or no output term).
The pattern is a left-to-right walk over the tokens (every word, every ID{…} and the "&" is one token) and must contain $ACT exactly where the pseudo-sentence has the "&".
Typical causes: the "&" is not matched by $ACT (a gap [^$ACT]{…} stops in front of the "&", it can never cross it: put @.{0,N} before $ACT for the words between the entity and the "&"); a word macro or word is placed where the pseudo-sentence has an entity token ID{…} (word macros never match entities; skip entities with a gap such as @.{0,3}); a required word that is not in the pseudo-sentence; a gap that is too short (count the tokens); a macro that does not contain the word used in the sentence; the order of @regulator / @target / $ACT does not follow the pseudo-sentence. Follow the "Token walk" line when it is given.
Make the smallest change that makes the pattern match all given pseudo-sentences, keep @regulator, @target and $ACT. Reply with the corrected pattern ONLY, in one markdown code block.`;
const SYSTEM_REPAIR_TAGGED = `${HYPHEN_RULE}
${VERB_RULE_SENT}
${ONCE_RULE}
${LONG_RULE}
${SHORT_RULE}
You repair a MedScan extraction pattern that was compiled and run on the TAGGED sentence (the "msrc" line of the markup: the original sentence in which recognised entities are written ID{ids=text}). There are no pseudo-sentences and no "&": the pattern must NOT contain $ACT or "&". You get the tagged sentence, the pattern and what happened (a compile error, or no output term).
The pattern is a left-to-right walk over the real words of the sentence; every word and every ID{…} is one token. Typical causes: a gap that is too short or too long (count the tokens between @regulator and @target; use @.{0,N}, with N at least the number of tokens you do not match, or [^$X]{0,N}); a word, stem or macro that does not match the actual word in the sentence (a macro covers a word only if the word is in its definition: add the word next to the macro inside the same brackets); words in the sentence the pattern has not accounted for between the entities (the sentence has extra clauses, brackets, commas, "which is", "a metabolite of": every token must be matched or bridged); the order of @regulator and @target does not follow the sentence; the wrong entity: @regulator / @target bind to the CLOSEST marked-up entity of their node type, another entity of that type standing in between cannot be skipped, so design the pattern for the entities that really are neighbours; a wrong inflection (use a trailing ~ for all forms).
Make the smallest change that makes the pattern match the tagged sentence, keep @regulator and @target, and do not add $ACT. Reply with the corrected pattern ONLY, in one markdown code block.`;

const JSON_ONLY = 'Answer NOW with the JSON object only — no reasoning, no explanation, no text before or after it.';

// The first well-formed JSON object in the reply that has one of the wanted keys (a model may think aloud before it answers).
function parseJsonObject(s, keys = ['items', 'relation', 'index']) {
  const t = String(s || '');
  for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
    let depth = 0, inStr = false;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { const o = JSON.parse(t.slice(i, j + 1)); if (o && typeof o === 'object' && keys.some(k => k in o)) return o; } catch { /* next candidate */ }
        break;
      }
    }
  }
  return null;
}
// ( … ) around the whole pattern, with no | inside, is only a wrapper: the patterns of a set are written without it
function unwrapGroup(p) {
  if (p[0] !== '(') return p;
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '"') { const e = p.indexOf('"', i + 1); if (e < 0) return p; i = e; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return i === p.length - 1 ? unwrapGroup(p.slice(1, -1).trim()) : p; }
    else if (c === '|' && depth === 1) return p;
  }
  return p;
}
// A ConceptScan pseudo-sentence is "ENTITY & word ENTITY": a pattern for it has $ACT right after its first entity (the "&"), a pattern for the tagged sentence has none.
// Small models forget it or put it elsewhere: it is put there (csMode) / taken out (not csMode); the real test that follows decides whether the pattern works.
function ensureAct(p, csMode) {
  const t = String(p || '');
  const noAct = t.replace(/[ \t]*\$ACT\b[ \t]*/g, ' ').replace(/ {2,}/g, ' ').replace(/ +$/gm, '');
  if (!csMode) return /\$ACT\b/.test(t) ? noAct.trim() : t;
  if (/@(regulator|target)\s+\$ACT\b/.test(t)) return t;                    // already right after the first entity
  if (/^[^@]*\$ACT\b/.test(t)) return t;                                      // $ACT in front of the entities: left as it is
  return noAct.replace(/@(regulator|target)\b/, m => m + ' $ACT');
}
function parsePattern(s) {
  const t = String(s || '');
  const f = t.match(/```[a-z]*\r?\n([\s\S]*?)```/i);
  // a bare "&" copied from the pseudo-sentence is not valid pattern syntax: the ConceptScan action token is written $ACT
  return applyFixes(unwrapGroup((f ? f[1] : t).trim()).replace(/(^|\s)&(?=\s|$)/g, (m, sp) => sp + '$ACT'));   // + the spell-check fixes (a bare ".{0,3}" → "@.{0,3}")
}
// every candidate pattern of a reply (one per markdown code block), at most 3
// the two entities of a pattern: @regulator / @target (the convention of new patterns) or @in / @out (the names the CONTROL rules of older patterns use: in = regulator, out = target) — both count, the text is never rewritten
const hasRegulator = (p) => /@(regulator|in)(?![\w])/.test(p);
const hasTarget = (p) => /@(target|out)(?![\w])/.test(p);
function parsePatterns(s) {
  const ok = (p) => hasRegulator(p) && hasTarget(p);
  const out = [];
  for (const m of String(s || '').matchAll(/```[a-z]*\r?\n([\s\S]*?)```/gi)) { const p = parsePattern('```\n' + m[1] + '```'); if (ok(p) && !out.includes(p)) out.push(p); }
  // fences that do not pair up (an opening ``` missing, a stray one): cut the reply at every fence marker and take each piece that holds both entities
  if (!out.length) for (const seg of String(s || '').split(/```[a-z]*/i)) { const p = parsePattern(seg); if (ok(p) && !out.includes(p)) out.push(p); }
  if (!out.length) { const p = parsePattern(s); if (ok(p)) out.push(p); }
  return out.slice(0, 3);
}
// a reply without a usable pattern (no @regulator / @target, prose around it) may still hold a pattern: the code block, or the block of the reply that looks like a pattern
// (starts with ( [ @ $, balanced brackets, no prose sentence). → the text, or '' — offered to the user to open for editing and tweak
function looseCandidate(reply) {
  const t = String(reply || '');
  const blocks = [...t.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/gi)].map(m => m[1]);
  if (!blocks.length) blocks.push(...t.split(/\r?\n\s*\r?\n/));
  const balanced = (s) => { let d = 0; for (const c of s) { if (c === '(' || c === '[' || c === '{') d++; else if (c === ')' || c === ']' || c === '}') { d--; if (d < 0) return false; } } return d === 0; };
  const scored = blocks.map(b => b.trim()).filter(b => /^[(\[@$]/.test(b) && /[@$\[]/.test(b) && balanced(b) && !/[.!?]\s+[A-Z]/.test(b.replace(/@\.[{*+?]?[\d,}]*\s/g, ''))).map(b => ({ b, n: b.length }));
  scored.sort((a, b) => b.n - a.n);
  return scored.length ? parsePattern('```\n' + scored[0].b + '\n```') : '';
}
// "Other cartridges": the current cartridge has no relation type for this sentence — which sibling cartridge has one?
const SYSTEM_OTHERS = `You help to find the MedScan cartridge in which a relation of a sentence can be extracted. The current cartridge has no suitable relation type for the sentence. You get the sentence and, for every other cartridge, what that cartridge marks up in it (node types with examples), the ConceptScan pseudo-sentences, its relation types (with the regulator → target node types its existing rules allow and the properties it knows) and a table of the covered pairs.
Pick the cartridges where the sentence really states a relation between two marked-up entities and a relation type of that cartridge describes it (same rules as for a single cartridge: the meaning of the sentence decides, not the node types alone). Prefer a relation type whose existing rules already allow the pair (listed in "Covered pairs"); a pair that is not covered is possible but needs a new rule — say so in the reason. Do not invent cartridges, relation types or node types: use only the names you are given. At most one match per cartridge (the best one); no match at all is a valid answer.
Reply with JSON only: {"matches":[{"cartridge":"<cartridge name>","relation":"<relation type>","regulator":"<node type>","target":"<node type>","properties":{"Effect":"negative"},"reason":"<one short sentence>"}]}`;

// the pseudo-sentences: lines of the ConceptScan output that start with "<"
// the markup without the pseudo-sentences (the lines that start with "<"): sent to the LLM when the pattern is to be designed for the SENTENCE, so a pseudo-sentence with an & cannot pull it into a ConceptScan pattern
// the tagged sentence of a markup: the msrc line(s) with the entities written ID{ids=text} (no pseudo-sentences, no mref / TextMods lines)
const taggedSentence = (markup) => String(markup || '').split(String.fromCharCode(10)).filter(l => /^msrc\s/.test(l)).map(l => l.replace(/^msrc\s+/, '').trim()).join(String.fromCharCode(10)) || withoutPseudo(markup);
const withoutPseudo = (markup) => String(markup || '').split(String.fromCharCode(10)).filter(l => !/^<\s/.test(l)).join(String.fromCharCode(10));
// the markup with only the chosen pseudo-sentences (P1, P2 ... = the 1st, 2nd ... line that starts with "<"): mref / msrc stay. "Is this relation already extracted?" must be asked of the
// pseudo-sentences the row is about, not of the whole sentence - an existing pattern that finds ANOTHER relation of the sentence (same node types) is no answer.
const markupOfLines = (markup, lines) => {
  let n = 0;
  return String(markup || '').split(String.fromCharCode(10)).filter(l => { if (!/^<s/.test(l)) return true; n++; return lines.includes(n); }).join(String.fromCharCode(10));
};
const entityNamesOf = (line) => [...String(line || '').matchAll(/ID{[^=}]*=([^}]*)}/g)].map(m => m[1].trim().toLowerCase());
const pseudoLines = (markup) => String(markup || '').split(String.fromCharCode(10)).map(l => l.replace(/\r$/, '')).filter(l => /^<\s/.test(l)).map(l => l.replace(/^<\s+/, '').trim());

// ID{…} tokens in green, the rest as is
function Tokens({ text }) {
  return <>{String(text).split(/(ID[{][^}]*[}])/).map((t, i) => /^ID[{]/.test(t) ? <span key={i} style={{ color: '#a6e3a1', fontWeight: 700 }}>{t}</span> : <span key={i}>{t}</span>)}</>;
}

export default function SuggestPatternModal({ cart, sentence, markup, markupView, wizardOpen, runOpts, preset, pipelineCart, onRunWith, onSwitchCartridge, onClose, onResult, extractedRels = [] }) {
  const [ctx, setCtx] = useState(null);
  const [skipped, setSkipped] = useState([]);   // [{ lines, reason }] pseudo-sentences the LLM did not use
  const [rows, setRows] = useState(null);         // [{ id, lines:[n…], relation, regulator, target, reason, checked }]
  // A relation type that GraphExplorer shows under the name of ANOTHER type of the list (ExpressionControl as "Expression", UnknownRegulation as "Regulation") is one choice: "Expression (ExpressionControl)".
  // dupOf: { Expression: 'ExpressionControl', Regulation: 'UnknownRegulation' } - the plain-named type is not listed again; a row that has it is shown (and used) as the kept one.
  const dupOf = React.useMemo(() => {
    const m = {};
    for (const x of Object.keys(ctx?.relations || {})) { const a = ctx.aliases?.[x]; if (a && a !== x && ctx.relations[a] !== undefined) m[a] = x; }
    return m;
  }, [ctx]);
  useEffect(() => { if (rows && rows.some(r => dupOf[r.relation])) setRows(rs => rs.map(r => (dupOf[r.relation] ? { ...r, relation: dupOf[r.relation] } : r))); }, [rows, dupOf]);
  const [phase, setPhase] = useState('guess');    // guess | confirm | design
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);
  const [errorReply, setErrorReply] = useState('');          // the complete LLM reply when it held no usable pattern
  const [errorRow, setErrorRow] = useState(null);            // the relation row that design failed for (the reply's pattern can be opened for it)
  const looseP = React.useMemo(() => looseCandidate(errorReply), [errorReply]);
  const started = useRef(false);
  const api = window.api.relation;
  const pseudo = pseudoLines(markup);

  // for every ordered pair of node types in the markup: the relation types whose existing rules already allow it
  const covered = (c) => {
    const names = c.types.map(t => t.type), out = [];
    for (const a of names) for (const b of names) {
      if (a === b && (c.types.find(x => x.type === a)?.examples.length || 0) < 2) continue;   // same type on both sides only when two entities of it are marked up
      const rels = Object.keys(c.relations).filter(r => c.usage?.[r]?.regulators.includes(a) && c.usage?.[r]?.targets.includes(b));
      out.push(`${a} → ${b}: ${rels.length ? rels.join(', ') : 'none'}`);
    }
    return out.join('\n');
  };

  const keyLabel = (c, rel, k) => (c.propAliases?.[rel]?.[k] ? `${k} (GraphExplorer shows it as ${c.propAliases[rel][k]})` : k);
  const fmtPropsOf = (c, n) => { const p = c.props?.[n]; return p && Object.keys(p).length ? '; properties: ' + Object.entries(p).map(([k, v]) => `${keyLabel(c, n, k)} ${k === 'Effect' ? '∈' : 'e.g.'} {${v.slice(0, 14).join(', ')}}`).join(', ') : ''; };

  const askGuess = async (c) => {
    const fmtProps = (n) => fmtPropsOf(c, n);
    setPhase('guess'); setError(null);
    let local = false;                                                              // a local model: the short prompt, and the answer is checked against the rules of the cartridge
    try { local = llmTargetOf(await window.api.settings.get(), 'suggest.guess') === 'local'; } catch { /* the provider */ }
    const fallback = [{ id: 0, lines: [], relation: Object.keys(c.relations)[0] || '', regulator: c.types[0]?.type || '', target: c.types[1]?.type || '', props: {}, reason: '', checked: true }];
    try {
      const fmtUse = (n) => { const u = c.usage?.[n]; return u && (u.regulators.length || u.targets.length) ? `; existing rules: regulators ${u.regulators.join(', ')} → targets ${u.targets.join(', ')}` : '; no rules yet'; };
      const rels = Object.entries(c.relations).map(([n, roles]) => `${n} (${c.aliases?.[n] ? `GraphExplorer shows it as ${c.aliases[n]}; ` : ''}${roles === 'in,out' ? 'directional' : 'non-directional'}${fmtUse(n)}${fmtProps(n)})`);
      const user = [
        `Cartridge: ${cart.name}`, `Sentence: ${sentence}`,
        `MedScan markup:\n${String(markup).slice(0, local ? 2000 : 3500)}`,
        `Pseudo-sentences:\n${pseudo.map((l, i) => `P${i + 1}: ${l}`).join('\n') || '(none)'}`,
        `Node types present in the markup: ${c.types.map(t => `${t.type} (${t.examples.join('; ')})`).join(', ') || '(none)'}`,
        `Relation types of this cartridge: ${rels.join(', ')}`,
        `Covered pairs (regulator → target: relation types whose existing rules already allow it):\n${covered(c) || '(none)'}`,
      ].join('\n\n');
      // a reasoning model can use up the token budget thinking aloud: ask again, shorter and stricter, with more room
      let g = null, reply = '';
      for (let attempt = 0; attempt < 2 && !g; attempt++) {
        reply = await callLlm([{ role: 'system', content: local ? SYSTEM_GUESS_LOCAL : SYSTEM_GUESS }, { role: 'user', content: user + '\n\n' + JSON_ONLY }],
          { fn: 'suggest.guess', grounding: false, json: true, maxTokens: 8192, minNumCtx: 16384 });
        g = parseJsonObject(reply);
      }
      const items = g && (Array.isArray(g.items) ? g.items : (g.relation ? [g] : null));
      if (!items) throw new Error('The LLM reply was not readable (tried twice): ' + JSON.stringify(String(reply).slice(0, 160)));
      const names = c.types.map(t => t.type);
      const nl = String.fromCharCode(10);
      const noPair = [];                                      // proposed relations whose entities are not neighbours → skipped
      const out0 = items.slice(0, 6).map((it, n) => {
        const asked = String(it.relation || '').toLowerCase();                  // the cartridge name, or the GraphExplorer name of it
        let relName = Object.keys(c.relations).find(r => r.toLowerCase() === asked) || Object.keys(c.relations).find(r => (c.aliases?.[r] || '').toLowerCase() === asked) || Object.keys(c.relations)[0] || '';
        let reg = names.includes(it.regulator) ? it.regulator : names[0] || '';
        const twice = (t) => (c.types.find(x => x.type === t)?.examples.length || 0) > 1;      // two entities of this type are marked up → a relation between them is possible
        let tgt = names.includes(it.target) && (it.target !== reg || twice(reg)) ? it.target : (names.find(x => x !== reg) || '');
        const reason = String(it.reason || '').trim();           // the hint: the wording of the sentence (the user may edit it)
        let note = '';                                           // an explanation shown under the hint — never sent to the LLM as wording
        if (!reason) {                                          // the LLM left the wording out: say at least which entities the relation links (the closest pair of the two types)
          const lns = (Array.isArray(it.lines) ? it.lines : []).map(Number).filter(x => Number.isInteger(x) && x >= 1 && x <= pseudo.length).map(x => pseudo[x - 1]).join(nl);
          const src = lns || (String(markup || '').split(nl).find(l => /^msrc\s/.test(l)) || '');
          const p = c.entityTypes ? neighbourPairs(src, c.entityTypes, reg, tgt)[0] : null;
          if (p) note = `${p.regulator} (${reg}) → ${p.target} (${tgt}).`;
        }
        // The types the LLM named must fit the pseudo-sentences it assigned (a typed entity of each type, none in between). If they fit none of them (it said Complex for "dysgerminoma", a Disease),
        // the types are read from the first pseudo-sentence instead: its first and last typed entity, in the order of the line.
        const own = (Array.isArray(it.lines) ? it.lines : []).map(Number).filter(x => Number.isInteger(x) && x >= 1 && x <= pseudo.length);
        if (own.length && c.entityTypes && !own.some(n => neighbourPairs(pseudo[n - 1], c.entityTypes, reg, tgt).length)) {
          const typed = [...String(pseudo[own[0] - 1]).matchAll(/ID[{]([\d,\s]+)=/g)].map(m => c.entityTypes[m[1].replace(/\s+/g, '')] || []).filter(t => t.length);
          const r0 = typed.length >= 2 ? typed[0].find(t => names.includes(t)) : '', t0 = typed.length >= 2 ? typed[typed.length - 1].find(t => names.includes(t)) : '';
          if (r0 && t0 && !(r0 === t0 && !twice(r0))) { note += ` (Node types corrected from P${own[0]}: ${r0} → ${t0}; the LLM had said ${reg} → ${tgt}, which no assigned pseudo-sentence contains.)`; reg = r0; tgt = t0; }
        }
        const u = c.usage?.[relName];                           // reversed against every existing rule of the relation → swap
        const has = (list, x) => (list || []).includes(x);
        if (u && has(u.regulators, tgt) && has(u.targets, reg) && !has(u.regulators, reg) && !has(u.targets, tgt)) {
          [reg, tgt] = [tgt, reg];
          note += ` (Direction swapped: the existing ${relName} rules of this cartridge are ${u.regulators.join(', ')} → ${u.targets.join(', ')}.)`;
        }
        if (local) {                                            // a small model picks a relation type no rule of the cartridge has for this pair: the existing frames decide
          const covers = (r) => { const w = c.usage?.[r]; return !!w && has(w.regulators, reg) && has(w.targets, tgt); };
          if (!covers(relName)) {
            const alt = Object.keys(c.relations).filter(covers);
            if (alt.length) { note += ` (${relName} has no rule for ${reg} → ${tgt} in this cartridge; ${alt[0]} has, so it was used.)`; relName = alt[0]; }
          }
        }
        const vocab = c.props?.[relName] || {};
        const props = {};
        for (const [k0, v] of Object.entries(it.properties || {})) {
          const k = vocab[k0] ? k0 : Object.keys(vocab).find(x => (c.propAliases?.[relName]?.[x] || '') === k0);   // the GraphExplorer name of a property → the cartridge's
          if (!k) continue;
          if (k === 'Effect') { if (vocab[k].includes(String(v))) props[k] = String(v).trim(); }
          else if (String(v).trim() && String(v).length < 60) {
            const known = (vocab[k] || []).find(x => String(x).toLowerCase() === String(v).trim().toLowerCase());
            if (known !== undefined) props[k] = String(known);                                   // a listed value
            else if (!local) props[k] = String(v).trim();                                        // a new value: only from a model that is trusted with it
          }
        }
        const lines = (Array.isArray(it.lines) ? it.lines : []).map(Number).filter(x => Number.isInteger(x) && x >= 1 && x <= pseudo.length);
        return { id: n, lines, relation: relName, regulator: reg, target: tgt, props, reason, note, checked: true };
      });
      // sentence-level patterns work on the tagged sentence (the msrc line): there an entity of the same type between the two cannot be skipped.
      // ConceptScan pseudo-sentences are always noun-verb-noun with no markup in between, so rows with pseudo-sentences are not checked.
      const tagged = (String(markup || '').split(nl).find(l => /^msrc\s/.test(l)) || '').replace(/^msrc\s+/, '');
      const out = out0.filter(r => {
        if (r.lines.length || !tagged || !c.entityTypes) return true;
        const ok = neighbourPairs(tagged, c.entityTypes, r.regulator, r.target).length > 0;
        if (!ok) noPair.push({ lines: [], reason: `${r.relation} ${r.regulator} → ${r.target}: another ${r.regulator} / ${r.target} entity stands between the two in the tagged sentence, the matcher would take the closer one — not extractable` });
        return ok;
      });
      setSkipped([...noPair, ...(Array.isArray(g.skipped) ? g.skipped : [])].map(x => ({ lines: (Array.isArray(x.lines) ? x.lines : []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= pseudo.length), reason: String(x.reason || '') })));
      checkedKey.current = {}; matchKey.current = {};         // "Ask again" gives new rows with the same ids 0, 1, 2…: the cached checks of the previous answer must not be taken for theirs
      setRows(out);                                           // empty = the LLM (validly) found nothing; no made-up row
      setPhase('confirm');
    } catch (e) { setError(e.message); setPhase('confirm'); setRows(r => r || fallback); }
  };

  useEffect(() => {
    if (started.current) return; started.current = true;
    (async () => {
      const r = await api.suggestContext({ cartPath: cart.path, markup, sentence });
      if (!r.ok) { setError(r.error); setPhase('confirm'); return; }
      if (preset) {                                          // the LLM already chose this relation ("Other cartridges") — no second request
        const typesOf = (l) => [...String(l).matchAll(/ID[{]([\d,\s]+)=/g)].flatMap(m => r.entityTypes?.[m[1].replace(/\s+/g, '')] || []);
        const lines = pseudoLines(markup).map((l, i) => [i + 1, typesOf(l)]).filter(([, t]) => t.includes(preset.regulator) && t.includes(preset.target)).map(([n]) => n);
        setCtx(r); setSkipped([]);
        setRows([{ id: 0, lines, relation: preset.relation, regulator: preset.regulator, target: preset.target, props: preset.props || {}, reason: preset.reason || '', checked: true }]);
        setPhase('confirm');
        return;
      }
      setCtx(r); askGuess(r);
    })();
  }, []);

  // "Other cartridges": run the sentence through the sibling cartridges, let the LLM pick the one whose relation types fit
  const [others, setOthers] = useState(null);       // { busy, msg, matches: [{ cartridge, path, markup, relation, regulator, target, props, reason, covered }], checked: n, error }
  const findOthers = async () => {
    setOthers({ busy: true, msg: 'Running the sentence through the other cartridges…', matches: [] });
    try {
      const r = await api.otherCartridgeContexts({ cartPath: cart.path, sentence, organism: runOpts?.organism, userDict: runOpts?.userDict });
      if (!r.ok) throw new Error(r.error);
      const carts = r.carts.filter(c => c.ctx.types.length >= 1 && Object.keys(c.ctx.relations).length);
      // a cartridge is worth asking about when an existing rule allows a marked-up pair (full description), or — a new rule would be needed — when at least two entities are marked up (short description)
      const hasCovered = (c) => /: (?!none$)/m.test(covered(c.ctx));
      const usable = carts.filter(c => hasCovered(c) || c.ctx.types.some(t => t.examples.length > 1) || c.ctx.types.length >= 2);
      if (!usable.length) { setOthers({ busy: false, matches: [], checked: r.carts.length }); return; }
      setOthers({ busy: true, msg: `Asking the LLM about ${usable.length} cartridge${usable.length === 1 ? '' : 's'}…`, matches: [] });
      const block = (c) => {
        const x = c.ctx;
        if (!hasCovered(c)) return [`=== Cartridge: ${c.name} (no existing rule allows a marked-up pair — a match would need a new rule)`,       // short description: types + relation type names only
          `Node types present in its markup: ${x.types.map(t => `${t.type} (${t.examples.join('; ')})`).join(', ')}`,
          `Relation types: ${Object.entries(x.relations).map(([n, roles]) => `${n} (${roles === 'in,out' ? 'directional' : 'non-directional'})`).join(', ')}`].join('\n');
        const rels = Object.entries(x.relations).map(([n, roles]) => `${n} (${roles === 'in,out' ? 'directional' : 'non-directional'}${(() => { const u = x.usage?.[n]; return u && (u.regulators.length || u.targets.length) ? `; existing rules: regulators ${u.regulators.join(', ')} → targets ${u.targets.join(', ')}` : '; no rules yet'; })()}${fmtPropsOf(x, n)})`);
        return [`=== Cartridge: ${c.name}`,
          `Node types present in its markup: ${x.types.map(t => `${t.type} (${t.examples.join('; ')})`).join(', ') || '(none)'}`,
          `Pseudo-sentences:\n${pseudoLines(c.markup).map((l, i) => `P${i + 1}: ${l}`).join('\n') || '(none)'}`,
          `Relation types: ${rels.join(', ')}`,
          `Covered pairs:\n${covered(x) || '(none)'}`].join('\n');
      };
      // one LLM request per cartridge, all at once; a match is shown as soon as its answer arrives
      const found = [], nl = String.fromCharCode(10);
      let answered = 0, failed = 0, lastError = '';
      const one = async (c) => {
        const ask = `Sentence: ${sentence}${nl}${nl}${block(c)}${nl}${nl}${JSON_ONLY}`;
        try {
          let g = null, reply = '';
          for (let attempt = 0; attempt < 2 && !g; attempt++) {                  // a reasoning model can use up the token budget: ask again
            reply = await callLlm([{ role: 'system', content: SYSTEM_OTHERS }, { role: 'user', content: ask }], { fn: 'suggest.others', grounding: false, json: true, maxTokens: 8192 });
            g = parseJsonObject(reply, ['matches']);
          }
          if (!g || !Array.isArray(g.matches)) throw new Error('The LLM reply for ' + c.name + ' was not readable: ' + JSON.stringify(String(reply).slice(0, 160)));
          const x = c.ctx, names = x.types.map(t => t.type);
          for (const m of g.matches) {
            const rel = Object.keys(x.relations).find(k => k.toLowerCase() === String(m.relation || '').toLowerCase()) || Object.keys(x.relations).find(k => (x.aliases?.[k] || '').toLowerCase() === String(m.relation || '').toLowerCase());
            if (!rel || !names.includes(m.regulator) || !names.includes(m.target)) continue;
            const vocab = x.props?.[rel] || {}, props = {};
            for (const [k, v] of Object.entries(m.properties || {})) if (k === 'Effect' && vocab.Effect && vocab.Effect.includes(String(v))) props.Effect = String(v);
            // the pattern folders (grdata/…) whose frames take exactly this relation; an unset Effect is the frame's "unknown"
            const fp = props.Effect ? { Effect: props.Effect } : (vocab.Effect ? { Effect: 'unknown' } : {});
            const fr = await api.frameFolders({ cartPath: c.path, relation: rel, props: fp, regulator: m.regulator, target: m.target }).catch(() => null);
            // a cartridge with the right frame: does one of its patterns already extract the relation from this sentence (with ITS markup)?
            let extracted = null, notRun = null;
            if (fr && fr.exact && fr.exact.length) {
              const ex = await api.findExtracting({ cartPath: c.path, markup: c.markup, relation: rel, props: fp, regulator: m.regulator, target: m.target }).catch(() => null);
              const ms = (ex && ex.ok && ex.matches) || [];
              extracted = ms.find(x => x.inPipeline) || null;
              notRun = extracted ? null : (ms[0] || null);
            }
            found.push({ cartridge: c.name, path: c.path, markup: c.markup, relation: rel, regulator: m.regulator, target: m.target, props, reason: String(m.reason || ''), exact: (fr && fr.exact) || [], other: (fr && fr.other) || [], extracted, notRun });
            break;                                                              // the best match of a cartridge only
          }
        } catch (e) { failed++; lastError = e.message; }
        answered++;
        setOthers({ busy: answered < usable.length, msg: `Asking the LLM about ${usable.length} cartridge${usable.length === 1 ? '' : 's'} (${answered} answered)…`, matches: [...found], checked: r.carts.length });
      };
      await Promise.all(usable.map(one));
      setOthers({ busy: false, matches: found, checked: r.carts.length, error: failed === usable.length ? lastError : (failed ? `${failed} of ${usable.length} cartridges could not be checked (${lastError})` : undefined) });
    } catch (e) { setOthers({ busy: false, matches: [], error: e.message }); }
  };

  const autoDesign = useRef(!!(preset && preset.autoDesign));
  useEffect(() => {
    if (autoDesign.current && ctx && rows && rows.length && phase === 'confirm') { autoDesign.current = false; design(rows[0]); }
  }, [ctx, rows, phase]);

  const addRow = () => setRows(rs => [...rs, { id: Math.max(-1, ...rs.map(r => r.id)) + 1, lines: [], relation: Object.keys(ctx.relations)[0] || '', regulator: ctx.types[0]?.type || '', target: ctx.types[1]?.type || '', props: {}, reason: '', checked: true, manual: true }]);
  const toggleLine = (id, n) => setRows(rs => rs.map(r => (r.id === id ? { ...r, lines: r.lines.includes(n) ? r.lines.filter(x => x !== n) : [...r.lines, n].sort((a, b) => a - b) } : r)));
  const update = (id, patch) => setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));
  // "is this relation already extracted by the existing patterns?" — checked for every row (and again when its types / properties change)
  const [viewExisting, setViewExisting] = useState(null);
  const checkedKey = useRef({});
  useEffect(() => {
    if (!rows || !ctx) return;
    rows.forEach(r => {
      if (!r.relation || !r.regulator || !r.target) return;
      const props = effProps(r.props, r.relation);
      const key = JSON.stringify([r.relation, r.regulator, r.target, props, r.lines]);
      if (checkedKey.current[r.id] === key) return;
      checkedKey.current[r.id] = key;
      api.findExtracting({ cartPath: cart.path, markup: r.lines.length ? markupOfLines(markup, r.lines) : markup, relation: r.relation, props, regulator: r.regulator, target: r.target })
        .then(res => setRows(rs => rs.map(x => (x.id === r.id && checkedKey.current[r.id] === key ? { ...x, pipeHit: pipelineHit(r, props), existing: res && res.ok && res.matches && res.matches.some(m => m.inPipeline) ? { ...res, matches: res.matches.filter(m => m.inPipeline) } : null, unused: res && res.ok && res.matches && !res.matches.some(m => m.inPipeline) && res.matches.length ? res : null } : x))))
        .catch(() => { /* optional */ });
    });
  }, [rows, ctx]);

  // design the pattern of one row (+ the closest existing pattern set)
  // no Effect chosen = "unknown" when the relation's rules have an Effect property
  // "does this cartridge extract this kind of relation?" — by node types, relation type and direction only; if not, the other cartridges that do
  const matchKey = useRef({});
  useEffect(() => {
    if (!rows || !ctx) return;
    rows.forEach(r => {
      if (!r.relation || !r.regulator || !r.target) return;
      const key = JSON.stringify([r.relation, r.regulator, r.target]);
      if (matchKey.current[r.id] === key) return;
      matchKey.current[r.id] = key;
      api.relationMatches({ cartPath: cart.path, relation: r.relation, regulator: r.regulator, target: r.target })
        .then(res => setRows(rs => rs.map(x => (x.id === r.id && matchKey.current[r.id] === key ? { ...x, matches: res && res.ok ? res : null } : x))))
        .catch(() => { /* optional */ });
    });
  }, [rows, ctx]);

  const effProps = (p, rel) => ({ ...(p || {}), ...(!(p && p.Effect) && ctx?.props?.[rel]?.Effect ? { Effect: 'unknown' } : {}) });
  // token walk of the row's pseudo-sentences (see frames.js tokenWalk)
  const walks = (row) => row.lines.map(n => tokenWalk(pseudo[n - 1], ctx?.entityTypes || {}, row.regulator, row.target)).filter(Boolean).filter((w, i, a) => a.indexOf(w) === i).join(String.fromCharCode(10));
  const designRow = async (row, seed = null, meta = null) => {   // seed: an existing pattern to start from instead of the LLM's (Redesign)
    const tm = {}, t0 = Date.now();                         // timing log: stage → ms
    const timed = async (label, p) => { const t = Date.now(); try { return await p; } finally { tm[label] = (tm[label] || 0) + (Date.now() - t); } };
    let samples = [];
    let mp = { macros: ctx.macros, macroNames: ctx.macroNames };   // re-ranked for this relation: macros defined nearer to its pattern files weigh more
    const [pf, mr] = await Promise.all([
      timed('patterns of relation', api.patternsFor({ carts: [{ name: cart.name, path: cart.path }], name: row.relation }).catch(() => null)),   // the relation's existing patterns show the cartridge's style
      timed('macro ranking', api.macroPrompt({ cartPath: cart.path, sentence, relation: row.relation }).catch(() => null)),
    ]);
    const eff = String(effProps(row.props, row.relation).Effect || '').toLowerCase();
    const sameEff = (x) => !eff || new RegExp('Effect\\s*=\\s*"' + eff + '"', 'i').test(x.control || '');
    const rowsOf = ((pf && pf.rows) || []).slice().sort((a, b) => sameEff(b) - sameEff(a));       // frames with the same Effect first
    // macros the patterns are built from: only those used as a word set to MATCH ([$A $B]; not the guards [^$X]), counted for this Effect and for the others
    const used = new Map(), other = new Map();
    const wordSets = (alt) => [...String(alt).matchAll(/\[([^\]\[]*)\]/g)].filter(m => !m[1].trim().startsWith('^')).flatMap(m => m[1].match(/[$][A-Za-z_]\w*/g) || []).filter(m => m !== '$ACT');
    for (const x of rowsOf) {
      const alts = [...(x.patternSets || []).flatMap(st => st.alts || []), ...(x.inlinePattern ? x.inlinePattern.alts || [] : [])];
      if (sameEff(x)) samples.push(...alts);
      const tab = sameEff(x) ? used : other;
      for (const al of alts) for (const m of wordSets(al)) tab.set(m, (tab.get(m) || 0) + 1);
    }
    for (const x of rowsOf) if (!sameEff(x)) samples.push(...[...(x.patternSets || []).flatMap(st => st.alts || []), ...(x.inlinePattern ? x.inlinePattern.alts || [] : [])]);
    samples = samples.filter(a => a && a.length < 220).slice(0, 5);
    let effMacros = '';
    try {
      const names = [...used.entries()].sort((a, b) => (b[1] - (other.get(b[0]) || 0)) - (a[1] - (other.get(a[0]) || 0)) || b[1] - a[1]).slice(0, 30).map(e => e[0]);   // specific to this Effect first
      if (names.length) {
        const d = await api.macroDefs({ cartPath: cart.path, file: cart.path + '\\ctrltype.ini', names, max: 200 });
        effMacros = names.filter(n => d.defs && d.defs[n]).map(n => n + ': ' + d.defs[n]).join('\n');
      }
    } catch { /* optional */ }
    if (mr && mr.ok && mr.macros) mp = mr;
    const mine = row.lines.map(n => `P${n}: ${pseudo[n - 1]}`).join('\n');
    const nl = String.fromCharCode(10);
    const lines = mine.trim() ? mine.split(nl) : [String(markup || '').split(nl).find(l => /^msrc\s/.test(l)) || ''];
    const regNames = [], tgtNames = [];
    let bestPair = null;
    for (const line of lines) {
      const ents = [...line.matchAll(/ID[{]([\d,\s]+)=([^}]*)[}]/g)].map(e => ({ at: e.index, end: e.index + e[0].length, name: e[2].trim(), types: ctx?.entityTypes?.[e[1].replace(/\s+/g, '')] || [] })).filter(e => e.name);
      let best = null;
      for (const r of ents.filter(e => e.types.includes(row.regulator))) for (const t of ents.filter(e => e.types.includes(row.target))) {
        if (r === t) continue;
        const gap = r.end <= t.at ? t.at - r.end : r.at >= t.end ? r.at - t.end : 0;
        if (!best || gap < best.gap) best = { gap, r, t };
      }
      if (best && (!bestPair || best.gap < bestPair.gap)) bestPair = { ...best, line };
      if (best) { if (!regNames.includes(best.r.name)) regNames.push(best.r.name); if (!tgtNames.includes(best.t.name)) tgtNames.push(best.t.name); }
    }
    // the two entities the pattern must link (the closest pair — what MedScan binds), and the words between them: without this the LLM may design for another pair of the same types
    const between = bestPair ? bestPair.line.slice(Math.min(bestPair.r.end, bestPair.t.end), Math.max(bestPair.r.at, bestPair.t.at)).trim() : '';
    const pairText = bestPair ? [
      'The pattern must link THESE two entities (MedScan binds @regulator / @target to the closest pair of the two node types): @regulator = "' + bestPair.r.name + '" (' + row.regulator + '), @target = "' + bestPair.t.name + '" (' + row.target + '). Do not design it for any other ' + row.regulator + ' / ' + row.target + ' entity of the sentence.',
      'Text between them in the sentence: "' + between + '" — the gap between @regulator and @target needs only about that many tokens.',
    ].filter(Boolean).join(nl) : '';
    // the user's hint (or the LLM's wording from the first step): sent always — also when no closest pair of entities could be found
    const hintText = row.reason && row.reason.trim() ? 'HINT — the words of the sentence that state this relation (written or corrected by the user' + (mine ? '' : '; entities as ID{ids=text} are the markup of the sentence') + '): "' + row.reason.trim() + '". Design the pattern for THIS wording: the relation-carrying words of the pattern (verb, preposition) must be the ones in the hint, and the pattern must match the hint text. ' + (mine ? 'The pseudo-sentences below are only a summary of the sentence and may have lost these words.' : '') : '';
    let local = false;                                                              // a local model has a small context: shorter prompt, the task repeated at the end
    try { local = llmTargetOf(await window.api.settings.get(), 'suggest.design') === 'local'; } catch { /* the provider */ }
    const user = [
      `Cartridge: ${cart.name}`, `Relation type: ${row.relation}`, `Regulator node type: ${row.regulator}`, `Target node type: ${row.target}`,
      Object.keys(row.props || {}).length ? `CONTROL properties of this rule: ${Object.entries(row.props).map(([k, v]) => k + '=' + v).join(', ')}` : '',
      pairText, hintText,
      // two different messages: the pseudo-sentences ALONE (no sentence, no markup) for a ConceptScan pattern; the tagged sentence ALONE (no pseudo-sentence) for a sentence-level pattern
      mine ? `The pattern must match these ConceptScan pseudo-sentences:\n${mine}` : `Tagged sentence (the pattern works on it; entities are written ID{ids=text}):\n${taggedSentence(markup).slice(0, local ? 1800 : 3500)}`,
      mine ? walks(row) : '',
      samples.length ? `Existing patterns of ${row.relation} in this cartridge (for style):\n${samples.join('\n')}` : '',
      effMacros ? `Macros that existing patterns with the same properties${eff ? ' (Effect=' + eff + ')' : ''} use (most used first; use them for the words that decide the Effect):\n${effMacros}` : '',
      `Macros available in this cartridge (only those containing a word of the sentence; name: definition, most relevant first):\n${mp.macros.slice(0, local ? 25 : mp.macros.length).map(m => `${m.name}: ${local ? String(m.body).slice(0, 220) : m.body}`).join('\n')}`,
      mp.macroNames?.length ? `More macros (names only — use one if its name clearly fits):\n${mp.macroNames.slice(0, local ? 80 : mp.macroNames.length).join(' ')}` : '',
      mine ? TASK_END_CS : TASK_END_SENT,
    ].filter(Boolean).join('\n\n');
    const llmP = seed ? Promise.resolve('') : timed('LLM design', callLlm([{ role: 'system', content: mine ? (local ? SYSTEM_PATTERN_CS_LOCAL : SYSTEM_PATTERN_CS) : (local ? SYSTEM_PATTERN_SENT_LOCAL : SYSTEM_PATTERN_SENT) }, { role: 'user', content: user }],
      { fn: 'suggest.design', grounding: false, maxTokens: 4096, minNumCtx: 16384 }));
    // the lookups the end of the design needs start once the request has left and run while the LLM is thinking
    const exP = api.existingSets({ cartPath: cart.path, name: row.relation }).catch(() => null);
    const reply = await llmP;
    const csModeD = row.lines.length > 0;                                   // pseudo-sentences chosen → $ACT pattern, else the tagged sentence
    const candidatesRaw = seed ? [seed] : parsePatterns(reply).map(p => { const q = ensureAct(p, csModeD); if (q !== p) console.info(`[design] $ACT ${csModeD ? 'put right after the first entity' : 'removed (pattern for the tagged sentence)'}: ${p}  →  ${q}`); return q; });
    // literal words that a small macro of the cartridge already covers become that macro; bigger macros are only suggested (what was done goes to the banner)
    const fixLog = new Map();                                  // pattern text → { applied, suggested }
    const fixAll = async (list) => {
      try {
        const glued = [...new Set([...String(markup || '').matchAll(/([A-Za-z]{2,}-)(?=ID[{])/g)].map(m => m[1].toLowerCase()))];     // prefixes stuck to an entity: anti-ID{…}
        const r = await api.fixMacros({ cartPath: cart.path, patterns: list, glued });
        if (r.ok && r.fixes && r.fixes.length === list.length) return r.fixes.map(x => { fixLog.set(x.pattern, { applied: x.applied, suggested: x.suggested }); return x.pattern; });
      } catch { /* optional */ }
      return list;
    };
    const fixedAll = seed ? [seed] : await fixAll(candidatesRaw);
    const withVerb = seed ? fixedAll : fixedAll.filter(hasRelationWord);                       // entity-verb-entity: a pattern without the relation word is dropped (kept only when none has one)
    if (withVerb.length < fixedAll.length) console.info(`[design] dropped ${fixedAll.length - withVerb.length} candidate(s) without a relation word`);
    const candidatesP = withVerb.length ? withVerb : fixedAll;
    candidatesRaw.forEach((c, i) => console.info(`[design] LLM candidate ${i + 1}: ${c}${fixedAll[i] !== c ? `
[design]   after macro fix: ${fixedAll[i]}` : ''}`));
    if (!candidatesP.length) {
      const err = new Error('The LLM did not return a usable pattern. Its complete reply is shown below.');
      err.reply = String(reply);                                       // the whole reply, shown in the dialog
      console.info('[design] LLM reply without a usable pattern:\n' + err.reply);
      throw err;
    }
    const defsOf = async (list) => { const r = await api.macroDefs({ cartPath: cart.path, file: cart.path + '\\ctrltype.ini', names: list, max: 1500 }); return (r.ok && r.defs) || {}; };
    // screen the candidates with the real test, one after the other: the first that produces output wins (no more LLM calls needed)
    let finalPattern = candidatesP[0], screened = null, firstCompiled = -1;
    setProgress('testing the candidates…');
    for (let k = 0; k < candidatesP.length; k++) {
      const t = await timed('test', api.testPattern({ cartPath: cart.path, pattern: candidatesP[k], markup, relationName: row.relation, regulators: [row.regulator], targets: [row.target] }));
      const r = t.ok ? t.result : { ok: false, message: t.error };
      if (r.ok && r.skipped) { finalPattern = candidatesP[k]; screened = { skipped: true, message: r.message }; break; }
      if (r.ok && r.terms > 0) { finalPattern = candidatesP[k]; screened = { ok: true, terms: r.terms, attempts: 0, candidate: k + 1, of: candidatesP.length }; break; }
      if (r.ok && firstCompiled < 0) firstCompiled = k;
    }
    if (!screened && firstCompiled > 0) finalPattern = candidatesP[firstCompiled];   // none works: repair the first one that at least compiled
    // run the pattern on the real ConceptScan output; repair it up to 3 times when it finds nothing or does not compile
    let tested = screened;
    try {
      for (let attempt = 0; attempt < 4 && !screened && !seed; attempt++) {
        const t = await timed('test', api.testPattern({ cartPath: cart.path, pattern: finalPattern, markup, relationName: row.relation, regulators: [row.regulator], targets: [row.target] }));
        const r = t.ok ? t.result : { ok: false, message: t.error };
        if (!r.ok) tested = { ok: false, message: r.message, attempts: attempt };
        else if (r.skipped) { tested = { skipped: true, message: r.message }; break; }
        else tested = { ok: r.terms > 0, terms: r.terms, attempts: attempt };
        if (tested.ok || attempt === 3) break;
        const what = r.ok ? 'The pattern compiled but produced NO output term on the sentence markup (ConceptScan output for $ACT patterns, the tagged sentence otherwise).' : `The pattern did not compile/validate: ${r.message}`;
        setProgress(`test #${attempt + 1} failed, repairing (${attempt + 1}/3)…`);
        const csMode = row.lines.length > 0;                  // the row has ConceptScan pseudo-sentences → $ACT pattern; otherwise the tagged sentence
        const fixedReply = await timed('LLM repair', callLlm([{ role: 'system', content: csMode ? SYSTEM_REPAIR_CS : SYSTEM_REPAIR_TAGGED }, { role: 'user', content:
          `${csMode ? 'Pseudo-sentences:\n' + mine : 'Tagged sentence (msrc line):\n' + (String(markup || '').split(String.fromCharCode(10)).find(l => /^msrc\s/.test(l)) || '').replace(/^msrc\s+/, '')}\n\n${csMode && walks(row) ? walks(row) + '\n\n' : ''}Regulator node type: ${row.regulator}; target node type: ${row.target}\n\nPattern:\n${finalPattern}\n\n${what}\n\nMacro definitions used:\n${(await (async () => { try { const names = [...new Set(finalPattern.match(/[$@][A-Za-z_]\w*/g) || [])].filter(n => n !== '@regulator' && n !== '@target' && n !== '$ACT'); const d = names.length ? await api.macroDefs({ cartPath: cart.path, file: cart.path + '\\ctrltype.ini', names, max: 800 }) : { defs: {} }; return Object.entries(d.defs || {}).map(([k, v]) => k + ': ' + v).join('\n'); } catch { return ''; } })())}` }],
          { fn: 'suggest.repair', grounding: false, maxTokens: 4096, minNumCtx: 16384 }));
        const fixed = parsePattern(fixedReply);
        if (!fixed || !hasRegulator(fixed) || !hasTarget(fixed) || fixed === finalPattern) break;
        console.info(`[design] LLM repair #${attempt + 1} (${what.slice(0, 80)}): ${fixed}`);
        finalPattern = (await fixAll([fixed]))[0];
      }
    } catch { /* the test is a help; without it the pattern is still offered */ }
    let macroHints = [];                                       // words next to a macro that the macro lacks → the user may want to add them to the macro
    const hintsP = (async () => {
      const names = [...new Set(finalPattern.match(/[$][A-Za-z_]\w*/g) || [])].filter(n => n !== '$ACT');
      if (!names.length) return [];
      const d1 = await defsOf(names);
      const nested = [...new Set(Object.values(d1).flatMap(b => b.match(/[$@][A-Za-z_]\w*/g) || []))].filter(n => !(n in d1) && n !== '$ACT').slice(0, 40);
      return macroGaps(finalPattern, { ...d1, ...(nested.length ? await defsOf(nested) : {}) });
    })().catch(() => []);
    let candidates = [], placementId = null, placementReason = '', placementWhy = '';
    const ex = await timed('frame lookup', exP);
    candidates = (ex && ex.sets) || [];
    if (candidates.length) ({ id: placementId, reason: placementReason, why: placementWhy } = chooseFrame(candidates, row, finalPattern));
    else placementReason = `${cart.name} has no pattern set for ${row.relation} yet — a new folder is created`;
    macroHints = await timed('macro hints', hintsP);
    tm.total = Date.now() - t0;
    console.info('[design timing, ms] ' + JSON.stringify(tm) + ' — ' + row.regulator + ' ' + row.relation + ' ' + row.target);
    // the entities of the regulator / target type as they stand in the pseudo-sentences of the row (or, without any, in the tagged sentence) — for the @regulator / @target tooltip
    // MedScan takes the regulator closest to the target, so per sentence only the closest pair of a regulator-type and a target-type entity counts
    const example = (type) => ((ctx?.types || []).find(x => x.type === type)?.examples || []).slice(0, 3);
    return { regNames: regNames.length ? regNames : example(row.regulator), tgtNames: tgtNames.length ? tgtNames : example(row.target), relation: row.relation, regulator: row.regulator, target: row.target, pattern: finalPattern, macroFixes: fixLog.get(finalPattern) || { applied: [], suggested: [] }, markup: String(markup || ''), macroHints, props: effProps(row.props, row.relation), tested, candidates, placementId, placementReason, placementWhy, pseudo: mine, timing: tm, existing: row.existing || null, fromExisting: meta };
  };

  const designIn = async (row, o) => {
    setPhase('design'); setError(null); setProgress(`running the sentence through ${o.cartridge}…`);
    try {
      const r = await api.otherCartridgeContexts({ cartPath: cart.path, sentence, organism: runOpts?.organism, userDict: runOpts?.userDict, only: [o.path] });
      const c = r.ok && r.carts && r.carts[0];
      if (!c) throw new Error(r.error || `The pipeline of ${o.cartridge} gave no markup for this sentence.`);
      onSwitchCartridge({ name: o.cartridge, path: o.path }, c.markup, { relation: row.relation, regulator: row.regulator, target: row.target, props: row.props || {}, reason: row.reason || '', autoDesign: true });
    } catch (e) { setError(e.message); setPhase('confirm'); }
  };

  // Redesign: the existing pattern that extracts the relation goes into the wizard as it is (spaces tidied), for the user to inspect and edit
  const redesign = (row) => {
    const m = row.existing.matches[0];
    design(row, String(m.wizardAlt || m.alt).replace(/[ 	]{2,}/g, ' ').trim(), { set: m.set, folder: m.folder, index: m.index });
  };

  // one pattern at a time: the button of a row designs that row and opens its wizard
  // the relation the LLM proposes is already in the pipeline output of this sentence (same relation type, node types and Effect arrow):
  // { text: 'SmallMol:(equol) — UnknownRegulation --| Disease:(dyslipidemia)' } | null — a check that does not depend on finding the pattern that produced it
  const pipelineHit = (r, props) => {
    if (pipelineCart && String(pipelineCart.path).toLowerCase() !== String(cart.path).toLowerCase()) return null;
    const low = (x) => String(x || '').toLowerCase();
    const sameType = (t) => sameRelation(r.relation, t);                    // Regulation = UnknownRegulation …: shared/relationTypes.js
    const arrow = effectArrow((props || {}).Effect);
    const of = (list, t) => (list || []).filter(n => low(n).startsWith(low(t) + ':('));
    // a row about chosen pseudo-sentences is only "already extracted" when the output relation is between THEIR entities (first and last entity of a line, in either direction)
    const nameOf = (n) => { return low(n.slice(n.indexOf(':(') + 2, n.lastIndexOf(')'))); };
    const pairs = r.lines.map(n => entityNamesOf(pseudo[n - 1])).filter(e => e.length >= 2).map(e => [e[0], e[e.length - 1]]);
    for (const x of extractedRels || []) {
      if (!sameType(x.type) || x.arrow !== arrow) continue;
      let regs = of(x.regs, r.regulator), tgts = of(x.tgts, r.target);
      if (r.lines.length) {
        const rn = regs.map(nameOf), tn = tgts.map(nameOf);
        const ok = pairs.filter(([a, b]) => (rn.includes(a) && tn.includes(b)) || (rn.includes(b) && tn.includes(a)));
        if (!ok.length) continue;
        const keep = new Set(ok.flat());
        regs = regs.filter(n => keep.has(nameOf(n))); tgts = tgts.filter(n => keep.has(nameOf(n)));
      }
      if (regs.length && tgts.length) return { text: regs.join(' + ') + ' — ' + x.type + ' ' + x.arrow + ' ' + tgts.join(' + '), folder: x.folder || '' };
    }
    return null;
  };

  const design = async (row, seed = null, meta = null) => {
    const todo = [row];
    setPhase('design'); setError(null); setErrorReply(''); setProgress(`${row.regulator} — ${row.relation} → ${row.target}`);
    const settled = await Promise.all(todo.map(r => designRow(r, seed, meta).then(
      v => ({ ok: true, v }),
      e => ({ ok: false, e }))));
    const good = settled.filter(x => x.ok).map(x => x.v);
    if (!good.length) { setErrorRow(row); setErrorReply(settled.map(x => x.e?.reply).filter(Boolean).join('\n\n— — —\n\n')); setError(settled.map(x => x.e?.message).filter(Boolean).join('\n')); setPhase('confirm'); return; }
    setPhase('confirm');
    onResult(good, settled.filter(x => !x.ok).map(x => x.e.message));
  };

  const sel = { fontSize: 13, padding: '4px 6px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, minWidth: 150 };
  const typeNames = ctx ? ctx.types.map(t => t.type) : [];
  const bad = (r) => !r.relation || !r.regulator || !r.target;
  const nChecked = rows ? rows.filter(r => r.checked).length : 0;
  const anyBad = rows ? rows.some(r => r.checked && bad(r)) : false;

  return (
    <FloatingDialog title={`Suggest pattern — ${cart.name}`} width={900} dock="left">
      <div>
        <div style={{ fontSize: 12, marginBottom: 8, color: 'var(--text-muted)' }}>{sentence}</div>
        <div className="text-xs text-muted" style={{ marginBottom: 3 }}>ConceptScan markup (last pipeline step) — the input the pattern works on. Patterns match the pseudo-sentences (lines starting with <b>&lt;</b>), numbered P1…P{pseudo.length || 'n'} below; the <b>msrc</b> line is the original sentence:</div>
        <div style={{ marginBottom: 12 }}>{markupView || <pre>{String(markup || '').trim()}</pre>}</div>
        {error && <div className="alert alert-danger" style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{error}
          {errorReply && <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <b style={{ fontSize: 12 }}>LLM reply</b>
              <span style={{ display: 'flex', gap: 6 }}>
                {looseP && errorRow && <button className="btn btn-sm btn-primary" title="Open the pattern found in this reply in the pattern editor as it is, to adjust it (the LLM left out @regulator / @target, or wrote text around it)" onClick={() => design(errorRow, looseP, null)}>Open pattern for editing →</button>}
                <button className="btn btn-sm btn-secondary" onClick={() => navigator.clipboard.writeText(errorReply)}>Copy</button>
              </span>
            </div>
            <pre style={{ margin: '4px 0 0', maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11, padding: 8, background: 'rgba(0,0,0,0.25)', borderRadius: 4, color: 'var(--text)' }}>{errorReply}</pre>
          </>}
        </div>}

        {!rows && phase === 'guess' && <div className="flex items-center gap-8"><span className="spinner" /><span className="text-muted text-sm">Asking the LLM which relations the pseudo-sentences express…</span></div>}

        {rows && ctx && (
          <>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              {phase === 'guess' ? <span className="spinner" /> : null} {rows.length === 0 && phase !== 'guess' && !error
                ? 'The LLM found no relation that this cartridge can extract from this sentence — the reasons are listed below. Press “Add a relation myself” if you disagree.'
                : <>The LLM found {rows.filter(r => !r.manual).length} relation{rows.length === 1 ? '' : 's'} — change types if you disagree, then press “Design pattern” on the relation you want — one pattern at a time:</>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map(r => (
                <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
                    <div style={{ fontFamily: 'Consolas, monospace', wordBreak: 'break-word', flex: 1 }}>
                      {r.lines.length ? r.lines.map(n => <div key={n}><b>P{n}</b>&nbsp; <Tokens text={pseudo[n - 1]} /></div>) : <span className="text-muted">(no pseudo-sentence assigned)</span>}
                    </div>
                    {(() => {
                      const dis = phase !== 'confirm' || bad(r) || wizardOpen;
                      const tip = wizardOpen ? 'Finish or cancel the open Add relation dialog first' : 'Design the pattern of this relation and open the Add relation wizard for it';
                      const alt = r.matches && !r.matches.current.length ? r.matches.others : [];       // this cartridge has no frame for it, others do
                      return alt.length
                        ? <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                            <button className="btn btn-sm btn-secondary" onClick={() => design(r)} disabled={dis} title={tip}>Design pattern in {cart.name}</button>
                            {alt.map(o => <button key={o.cartridge} className="btn btn-sm btn-primary" onClick={() => designIn(r, o)} disabled={dis}
                              title={wizardOpen ? tip : `${o.cartridge} extracts this relation: ${o.folders.join(', ')}. The sentence is run through ${o.cartridge} and the pattern is designed there.`}>Design pattern in {o.cartridge}</button>)}
                          </div>
                        : <button className={`btn btn-sm ${r.existing || r.pipeHit ? 'btn-secondary' : 'btn-primary'}`} style={{ flexShrink: 0 }} onClick={() => (r.existing ? redesign(r) : design(r))} disabled={dis} title={r.existing ? 'Open the existing pattern that already extracts this relation in the New relation wizard (step 4), to inspect and edit it — no LLM call' : tip}>{r.existing ? 'Redesign →' : r.pipeHit ? 'Design anyway →' : 'Design pattern →'}</button>;
                    })()}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                    <select style={sel} value={r.regulator} onChange={e => update(r.id, { regulator: e.target.value })} title="Regulator type">
                      {typeNames.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <span>—</span>
                    <select style={sel} value={r.relation} onChange={e => update(r.id, { relation: e.target.value, props: Object.fromEntries(Object.entries(r.props || {}).filter(([k, v]) => ctx.props?.[e.target.value]?.[k]?.includes(v))) })} title="Relation type">
                      {Object.keys(ctx.relations).filter(x => !dupOf[x]).map(x => ({ x, label: ctx.aliases?.[x] && ctx.aliases[x] !== x ? `${ctx.aliases[x]} (${x})` : x }))
                        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })).map(o => <option key={o.x} value={o.x}>{o.label}</option>)}
                    </select>
                    {Object.entries(ctx.props?.[r.relation] || {}).map(([k, vals]) => {
                      const set = (val) => update(r.id, { props: { ...Object.fromEntries(Object.entries(r.props || {}).filter(([kk]) => kk !== k)), ...(val ? { [k]: val } : {}) } });
                      const ge = ctx.propAliases?.[r.relation]?.[k];
                      return (
                        <label key={k} className="text-xs" style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={ge ? `GraphExplorer shows ${k} as ${ge}` : undefined}>
                          {k}{ge ? ` (GE: ${ge})` : ''}
                          {k === 'Effect'
                            ? <select style={{ ...sel, minWidth: 100 }} value={r.props?.[k] || ''} onChange={e => set(e.target.value)}>
                                <option value="">(not set)</option>{vals.map(v => <option key={v} value={v}>{v}</option>)}
                              </select>
                            : <>
                                <input list={`pv-${r.id}-${k}`} style={{ ...sel, minWidth: 150 }} value={r.props?.[k] || ''} placeholder="(not set)" onChange={e => set(e.target.value)} />
                                <datalist id={`pv-${r.id}-${k}`}>{vals.map(v => <option key={v} value={v} />)}</datalist>
                              </>}
                        </label>
                      );
                    })}
                    <span>→</span>
                    <select style={sel} value={r.target} onChange={e => update(r.id, { target: e.target.value })} title="Target type">
                      {typeNames.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {bad(r) && <span className="text-xs" style={{ color: 'var(--danger, #f38ba8)' }}>choose a relation type, a regulator type and a target type</span>}
                  </div>
                  {pseudo.length > 0 && <div className="text-xs" style={{ marginTop: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>Design the pattern for:</span>
                    <label title="A pattern on the tagged sentence (the msrc line): the words between the entities, no $ACT"><input type="radio" name={'target' + r.id} checked={!r.lines.length} onChange={() => update(r.id, { lines: [] })} /> the sentence</label>
                    <label title="A ConceptScan pattern on the normalised noun-verb-noun pseudo-sentences (with $ACT for the &)"><input type="radio" name={'target' + r.id} checked={r.lines.length > 0} onChange={() => { if (!r.lines.length) update(r.id, { lines: [1] }); }} /> pseudo-sentence:</label>
                    {pseudo.map((_, i) => <label key={i} style={{ opacity: r.lines.length ? 1 : 0.4 }}><input type="checkbox" disabled={!r.lines.length} checked={r.lines.includes(i + 1)} onChange={() => toggleLine(r.id, i + 1)} /> P{i + 1}</label>)}
                  </div>}
                  <div style={{ marginTop: 6 }}>
                    <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 2 }} title="The words of the sentence that state this relation. “Design pattern” designs the pattern for exactly this wording (the pseudo-sentences above are only a summary of the sentence).">Hint for the design — the wording of the sentence that states this relation (edit it if the LLM picked the wrong words)</label>
                    <textarea className="form-control" rows={2} spellCheck={false} style={{ width: '100%', fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }} value={r.reason || ''}
                      onChange={e => update(r.id, { reason: e.target.value })} placeholder="e.g. converts the antiviral agent ID{1213822=sorivudine} into ID{1273371=(E)-5-(2-bromovinyl)uracil}," />
                    {r.note && <div className="text-xs" style={{ marginTop: 3, color: 'var(--text-muted)' }}>{r.note}</div>}
                  </div>
                  {r.matches && !r.matches.current.length && r.matches.others.length > 0 && (
                    <div className="text-xs" style={{ marginTop: 6, color: 'var(--warning, #e8a000)' }}>
                      ⚠ {cart.name} has no frame for {r.regulator} — {r.relation} → {r.target}. {r.matches.others.map(o => `${o.cartridge} has one (${o.folders.join(', ')})`).join('; ')}. Choose where to design the pattern.
                    </div>
                  )}
                  {r.unused && (() => { const m = r.unused.matches[0]; return (
                    <div className="alert alert-warning" style={{ marginTop: 6, padding: '6px 10px', fontSize: 12 }}>
                      ⚠ The existing pattern <b>#{m.index}</b> of <code>{m.set}</code> ({m.folder}) finds this relation in the sentence, but <code>{m.folder}</code> is not part of allpats in locscan.ini, so the pipeline does not run it. A new pattern would extract the relation in the pipeline; alternatively add the folder to allpats.
                      <button type="button" className="btn btn-sm" style={{ marginLeft: 8, padding: '1px 8px' }} onClick={() => setViewExisting(r.unused)}>View existing pattern</button>
                    </div>); })()}
                  {r.pipeHit && !r.existing && (
                    <div className="alert alert-success" style={{ marginTop: 6, padding: '6px 10px', fontSize: 12 }}>
                      ✓ Already extracted: the {pipelineCart?.name || cart.name} pipeline output for this sentence already contains <b className="mono">{r.pipeHit.text}</b>{r.pipeHit.folder ? <> (<code>{r.pipeHit.folder}</code>)</> : null}. A new pattern is probably redundant.
                    </div>)}
                  {r.existing && (() => { const m = r.existing.matches[0]; const otherRun = !!(pipelineCart && onRunWith && String(pipelineCart.path).toLowerCase() !== String(cart.path).toLowerCase()); return (
                    <div className="alert alert-success" style={{ marginTop: 6, padding: '6px 10px', fontSize: 12 }}>
                      {otherRun
                        ? <>✓ Already extracted by <b>{cart.name}</b>: the existing pattern <b>#{m.index}</b> of <code>{m.set}</code> ({m.folder}) finds this relation in the sentence. The <b>{pipelineCart.name}</b> pipeline you ran does not extract it.{' '}
                            <a href="#" onClick={e => { e.preventDefault(); onRunWith(cart); }} style={{ color: 'var(--accent-hover, #9b8df9)', fontWeight: 600, textDecoration: 'underline' }}>Run the sentence with {cart.name} to see it</a>.</>
                        : <>✓ Already extracted: the existing pattern <b>#{m.index}</b> of <code>{m.set}</code> ({m.folder}) finds this relation in the sentence{r.existing.matches.length > 1 ? ` (and ${r.existing.matches.length - 1} more)` : ''}. A new pattern is probably redundant.</>}
                      <button type="button" className="btn btn-sm" style={{ marginLeft: 8, padding: '1px 8px' }} onClick={() => setViewExisting(r.existing)}>View existing pattern</button>
                    </div>); })()}
                </div>
              ))}
            </div>
            {skipped.length > 0 && <div className="text-xs" style={{ marginTop: 8, color: 'var(--text-muted)' }}>Not used by the LLM: {skipped.map((x, i) => <div key={i}><b>{x.lines.length ? x.lines.map(n => 'P' + n).join(', ') : 'other'}</b> — {x.reason}</div>)}</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={addRow}>＋ Add a relation myself</button>
              {rows.length === 0 && phase === 'confirm' && !error && onSwitchCartridge && (
                <button className="btn btn-secondary btn-sm" onClick={findOthers} disabled={others?.busy}
                  title="Run the sentence through the other cartridges and let the LLM look for one whose relation types fit it">Other cartridges</button>
              )}
            </div>
            {others && (
              <div style={{ marginTop: 10, padding: '8px 10px', border: '1px solid var(--border, #3a3a4a)', borderRadius: 6, fontSize: 13 }}>
                {others.busy && <div><span className="spinner" /> {others.msg}</div>}
                {others.error && <div style={{ color: 'var(--danger, #f38ba8)' }}>{others.error}</div>}
                {!others.busy && !others.error && others.matches.length === 0 && <div className="text-muted">No other cartridge ({others.checked || 0} checked) has a relation type that fits this sentence.</div>}
                {others.matches.map(m => (
                  <div key={m.cartridge} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                    <div style={{ flex: 1 }}>
                      <b>{m.cartridge}</b> — {m.regulator} — {m.relation}{m.props.Effect ? ` (Effect=${m.props.Effect})` : ''} → {m.target}
                      <div className="text-xs" style={{ color: m.exact.length ? 'var(--success, #a6e3a1)' : 'var(--warning, #e8a000)' }}>{m.extracted
                        ? <>✓ Existing pattern in <code>{m.extracted.folder}</code>. {onRunWith ? <a href="#" onClick={e => { e.preventDefault(); if (!wizardOpen) onRunWith({ name: m.cartridge, path: m.path }); }} style={{ color: 'var(--accent-hover, #9b8df9)', fontWeight: 600, textDecoration: 'underline' }}>Re-run pipeline with {m.cartridge}</a> : null}</>
                        : m.exact.length
                        ? <>✓ Existing frame in <code>{m.exact.join(', ')}</code></>
                        : m.other.length ? <>The frames in <code>{m.other.join(', ')}</code> take {m.regulator} → {m.target}, but with other properties — a new frame{m.props.Effect ? ` (Effect=${m.props.Effect})` : ''} is needed</>
                        : <>No existing frame takes {m.regulator} → {m.target} — a new rule is needed</>}</div>
                      {m.notRun && <div className="text-xs" style={{ color: 'var(--warning, #e8a000)' }}>The existing pattern #{m.notRun.index} of <code>{m.notRun.set}</code> ({m.notRun.folder}) finds it, but that folder is not part of allpats in locscan.ini, so the pipeline does not run it.</div>}
                      {m.reason && <div className="text-xs text-muted">{m.reason}</div>}
                    </div>
                    <button className="btn btn-primary btn-sm" style={{ flexShrink: 0 }} disabled={wizardOpen} onClick={() => onSwitchCartridge({ name: m.cartridge, path: m.path }, m.markup, { relation: m.relation, regulator: m.regulator, target: m.target, props: m.props, reason: m.reason })}>Switch to {m.cartridge} →</button>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs" style={{ marginTop: 8, color: 'var(--text-muted)' }}>
              Only IsFrame node types that are marked up in this sentence are offered: {ctx.types.map(t => `${t.type} (${t.examples[0]})`).join(', ') || 'none'}.
              An entity that is not marked up cannot take part in an extraction pattern. The wizard opens for the pattern you design; the other relations stay here for the next one.
            </div>
            {typeNames.length < 2 && <div className="alert alert-warning" style={{ marginTop: 8 }}>Fewer than two IsFrame node types are marked up in this sentence — no relation can be extracted from it by this cartridge.</div>}
          </>
        )}

        <div className="modal-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          {phase === 'design' && <span className="flex items-center gap-8"><span className="spinner" /><span className="text-muted text-sm">Designing pattern… {progress}</span></span>}
          {ctx && phase === 'confirm' && <button className="btn btn-secondary" onClick={() => askGuess(ctx)}>Ask again</button>}
          <button className="btn btn-secondary" onClick={onClose} disabled={phase === 'design'}>Close</button>
        </div>
      </div>
      {viewExisting && <UsedPatternsDialog res={viewExisting} cartPath={cart.path} title="Existing pattern that already extracts this relation (read-only)" onClose={() => setViewExisting(null)} />}
    </FloatingDialog>
  );
}
