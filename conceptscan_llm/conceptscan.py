#!/usr/bin/env python3
"""
conceptscan.py - drop-in replacement for MedScan's conceptscan.exe that gets its pseudo-sentences from an LLM (Ollama).

I/O is the same as conceptscan.exe (see locscan.ini:  ./conceptscan -t$t -O2 -O$E -w$w -v$v -q$q -H csdata -p$p ):
  input  (stdin or -i):  records  mref / TextRef / msrc  separated by blank lines; msrc = sentence with ID{ids=text} entity markup
  output (stdout or -o): the same lines, CRLF, and after every msrc line the pseudo-sentences
        <TAB>#Main  <subject tokens> & <verb>  <object tokens>
        <TAB>#NPRel <subject tokens> &<verb>  <object tokens>
  Subject / object keep the ID{...} tokens of the sentence, so the patterns of the cartridges (csout mode) match as before.

ONE request per sentence: the prompt (the template of the app, with the list of the sentence's target entities) asks for noun phrase 1 - predicate - noun phrase 2 triples; each noun phrase
must hold a target entity (an entity a frame of the cartridge can use; not two of the same type), which maps the triple back to the tokens of the input line (conceptscan_mapping.py).
A triple that cannot be mapped, or has fewer than -O entities, is dropped.
Settings: conceptscan_llm.json next to this file (or the .exe); environment CSLLM_URL / CSLLM_MODEL / CSLLM_WORKERS override it.
"""
import sys, os, re, json, time, hashlib, sqlite3, threading, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from conceptscan_mapping import find_span, unescape_u, Tok, ENT_RE, WORD_RE, clean_phrase, tokenize, triples_to_lines, plain_text, NodeTyper, load_ranges, set_modifier_stop  # noqa: E402
import conceptscan_version  # noqa: E402
from conceptscan_frames import load_catalog, candidate_pairs  # noqa: E402

APP_DIR = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, 'frozen', False) else __file__))

DEFAULTS = {
    'backend': 'ollama',               # 'ollama', 'openai' (any OpenAI-compatible /chat/completions gateway) or 'bedrock'
    'api_key': '',                     # openai backend: bearer key (better: environment CSLLM_APIKEY, so it is not written to a file)
    'auth_header': '',                 # openai backend: name of the header that carries the key instead of "Authorization: Bearer" (e.g. api-key, x-api-key)
    'extra_headers': '',               # openai backend: more headers, one "name: value" per line (also CSLLM_EXTRAHEADERS)
    'top_p': None,                     # openai backend: nucleus sampling (unset = the server's default)
    'max_tokens': 1500,                # openai / bedrock: maximum tokens of the answer
    'referent_prompt_file': '',        # a text file that REPLACES the pronoun question (CSLLM_REFERENT_PROMPT_FILE); empty = the built-in one (--show-referent-prompt)
    'prompt_file': '',                 # a text file that REPLACES the prompt template (CSLLM_PROMPT_FILE); empty = the built-in template (see --show-pair-prompt)
    'url': 'http://localhost:11434',   # Ollama server
    'region': 'us-east-1',             # bedrock: AWS region (credentials: the usual AWS chain - instance role, env vars, ~/.aws)
    'model': 'llama3.1:8b',            # any model pulled into Ollama, e.g. llama4:scout, qwen2.5:14b
    'workers': 4,                      # sentences sent to the LLM in parallel (set OLLAMA_NUM_PARALLEL on the server to match)
    'timeout': 300,                    # seconds per request
    'retries': 2,
    'num_ctx': 4096,
    'temperature': 0,
    'keep_alive': '30m',
    'cache': True,                     # remember answers (sqlite file next to the config): re-running the same text costs nothing
    'cache_file': 'conceptscan_llm_cache.sqlite',
    'cache_max_mb': 1024,              # the cache is kept under this size: when it grows over it, the OLDEST answers are deleted (0 = no limit); CSLLM_CACHE_MAX_MB
    'drop_negated': True,              # drop a triple when a negation word (not, no, never, neither, nor, without, cannot, n't, fail to, unable to, lack) sits between/around its words - conceptscan outputs no negations
    'cartridge': '',                   # the cartridge folder (has grdata and nodetype.ini). Empty = the current folder, then the folder of the exe. Its nodetype.ini gives the node type of an entity id, its grdata the frames (relation types)
    'pair_window': 40,                 # only pairs of entities that are at most this many tokens apart are listed
    'max_pairs': 24,                   # at most this many candidate relations are listed (the closest ones)
    'check_frames': False,             # OFF by default: every triple the model asserts is written, also when no frame takes its subject type -> object type (msgrep ignores it). True (CSLLM_CHECK=1) drops such triples
}

# ── pairs mode: one request per pair of entities that the cartridge's frames can extract ──
# The answer of a request is ONE structure: noun phrase 1 - predicate - noun phrase 2 (the names of its keys are those of the JSON line of the template, found by their meaning:
# see parse_answer). The prompt decides what the three values are; the program turns them into the pseudo-sentence "noun phrase 1 & predicate noun phrase 2".
#
# STRATEGY (2.1.0): ONE request per sentence. The prompt starts with the list of the target entities - every entity of the sentence that some frame of the cartridge can use,
# in the order of the sentence: Target entities in sentence: ["a", "b", "c"] - then the template (the instructions), then the sentence. The model answers with a JSON ARRAY of
# triples {NP1, Predicate, NP2}; each noun phrase must hold a target entity (not two of the same type), which is how the program knows which two entities a triple links.
DEFAULT_PROMPT = (       # ${1:...}: the list of the target entities (see sentence_prompt); the last line is the JSON answer line
    'You are linguist with expertise in biomedical literature\n'
    'Focusing on ${1:list of tagged entities}\n'
    'Fill in the steps in order:\n'
    '1. "noun_phrases": every noun phrase of the sentence that contains at least one focus entity. Split appositives, coordinations and complex compound phrases so each noun phrase holds least number of focus entities.\n'
    '2. "triples": for every pair of those "noun_phrases" with a direct link in the sentence, where NP1 appears before NP2, extract the exact linking predicate including prepositional phrases if exist (verb, adjective, relational noun or passive verb phrase together with its agentive preposition). Keep full verbal complex, do not omit adverbs. Coordinating conjunctions alone such as "and" cannot be a predicate.\n'
    'Answer with JSON only: {"triples": [{"NP1": "...", "Predicate": "...", "NP2": "..."}]}')
# The second request, only for a noun phrase that starts with a pronoun ("its deletion in beta-cells"): which entity does the pronoun refer to? ${sentence} ${np1} ${predicate} ${np2} ${pronoun}
# ${candidates} (the target entities that stand before the pronoun, as ["a", "b"]) are replaced; the user can edit the text (the app's "Pronoun prompt" box, CSLLM_REFERENT_PROMPT_FILE).
DEFAULT_REFERENT_PROMPT = (
    'Sentence: ${sentence}\n'
    'Triple: NP1 "${np1}" - Predicate "${predicate}" - NP2 "${np2}"\n'
    'Entities of the sentence before "${pronoun}": ${candidates}\n'
    'What entity does "${pronoun}" refer to in this triple? Answer with one of the listed entities, copied exactly, or "none".')
