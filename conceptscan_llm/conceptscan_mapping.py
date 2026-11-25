"""Tokenizing of an msrc line like conceptscan does, and mapping of LLM triples (copied phrases) back to the tokens of the line."""
import os, re
from difflib import SequenceMatcher

TOKEN_RE = re.compile(r'ID\{[^}]*\}|\w+(?:[.,:/\']\w+)*|\S')
GLOSSARY_RE = re.compile(r'\s*(?:GLOSSARY|CONTEXT)\{.*?\}')      # GLOSSARY{..} (variant names) and CONTEXT{ids} (tissue / population ids of the paper) are markers, not words of the sentence
ENT_RE = re.compile(r'^ID\{([^}=]*)=([^}]*)\}$')
WORD_RE = re.compile(r'\w+')
EDGE_STOP = {'the', 'a', 'an', 'this', 'that', 'these', 'those', 'its', 'their', 'his', 'her', 'of', 'in', 'on', 'to', 'by', 'with',
             'for', 'and', 'or', 'as', 'at', 'from', 'both', 'is', 'are', 'was', 'were', 'be', 'been'}


class Tok:
    __slots__ = ('text', 'entity', 'words', 'ids')
    def __init__(self, text):
        self.text = text
        m = ENT_RE.match(text)
        self.entity = bool(m)
        self.ids = m.group(1) if m else ''
        self.words = [w.lower() for w in WORD_RE.findall(m.group(2) if m else text)]


BS = chr(92)
U_RE = re.compile(re.escape(BS) + 'u([0-9a-fA-F]{4})')


def unescape_u(s):
    """a unicode escape written out as text (backslash, u, 4 hex digits: an escaped line) -> the character itself (beta); a surrogate pair becomes one character"""
    if BS + 'u' not in str(s): return s
    out = U_RE.sub(lambda m: chr(int(m.group(1), 16)), s)
    try: return out.encode('utf-16', 'surrogatepass').decode('utf-16')
    except UnicodeError: return out


def plain_text(msrc):
    """The sentence as the LLM sees it: entity markup removed (ID{1956=EGFR} -> EGFR), glossary dropped."""
    return re.sub(r'ID\{[^}=]*=([^}]*)\}', r'\1', GLOSSARY_RE.sub('', msrc))


BRACKET_RE = re.compile(r'\[\[\s*(.*?)\s*(?:\|[^\]]*)?\]\]')
DEFAULT_RANGES = {0: 'Protein', 1: 'SmallMol', 2: 'CellObject', 3: 'Complex', 4: 'CellProcess', 5: 'Virus', 6: 'Tissue', 7: 'Organism', 8: 'Organ',
                  9: 'Disease', 10: 'CellType', 11: 'CellLine', 12: 'FunctionalClass', 13: 'Treatment', 14: 'Enzyme', 15: 'ClinicalParameter',
                  16: 'MedicalProcedure', 17: 'GeneticVariant', 18: 'Pathogen'}      # [NodeType-MSIDRange] of nodetype.ini: the node type of an id is id // 1000000


def load_ranges(cartridge_dir):
    """[NodeType-MSIDRange] of <cartridge>\\nodetype.ini -> {range number: node type name}; the built-in table when the file is missing."""
    try:
        txt = open(os.path.join(cartridge_dir, 'nodetype.ini'), encoding='utf-8', errors='replace').read()
    except (OSError, TypeError):
        return dict(DEFAULT_RANGES)
    sec = re.search(r'\[NodeType-MSIDRange\](.*?)(?:\n\s*\[|\Z)', txt, re.S)
    out = {}
    for name, num in re.findall(r'^\s*(\w+)\s*=\s*(\d+)\s*$', sec.group(1) if sec else '', re.M):
        out[int(num)] = name
    return out or dict(DEFAULT_RANGES)


