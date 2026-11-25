"""The frames of a cartridge (the CONTROL blocks of its grdata) and the hints they give the LLM.

A frame says: an entity of node type X (in = %a(X ...)) can act on an entity of node type Y (out = %b(Y ...)) with a relation of ControlType T.
From them: for every pair of marked entities of a sentence, the relation types that could be extracted and in which direction (A -> B).
The hints are written into the prompt, and a triple whose subject type -> object type no frame takes is dropped (msgrep could not extract it)."""
import os, re
from itertools import combinations

CONTROL_RE = re.compile(r'(?<![\w$])CONTROL\b')
CTYPE_RE = re.compile(r'\bControlType\s*=\s*"([^"]+)"')
IN_RE = re.compile(r'(?<![\w])in\s*=\s*%(\w+)\s*(?:\(([^)]*)\))?')
OUT_RE = re.compile(r'(?<![\w])out\s*=\s*%(\w+)\s*(?:\(([^)]*)\))?')


COVERED_BY_PROTEIN = ('Complex', 'FunctionalClass')        # a frame written for "Protein" (in = %a(Protein)) also takes entities typed Complex and FunctionalClass: msgrep treats them as one family (the app: NODE_TYPE_COVERS)


def family(types):
    """the node types an entity can be matched with in a frame: its own, and Protein for a Complex / FunctionalClass"""
    t = set(types)
    if t & set(COVERED_BY_PROTEIN): t.add('Protein')
    return t


class Catalog:
    def __init__(self, frames, triples=None):
        self.frames = frames                  # pair frames: [(ControlType, frozenset(in types), frozenset(out types))]
        self.triples = triples or []          # triple frames: [(ControlType, a types, c types, t types)]: A acts on C via T
        self.folders = []                     # the csout rule folders the frames come from ([] = all of grdata)
        self._memo = {}

    def __bool__(self):
        return bool(self.frames)

    def control_types(self):
        return sorted({f[0] for f in self.frames})

    def relations(self, subj_types, obj_types):
        """ControlTypes that take an entity of one of subj_types as the agent and one of obj_types as the object."""
        k = (tuple(subj_types), tuple(obj_types))
        if k not in self._memo:
            a, b = family(subj_types), family(obj_types)
            self._memo[k] = sorted({c for c, i, o in self.frames if i & a and o & b})
        return self._memo[k]

    def allowed(self, subj_types, obj_types):
        return bool(self.relations(subj_types, obj_types))