RAW = chr(0) + 'raw' + chr(0)                 # a text that starts with this is sent as it is (the request about a pronoun), not as "Sentence: ..." after a system prompt


def referent_prompt(template, sentence, a, pronoun, names):
    t = template
    for k, v in (('sentence', sentence), ('np1', a['np1']), ('predicate', a['predicate']), ('np2', a['np2']), ('pronoun', pronoun), ('candidates', json.dumps(list(names), ensure_ascii=False))):
        t = t.replace('${%s}' % k, v)
    return t.strip()


def match_referent(reply, names):
    """the candidate the reply names: the whole reply (ignoring case, quotes, punctuation) equals a name, else the one name that stands in the reply (the longest, when the others are inside it). None = "none" / no or several names"""
    rw = _words(reply or '')
    if not rw or rw == ['none']: return None
    for n in names:
        if _words(n) == rw: return n
    inside = [n for n in names if _inside(_words(n), rw)]
    if len(inside) > 1:
        inside.sort(key=lambda n: -len(_words(n)))
        if all(_inside(_words(n), _words(inside[0])) for n in inside[1:]): inside = inside[:1]
    return inside[0] if len(inside) == 1 else None


PAIR_ANSWER_LINE = 'Answer with a JSON array only: `[{"NP1": "...", "Predicate": "...", "NP2": "..."}]`'


def pair_answer_line():
    return PAIR_ANSWER_LINE


def has_answer_line(template):
    """does a template carry its own JSON answer line?"""
    return bool(re.search(r'answer\s+with\s+(?:a\s+)?json', template, re.I) or re.search(r'\{\s*"[^"]+"\s*:', template))


def targets_line(names):
    """The first line of every request: the target entities in the order of the sentence."""
    return 'Target entities in sentence: ' + json.dumps(list(names), ensure_ascii=False)


def sentence_prompt(template, names):
    """The prompt of a sentence: the template, in which the placeholder ${1:...} (also ${entities} / ${entities:...}; the text after the colon is only a reminder) is replaced by the list of the
    target entities - every entity a frame of the cartridge can use, in the order of the sentence, as ["a", "b", "c"]. A template without the placeholder gets no list: the wording around it is the user's.
    Other numbered placeholders (the older per-pair templates) are replaced by nothing."""
    t = re.sub(r'\$\{(?:1|entities)(?::[^}]*)?\}', lambda m: json.dumps(list(names), ensure_ascii=False), template)
    t = re.sub(r'\$\{\d+:[^}]*\}', '', t)
    if not has_answer_line(t): t = t.rstrip() + '\n\n' + PAIR_ANSWER_LINE        # an older template without a JSON line: the default line is added
    return t.strip()                                                              # the target entities are NOT listed in the prompt: the program knows them, the template tells the model what to find


def _json_value(reply):
    s = (reply or '').strip()
    for cand in (s, s[s.find('['):s.rfind(']') + 1] if '[' in s else '', s[s.find('{'):s.rfind('}') + 1] if '{' in s else ''):
        try:
            return json.loads(cand)
        except ValueError:
            continue
    # an answer cut off in the middle (the model ran on up to the token limit, or broke the JSON): the complete flat objects in front of the break are the triples it did give
    objs = []
    for m in re.finditer(r'\{[^{}]*\}', s):
        try:
            d = json.loads(m.group(0))
        except ValueError:
            continue
        if isinstance(d, dict) and d: objs.append(d)
    return objs or None


def _pair_dict(reply):
    d = _json_value(reply)
    if isinstance(d, list) and d and isinstance(d[0], dict): d = d[0]
    return d if isinstance(d, dict) else None


def _dicts(value):
    """the triple objects of an answer: an array of them, one object, or an object that holds the array ({"triples": [...]})"""
    if isinstance(value, list): return [x for x in value if isinstance(x, dict)]
    if isinstance(value, dict):
        lists = [(k, v) for k, v in value.items() if isinstance(v, list) and v and all(isinstance(x, dict) for x in v)]
        for k, v in lists:
            if re.search(r'triple|relation|result|answer|predicate', str(k), re.I): return v        # {"noun_phrases": [...], "triples": [...]}: the steps first, the triples named
        if lists: return lists[-1][1]                                                                  # else the last list of objects: the last step is the answer
        return [value]
    return []


LEGACY_KEYS = {'preposition', 'effect', 'modifier', 'change type', 'change_type'}       # the older separate fields: read as before when a template still asks for them


SPLIT_RE = re.compile(r',\s+(?:(?:and|or)\s+)?|;\s+(?:(?:and|or)\s+)?|\s+and\s+|\s+or\s+', re.I)       # the separators of a coordination: ", " "; " " and " " or "


def real_ids(tok):
    """the ids of a markup without the class ids (9000000 = the node type Disease itself): the entities the markup stands for"""
    return [x for x in (tok.ids or '').split(',') if x.strip().isdigit() and int(x) % 1000000 != 0]


def split_targets(ents, toks=None):
    """The focus entities of a sentence. A markup with SEVERAL ids ("neonatal respiratory distress syndrome and neonatal hyperbilirubinemia": ids 9005440 and 9018890) is a coordination of entities:
    it is listed as its parts (split at ", " "; " " and " " or "), in the order of the name - the model then cannot answer with the whole coordination as one noun phrase.
    A markup with one id is never split ("rheumatic and musculoskeletal diseases" may be one term). A part keeps the types and positions of its entity;
    'parent' is the entity itself (the triple is written on its token)."""
    out = []
    for e in ents:
        parts = [x.strip() for x in SPLIT_RE.split(e['name']) if x.strip()]
        if len(parts) < 2 or toks is None or len(real_ids(toks[e['pos'][0]])) < 2: out.append(dict(e, parent=e)); continue
        out.extend(dict(e, name=x, parent=e) for x in parts)
    return out


def _words(s):
    return [w.lower() for w in WORD_RE.findall(s)]


def _inside(a, b):
    """the words a stand in a row inside the words b"""
    return bool(a) and any(b[i:i + len(a)] == a for i in range(len(b) - len(a) + 1))


