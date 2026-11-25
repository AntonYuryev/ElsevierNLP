#!/usr/bin/env python3
"""
htmltext.py — HTML → MSXML converter for MedScan/locscan pipeline.

Mirrors the interface of elstext.exe / pmctext.exe so it can be wired into
locscan.ini as a drop-in converter for the Elsevier BCE v6 HTML format.

Usage:
  htmltext.py [options] [file ...]
  htmltext.py -l -          # read file paths from stdin (one per line)
  htmltext.py -l list.txt   # read file paths from a text file
  htmltext.py -d dir        # all .html files in dir (non-recursive)
  htmltext.py -s dir        # all .html files in dir and subdirs

Options:
  -w          Suppress warnings
  -v          Increase verbosity (repeat for more)
  -q          Suppress logging (quiet)
  -l lfile    Get input filenames from lines of lfile (- = stdin)
  -d dir      Get input filenames from directory dir (not recursive)
  -s dir      Get input filenames from directory dir and subdirs
  -o ofile    Output msxml to ofile; default is stdout
  -k          Output Keywords as <attr name="Keywords" .../>
  -T          Output additional <section type="title"> for title text
  -A          Output additional <section type="abstract"> for abstract text
  -h          Show this help
"""

import sys
import io
import os
import re
import warnings
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as _sax_escape

# Full XML encoding for MSXML output: & < > " ' are entity-encoded (quotes matter inside attribute
# values), and characters that are illegal in XML 1.0 (control chars, lone surrogates, U+FFFE/FFFF)
# are dropped so the output is always well-formed.
_XML_ILLEGAL = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]')
_XML_ENT = {'"': '&quot;', "'": '&apos;'}

def escape(s):
    return _sax_escape(_XML_ILLEGAL.sub('', str(s)), _XML_ENT)
import argparse
import logging
import urllib.request
import urllib.error
import json

try:
    from bs4 import BeautifulSoup, Tag, XMLParsedAsHTMLWarning
    warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
except ImportError:
    sys.exit("ERROR: beautifulsoup4 not installed. Run: pip install beautifulsoup4 lxml")

MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun",
               "Jul","Aug","Sep","Oct","Nov","Dec"]

# Sections whose content adds no NLP value — skip entirely (heading matched case-insensitively)
SKIP_SECTION_HEADINGS = {
    "acknowledgements", "acknowledgments",
    "funding",
    "references",
    "author contributions",
    "data availability",
    "declarations",
    "ethics approval",
    "consent to participate",
    "consent to publish",
    "competing interests",
    "electronic supplementary material",
    "publisher's note",
    "publisher’s note",   # curly apostrophe variant
}

# ── Logging setup ─────────────────────────────────────────────────────────────

log = logging.getLogger("htmltext")

# ── DOI helpers ───────────────────────────────────────────────────────────────

def doi_from_filename(path):
    """10.1016_j.biomaterials.2024.122632.html → 10.1016/j.biomaterials.2024.122632"""
    base = os.path.splitext(os.path.basename(path))[0]
    # Replace the first underscore (which separates registrant from suffix) with /
    return base.replace('_', '/', 1)

# ── CrossRef fallback ─────────────────────────────────────────────────────────

_crossref_cache = {}

