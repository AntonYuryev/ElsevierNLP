// ── Every place of the app that asks an LLM ────────────────────────────────────────────────────────────────────────────────────────
// Settings → LLM Connector and Settings → Local LLM list these functions; for each one the user chooses which LLM answers:
//   'api'   = the LLM provider of Settings → LLM Connector (e.g. Gemini)
//   'local' = the local Ollama server of Settings → Local LLM (port / SSH tunnel), with the model chosen there
// The choice is kept in the setting llmFunctionTargets = { <function id>: 'api' | 'local' } (default 'api'). callLlm(messages, { fn: '<id>' }) reads it.
// Triplification (conceptscan_llm in the Pipeline and NLP Runner) is not here: it is chosen in the Triplification panel of those screens.

export const LLM_FUNCTIONS = [
  // Reader
  { id: 'reader.pronouns', group: 'Reader', name: 'Pronoun resolution (Reader)', text: 'For each pronoun (it, its, they, them, their) of the document asks which entity marked up before it is meant, so that the relations are found in the text with the names. Whatever the Triplefication is.', default: 'local' },
  // Suggest pattern (Pipeline screen) — no Google Search grounding in any of these calls
  { id: 'suggest.guess',  group: 'Suggest pattern', name: 'Find the relations of the sentence', text: 'Reads the ConceptScan markup and proposes the relations (types, node types, the wording).' },
  { id: 'suggest.design', group: 'Suggest pattern', name: 'Design the pattern', text: 'Writes the extraction pattern for one relation (the candidates that are tested).' },
  { id: 'suggest.repair', group: 'Suggest pattern', name: 'Repair a pattern that failed its test', text: 'Corrects a candidate pattern after the test found nothing or an error.' },
  { id: 'suggest.others', group: 'Suggest pattern', name: 'Other cartridges: which one fits the sentence', text: 'Picks the sibling cartridges whose relation types fit the sentence.' },
  // Patterns screen
  { id: 'relpat.examples', group: 'Patterns', name: 'Example sentences for the patterns of a relation', text: 'Writes a sentence for each pattern in the "Patterns of this relation" window.' },
  // Dictionary screen
  { id: 'dict.editByLlm',       group: 'Dictionary', name: 'Edit by LLM (name / URN of the records)', text: 'Chooses a preferred name and a URN for the records in the editor.', grounding: true },
  { id: 'dict.mixedAnnotate',   group: 'Dictionary', name: 'Mixed import: annotate the unmapped aliases', text: 'Proposes the entity name / URN of every alias of the mixed import that has no record.', grounding: true },
  { id: 'dict.batchConflicts',  group: 'Dictionary', name: 'Batch import: resolve conflicts', text: 'Fills the table alias × conflicting record (Yes / No) of the batch import.', grounding: true },
  { id: 'dict.resolveConflicts', group: 'Dictionary', name: 'Resolve duplicate-alias conflicts', text: 'The "Resolve by LLM" button: decides which record an alias that is stored in several records belongs to.', grounding: true },
  { id: 'dict.resolveSingle',   group: 'Dictionary', name: 'Resolve one duplicate-alias conflict (context menu)', text: 'The same decision for the one row you right-click.', grounding: true },
];

export const LLM_TARGETS = { api: 'LLM provider (Settings → LLM Connector)', local: 'Local LLM (Settings → Local LLM)' };

/** 'api' | 'local' for a function id, from the settings object (anything unknown = 'api') */
export function llmTargetOf(settings, fnId) {
  const t = settings && settings.llmFunctionTargets && settings.llmFunctionTargets[fnId];
  if (t === 'local' || t === 'api') return t;
  const f = LLM_FUNCTIONS.find(x => x.id === fnId);
  return f && f.default === 'local' ? 'local' : 'api';                        // not chosen yet: the default of the function (main.js reader:coref uses the same: 'local')
}