def _types(spec, ranges):
    out = set()
    for t in re.split(r'[\s,]+', spec.strip()):
        if not t: continue
        if t.isdigit():                       # a class id such as 6000000 = the node type of range 6
            t = ranges.get(int(t) // 1000000, '')
        if t: out.add(t)
    return frozenset(out)


def _control_blocks(txt):
    """[(start, end, body)] of every CONTROL { ... } (a brace inside a quoted string does not count)."""
    out = []
    for m in CONTROL_RE.finditer(txt):
        i = m.end()
        while i < len(txt) and txt[i].isspace(): i += 1
        if i >= len(txt) or txt[i] != '{': continue
        depth, j, quoted = 0, i, False
        while j < len(txt):
            ch = txt[j]
            if ch == '"': quoted = not quoted
            elif not quoted:
                if ch == '{': depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0: break
            j += 1
        if j < len(txt) and depth == 0: out.append((m.start(), j + 1, txt[i + 1:j]))
    return out


def _frame_groups(txt):
    """CONTROL blocks that follow each other (only white space between) belong to one frame: one block = a pair frame, two blocks that share the
    agent variable = a triple frame (A acts on C via T), e.g.  CONTROL {in = %a(..) out = %c(..)}  CONTROL {in = %a out = %t(..)} : pattern ;"""
    groups, cur, last_end = [], [], None
    for s, e, body in _control_blocks(txt):
        if cur and txt[last_end:s].strip(): groups.append(cur); cur = []
        cur.append(body); last_end = e
    if cur: groups.append(cur)
    return groups


def _parse_block(body, var_types, ranges):
    c, i, o = CTYPE_RE.search(body), IN_RE.search(body), OUT_RE.search(body)
    if not (c and i and o): return None
    for m in (i, o):
        if m.group(2) is not None: var_types[m.group(1)] = _types(m.group(2), ranges)    # %a(Protein SmallMol) declares the types of %a
    return c.group(1), i.group(1), o.group(1)


def csout_folders(cartridge_dir):
    """The rule folders msgrep runs on conceptscan output: every command of <cartridge>\\locscan.ini with -Icsout and -H <folder>
    (e.g. p11grep=${MSGREP} -Icsout -H grdata/cs/p11 -b p11.grbatch | ...). Rules run with -Imsout (sentence level, e.g. trpl) are not among them.
    -> absolute folders that exist; [] when there is no locscan.ini or no such command."""
    try:
        lines = open(os.path.join(cartridge_dir or '', 'locscan.ini'), encoding='utf-8', errors='replace').read().splitlines()
    except OSError:
        return []
    out = []
    for ln in lines:
        if ln.lstrip().startswith((';', '#')) or not re.search(r'-I\s*csout\b', ln): continue
        m = re.search(r'-H\s*([^\s|]+)', ln)
        if m:
            p = os.path.normpath(os.path.join(cartridge_dir, m.group(1).strip('"').replace('/', os.sep)))
            if os.path.isdir(p) and p not in out: out.append(p)
    return out


def load_catalog(cartridge_dir, ranges, folders=None):
    """The frames of the rule folders msgrep matches on conceptscan output (csout_folders; all of <cartridge_dir>\\grdata when locscan.ini names none):
    pair frames (one CONTROL block) and triple frames (two blocks with the same agent).
    A block whose in / out is not typed entities (MemberOf ...) is not a relation between entities: skipped."""
    seen, frames, triples = set(), [], []
    folders = csout_folders(cartridge_dir) if folders is None else folders
    roots = folders or [os.path.join(cartridge_dir or '', 'grdata')]
    walk = (item for r in roots for item in os.walk(r))
    for dp, _dn, fn in walk:
        for f in fn:
            if not f.lower().endswith('.msgrep'): continue
            try:
                txt = open(os.path.join(dp, f), encoding='utf-8', errors='replace').read()
            except OSError:
                continue
            txt = re.sub(r'//[^\n]*', '', re.sub(r'/\*.*?\*/', '', txt, flags=re.S))
            for grp in _frame_groups(txt):
                var_types, parsed = {}, []
                for body in grp:
                    p = _parse_block(body, var_types, ranges)
                    if p: parsed.append(p)
                if len(parsed) != len(grp): continue
                if len(grp) == 1:
                    ct, iv, ov = parsed[0]
                    a, b = var_types.get(iv, frozenset()), var_types.get(ov, frozenset())
                    key = (ct, tuple(sorted(a)), tuple(sorted(b)))
                    if a and b and key not in seen: seen.add(key); frames.append((ct, a, b))
                elif len(grp) == 2 and parsed[0][1] == parsed[1][1] and parsed[0][2] != parsed[1][2]:
                    ct, av, cv = parsed[0]
                    a, c, t = var_types.get(av, frozenset()), var_types.get(cv, frozenset()), var_types.get(parsed[1][2], frozenset())
                    key = ('T', ct, tuple(sorted(a)), tuple(sorted(c)), tuple(sorted(t)))
                    if a and c and t and key not in seen: seen.add(key); triples.append((ct, a, c, t))
    cat = Catalog(frames, triples)
    cat.folders = folders
    return cat


def entities(toks, typer):
    """Distinct entities of the line (same ids = same entity: EGFR / epidermal growth factor receptor), in order of first appearance:
    [{'name', 'types', 'pos': [token indexes]}]. Class ids (n000000) do not identify an entity."""
    out, by_key = [], {}
    for i, t in enumerate(toks):
        if not t.entity: continue
        ids = frozenset(x.strip() for x in t.ids.split(',') if x.strip().isdigit() and int(x) % 1000000 != 0)
        key = ids or ('w', ' '.join(t.words))
        e = by_key.get(key)
        if e is None:
            m = re.match(r'^ID\{[^}=]*=([^}]*)\}$', t.text)
            e = by_key[key] = {'name': (m.group(1) if m else t.text).strip(), 'types': typer.types(t.ids), 'pos': []}
            out.append(e)
        e['pos'].append(i)
    return out


def candidate_pairs(toks, catalog, typer, window=40, max_pairs=24):
    """-> [(e1, e2)]: the pairs of distinct entities of the line (dicts of entities(): name, types, pos) that some frame of the cartridge can extract in EITHER direction,
    at most `window` tokens apart, e1 the one that comes first in the sentence. Closest pairs first, at most max_pairs."""
    ents = [e for e in entities(toks, typer) if e['types']]
    out = []
    for a, b in combinations(ents, 2):
        d = min(abs(i - j) for i in a['pos'] for j in b['pos'])
        if d > window: continue
        if not any(catalog.relations([ta], [tb]) or catalog.relations([tb], [ta]) for ta in a['types'] for tb in b['types']): continue
        first, second = (a, b) if min(a['pos']) <= min(b['pos']) else (b, a)
        out.append((d, min(first['pos']), first, second))
    out.sort(key=lambda x: (x[0], x[1]))
    return [(x[2], x[3]) for x in out[:max_pairs]]