def entities_in(phrase, targets):
    """the target entities that a noun phrase holds (their words, in a row; of nested names - "EGFR" in "EGFR kinase", "buprenorphine" in "norbuprenorphine" is NOT nested (other word) - the longest).
    A noun phrase that is the coordination MedScan marked as ONE entity ("PPARa and PPARd": one markup, several ids) is that markup as a whole: its parts - and a PPARd marked elsewhere
    in the line - are not entities of the phrase, since the words of the phrase belong to the coordination."""
    words = _words(clean_phrase(phrase))
    found = [e for e in targets if _inside(_words(e['name']), words)]
    def is_part(e):                                             # a part of a coordination that was split ("PPARa" of "PPARa and PPARd"): its name is not the name of its parent markup
        par = e.get('parent')
        return par is not None and par is not e and _words(par['name']) != _words(e['name'])
    parents = {}
    for e in found:                                             # the coordinations (parents of the split parts) whose whole name stands in the phrase
        if is_part(e): parents.setdefault(id(e['parent']), (e['parent'], []))[1].append(e)
    for par, parts in parents.values():
        pw = _words(par['name'])
        k = next((i for i in range(len(words) - len(pw) + 1) if words[i:i + len(pw)] == pw), None)
        if k is None: continue
        rest = words[:k] + words[k + len(pw):]                  # what is left of the phrase around the coordination
        names = {' '.join(_words(x['name'])) for x in parts}
        drop = [i for i, x in enumerate(found) if any(x is p for p in parts) or (' '.join(_words(x['name'])) in names and not _inside(_words(x['name']), rest))]
        if not drop: continue
        at = drop[0]                                            # the parts, and a same-named entity (a PPARd marked elsewhere in the line), are the coordination as a whole here
        keep = [x for i, x in enumerate(found) if i not in drop]
        found = keep[:at] + [dict(par, parent=par)] + keep[at:]
    uniq = {}                                                   # the same name listed twice (two mentions of PPARd in a record): ONE entity of the phrase.
    for e in found:                                             # A whole markup is preferred to a part of a coordination, else the first one; the mention in the line is chosen later (pick_pair)
        k = ' '.join(_words(e['name']))
        if k not in uniq or (is_part(uniq[k]) and not is_part(e)): uniq[k] = e
    found = [e for e in found if uniq[' '.join(_words(e['name']))] is e]
    if len(found) > 1:                                          # one name inside another (as words): the longer one is meant, if all the others are inside it
        by_len = sorted(found, key=lambda e: -len(_words(e['name'])))
        longest = _words(by_len[0]['name'])
        if all(_inside(_words(e['name']), longest) for e in by_len[1:]): found = by_len[:1]
    return found


def same_type(found):
    """do two of the entities share a node type?"""
    for i in range(len(found)):
        for j in range(i + 1, len(found)):
            if set(found[i].get('types') or []) & set(found[j].get('types') or []): return True
    return False


ANAPHORA = {'it', 'its', 'they', 'their', 'them', 'he', 'his', 'she', 'her', 'this', 'these', 'those', 'such'}      # a noun phrase that starts with one of these points back to an earlier entity


SEG_RE = re.compile(r'\s*[,;]\s*|\s+(?:and|or|nor|but|plus|versus|vs|as|well)\s+', re.I)       # the separators that join (or set apart) parts of a noun phrase: ", " "; " and the joining words


def np_parts(phrase, targets):
    """The noun phrases a noun phrase of the model stands for: [(phrase, its entities)], or None when it holds no entity.
    Entities of different types (or one entity): the phrase as the model gave it. Two entities of the SAME type ("norbuprenorphine, a metabolite of buprenorphine", "sedation and analgesia"):
    the phrase is split at the separators and every part that holds an entity is a noun phrase of its own (the caller writes one triple per part, with the same predicate);
    a part that still holds two entities of one type is left out."""
    found = entities_in(phrase, targets)
    if not found: return None
    if not same_type(found): return [(phrase, found)]
    parts = []
    for seg in SEG_RE.split(clean_phrase(phrase)):
        seg = seg.strip()
        f = entities_in(seg, targets) if seg else []
        if f and not same_type(f): parts.append((seg, f))
    return parts or None


INNER_JOINERS = {'and', 'or', 'nor', 'but', 'plus', 'versus', 'vs', 'as', 'well'}      # words that join parts of a coordination
INNER_MARKS = (',', ';')                                                               # the comma and the semicolon join the parts of a coordination too
INNER_MAX_WORDS = 4                                                                  # a longer stretch between two entities is a phrase of its own, not a predicate


def inner_triples(phrase, ents):
    """A noun phrase that holds several entities ("arecoline-induced EMT": two markups with "induced" between them) says a relation by itself. -> [(entity 1, words between, entity 2)] for each
    two entities that follow each other in the phrase; nothing between them = no triple. The words are the phrase's own."""
    if not ents or len(ents) < 2: return []
    text = clean_phrase(phrase)
    spans = [(m.start(), m.end()) for m in WORD_RE.finditer(text)]       # where each word stands: the punctuation between two entities is looked at too
    words = [text[a:b] for a, b in spans]
    low = [w.lower() for w in words]
    at = []
    for e in ents:
        ew = [w.lower() for w in WORD_RE.findall(e['name'])]
        k = next((i for i in range(len(low) - len(ew) + 1) if ew and low[i:i + len(ew)] == ew), None)
        if k is not None: at.append((k, k + len(ew), e))
    at.sort(key=lambda x: x[0])
    out = []
    for (s1, t1, e1), (s2, t2, e2) in zip(at, at[1:]):
        between = ' '.join(words[t1:s2]).strip()
        bw = between.lower().split()
        if s2 > t1 and any(c in text[spans[t1 - 1][1]:spans[s2][0]] for c in INNER_MARKS): continue      # a comma or semicolon between the entities: a list
        if not between or s2 < t1 or len(bw) > INNER_MAX_WORDS or any(w in INNER_JOINERS for w in bw): continue      # "release and tubular": a joiner between the entities means they are coordinated parts of a list, not a predicate
        out.append((e1, between, e2))
    return out


def readable_answer(raw):
    """The model's answer for the debug log: one triple per line (a list of objects is written one object per line, also inside {"triples": [...]}); anything else as it came."""
    v = _json_value(raw)
    dumps = lambda x: json.dumps(x, ensure_ascii=False)
    objs = lambda x: isinstance(x, list) and x and all(isinstance(i, dict) for i in x)
    if objs(v): return '[\n  ' + ',\n  '.join(dumps(i) for i in v) + '\n]'
    if isinstance(v, dict) and any(objs(x) for x in v.values()):
        rows = []
        for k, x in v.items():
            rows.append('  %s: %s' % (dumps(k), ('[\n    ' + ',\n    '.join(dumps(i) for i in x) + '\n  ]') if objs(x) else dumps(x)))
        return '{\n' + ',\n'.join(rows) + '\n}'
    return raw


def parse_answers(reply):
    """The answer of the sentence request -> [{'np1', 'predicate', 'np2'}, ...] (a JSON array of triples; an empty array = no relation)."""
    v = _json_value(reply)
    if v is None: raise RuntimeError('the model did not return JSON: ' + (reply or '').strip()[:200])
    return [parse_answer_dict(d) for d in _dicts(v)]


def parse_answer(reply):
    """the first triple of an answer ('' = missing)"""
    d = _pair_dict(reply)
    if d is None: raise RuntimeError('the model did not return JSON for a pair: ' + (reply or '').strip()[:200])
    return parse_answer_dict(d)