class NodeTyper:
    """Node types of the ids of an entity: ID{0,12812599=amylase} -> ['Protein', 'FunctionalClass'] (id // 1000000, names from nodetype.ini)."""
    def __init__(self, ranges=None):
        self.ranges = ranges or dict(DEFAULT_RANGES)
    def types(self, ids):
        out = []
        for i in str(ids).split(','):
            i = i.strip()
            if i.isdigit():
                t = self.ranges.get(int(i) // 1000000)
                if t and t not in out: out.append(t)
        return out


def clean_phrase(s):
    """A phrase of the LLM answer without the entity brackets and their type: '[[EGFR | gene]] kinase' -> 'EGFR kinase'. Also accepts a stray '| gene'."""
    s = BRACKET_RE.sub(r'\1', str(s or ''))
    return re.sub(r'\s*\|\s*[A-Za-z][A-Za-z -]*$', '', s.replace('[[', '').replace(']]', ''))


def tokenize(msrc):
    s = re.sub(r'(?<=[\w.])ID\{', ' ID{', GLOSSARY_RE.sub('', msrc))     # p.ID{..=G2019S}, antiID{..=tumor}: the entity is its own token, not the tail of a word
    return [Tok(t) for t in TOKEN_RE.findall(s)]


def _flat(toks):
    return [(i, w) for i, t in enumerate(toks) for w in t.words]


def _trim(words):
    a, b = 0, len(words)
    while a < b and words[a] in EDGE_STOP: a += 1
    while b > a and words[b - 1] in EDGE_STOP: b -= 1
    return words[a:b]


def find_span(toks, phrase, flat=None, trim=True, must=None):
    """token index range [a, b) of the phrase in the line, or None. Exact on words first, then a close fuzzy window (LLM typos / hyphen changes)."""
    flat = flat or _flat(toks)
    words = [w.lower() for w in WORD_RE.findall(phrase or '')]
    if trim: words = _trim(words)             # trim=False: the words exactly as given (the noun phrases of the model keep their articles and prepositions)
    if not words or not flat: return None
    fw = [w for _, w in flat]
    n = len(words)
    best, first = None, None
    for s in range(0, len(fw) - n + 1):
        if fw[s:s + n] == words:
            if must is None or flat[s][0] <= must <= flat[s + n - 1][0]:          # must: the occurrence that contains this token (the phrase may stand twice in the line)
                best = (s, s + n); break
            if first is None: first = (s, s + n)                                 # none contains it: the first one (the caller sees that it does not contain the entity)
    if best is None: best = first
    if best is None:
        score, ps = 0.0, ''.join(words)          # compare the letters, so "non small" = "nonsmall" and "EGFR-KDD" = "EGFR KDD"
        for size in range(max(1, n - 2), n + 3):
            for s in range(0, len(fw) - size + 1):
                r = SequenceMatcher(None, ps, ''.join(fw[s:s + size])).ratio()
                if r > score: score, best = r, (s, s + size)
        if score < 0.9: return None
        lo, hi = best                                   # a window one or two words too wide: drop the extra edge words that are stop words
        while hi - lo > 1 and fw[lo] in EDGE_STOP and fw[lo] not in words: lo += 1
        while hi - lo > 1 and fw[hi - 1] in EDGE_STOP and fw[hi - 1] not in words: hi -= 1
        best = (lo, hi)
    a, b = flat[best[0]][0], flat[best[1] - 1][0] + 1
    while a < b and not (toks[a].entity or toks[a].words): a += 1
    while b > a and not (toks[b - 1].entity or toks[b - 1].words): b -= 1       # no "(" / "," at the edges
    if a < b:
        bal = sum(1 for t in toks[a:b] if t.text == '(') - sum(1 for t in toks[a:b] if t.text == ')')
        if bal > 0 and b < len(toks) and toks[b].text == ')': b += 1                 # "(EGFR-KDD" + its ")"
        elif bal < 0 and a > 0 and toks[a - 1].text == '(': a -= 1                  # "EGFR) tyrosine kinase" + its "("
        bal = sum(1 for t in toks[a:b] if t.text == '(') - sum(1 for t in toks[a:b] if t.text == ')')
        if bal != 0: return None                                                     # still unbalanced: not a clean phrase
    return (a, b) if a < b else None


FORMS = {'be': {'is', 'are', 'was', 'were', 'be', 'been', 'being'}, 'have': {'has', 'have', 'had', 'having'},
         'do': {'do', 'does', 'did', 'done'}}


AUX = {'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'having', 'do', 'does', 'did', 'may', 'might', 'can', 'could', 'will', 'would', 'should'}


IRREGULAR = {'bind': {'bound'}, 'drive': {'drove', 'driven'}, 'give': {'gave', 'given'}, 'take': {'took', 'taken'}, 'show': {'shown'}, 'cause': set(),
             'lead': {'led'}, 'make': {'made'}, 'find': {'found'}, 'increase': set(), 'undergo': {'underwent', 'undergone'}, 'know': {'knew', 'known'},
             'rise': {'rose', 'risen'}, 'arise': {'arose', 'arisen'}, 'induce': set(), 'break': {'broke', 'broken'}, 'seek': {'sought'}, 'bear': {'bore', 'borne'}}


# ---- premodifiers of a noun phrase ----------------------------------------------------------------------------------------------------------------------------------------
# The model often leaves the adjective out of its noun phrase ("effects on bone health" for "detrimental effects on bone health"). The words between the predicate and the first word of the
# phrase are premodifiers of its head noun (adjectives, noun modifiers), so they are added to the phrase - unless they are stop words: prepositions (the $PREP macro of the cartridge's
# grdata/DictionaryMacros.msgrep), articles / determiners, conjunctions, auxiliaries, and a few sentence adverbs. No part-of-speech tagger: the position (between the verb and the noun) decides.
MIN_PREMOD_LEN = 3                                                               # a word of this many characters or fewer (is, of, can, may, the ...) ends the premodifiers
MAX_PREMOD = 4                                                                   # at most this many words are added in front of a phrase
_PREP_DEFAULT = ('by as to in with for from on at between into without among about against per throughout out across toward towards onto after during within under through before due given '
                 'upon because according despite via prior until along instead irrespective beneath inasmuch insofar lieu previous forasmuch insomuch above').split()
_DETERMINERS = 'the a an this that these those its their his her each every both some any all no which who whose than'.split()
_CONJ = ['and', 'or', 'nor', 'but', 'plus', 'versus', 'vs', 'as', 'well']
_ADVERBS = ['also', 'not', 'then', 'further', 'thereby']
MODIFIER_STOP = set(_PREP_DEFAULT) | set(_DETERMINERS) | set(_CONJ) | set(_ADVERBS)


def _macro_words(text, name, depth=0):
    """the words of the macro #define $NAME [ ... ] of a macro file: single words, the first word of "quoted phrases", and the words of the macros it uses ($AGAINST ...)"""
    m = re.search(r'#define\s+\$' + re.escape(name) + r'\b\s*\[(.*?)\]', text, re.S)
    out = set()
    if not m: return out
    for phrase, ref, word in re.findall(r'"([^"]+)"|\$(\w+)|([^\s"\[\]]+)', m.group(1)):
        if phrase: out.update(w.lower() for w in WORD_RE.findall(phrase.split()[0]))
        elif ref:
            if depth < 3: out |= _macro_words(text, ref, depth + 1)
        elif word: out.update(w.lower() for w in WORD_RE.findall(word.rstrip('~')))
    return out


def set_modifier_stop(cart):
    """take the prepositions from $PREP of <cartridge>/grdata/DictionaryMacros.msgrep (the built-in list when there is none)"""
    global MODIFIER_STOP
    preps = set(_PREP_DEFAULT)
    try:
        f = os.path.join(cart or '', 'grdata', 'DictionaryMacros.msgrep')
        if cart and os.path.isfile(f):
            with open(f, encoding='utf-8', errors='replace') as fh: got = _macro_words(fh.read(), 'PREP')
            if got: preps = got
    except Exception:
        pass
    MODIFIER_STOP = preps | set(_DETERMINERS) | set(_CONJ) | set(_ADVERBS)


def _premodified(toks, span, limit, stop):
    """span (a, b) with the premodifier words in front of the noun phrase added: plain words directly before it (back to token index `limit`), not stop words,
    not auxiliaries, not words of the predicate (`stop`), not entities, not words of 3 characters or fewer, at most MAX_PREMOD of them"""
    a, b = span
    n = 0
    while a > limit and n < MAX_PREMOD:
        t = toks[a - 1]
        if t.entity or not t.words or any(len(w) <= MIN_PREMOD_LEN or w in MODIFIER_STOP or w in AUX or w in stop for w in t.words): break
        a -= 1; n += 1
    return (a, b), n


def verb_forms(w):
    """the words a (base form) verb can appear as in a sentence: itself, its inflections (-s -es -ed -d -ing, y->ies/ied, doubled consonant) and the agent noun (-er, -r).
    NOT a longer word that only starts the same way: 'downregulate' is not 'downregulation'."""
    f = {w, w + 's', w + 'es', w + 'ed', w + 'd', w + 'ing', w + 'er', w + 'r', w + 'ers', w + 'rs'} | IRREGULAR.get(w, set())
    if w.endswith('e'): f |= {w[:-1] + 'ing', w[:-1] + 'er', w[:-1] + 'ers'}
    if w.endswith('y') and len(w) > 2: f |= {w[:-1] + 'ies', w[:-1] + 'ied', w[:-1] + 'ier'}
    if len(w) > 2 and w[-1] not in 'aeiouwxy' and w[-2] in 'aeiou' and w[-3] not in 'aeiou': f |= {w + w[-1] + 'ed', w + w[-1] + 'ing', w + w[-1] + 'er'}
    return f


def verb_in_sentence(verb, fw):
    """does the (base form) verb occur in the sentence as a word, in some form? Words the model made up (downregulate for downregulation) and hallucinated verbs (exist, have ...) are rejected."""
    w = verb.split(' ')[0].lower()
    words = set(fw)
    if w in FORMS: return bool(FORMS[w] & words)
    return bool(verb_forms(w) & words)


PREPOSITIONS = {'by', 'to', 'of', 'in', 'on', 'at', 'with', 'for', 'from', 'as', 'into', 'via', 'through', 'than', 'over', 'under', 'after', 'before', 'between', 'within', 'against',
                'upon', 'onto', 'toward', 'towards', 'during', 'among', 'across', 'about', 'per', 'through', 'thereby', 'whereby'}


def _phrase_at(vw, fw):
    n = len(vw)
    if not n: return False
    first = {vw[0]} | (FORMS[vw[0]] if vw[0] in FORMS else verb_forms(vw[0]))
    return any(fw[i] in first and fw[i + 1:i + n] == vw[1:] for i in range(len(fw) - n + 1))


def soft_predicate(vw):
    """the predicate without its leading and trailing prepositions ("by lowering" -> "lowering", "exert similar effects on" -> "exert similar effects"); [] when only prepositions are left"""
    a, b = 0, len(vw)
    while a < b and vw[a] in PREPOSITIONS: a += 1
    while b > a and vw[b - 1] in PREPOSITIONS: b -= 1
    return list(vw[a:b])


def predicate_in_sentence(vw, fw):
    """pairs mode: the words of the predicate stand in a row in the sentence (the first word may be any form of the verb: "have" for "has"). A predicate the model made out of words that are
    all somewhere in the sentence ("by simultaneously decreasing and increasing") is not a phrase of the sentence. When the exact predicate is not there, a softer match is tried without its
    leading and trailing prepositions: "by lowering" is not written so in the sentence ("..., lowering LDL ..."), but "lowering" is - the model only added the preposition of its own reading."""
    if _phrase_at(vw, fw): return True
    soft = soft_predicate(vw)
    return bool(soft) and soft != list(vw) and _phrase_at(soft, fw)


def _ents(toks, a, b):
    return sum(1 for t in toks[a:b] if t.entity)


INNER_BRACKET = re.compile(r'\[\[([^\[\]]*)\]\]')      # innermost brackets only: a nested "[[0.24% of [[EGFR | gene]] patients]]" gives "EGFR | gene"


def bracket_names(raw):
    return [re.sub(r'\s*\|[^|]*$', '', m).strip() for m in INNER_BRACKET.findall(str(raw or ''))]


def verb_index(toks, verb):
    """token index of the sentence word the (base form) verb comes from, or None. Plain words first, entity text last."""
    w = verb.split(' ')[0]
    w = w.lower()
    forms = FORMS[w] if w in FORMS else verb_forms(w)
    for ent_pass in (False, True):
        for i, t in enumerate(toks):
            if t.entity != ent_pass: continue
            if any(x in forms for x in t.words): return i
    return None


def entity_candidates(toks, raw):
    """Entity-only mode: ALL the entity tokens of the line that the answer phrase of the LLM names (a name can be marked up several times in a line).
    The answer phrase of the LLM ('[[EGFR | gene]]', or bare words) -> index of ONE entity token of the line, or None.
    The first bracketed name that matches an entity decides (exact words, then the same letters: EGFR-KDD / EGFR KDD, then an entity that is the
    beginning of the name or the other way round: [[EGFR-KDD]] -> EGFR, tumors -> tumor); of several equal entities the one nearest to token
    `near` (the verb) is taken. A phrase without brackets falls back to the usual span match and uses the first entity inside the span."""
    names = bracket_names(raw)
    if names:
        cands = []
        for name in names:
            want = [w.lower() for w in WORD_RE.findall(name)]
            if not want: continue
            letters = ''.join(want)
            cands = [i for i, t in enumerate(toks) if t.entity and t.words == want]
            if not cands: cands = [i for i, t in enumerate(toks) if t.entity and ''.join(t.words) == letters]
            if not cands:
                part = [(len(''.join(t.words)), i) for i, t in enumerate(toks) if t.entity and t.words and min(len(''.join(t.words)), len(letters)) >= 4
                        and (letters.startswith(''.join(t.words)) or ''.join(t.words).startswith(letters))]
                if part: best = max(p[0] for p in part); cands = [i for n, i in part if n == best]
            if cands: break
    else:
        sp = find_span(toks, clean_phrase(raw))
        cands = [i for i in range(*sp) if toks[i].entity][:1] if sp else []
    return cands


def find_entity(toks, raw, near=None):
    """ONE entity token of the line for an answer phrase (see entity_candidates): of several equal entities the one nearest to token `near` (the verb), else the first. None when there is none."""
    cands = entity_candidates(toks, raw)
    if not cands: return None
    return min(cands, key=lambda i: abs(i - near)) if near is not None else cands[0]


def pick_pair(cs, co, near=None):
    """The entity tokens of a triple when the subject and / or the object are marked up several times in the line ("PPARd" twice): the pair that stands closest together decides -
    the subject on the LEFT of the object (the mention of the subject that precedes the object, the nearest one to it; and the mention of the object that follows the subject), else the
    other order; equal: the nearer to the verb. -> (subject token, object token); None for a side that has no token."""
    if not cs or not co: return (min(cs, key=lambda i: abs(i - near)) if cs and near is not None else (cs[0] if cs else None)), (min(co, key=lambda i: abs(i - near)) if co and near is not None else (co[0] if co else None))
    def key(p):
        i, j = p
        return (0 if i < j else 1, abs(j - i), abs(((i + j) // 2) - near) if near is not None else 0)
    return min(((i, j) for i in cs for j in co if i != j), key=key, default=(cs[0], co[0]))


NEG_CUES = {'no', 'not', 'never', 'neither', 'nor', 'none', 'without', 'cannot', 'unable', 'fail', 'fails', 'failed', 'failing',
            'lack', 'lacks', 'lacked', 'lacking'}           # $NOT of the cartridges (no not cannot nor neither none without) + never, n't, fail to, unable to, lack of
NEG_BEFORE = {'no', 'not', 'neither', 'without', 'never'}


def negated_between(toks, lo, hi):
    """Is there a negation word inside toks[lo:hi] (the stretch that holds subject, verb and object), or right before it? conceptscan never outputs a
    negated relation ("X does not prevent Y"), so such a triple must not be output either. "not only ... but also" is not a negation."""
    if lo > 0 and toks[lo - 1].text.lower() in NEG_BEFORE: lo -= 1
    n = len(toks)
    for i in range(max(0, lo), min(hi, n)):
        t = toks[i]
        if t.entity: continue
        x = t.text.lower()
        if x in NEG_CUES:
            if x == 'not' and i + 1 < n and toks[i + 1].text.lower() == 'only': continue
            return True
        if x.endswith("n't") or x.endswith('n’t'): return True
        if x in ("'", '’') and i > 0 and i + 1 < n and toks[i + 1].text.lower() == 't' and toks[i - 1].text.lower().endswith('n'): return True
    return False


CLAUSE_BREAK = {',', ';', ':', '(', ')', '[', ']', 'and', 'but', 'while', 'whereas', 'meanwhile', 'however', 'although', 'though', 'yet', 'which', 'that', 'whereby'}


def _cue_at(toks, i):
    """is toks[i] a negation word (not 'not only')?"""
    t = toks[i]
    if t.entity: return False
    x = t.text.lower(); n = len(toks)
    if x in NEG_CUES:
        return not (x == 'not' and i + 1 < n and toks[i + 1].text.lower() == 'only')
    if x.endswith("n't") or x.endswith('n’t'): return True
    return x in ("'", '’') and i > 0 and i + 1 < n and toks[i + 1].text.lower() == 't' and toks[i - 1].text.lower().endswith('n')


def verb_positions(toks, verb):
    """every token index the (base form) verb can come from, plain words first."""
    w = verb.split(' ')[0].lower()
    forms = FORMS[w] if w in FORMS else verb_forms(w)
    out = []
    for ent_pass in (False, True):
        for i, t in enumerate(toks):
            if t.entity == ent_pass and any(x in forms for x in t.words): out.append(i)
        if out: break
    return out


def pick_verb(toks, verb, s, o):
    """the occurrence of the verb that belongs to this triple: between subject and object when there is one (the last of them), else the nearest to the subject."""
    pos = verb_positions(toks, verb)
    if not pos: return None
    lo, hi = sorted([s[1], o[1]])[0], max(s[0], o[0])
    if s[1] <= o[0]: lo, hi = s[1], o[0]
    elif o[1] <= s[0]: lo, hi = o[1], s[0]
    between = [i for i in pos if lo <= i <= hi]
    return between[-1] if between else min(pos, key=lambda i: abs(i - s[0]))


def negated_near_verb(toks, vi, back=5, fwd=2):
    """Does a negation attach to the verb at toks[vi]: the verb itself ("failed to induce"), a cue in the few words before it up to the clause boundary
    ("did not increase", "is unable to affect"), or "no" / "neither" right after it ("inhibits neither A nor B")? A negation of an earlier, coordinated verb
    ("did not increase X, and significantly reduced Y") does not count for the later verb: the clause boundary stops the search."""
    i, steps = vi, 0
    while i >= 0 and steps <= back:
        if i != vi and toks[i].text.lower() in CLAUSE_BREAK: break
        if _cue_at(toks, i): return True
        i -= 1; steps += 1
    for j in range(vi + 1, min(len(toks), vi + 1 + fwd)):
        if toks[j].text.lower() in CLAUSE_BREAK: break
        if not toks[j].entity and toks[j].text.lower() in {'no', 'not', 'neither', 'nor', 'never'} and _cue_at(toks, j): return True
    return False


MOD_GAP = re.compile(r'^\s*[-‐-―]\s*[\w-]+\s*$')        # "-dependent", "-induced", "-mediated" between two entities
def _neighbour_ids(toks, span, which):
    """The (non-class) ids of the entity token of toks[span] that is nearest to the verb: the last one of a subject span, the first of an object span."""
    ents = [t for t in toks[span[0]:span[1]] if t.entity]
    if not ents: return set()
    t = ents[-1] if which == 'last' else ents[0]
    return {i.strip() for i in t.ids.split(',') if i.strip().isdigit() and int(i.strip()) % 1000000 != 0}


CONJ_GAP = re.compile(r'^\s*(?:,\s*(?:and|or)|,|/|&|and/or|and|or)\s*$', re.I)
NOT_A_VERB = {'in', 'to', 'of', 'on', 'by', 'with', 'for', 'at', 'from', 'as', 'into', 'via', 'than', 'and', 'or', 'that', 'which', 'who', 'whose'}


def entity_choices(raw):
    """The bracketed entities of one subject / object field: None = at most one entity (nothing to expand), [] = several that are not a list
    ([[EGFR]] [[tyrosine kinase]] inhibitors: which one is meant?), else the names of a list ([[serine]]/[[cysteine]], A, B and C)."""
    raw = str(raw or '')
    ms = list(INNER_BRACKET.finditer(raw))
    names = [re.sub(r'\s*\|[^|]*$', '', m.group(1)).strip() for m in ms]
    if len({n.lower() for n in names}) <= 1: return None
    keep = [i for i in range(len(ms)) if not (i + 1 < len(ms) and MOD_GAP.match(raw[ms[i].end():ms[i + 1].start()]))]   # [[X]]-dependent [[Y]]: X only modifies Y, Y is the head
    for i, j in zip(keep, keep[1:]):
        if not CONJ_GAP.match(raw[ms[i].end():ms[j].start()]): return []
    return [names[i] for i in keep]


def expand_entity_triples(triples):
    """Entity-only mode: a list of entities in one field becomes one triple per entity; an ambiguous field drops the triple."""
    for t in triples:
        subs, objs = entity_choices(t.get('subject')), entity_choices(t.get('object'))
        if subs == [] or objs == []: continue
        ss = ['[[%s]]' % n for n in subs] if subs else [t.get('subject', '')]
        oo = ['[[%s]]' % n for n in objs] if objs else [t.get('object', '')]
        for s in ss:
            for o in oo:
                yield dict(t, subject=s, object=o)


def _occurrences(toks, words):
    """token spans (a, b) of the plain (not entity) tokens that spell `words` one after the other"""
    k, out = len(words), []
    for a in range(len(toks) - k + 1):
        if all(not toks[a + j].entity and words[j] in toks[a + j].words for j in range(k)): out.append((a, a + k))
    return out


EXTRA_FIELDS = (('effect', ('effect', 'modifier')), ('change type', ('change_type', 'change type')), ('preposition', ('preposition',)))
EXTRA_REACH = 4          # an effect / change-type word stands within this many tokens of the subject entity, the object entity or the verb


def _gap(x, span):
    """tokens between the occurrence x = (a, b) and a token span (c, d); 0 = they touch or overlap"""
    return span[0] - x[1] + 1 if x[1] <= span[0] else (x[0] - span[1] + 1 if x[0] >= span[1] else 0)


def place_extras(toks, t, s, o, verb, vi, strict, sent_words, note):
    """pairs mode: the extra words of a triple - effect (downregulation, higher ...), change type (level, activity, mRNA ...) and the preposition after the verb (by, from, of ...).
    Every one must be a word of the sentence (strict mode: else it is left out) and stand where it belongs: an effect / change-type word within EXTRA_REACH tokens of the subject
    entity, the object entity or the verb (the word that changes the sign of the effect can stand at either entity), the preposition right after the verb.
    The words keep the order of the sentence: (before, after, tail) = those before the verb (they follow the subject: 'ID{X} downregulation & ...'), those from the verb up to the
    object ('... & driver of ID{Y}') and those behind the object entity ('... ID{Y} knockdown')."""
    sent_set = set(sent_words)
    placed = []                                                                # (token position, 'before' | 'after' | 'tail', text)
    for kind, keys in EXTRA_FIELDS:
        raw = next((t.get(k) for k in keys if t.get(k)), '')
        words = WORD_RE.findall(str(raw or '').lower())
        if not words: continue
        vw0 = verb.split(' ')[0]
        if kind != 'preposition' and len(words) == 1 and (words[0] == vw0 or words[0] in verb_forms(vw0)):      # the model repeats the verb as the effect: the verb says it already
            note(t, 'the %s "%s" is the verb itself: left out' % (kind, words[0])); continue
        known = all(w in sent_set for w in words)
        if strict and not known: note(t, 'the %s "%s" is not a word of the sentence: left out' % (kind, ' '.join(words))); continue
        if not known:                                                          # strict mode off: the model's own word cannot be placed - after the subject, a preposition after the verb
            placed.append((-1 if kind != 'preposition' else 10 ** 6, 'after' if kind == 'preposition' else 'before', ' '.join(words))); continue
        occ = [(a, b) for a, b in _occurrences(toks, words) if not (a < s[1] and s[0] < b) and not (a < o[1] and o[0] < b) and not (vi is not None and a <= vi < b)]      # not an entity, not the verb's own word
        if kind == 'preposition':
            anchor = vi if vi is not None else s[1] - 1
            occ = [(a, b) for a, b in occ if a > anchor and a - anchor <= EXTRA_REACH + 2]
            pick = min(occ, key=lambda x: x[0]) if occ else None
        else:
            def dist(x):
                return min([_gap(x, s), _gap(x, o)] + ([_gap(x, (vi, vi + 1))] if vi is not None else []))
            occ = [x for x in occ if dist(x) <= EXTRA_REACH]
            pick = min(occ, key=dist) if occ else None
        if not pick: note(t, 'the %s "%s" is not next to the subject, the object or the verb: left out' % (kind, ' '.join(words))); continue
        text = ' '.join(x.text for x in toks[pick[0]:pick[1]])
        if o[0] > s[0] and pick[0] >= o[1]: side = 'tail'
        elif (vi is not None and pick[0] > vi) or (vi is None and kind == 'preposition'): side = 'after'
        else: side = 'before'
        placed.append((pick[0], side, text))
    placed.sort(key=lambda x: x[0])
    before = [x[2] for x in placed if x[1] == 'before']
    after = [x[2] for x in placed if x[1] == 'after']
    tail = [x[2] for x in placed if x[1] == 'tail']
    vw = verb.split(' ')
    while after and vw and after[0].lower().split(' ')[0] in vw[-1:] and len(after[0].split(' ')) == 1: after = after[1:]      # "associate with" + "with": once
    return before, after, tail


def _retarget(toks, flat, phrase, own):
    """An entity that is named several times in the sentence ("ketamine" three times): the mention that stands inside the model's noun phrase is the one meant."""
    if not own or not str(phrase or '').strip(): return own
    sp = find_span(toks, clean_phrase(phrase), flat, trim=False)
    if not sp or sp[0] <= own[0] < sp[1]: return own
    for i in range(*sp):
        if toks[i].entity and toks[i].words == toks[own[0]].words: return (i, i + 1)
    return own


def _widen(toks, flat, phrase, own, other, what, note, t, stop=()):
    """pairs mode: the noun phrase the model gave (it must be words of the sentence, contain this side's entity and not the other side's) replaces the entity token as the side of the triple;
    otherwise None: the triple is dropped (the noun phrases are the model's, the app does not make up its own)."""
    if not str(phrase or '').strip(): return own
    sp = find_span(toks, clean_phrase(phrase), flat, trim=False, must=own[0])
    if not sp: note(t, 'the %s "%s" is not words of the sentence: triple dropped' % (what, phrase)); return None
    if not (sp[0] <= own[0] < sp[1]): note(t, 'the %s "%s" does not contain the entity: triple dropped' % (what, phrase)); return None
    if sp[0] < other[1] and other[0] < sp[1]: note(t, 'the %s "%s" contains the other entity too: triple dropped' % (what, phrase)); return None
    limit = other[1] if other[1] <= sp[0] else 0                                  # the premodifiers: the words in front of the phrase, back to the other side / the sentence start
    sp2, n = _premodified(toks, sp, limit, stop)
    if n: note(t, 'the %s "%s" is widened by its premodifier(s) "%s"' % (what, phrase, ' '.join(x.text for x in toks[sp2[0]:sp[0]])))
    return sp2


def _anaphoric(toks, flat, phrase, own, other, what, note, t):
    """pairs mode: the model's noun phrase starts with a pronoun ("its deletion in beta-cells"): the text of this side is the antecedent's markup (the entity token `own`) followed by the rest of the phrase
    as the sentence has it. None (the triple is dropped) when the phrase is not words of the sentence in a row, or it overlaps the other side."""
    sp = find_span(toks, clean_phrase(phrase), flat, trim=False)
    if not sp or toks[sp[0]].entity: note(t, 'dropped: the %s "%s" is not words of the sentence' % (what, phrase)); return None
    if sp[0] < other[1] and other[0] < sp[1]: note(t, 'dropped: the %s "%s" overlaps the other side of the triple' % (what, phrase)); return None
    text = ' '.join([toks[own[0]].text] + [x.text for x in toks[sp[0] + 1:sp[1]]])
    note(t, 'the pronoun "%s" of the %s is replaced by its antecedent: %s' % (toks[sp[0]].text, what, text))
    return text


def triples_to_lines(toks, triples, min_ent=2, require_verb=True, first_main=False, entity_only=False, skip_aux=False, skip_negated=False, allow=None, trace=None, full_predicate=False):
    """LLM triples [{subject, verb, object, kind}] -> pseudo-sentence lines '#Main  S & verb  O' (without the leading '<TAB>').
    first_main: the first line that survives is #Main, all later ones #NPRel (kind is ignored).
    entity_only: subject and object are single entity tokens. skip_aux: a triple whose verb is only an auxiliary / modal (be, have, may ...) is dropped.
    trace: a list that receives one text line per triple of the model: what became of it ("kept: ..." or "dropped: <the reason>")."""
    flat = _flat(toks)
    sent_words = [w for _, w in flat]
    out, seen, seen_pairs, seen_text = [], set(), set(), set()
    if entity_only: triples = list(expand_entity_triples(triples))
    all_pred = {w for tt in triples for w in WORD_RE.findall(str(tt.get('verb', '')).lower())}      # the verbs of ALL the model's predicates: not premodifiers of any phrase ("increasing" in "decreasing X and increasing Y")
    def note(t, what):
        if trace is not None: trace.append('%s / %s / %s  ->  %s' % (t.get('subject', ''), t.get('verb', ''), t.get('object', ''), what))
    for t in triples:
        vw = WORD_RE.findall(str(t.get('verb', '')).lower())
        if not full_predicate:                                                  # pairs mode (full_predicate): the predicate is kept exactly as the model gave it, "is a driver of" included
            while len(vw) > 1 and vw[0] in AUX: vw = vw[1:]                     # "were identified" -> "identified" (NPRel would glue "were")
            while len(vw) > 1 and vw[0] in ('a', 'an', 'the'): vw = vw[1:]       # "is a driver of" -> "driver of"
        verb = ' '.join(vw).strip()
        try:
            if entity_only and verb:                                           # each side is ONE entity token; the words around it do not matter
                near = verb_index(toks, verb)
                si, oi = pick_pair(entity_candidates(toks, t.get('subject', '')), entity_candidates(toks, t.get('object', '')), near)      # several marked mentions: the closest pair, subject on the left of the object
                s, o = ((si, si + 1) if si is not None else None), ((oi, oi + 1) if oi is not None else None)
            else:
                s = find_span(toks, clean_phrase(t.get('subject', '')), flat)
                o = find_span(toks, clean_phrase(t.get('object', '')), flat)
        except Exception:
            note(t, 'dropped: could not locate subject / object in the sentence'); continue
        if not verb: note(t, 'dropped: no verb'); continue
        if not s: note(t, 'dropped: the subject is not words of the sentence (the model changed or invented them)'); continue
        if not o: note(t, 'dropped: the object is not words of the sentence (the model changed or invented them)'); continue
        if verb in NOT_A_VERB and not full_predicate: note(t, 'dropped: the "verb" is a preposition'); continue         # pairs mode (full_predicate): "in", "with", "due to" are valid predicates, the downstream patterns decide
        if allow is not None and entity_only and not allow(s[0], o[0]): note(t, 'dropped: no frame of the cartridge takes this subject type -> object type'); continue
        if skip_aux and all(w in AUX for w in verb.split(' ')): note(t, 'dropped: the verb is only an auxiliary / modal (is, have, may ...)'); continue
        if require_verb and not (verb_in_sentence(verb, sent_words) or (full_predicate and soft_predicate(vw) and verb_in_sentence(' '.join(soft_predicate(vw)), sent_words))): note(t, 'dropped: the verb "%s" does not occur in the sentence' % verb); continue
        if require_verb and full_predicate and not predicate_in_sentence(vw, sent_words): note(t, 'dropped: the predicate "%s" is not a phrase of the sentence (its words do not stand in a row there)' % verb); continue
        if skip_negated:
            vi = pick_verb(toks, verb, s, o)
            if vi is not None:                                                  # the negation that belongs to THIS verb (see negated_near_verb), or "No X inhibits Y" / "Neither X ..." before the subject
                if negated_near_verb(toks, vi) or (s[0] > 0 and toks[s[0] - 1].text.lower() in NEG_BEFORE and _cue_at(toks, s[0] - 1)): note(t, 'dropped: the sentence negates this verb'); continue
            elif negated_between(toks, min(s[0], o[0]), max(s[1], o[1])): note(t, 'dropped: a negation sits between subject and object'); continue
        if s[0] < o[1] and o[0] < s[1]: note(t, 'dropped: subject and object overlap'); continue                    # overlapping phrases are not a relation
        ids_s, ids_o = _neighbour_ids(toks, s, 'last'), _neighbour_ids(toks, o, 'first')
        if ids_s and ids_s == ids_o: note(t, 'dropped: the entity next to the verb is the same on both sides'); continue   # "EGFR involve EGFR" is no relation. Only when the two have the SAME ids:
        # "hypertension (aortic dissection" (9000536, 9010369) ... "hypertension" (9010369) share one id but the first is also aortic dissection: that relation is real
        es, eo = _ents(toks, *s), _ents(toks, *o)
        if es < 1 or eo < 1 or es + eo < min_ent: note(t, 'dropped: subject and object each need a dictionary entity (ID{...}); the subject has %d, the object %d' % (es, eo)); continue
        if entity_only:                                                         # the same pair and verb once, whether the model called it clause or modifier
            pair = (s[0], verb if full_predicate else verb.split(' ')[0], o[0])
            if pair in seen_pairs: note(t, 'dropped: the same pair and verb again'); continue
            seen_pairs.add(pair)
        if entity_only and (t.get('subject_phrase') or t.get('object_phrase')):                  # pairs mode: the noun phrases of the answer around the two entities
            s2, o2 = _widen(toks, flat, t.get('subject_phrase'), s, o, 'noun phrase 1', note, t, set(vw) | all_pred), _widen(toks, flat, t.get('object_phrase'), o, s, 'noun phrase 2', note, t, set(vw) | all_pred)
            if s2 is None or o2 is None: continue
            if s2[0] < o2[1] and o2[0] < s2[1]: note(t, 'dropped: the two noun phrases overlap'); continue
            s, o = s2, o2
        sub = ' '.join(x.text for x in toks[s[0]:s[1]])
        if entity_only and (t.get('subject_anaphor') or t.get('object_anaphor')):          # "its deletion in beta-cells": only the PRONOUN is replaced by the antecedent (its markup), the rest stays as written
            sub2 = _anaphoric(toks, flat, t.get('subject_anaphor'), s, o, 'noun phrase 1', note, t) if t.get('subject_anaphor') else sub
            obj2 = _anaphoric(toks, flat, t.get('object_anaphor'), o, s, 'noun phrase 2', note, t) if t.get('object_anaphor') else ' '.join(x.text for x in toks[o[0]:o[1]])
            if sub2 is None or obj2 is None: continue
            sub, obj = sub2, obj2
        else:
            obj = ' '.join(x.text for x in toks[o[0]:o[1]])
        before, after, tail = [], [], []                                        # pairs mode: effect / change type / preposition words, in the order of the sentence
        if any(t.get(k) for _, ks in EXTRA_FIELDS for k in ks):
            before, after, tail = place_extras(toks, t, s, o, verb, pick_verb(toks, verb, s, o), require_verb, sent_words, note)
        if before: sub = sub + ' ' + ' '.join(before)
        if tail: obj = obj + ' ' + ' '.join(tail)
        if (sub, verb, obj) in seen_text: note(t, 'dropped: the same noun phrases and predicate again (the model\'s phrase holds several entities: one line serves them all)'); continue
        seen_text.add((sub, verb, obj))
        if (len(out) > 0) if first_main else (t.get('kind') == 'modifier'):
            line = '#NPRel  %s &%s  %s' % (sub, verb if full_predicate else verb.split(' ')[0], obj)   # NPRel carries one glued verb (pairs mode: the whole predicate)
        else:
            line = '#Main  %s & %s  %s' % (sub, ' '.join([verb] + after), obj)
        if line in seen: note(t, 'dropped: the same line again'); continue
        seen.add(line); out.append(line); note(t, 'KEPT as: ' + line)
    return out
