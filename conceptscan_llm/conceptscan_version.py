"""Which conceptscan_llm is this?  VERSION is changed by hand when behaviour changes; the sources hash and the build time say exactly which code a conceptscan.exe was built from.
The exe has them from _build_info.py (written by app/scripts/prepare-llm.js or "python conceptscan_version.py --write" just before PyInstaller runs);
run from the .py files the hash of the files on disk is computed live. The same hash is computed by app/scripts/prepare-llm.js - the two must stay identical."""
import glob, hashlib, os, sys, time

VERSION = '2.1.0'
HERE = os.path.dirname(os.path.abspath(__file__))


def source_hash(directory=HERE):
    """sha1 over conceptscan*.py (sorted by name; line ends normalised, so a Windows and a Unix checkout agree), first 10 hex digits"""
    h = hashlib.sha1()
    for path in sorted(glob.glob(os.path.join(directory, 'conceptscan*.py')), key=os.path.basename):
        with open(path, 'rb') as f: data = f.read().replace(b'\r\n', b'\n')
        h.update(os.path.basename(path).encode('utf-8') + b'\0' + data + b'\0')
    return h.hexdigest()[:10]


def info():
    """{'version', 'sources', 'built'}"""
    if getattr(sys, 'frozen', False):
        try:
            import _build_info
            return {'version': VERSION, 'sources': _build_info.SOURCES, 'built': _build_info.BUILT}
        except ImportError:
            return {'version': VERSION, 'sources': 'unknown', 'built': 'unknown'}
    return {'version': VERSION, 'sources': source_hash(), 'built': 'n/a (running the .py files)'}


def text():
    i = info()
    return 'conceptscan_llm %s (sources %s, built %s)' % (i['version'], i['sources'], i['built'])


if __name__ == '__main__':
    if '--write' in sys.argv:        # before PyInstaller: remember the sources hash and the time in the exe
        with open(os.path.join(HERE, '_build_info.py'), 'w', encoding='utf-8') as f:
            f.write('SOURCES = %r\nBUILT = %r\n' % (source_hash(), time.strftime('%Y-%m-%d %H:%M')))
    print(text())