def parse_answer_dict(d):
    """One triple object -> {'np1', 'predicate', 'np2'} ('' = missing).
    The keys are named by the JSON line of the template, so they are recognised by their meaning: the predicate = "predicate" / "verb" / "relation"..., noun phrase 1 / 2 = the keys with
    a 1 / 2 (or first / second, subject / object ...); a single key that is none of these is the predicate."""
    out, unknown = {'np1': '', 'predicate': '', 'np2': ''}, []
    for k, v in d.items():
        if not isinstance(v, str): continue
        kl, v = str(k).lower().strip(), v.strip()
        if kl in LEGACY_KEYS: continue
        if re.search(r'predicate|verb|relation|link|action', kl): out['predicate'] = out['predicate'] or v
        elif re.search(r'(^|[^a-z0-9])1($|[^0-9])|first|subject|leading|np1|arg1', kl): out['np1'] = out['np1'] or v
        elif re.search(r'(^|[^a-z0-9])2($|[^0-9])|second|object|following|np2|arg2', kl): out['np2'] = out['np2'] or v
        else: unknown.append(v)
    if not out['predicate'] and len(unknown) == 1: out['predicate'] = unknown[0]
    return out


def load_config():
    cfg = dict(DEFAULTS)
    for p in (os.path.join(APP_DIR, 'conceptscan_llm.json'), os.path.join(os.getcwd(), 'conceptscan_llm.json')):
        if os.path.isfile(p):
            try:
                with open(p, encoding='utf-8') as f:
                    cfg.update({k: v for k, v in json.load(f).items() if not k.startswith('_')})
            except Exception as e:  # a broken config must not be silently ignored
                die('cannot read %s: %s' % (p, e), 2)
    if os.environ.get('CSLLM_BACKEND'): cfg['backend'] = os.environ['CSLLM_BACKEND']
    if os.environ.get('CSLLM_REGION'): cfg['region'] = os.environ['CSLLM_REGION']
    if os.environ.get('CSLLM_APIKEY'): cfg['api_key'] = os.environ['CSLLM_APIKEY']
    if os.environ.get('CSLLM_AUTHHEADER'): cfg['auth_header'] = os.environ['CSLLM_AUTHHEADER']
    if os.environ.get('CSLLM_EXTRAHEADERS'): cfg['extra_headers'] = os.environ['CSLLM_EXTRAHEADERS']
    if os.environ.get('CSLLM_TOPP'): cfg['top_p'] = float(os.environ['CSLLM_TOPP'])
    if os.environ.get('CSLLM_TEMPERATURE'): cfg['temperature'] = float(os.environ['CSLLM_TEMPERATURE'])
    if os.environ.get('CSLLM_TIMEOUT'): cfg['timeout'] = int(os.environ['CSLLM_TIMEOUT'])
    if os.environ.get('CSLLM_NUMCTX'): cfg['num_ctx'] = int(os.environ['CSLLM_NUMCTX'])
    if os.environ.get('CSLLM_PROMPT_FILE'): cfg['prompt_file'] = os.environ['CSLLM_PROMPT_FILE']
    if os.environ.get('CSLLM_REFERENT_PROMPT_FILE'): cfg['referent_prompt_file'] = os.environ['CSLLM_REFERENT_PROMPT_FILE']
    if os.environ.get('CSLLM_URL'): cfg['url'] = os.environ['CSLLM_URL']
    if os.environ.get('CSLLM_MODEL'): cfg['model'] = os.environ['CSLLM_MODEL']
    if os.environ.get('CSLLM_CARTRIDGE'): cfg['cartridge'] = os.environ['CSLLM_CARTRIDGE']
    if os.environ.get('CSLLM_CHECK'): cfg['check_frames'] = os.environ['CSLLM_CHECK'] not in ('0', 'false', 'no')
    if os.environ.get('CSLLM_MAXTOKENS'): cfg['max_tokens'] = int(os.environ['CSLLM_MAXTOKENS'])
    if os.environ.get('CSLLM_WORKERS'): cfg['workers'] = int(os.environ['CSLLM_WORKERS'])
    if os.environ.get('CSLLM_CACHE'): cfg['cache'] = os.environ['CSLLM_CACHE'] not in ('0', 'false', 'no')
    if os.environ.get('CSLLM_CACHE_MAX_MB'): cfg['cache_max_mb'] = int(float(os.environ['CSLLM_CACHE_MAX_MB']))
    return cfg


def die(msg, code=2):
    sys.stderr.write('conceptscan: ' + msg + '\n'); sys.stderr.flush(); sys.exit(code)


class Cache:
    TRIM_EVERY = 2000          # the size is looked at after this many new answers (and when the file is opened)
    KEEP = 0.8                 # when over the limit, the oldest answers go until this share of the limit is left
    def __init__(self, path, max_mb=0):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=30)
        self.db.execute('CREATE TABLE IF NOT EXISTS c (k TEXT PRIMARY KEY, v TEXT)')
        self.db.commit()
        self.max_bytes = max(0, int(max_mb or 0)) * 1024 * 1024
        self.puts = 0
        self.trim()
    def get(self, k):
        with self.lock:
            r = self.db.execute('SELECT v FROM c WHERE k=?', (k,)).fetchone()
        return json.loads(r[0]) if r else None
    def put(self, k, v):
        with self.lock:
            self.db.execute('INSERT OR REPLACE INTO c VALUES (?,?)', (k, json.dumps(v)))
            self.db.commit()
            self.puts += 1
            due = self.max_bytes and self.puts % self.TRIM_EVERY == 0
        if due: self.trim()
    def live_bytes(self):
        q = lambda p: self.db.execute('PRAGMA ' + p).fetchone()[0]
        return (q('page_count') - q('freelist_count')) * q('page_size')      # the pages in use (deleted rows leave free pages that new answers reuse: the file does not grow over the limit)
    def trim(self):
        """over the size limit: delete the OLDEST answers (insert order = rowid; INSERT OR REPLACE gives a refreshed answer a new rowid) until KEEP of the limit is left"""
        if not self.max_bytes: return
        with self.lock:
            live = self.live_bytes()
            if live <= self.max_bytes: return
            n = self.db.execute('SELECT COUNT(*) FROM c').fetchone()[0]
            drop = min(n, int(n * (1 - self.KEEP * self.max_bytes / live)) + 1)
            self.db.execute('DELETE FROM c WHERE rowid IN (SELECT rowid FROM c ORDER BY rowid LIMIT ?)', (drop,))
            self.db.commit()