def crossref_meta(doi):
    """Fetch metadata dict from api.crossref.org; returns {} on failure."""
    if doi in _crossref_cache:
        return _crossref_cache[doi]
    url = f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='/')}"
    try:
        req = urllib.request.Request(url,
            headers={"User-Agent": "htmltext/1.0 (mailto:nlpmanager@example.com)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
        meta = data.get("message", {})
        _crossref_cache[doi] = meta
        return meta
    except Exception as e:
        log.warning("CrossRef lookup failed for %s: %s", doi, e)
        _crossref_cache[doi] = {}
        return {}

import urllib.parse   # needed for crossref_meta

def crossref_authors(meta):
    """Return 'Last,F.;Last2,F2.' string from CrossRef author list."""
    parts = []
    for a in meta.get("author", []):
        family = a.get("family", "")
        given  = a.get("given", "")
        initial = given[0] if given else ""
        if family:
            parts.append(f"{family},{initial}." if initial else family)
    return ";".join(parts)

def crossref_date(meta):
    """Return (year_str, month_str) from CrossRef published-print or published-online."""
    for key in ("published-print", "published-online", "created"):
        dp = meta.get(key, {}).get("date-parts", [[]])[0]
        if dp:
            year  = str(dp[0]) if len(dp) > 0 else ""
            month = MONTH_NAMES[dp[1]-1] if len(dp) > 1 and 1 <= dp[1] <= 12 else ""
            return year, month
    return "", ""

# ── HTML parsing ──────────────────────────────────────────────────────────────

def has_class(tag, cls):
    return cls in (tag.get("class") or [])

def get_text_clean(tag):
    """Return plain text from a BeautifulSoup tag, collapsing whitespace."""
    return re.sub(r'\s+', ' ', tag.get_text(separator=' ')).strip()

def parse_html(path, opts):
    """Parse a BCE HTML file and return a dict with all extracted fields."""
    with open(path, encoding="utf-8", errors="replace") as f:
        soup = BeautifulSoup(f.read(), "lxml")

    result = {}

    # ── Title ──────────────────────────────────────────────────────────────
    title_tag = soup.find("title")
    h1 = soup.find("h1")
    result["title"] = get_text_clean(h1 or title_tag) if (h1 or title_tag) else ""

    # ── DOI / PII from Sem_ divs ───────────────────────────────────────────
    doi_div = soup.find("div", class_=lambda c: c and "Sem_DOI" in c)
    result["doi"] = get_text_clean(doi_div).strip() if doi_div else doi_from_filename(path)

    pii_div = soup.find("div", class_=lambda c: c and "Sem_PII" in c)
    result["pii"] = get_text_clean(pii_div).strip() if pii_div else ""

    jid_div = soup.find("div", class_=lambda c: c and "Sem_JournalID" in c)
    result["journal_id"] = get_text_clean(jid_div).strip() if jid_div else ""

    # ── Keywords ───────────────────────────────────────────────────────────
    kw_div = soup.find("div", class_=lambda c: c and "TextKeyword" in (c if isinstance(c,list) else [c]))
    if kw_div:
        lines = [l.strip() for l in kw_div.get_text(separator='\n').split('\n')
                 if l.strip() and l.strip().lower() != 'keywords']
        result["keywords"] = "; ".join(lines)
    else:
        result["keywords"] = ""

    # ── Abstract ───────────────────────────────────────────────────────────
    abs_div = soup.find("div", class_=lambda c: c and "TextSection_abstract" in (c if isinstance(c,list) else [c]))
    if abs_div:
        # Remove the "Abstract" heading
        heading = abs_div.find(["h1","h2","h3","h4"])
        if heading:
            heading.decompose()
        result["abstract"] = get_text_clean(abs_div)
    else:
        # Try any div/section labelled Abstract
        abs_tag = soup.find(lambda t: t.name in ("div","section") and
                            get_text_clean(t).lower().startswith("abstract") and
                            len(get_text_clean(t)) > 20)
        result["abstract"] = get_text_clean(abs_tag) if abs_tag else ""

    # ── Body sections ──────────────────────────────────────────────────────
    # Collect all TextSection divs that are NOT the abstract
    body_parts = []
    skip_classes = {"Sem_Figure","Sem_Table","Sem_Reference","Sem_Caption",
                    "Sem_Footnote","Sem_Crossref","TextKeyword"}

    for sec in soup.find_all("div", class_=lambda c: c and "TextSection" in (c if isinstance(c,list) else [c])):
        classes = set(sec.get("class") or [])
        if classes & skip_classes:
            continue
        if "TextSection_abstract" in classes:
            continue  # already captured as abstract

        # Skip uninformative back-matter sections (Acknowledgements, References, etc.)
        heading = sec.find(["h1","h2","h3","h4","h5"])
        if heading:
            heading_text = re.sub(r'\s+', ' ', heading.get_text(separator=' ')).strip().lower()
            if heading_text in SKIP_SECTION_HEADINGS:
                continue

        # Remove figure/table/ref semantic divs
        for skip_cls in skip_classes:
            for child in sec.find_all("div", class_=lambda c: c and skip_cls in (c if isinstance(c,list) else [c])):
                child.decompose()

        # Strip table cell content but keep table legend (title + footnotes).
        # Tables live in div.TextLineBefore; remove the <table> element only —
        # sibling elements (table number heading, caption div, footnote div) are kept.
        for tbl_wrap in sec.find_all("div", class_="TextLineBefore"):
            for tbl in tbl_wrap.find_all("table"):
                tbl.decompose()

        text = get_text_clean(sec)
        if text:
            body_parts.append(text)

    result["body"] = "\n\n".join(body_parts)

    # ── Metadata from CrossRef (for fields not in HTML) ────────────────────
    doi = result["doi"]
    meta = crossref_meta(doi) if doi else {}

    result["authors"] = crossref_authors(meta)

    titles = meta.get("title", [])
    if not result["title"] and titles:
        result["title"] = titles[0]

    # ISSN
    issns = meta.get("ISSN", [])
    result["issn"] = issns[0] if issns else ""

    # Journal full name
    containers = meta.get("container-title", [])
    result["journal"] = containers[0] if containers else ""
    if not result["journal"] and result["journal_id"]:
        result["journal"] = result["journal_id"]

    # Pub date
    result["pub_year"], result["pub_month"] = crossref_date(meta)

    # Volume / Issue / Pages
    result["volume"] = str(meta.get("volume", ""))
    result["issue"]  = str(meta.get("issue",  ""))
    pages = meta.get("page", "") or meta.get("article-number", "")
    result["pages"]  = pages

    return result

# ── MSXML output ──────────────────────────────────────────────────────────────

def attr_line(name, value):
    return f'  <attr name="{name}" value="{escape(str(value))}" />\n'

def section_xml(uri, stype, attrs, text):
    out  = f' <section uri="{escape(uri)}" type="{stype}">\n'
    for k, v in attrs:
        if str(v):  # skip empty values
            out += attr_line(k, v)
    out += f'  <text>{escape(text)}</text>\n'
    out += ' </section>\n'
    return out

def article_to_msxml(path, opts):
    """Return MSXML string for one HTML file, or '' on error."""
    log.info("Processing: %s", path)
    try:
        rec = parse_html(path, opts)
    except Exception as e:
        log.error("Failed to parse %s: %s", path, e)
        return ""

    doi = rec["doi"]
    uri = f"info:doi/{doi}" if doi else f"file:{os.path.basename(path)}"
    url = f"http://dx.doi.org/{doi}" if doi else ""

    # Shared attrs for all sections
    base_attrs = [
        ("PII",        rec["pii"]),
        ("DOI",        doi),
        ("URL",        url),
        ("Title",      rec["title"]),
        ("Authors",    rec["authors"]),
        ("ISSN",       rec["issn"]),
        ("Journal",    rec["journal"]),
        ("PubTypes",   "Journal Article"),
        ("PubVersion", "S300.2"),
        ("PubYear",    rec["pub_year"]),
        ("PubMonth",   rec["pub_month"]),
        ("Volume",     rec["volume"]),
        ("Issue",      rec["issue"]),
        ("Pages",      rec["pages"]),
    ]
    if opts.keywords and rec["keywords"]:
        base_attrs.append(("Keywords", rec["keywords"]))

    out = ""

    # -T: title section
    if opts.title_section and rec["title"]:
        out += section_xml(uri, "title", base_attrs, rec["title"])

    # -A: abstract section
    if opts.abstract_section and rec["abstract"]:
        out += section_xml(uri, "abstract", base_attrs, rec["abstract"])

    # body section — always emitted; includes abstract text unless -A was given
    body_text_parts = []
    if rec["abstract"] and not opts.abstract_section:
        body_text_parts.append(rec["abstract"])
    if rec["body"]:
        body_text_parts.append(rec["body"])
    body_text = "\n\n".join(body_text_parts)

    if body_text:
        out += section_xml(uri, "body", base_attrs, body_text)
    else:
        log.warning("No body text extracted from %s", path)

    return out

# ── File collection ───────────────────────────────────────────────────────────

def collect_files_from_linefile(lfile):
    if lfile == "-":
        lines = sys.stdin.read().splitlines()
    else:
        with open(lfile) as f:
            lines = f.read().splitlines()
    return [l.strip() for l in lines if l.strip()]

def collect_files_from_dir(dirpath, recursive):
    result = []
    if recursive:
        for root, dirs, files in os.walk(dirpath):
            for fn in files:
                if fn.lower().endswith(".html"):
                    result.append(os.path.join(root, fn))
    else:
        for fn in os.listdir(dirpath):
            if fn.lower().endswith(".html"):
                result.append(os.path.join(dirpath, fn))
    return sorted(result)

# ── CLI ───────────────────────────────────────────────────────────────────────

def build_parser():
    p = argparse.ArgumentParser(
        prog="htmltext.py",
        description="HTML → MSXML converter for MedScan locscan pipeline",
        add_help=False)
    p.add_argument("-w", dest="suppress_warnings", action="store_true",
                   help="Suppress warnings")
    p.add_argument("-v", dest="verbosity", action="count", default=0,
                   help="Increase verbosity")
    p.add_argument("-q", dest="quiet", action="store_true",
                   help="Suppress logging (quiet)")
    p.add_argument("-l", dest="linefile", metavar="lfile",
                   help="Get input filenames from lines of lfile (- = stdin)")
    p.add_argument("-d", dest="dir_flat", metavar="dir",
                   help="Get input filenames from directory (non-recursive)")
    p.add_argument("-s", dest="dir_recursive", metavar="dir",
                   help="Get input filenames from directory and subdirs")
    p.add_argument("-o", dest="outfile", metavar="ofile", default="-",
                   help="Output msxml to ofile (default: stdout)")
    p.add_argument("-k", dest="keywords", action="store_true",
                   help="Output Keywords attribute")
    p.add_argument("-T", dest="title_section", action="store_true",
                   help="Output additional <section type='title'>")
    p.add_argument("-A", dest="abstract_section", action="store_true",
                   help="Output additional <section type='abstract'>")
    p.add_argument("-h", dest="help", action="store_true",
                   help="Show help")
    p.add_argument("files", nargs="*", help="Input HTML files")
    return p

def main():
    parser = build_parser()
    opts = parser.parse_args()

    if opts.help:
        print(__doc__)
        sys.exit(0)

    # Logging
    if opts.quiet:
        logging.disable(logging.CRITICAL)
    else:
        level = logging.WARNING
        if opts.suppress_warnings:
            level = logging.ERROR
        if opts.verbosity >= 1:
            level = logging.INFO
        if opts.verbosity >= 2:
            level = logging.DEBUG
        logging.basicConfig(stream=sys.stderr,
                            format="htmltext: %(levelname)s: %(message)s",
                            level=level)

    # Collect input files
    input_files = list(opts.files)
    if opts.linefile:
        input_files += collect_files_from_linefile(opts.linefile)
    if opts.dir_flat:
        input_files += collect_files_from_dir(opts.dir_flat, recursive=False)
    if opts.dir_recursive:
        input_files += collect_files_from_dir(opts.dir_recursive, recursive=True)

    if not input_files:
        log.error("No input files specified. Use -h for help.")
        sys.exit(1)

    # Open output — always UTF-8 (Windows stdout defaults to cp1252)
    if opts.outfile == "-":
        out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    else:
        out = open(opts.outfile, "w", encoding="utf-8")

    try:
        out.write("<batch>\n")
        for path in input_files:
            if not os.path.isfile(path):
                log.warning("File not found, skipping: %s", path)
                continue
            xml_str = article_to_msxml(path, opts)
            if xml_str:
                out.write(xml_str)
        out.write("</batch>\n")
        out.flush()
    finally:
        if opts.outfile == "-":
            out.detach()  # don't close the underlying sys.stdout.buffer
        else:
            out.close()

if __name__ == "__main__":
    main()