class Llm:
    def __init__(self, cfg):
        self.cfg = cfg
        self.backend = str(cfg.get('backend', 'ollama')).lower()
        if self.backend not in ('ollama', 'openai', 'bedrock'):
            die("unknown backend '%s' in conceptscan_llm.json (use ollama, openai or bedrock)" % self.backend, 2)
        self.prompt_override = ''                # the template from cfg['prompt_file']; '' = the built-in template
        if cfg.get('prompt_file'):
            try:
                with open(cfg['prompt_file'], encoding='utf-8-sig') as f: self.prompt_override = f.read().strip()
            except OSError as e:
                die('cannot read the prompt file %s: %s' % (cfg['prompt_file'], e), 2)
        self.referent_override = ''              # the pronoun question from cfg['referent_prompt_file']; '' = the built-in one
        if cfg.get('referent_prompt_file'):
            try:
                with open(cfg['referent_prompt_file'], encoding='utf-8-sig') as f: self.referent_override = f.read().strip()
            except OSError as e:
                die('cannot read the pronoun prompt file %s: %s' % (cfg['referent_prompt_file'], e), 2)
        self.cache = Cache(os.environ.get('CSLLM_CACHE_FILE') or os.path.join(APP_DIR, cfg['cache_file']), cfg.get('cache_max_mb', 0)) if cfg['cache'] else None      # CSLLM_CACHE_FILE: the app keeps it in the user data folder (an installed app cannot write next to its exe)
        self._bedrock = None
        self._bedrock_lock = threading.Lock()
        self.gate = threading.BoundedSemaphore(max(1, int(cfg.get('workers', 4))))     # pairs mode: at most `workers` requests at a time over all sentences
        self.n_cached = 0                                          # the sentence requests answered from the cache (the progress line tells them from the ones the LLM answered)
        self.n_lock = threading.Lock()

    def pair(self, text, system):
        """the ONE request of a sentence. text = the plain sentence, system = the prompt (target entities + template). -> (triples, raw answer); triples = [{'np1', 'predicate', 'np2'}]"""
        k = hashlib.sha1(('sent|%s|%s|%s|%s' % (self.backend, self.cfg['model'], system, text)).encode('utf-8')).hexdigest()
        if self.cache:
            hit = self.cache.get(k)
            if hit is not None:
                with self.n_lock: self.n_cached += 1
                return parse_answers(hit), hit
        with self.gate:
            reply = {'bedrock': self._ask_bedrock, 'openai': self._ask_openai}.get(self.backend, self._ask_ollama)(text, system)
        triples = parse_answers(reply)
        if self.cache: self.cache.put(k, reply)
        return triples, reply

    def referent(self, prompt):
        """the second request: the pronoun question, as one user message (no system prompt). -> the raw answer"""
        k = hashlib.sha1(('ref|%s|%s|%s' % (self.backend, self.cfg['model'], prompt)).encode('utf-8')).hexdigest()
        if self.cache:
            hit = self.cache.get(k)
            if hit is not None: return hit
        with self.gate:
            reply = {'bedrock': self._ask_bedrock, 'openai': self._ask_openai}.get(self.backend, self._ask_ollama)(RAW + prompt, '')
        if self.cache: self.cache.put(k, reply)
        return reply

    def _messages(self, text, system):
        """-> (system text, [(role, content)]): the prompt and the sentence as plain text, no worked examples"""
        if text.startswith(RAW): return '', [('user', text[len(RAW):])]
        return system, [('user', 'Sentence: ' + text)]

    # ── Ollama ──
    def _ask_ollama(self, text, system):
        system, conv = self._messages(text, system)
        body = {
            'model': self.cfg['model'], 'stream': False, 'keep_alive': self.cfg['keep_alive'],
            'options': {'temperature': self.cfg['temperature'], 'num_ctx': self.cfg['num_ctx']},
            'messages': ([{'role': 'system', 'content': system}] if system else []) + [{'role': r, 'content': c} for r, c in conv],
        }
        body['options']['num_predict'] = 24 if text.startswith(RAW) else 800      # an ARRAY of triples, keys as in the template's JSON line: no format (Ollama's "json" format only allows one object)
        data = json.dumps(body).encode('utf-8')
        last = None
        for attempt in range(self.cfg['retries'] + 1):
            try:
                req = urllib.request.Request(self.cfg['url'].rstrip('/') + '/api/chat', data, {'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=self.cfg['timeout']) as r:
                    return json.loads(r.read().decode('utf-8'))['message']['content']
            except urllib.error.HTTPError as e:     # model missing etc.: retrying does not help
                raise RuntimeError('Ollama answered HTTP %d: %s' % (e.code, e.read().decode('utf-8', 'replace')[:300]))
            except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
                last = e; time.sleep(1 + attempt)
        raise RuntimeError('LLM request failed (%s) - is Ollama running at %s with model %s?' % (last, self.cfg['url'], self.cfg['model']))

    # ── OpenAI-compatible gateway: POST <url>/chat/completions (OpenAI, Portkey and other gateways, vLLM, LM Studio ...) ──
    def _headers(self):
        h = {'Content-Type': 'application/json'}
        key = str(self.cfg.get('api_key') or '').strip()
        if key:
            if self.cfg.get('auth_header'): h[str(self.cfg['auth_header']).strip()] = key
            else: h['Authorization'] = 'Bearer ' + key
        for line in str(self.cfg.get('extra_headers') or '').splitlines():
            if ':' in line:
                n, v = line.split(':', 1)
                if n.strip(): h[n.strip()] = v.strip()
        return h

    def _ask_openai(self, text, system):
        system, conv = self._messages(text, system)
        body = {'model': self.cfg['model'], 'temperature': float(self.cfg['temperature']),
                'max_tokens': int(self.cfg.get('max_tokens', 1500)),
                'messages': ([{'role': 'system', 'content': system}] if system else []) + [{'role': r, 'content': c} for r, c in conv]}
        if self.cfg.get('top_p') is not None: body['top_p'] = float(self.cfg['top_p'])
        data = json.dumps(body).encode('utf-8')
        url = self.cfg['url'].rstrip('/') + '/chat/completions'
        last = None
        for attempt in range(self.cfg['retries'] + 1):
            try:
                req = urllib.request.Request(url, data, self._headers())
                with urllib.request.urlopen(req, timeout=self.cfg['timeout']) as r:
                    choice = json.loads(r.read().decode('utf-8'))['choices'][0]
                if choice.get('finish_reason') == 'length':                 # a thinking model (Gemini, o-series) spends max_tokens on its reasoning: the JSON is cut off
                    raise RuntimeError('the answer was cut off at max_tokens=%d (a thinking model spends them on its reasoning): raise CSLLM_MAXTOKENS' % body['max_tokens'])
                return choice['message']['content'] or ''
            except urllib.error.HTTPError as e:
                msg = e.read().decode('utf-8', 'replace')[:300]
                if e.code in (429, 500, 502, 503, 504) and attempt < self.cfg['retries']:
                    last = 'HTTP %d' % e.code; time.sleep(2 + 2 * attempt); continue
                raise RuntimeError('the LLM API answered HTTP %d: %s' % (e.code, msg))
            except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError) as e:
                last = e; time.sleep(1 + attempt)
        raise RuntimeError('LLM request failed (%s) - check the API base URL %s and the key' % (last, self.cfg['url']))

    # ── Amazon Bedrock (Converse API: the same call for Nova, Llama, Claude, Mistral ...) ──
    def _client(self):
        with self._bedrock_lock:
            if self._bedrock is None:
                try:
                    import boto3
                    from botocore.config import Config
                except ImportError:
                    raise RuntimeError('the bedrock backend needs boto3 (pip install boto3)')
                self._bedrock = boto3.client('bedrock-runtime', region_name=self.cfg.get('region', 'us-east-1'), config=Config(
                    read_timeout=self.cfg['timeout'], connect_timeout=15, retries={'max_attempts': 1}))   # retries are done below (throttling)
            return self._bedrock

    def _ask_bedrock(self, text, system):
        system, conv = self._messages(text, system)
        msgs = [{'role': r, 'content': [{'text': c}]} for r, c in conv]
        kw = {'modelId': self.cfg['model'], 'messages': msgs,
              'inferenceConfig': {'temperature': float(self.cfg['temperature']), 'maxTokens': int(self.cfg.get('max_tokens', 1500))}}
        if system: kw['system'] = [{'text': system}]
        last = None
        for attempt in range(int(self.cfg.get('bedrock_retries', 6)) + 1):
            try:
                r = self._client().converse(**kw)
                return ''.join(b.get('text', '') for b in r['output']['message']['content'])
            except Exception as e:
                code = getattr(e, 'response', {}).get('Error', {}).get('Code', '') if hasattr(e, 'response') else ''
                if code in ('ThrottlingException', 'ServiceUnavailableException', 'ModelTimeoutException', 'InternalServerException')                         or e.__class__.__name__ in ('ReadTimeoutError', 'ConnectTimeoutError', 'EndpointConnectionError'):
                    last = e; time.sleep(min(30, 2 ** attempt) + (hash(text) % 100) / 100.0); continue   # back off, then try again
                if code in ('AccessDeniedException', 'ValidationException', 'ResourceNotFoundException') or 'NoCredentials' in e.__class__.__name__:
                    raise RuntimeError('Bedrock error %s: %s (model %s, region %s - is the model enabled for this account in the Bedrock console, '
                                       'and does the role allow bedrock:InvokeModel?)' % (code or e.__class__.__name__, e, self.cfg['model'], self.cfg.get('region')))
                raise RuntimeError('Bedrock request failed: %s: %s' % (e.__class__.__name__, e))
        raise RuntimeError('Bedrock kept throttling / timing out (%s) - lower "workers" in conceptscan_llm.json' % last)


def find_cartridge(cfg):
    """The cartridge folder: config / CSLLM_CARTRIDGE, else the current folder (the app runs conceptscan there), else the folder of the exe - the first with a grdata or nodetype.ini."""
    cands = [cfg.get('cartridge')] if cfg.get('cartridge') else [os.getcwd(), APP_DIR]
    for c in cands:
        if c and (os.path.isdir(os.path.join(c, 'grdata')) or os.path.isfile(os.path.join(c, 'nodetype.ini'))): return c
    return cands[0] if cfg.get('cartridge') else ''


def parse_args(argv):
    o = {'t': '', 'O': [], 'i': '-', 'o': '-', 'P': 0, 'a': False, 'p': False, 'q': False, 'v': 0, 'r': None, 'u': 'none', 'n': False, 'T': False}
    flags_with_arg = set('tPioOHWru')
    i = 0
    while i < len(argv):
        a = argv[i]; i += 1
        if a == '-h' or a == '--help':
            print(__doc__); sys.exit(0)
        if not a.startswith('-') or a == '-':
            continue
        c = a[1]
        if c in flags_with_arg:
            val = a[2:] if len(a) > 2 else (argv[i] if i < len(argv) else ''); i += 0 if len(a) > 2 else 1
            if c == 'O': o['O'].append(val)
            else: o[c] = val
        else:   # w v q p a n T may be combined (-wq); unknown ones are ignored like conceptscan's other pipeline options
            for ch in a[1:]:
                if ch == 'v': o['v'] += 1
                elif ch in 'qapnTw': o[ch] = True
    return o


def entity_min(o):
    """-O N = number of entities in a triplet (default 2). locscan.ini passes -O2 and -O$E (an output mode of the old exe, usually empty): numbers only."""
    nums = [int(x) for x in o['O'] if re.fullmatch(r'\d+', x or '')]
    return nums[0] if nums else 2


def read_records(stream):
    rec = []
    for raw in stream:
        line = raw.rstrip('\r\n')
        if line == '':
            if rec: yield rec, 1
            else: yield [], 1
            rec = []
        else:
            rec.append(line)
    if rec: yield rec, 0


def main(argv):
    if argv and argv[0] == '--version':               # which conceptscan_llm is this: version, hash of its sources, build time
        sys.stdout.write(conceptscan_version.text() + '\n'); return 0
    if argv and argv[0] == '--show-pair-prompt':      # conceptscan.exe --show-pair-prompt [CARTRIDGE]: the template of the pairs mode (the app shows it in the editable box)
        sys.stdout.buffer.write(DEFAULT_PROMPT.encode('utf-8')); sys.stdout.buffer.flush()
        return 0
    if argv and argv[0] == '--show-referent-prompt':   # conceptscan.exe --show-referent-prompt: the built-in pronoun question (the app shows it in the editable box)
        sys.stdout.buffer.write(DEFAULT_REFERENT_PROMPT.encode('utf-8')); sys.stdout.buffer.flush()
        return 0
    if argv and argv[0] == '--ask':                    # conceptscan.exe --ask: stdin {"prompts": ["...", ...]} -> stdout {"replies": ["...", ...]}: one short request per prompt (the app's Reader asks which entity a pronoun refers to)
        try:
            prompts = [str(x) for x in (json.loads(sys.stdin.buffer.read().decode('utf-8-sig')) or {}).get('prompts', [])]
        except (ValueError, AttributeError) as e:
            die('--ask: stdin is not {"prompts": [...]}: %s' % e, 2)
        cfg = load_config()
        if os.environ.get('CSLLM_CACHE_FILE'): cfg['cache'] = True        # the same question (model + text) always has the same answer: a second analysis of a document asks nothing again
        llm = Llm(cfg)
        def one(pr):
            try: return llm.referent(pr)
            except RuntimeError as e: return 'ERROR: %s' % e
        replies, done = [''] * len(prompts), 0
        first = {}                                            # the same text twice ("its" twice in one sentence): asked once
        for i, pr in enumerate(prompts): first.setdefault(pr, i)
        with ThreadPoolExecutor(max_workers=max(1, int(cfg['workers']))) as pool:
            futs = {pool.submit(one, pr): pr for pr in first}
            for f in as_completed(futs):                      # "[ask] <done> <total>" on stderr after every answer: the app shows the progress
                pr = futs[f]; r = f.result()
                for i, q in enumerate(prompts):
                    if q == pr: replies[i] = r; done += 1
                sys.stderr.write('[ask] %d %d\n' % (done, len(prompts))); sys.stderr.flush()
        sys.stdout.buffer.write(json.dumps({'replies': replies}, ensure_ascii=False).encode('utf-8')); sys.stdout.buffer.flush()
        return 0
    preview = '--preview-pairs' in argv                  # --preview-pairs: do not ask the LLM; print as JSON the pairs of entities and the prompt made for each (the app's "Generate prompt")
    if preview: argv = [a for a in argv if a != '--preview-pairs']
    o = parse_args(argv)
    cfg = load_config()
    min_ent = entity_min(o)
    llm = Llm(cfg)
    cart = find_cartridge(cfg)                                         # the entities a frame of the cartridge can use: node types from nodetype.ini, frames from grdata
    typer = NodeTyper(load_ranges(cart))
    set_modifier_stop(cart)                                            # prepositions of $PREP (DictionaryMacros.msgrep): the words that end the premodifiers of a noun phrase
    cat = load_catalog(cart, typer.ranges)
    catalog = cat if cat else None
    if not catalog: sys.stderr.write('conceptscan_llm: warning: no cartridge folder with frames found (CSLLM_CARTRIDGE) - there is no entity to ask about\n')
    if not o['q']:                                                    # one line that says what is being run (the model, and which prompt)
        what = 'one request per sentence, target entities of the cartridge\'s frames (%d frames), JSON array of NP1-Predicate-NP2, no worked examples' % (len(catalog.frames) if catalog else 0)
        if llm.prompt_override: what += ' | EDITED prompt from %s' % cfg['prompt_file']
        sys.stderr.write('%s: %s %s | %s | cache %s\n' % (conceptscan_version.text(), cfg.get('backend', 'ollama'), cfg['model'], what, 'on' if cfg['cache'] else 'off')); sys.stderr.flush()
    check = bool(catalog) and bool(cfg.get('check_frames', True))
    t0 = time.time()
    fin = sys.stdin if o['i'] in ('-', '') else open(o['i'], encoding='utf-8', errors='replace', newline=None)
    if fin is sys.stdin:
        try: sys.stdin.reconfigure(encoding='utf-8', errors='replace')
        except Exception: pass
    fout = sys.stdout.buffer if o['o'] in ('-', '') else open(o['o'], 'wb')
    write = (lambda s: None) if preview else (lambda s: fout.write((s + '\r\n').encode('utf-8')))     # preview: the records are not written

    template = llm.prompt_override or DEFAULT_PROMPT
    debug = bool(os.environ.get('CSLLM_DEBUG'))
    previews = []
    prog = {'done': 0, 'total': 0, 'on': bool(os.environ.get('CSLLM_PROGRESS'))}       # the sentences that are asked of the LLM: how many are done (the app shows it: the LLM is slow)
    prog_lock = threading.Lock()
    def tick():
        if not prog['on']: return
        with prog_lock:
            prog['done'] += 1
            sys.stderr.write('[llm] %d %d %d\n' % (prog['done'], prog['total'], llm.n_cached)); sys.stderr.flush()

    def pairs_lines(toks, text):
        """ONE request per sentence: the target entities (all those a frame of the cartridge can use) are listed in the prompt, the model answers with NP1 - predicate - NP2 triples."""
        pairs = candidate_pairs(toks, catalog, typer, int(cfg.get('pair_window', 40)), int(cfg.get('max_pairs', 24))) if catalog else []
        mtext = plain_text(text)                                     # the sentence as written: the entity markup is NOT sent to the LLM
        log = ['\n--- SENTENCE: %s' % mtext]
        if not pairs and preview: previews.append({'sentence': mtext, 'entities': [], 'pairs': []})
        if not pairs:
            if debug: sys.stderr.write('\n'.join(log + ['--- no pair of entities can carry a relation of this cartridge: the LLM is not asked']) + '\n'); sys.stderr.flush()
            return []
        ents = {}                                                    # the target entities: all those a frame of the cartridge can use, in the order of the sentence
        for e1, e2 in pairs:
            for e in (e1, e2): ents[min(e['pos'])] = e
        targets = split_targets([ents[p] for p in sorted(ents)], toks)       # one markup with several ids ("A and B") is listed as separate focus entities
        names = [e['name'] for e in targets]
        prompt = sentence_prompt(template, names)
        if preview:
            previews.append({'sentence': mtext, 'entities': [{'name': e['name'], 'types': list(e['types'])} for e in targets], 'prompt': prompt,
                             'pairs': [{'entity1': e['name'], 'types1': list(e['types']), 'entity2': '', 'types2': [], 'prompt': prompt} for e in targets[:1]]})
            return []
        try:
            answers, raw = llm.pair(mtext, prompt)
        except RuntimeError as e:
            sys.stderr.write('conceptscan: warning: %s - sentence skipped: %s\n' % (e, mtext[:100])); sys.stderr.flush()
            answers, raw = [], 'ERROR: %s' % e
        tick()
        trace = [] if debug else None
        def note(msg):
            if trace is not None: trace.append(msg)
        reflog, refmemo = [], {}
        def referent_of(a, side):
            """the SECOND request: which entity does the pronoun at the start of NP1 / NP2 refer to? -> (entity, how) or (None, why not). The candidates are the target entities before the pronoun."""
            npt = a['np%d' % side]
            if (npt, side) in refmemo: return refmemo[(npt, side)]
            sp = find_span(toks, clean_phrase(npt), None, trim=False)
            if not sp: return None, 'the noun phrase is not words of the sentence'
            at = sp[0]
            before = [e for e in targets if min(e['pos']) < at]
            names = []
            for e in before:
                if e['name'] not in names: names.append(e['name'])
            if not names: return None, 'no target entity stands before the pronoun'
            pron = toks[at].text
            prompt2 = referent_prompt(llm.referent_override or DEFAULT_REFERENT_PROMPT, mtext, a, pron, names)
            try: reply = llm.referent(prompt2)
            except RuntimeError as e: reply = 'ERROR: %s' % e
            hit = match_referent(reply, names)
            ent = next((e for e in sorted(before, key=lambda e: -min(e['pos'])) if e['name'] == hit), None) if hit else None
            res = (ent, "the model's answer to the pronoun question") if ent else (None, 'the model answered "%s"' % (reply or '').strip()[:60])
            refmemo[(npt, side)] = res
            reflog.append('--- PRONOUN QUESTION (NP%d "%s"):\n%s\n--- PRONOUN ANSWER: %s\n--- PRONOUN RESULT: %s' % (side, npt, prompt2, (reply or '').strip(), ent['name'] if ent else 'none'))
            return res
        trip, seen = [], set()
        prev_subject = None                                          # the noun phrases (with their entities) of the subject of the previous triple: the antecedent of a pronoun
        for a in answers:
            a = {k: (unescape_u(v) if isinstance(v, str) else v) for k, v in a.items()}
            P1, P2 = np_parts(a['np1'], targets), np_parts(a['np2'], targets)
            anaphora1 = anaphora2 = False
            for side in (1, 2):                                      # a noun phrase with no entity that starts with a pronoun ("its deletion in beta-cells"): ask the model what the pronoun refers to
                Pn, npt = (P1, a['np1']) if side == 1 else (P2, a['np2'])
                wn = _words(npt)
                if Pn is not None or not wn or wn[0] not in ANAPHORA: continue
                ent, why = referent_of(a, side)
                if ent is None and side == 1 and prev_subject:       # no usable answer: the first noun phrase of the previous triple
                    ent, why = prev_subject[0][1][0], 'fallback: NP1 of the previous triple (%s)' % why
                if ent is None: note('dropped: %s "%s" starts with a pronoun and its antecedent is not known (%s)' % ('NP%d' % side, npt, why)); continue
                Pn = [(ent['name'], [ent])]
                note('anaphora: NP%d "%s" starts with a pronoun, its antecedent is %s (%s)' % (side, npt, ent['name'], why))
                if side == 1: P1, anaphora1 = Pn, True
                else: P2, anaphora2 = Pn, True
            if P1 is not None and not anaphora1: prev_subject = P1
            for ph, L in (P1 or []) + (P2 or []):                                   # a noun phrase that holds two or more entities (of different types) states a relation itself: entity - the words between - entity
                for e1, pred, e2 in inner_triples(ph, L):
                    key = (e1['parent']['name'], pred.lower(), e2['parent']['name'])
                    if e1['parent'] is e2['parent'] or key in seen: continue
                    seen.add(key)
                    trip.append({'subject': '[[%s]]' % e1['parent']['name'], 'verb': pred, 'object': '[[%s]]' % e2['parent']['name'], 'kind': 'clause', 'subject_phrase': '', 'object_phrase': ''})
                    note('made from the noun phrase "%s": %s - %s - %s' % (ph, e1['parent']['name'], pred, e2['parent']['name']))
            pw = _words(a['predicate'])
            if pw and all(w in INNER_JOINERS for w in pw): note('dropped: the predicate "%s" is only coordinating word(s), not a relation (NP1 "%s", NP2 "%s")' % (a['predicate'], a['np1'], a['np2'])); continue
            if not a['predicate']: note('dropped: no predicate (NP1 "%s", NP2 "%s")' % (a['np1'], a['np2'])); continue
            if P1 is None or P2 is None:
                note('dropped: %s "%s" (%s - %s - %s) holds no target entity, or only parts with two entities of one type' % ('NP1' if P1 is None else 'NP2', a['np1'] if P1 is None else a['np2'], a['np1'], a['predicate'], a['np2'])); continue
            if not anaphora1 and (len(P1) > 1 or P1[0][0] != a['np1']): note('NP1 "%s" holds entities of one type: split into %s' % (a['np1'], ' | '.join('"%s"' % x[0] for x in P1)))
            if not anaphora2 and (len(P2) > 1 or P2[0][0] != a['np2']): note('NP2 "%s" holds entities of one type: split into %s' % (a['np2'], ' | '.join('"%s"' % x[0] for x in P2)))
            for ph1, L1 in P1:                                      # one triple per part and per pair of entities, the same predicate
                for ph2, L2 in P2:
                    for e1 in L1:
                        for e2 in L2:
                            if e1['parent'] is e2['parent']: note('dropped: both noun phrases hold the same entity %s' % e1['parent']['name']); continue
                            key = (e1['parent']['name'], a['predicate'].lower(), e2['parent']['name'])
                            if key in seen: note('dropped: the same triple twice: %s' % ' - '.join(key)); continue
                            seen.add(key)
                            trip.append({'subject': '[[%s]]' % e1['parent']['name'], 'verb': a['predicate'], 'object': '[[%s]]' % e2['parent']['name'], 'kind': 'clause',
                                         'subject_phrase': '' if anaphora1 else ph1, 'object_phrase': '' if anaphora2 else ph2,
                                         'subject_anaphor': a['np1'] if anaphora1 else '', 'object_anaphor': a['np2'] if anaphora2 else ''})      # the model's noun phrase (or the part of it between the separators)
        lines = triples_to_lines(toks, trip, min_ent, True, first_main=True, entity_only=True, full_predicate=True,
                                 skip_aux=False, skip_negated=bool(cfg.get('drop_negated', True)), trace=trace,      # is / are / has ... are valid predicates: later pattern matching uses them
                                 allow=(lambda si, oi: catalog.allowed(typer.types(toks[si].ids), typer.types(toks[oi].ids))) if check else None)
        if debug:
            log.append('--- PROMPT:' + chr(10) + prompt + chr(10) + '--- MODEL ANSWER: ' + readable_answer(raw))
            log.extend(reflog)
            log.append('--- WHAT BECAME OF EACH TRIPLE:\n%s\n--- KEPT %d pseudo-sentence line(s) from %d triple(s)' % ('\n'.join('    ' + x for x in trace) or '    (the model gave no triple)', len(lines), len(answers)))
            sys.stderr.write('\n'.join(log) + '\n'); sys.stderr.flush()
        return lines

    def work(rec):
        """-> list of (line, [pseudo lines])"""
        res = []
        for line in rec:
            if line.startswith('<') and not o['a']:
                continue                                    # an old triple of the input: dropped unless -a (pass through existing triples)
            lines = []
            if line.startswith('msrc\t'):
                text = unescape_u(line[5:])                          # TGF-\u03b23 written as text -> TGF-β3, before anything is matched or validated
                toks = tokenize(text)
                if sum(1 for t in toks if t.entity) >= min_ent:
                    lines = pairs_lines(toks, text)
            res.append((line, lines))
        return res

    pool = ThreadPoolExecutor(max_workers=max(1, int(cfg['workers'])))
    chunk, n_sent = [], 0
    def flush():
        nonlocal n_sent
        futs = [pool.submit(work, rec) if rec else None for rec, _ in chunk]
        for (rec, _blank), f in zip(chunk, futs):
            if f is None:
                write(''); continue
            made = False
            for line, pseudo in f.result():
                write(line)
                for p in pseudo: write('<\t' + p); made = True
                if line.startswith('msrc\t'):
                    n_sent += 1
                    if o['P'] and int(o['P'] or 0) and n_sent % int(o['P']) == 0:
                        sys.stderr.write('%d sentences\n' % n_sent)
            write('')
            if made: write('')                              # conceptscan leaves an extra blank line after a record with pseudo-sentences
        chunk.clear()
    try:
        records = list(read_records(fin))
        if prog['on'] and catalog and not preview:                    # N = the sentences with at least one pair of entities a frame can extract (the others are not asked)
            cnt = {'sentences': 0, 'none': 0, 'single': 0, 'nopair': 0}      # all sentences; with no entity; with fewer than min_ent entities (one); with two or more but no pair a frame can use
            for rec, _blank in records:
                for line in rec or []:
                    if line.startswith('msrc\t'):
                        tk = tokenize(unescape_u(line[5:]))
                        cnt['sentences'] += 1
                        ne = sum(1 for t in tk if t.entity)
                        if ne == 0: cnt['none'] += 1
                        elif ne < min_ent: cnt['single'] += 1
                        elif candidate_pairs(tk, catalog, typer, int(cfg.get('pair_window', 40)), int(cfg.get('max_pairs', 24))): prog['total'] += 1
                        else: cnt['nopair'] += 1
            sys.stderr.write('[llm-info] sentences=%d eligible=%d single=%d none=%d nopair=%d\n' % (cnt['sentences'], prog['total'], cnt['single'], cnt['none'], cnt['nopair']))
            sys.stderr.write('[llm] 0 %d 0\n' % prog['total']); sys.stderr.flush()
        for rec, blank in records:
            chunk.append((rec, blank))
            if len(chunk) >= max(8, 4 * int(cfg['workers'])): flush()
        if chunk: flush()
    except RuntimeError as e:
        fout.flush(); die(str(e), 2)
    fout.flush()
    if preview:                                                       # the pairs and their prompts, for the app (nothing was sent to the LLM)
        sys.stdout.flush(); sys.stdout.buffer.write(('\n@@PAIRS@@' + json.dumps(previews, ensure_ascii=False)).encode('utf-8')); sys.stdout.buffer.flush()
        return 0
    if not o['q']:
        sys.stderr.write('Elapsed time: %.2f secs\n' % (time.time() - t0))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
