#!/usr/bin/env python3
"""Bounded, metadata-only official lookup. Results always need human review."""

import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.request
import urllib.error
from html.parser import HTMLParser

MAX_BYTES = 2 * 1024 * 1024
ERROR_CODES = frozenset({
    'invalid_provider', 'invalid_number', 'invalid_timeout', 'invalid_body',
    'response_too_large', 'invalid_utf8', 'malformed_html', 'result_count',
    'missing_identity', 'number_mismatch', 'http_status', 'final_url',
    'network_error', 'output_exists', 'unsafe_output', 'invalid_record',
    'write_failed', 'invalid_arguments',
})


class ReviewError(Exception):
    """Only an allowlisted code is exposed, never an underlying error value."""

    def __init__(self, code):
        self.code = code if code in ERROR_CODES else 'invalid_record'
        super().__init__(self.code)


def official_url(provider, number):
    if provider not in ('tj', 'ky'):
        raise ReviewError('invalid_provider')
    if (not isinstance(number, str) or len(number) > 10
            or not re.fullmatch(r'[0-9]+', number) or not number.strip('0')):
        raise ReviewError('invalid_number')
    if provider == 'tj':
        return ('https://www.tjmedia.com/song/accompaniment_search?'
                'nationType=JPN&strType=16&searchTxt=' + number + '&strWord=Y')
    return 'https://kygabang.com/chart/search_list.php?mode=SongSearch&val=' + number


_VOID = frozenset({'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                   'link', 'meta', 'param', 'source', 'track', 'wbr'})
_INLINE = frozenset({'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'del', 'div',
                     'em', 'font', 'i', 'ins', 'mark', 'p', 'rp', 'rt', 'ruby',
                     's', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'wbr'})
_BLOCKED_TAGS = frozenset({'script', 'style', 'template', 'noscript', 'iframe',
                           'object', 'svg', 'canvas', 'dialog', 'textarea'})
_BLOCKED_TOKEN = re.compile(r'(?:modal|lyric|lyrics|popup|dialog)', re.I)


class _Node:
    __slots__ = ('tag', 'attrs', 'parent', 'children', 'closed', 'blocked')

    def __init__(self, tag='', attrs=(), parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children, self.closed = [], False
        style = re.sub(r'\s+', '', self.attrs.get('style', '').lower())
        self.blocked = bool(
            (parent and parent.blocked) or tag in _BLOCKED_TAGS
            or _BLOCKED_TOKEN.search(self.attrs.get('class', '') + ' ' + self.attrs.get('id', ''))
            or self.attrs.get('role', '').lower() == 'dialog'
            or 'hidden' in self.attrs or self.attrs.get('aria-hidden', '').lower() == 'true'
            or 'display:none' in style or 'visibility:hidden' in style)

    def classes(self):
        return set(self.attrs.get('class', '').split())


def _identity_node(node):
    classes = node.classes()
    return ((node.tag == 'td' and bool(classes & {'search_col02', 'search_col03'}))
            or (node.tag == 'li' and bool(classes & {'title3', 'singer'}))
            or (node.tag == 'span' and 'num2' in classes))


class _MetadataHTML(HTMLParser):
    """Keep text only inside recognized cells; omit blocked subtree text entirely."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node()
        self.stack = [self.root]
        self.nodes = []

    def handle_starttag(self, tag, attrs):
        if len(self.stack) > 128 or len(self.nodes) >= 100000:
            raise ReviewError('malformed_html')
        node = _Node(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)
        self.nodes.append(node)
        if tag not in _VOID:
            self.stack.append(node)
        else:
            node.closed = True

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack[index].closed = True
                self.stack = self.stack[:index]
                return

    def handle_data(self, data):
        if not self.stack[-1].blocked and any(_identity_node(n) for n in self.stack):
            self.stack[-1].children.append(data)


def _ancestors(node):
    while node is not None:
        yield node
        node = node.parent


def _descendants(node, *, stop_rows=False):
    for child in node.children:
        if not isinstance(child, _Node) or child.blocked:
            continue
        if stop_rows and (child.tag in {'table', 'tr'}
                          or (child.tag == 'ul' and {'grid-container', 'list'} <= child.classes())):
            continue
        yield child
        yield from _descendants(child, stop_rows=stop_rows)


def _text(node):
    if node.blocked:
        return ''
    parts = []
    for child in node.children:
        if isinstance(child, str):
            parts.append(child)
        elif child.tag in _INLINE and not child.blocked:
            parts.append(' ' if child.tag in {'br', 'wbr'} else _text(child))
    return ''.join(parts)


def _clean(node):
    if not node.closed:
        raise ReviewError('malformed_html')
    value = ' '.join(_text(node).split())
    if (len(value) > 2000
            or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in value)):
        raise ReviewError('missing_identity')
    return value


def _single(nodes):
    if len(nodes) != 1:
        raise ReviewError('missing_identity')
    return nodes[0]


def parse_metadata(body, provider, number):
    """Parse saved bytes without manufacturing a source, timestamp, or review."""
    official_url(provider, number)
    if not isinstance(body, bytes):
        raise ReviewError('invalid_body')
    if len(body) > MAX_BYTES:
        raise ReviewError('response_too_large')
    try:
        text = body.decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        raise ReviewError('invalid_utf8') from None
    parser = _MetadataHTML()
    try:
        parser.feed(text)
        parser.close()
    except ReviewError:
        raise
    except Exception:
        raise ReviewError('malformed_html') from None
    if provider == 'tj':
        rows = [n for n in parser.nodes if not n.blocked and n.tag == 'ul'
                and {'grid-container', 'list'} <= n.classes()]
    else:
        rows = []
        for node in parser.nodes:
            if node.blocked or node.tag != 'tr':
                continue
            children = [n for n in node.children if isinstance(n, _Node)
                        and n.tag == 'td' and not n.blocked]
            if not any(n.classes() & {'search_col02', 'search_col03'} for n in children):
                continue
            parent = node.parent
            while parent is not None and parent.tag != 'table':
                parent = parent.parent
            if parent is None or 'search_list_tb' not in parent.classes():
                continue
            ancestor = parent.parent
            if any(n.tag == 'table' for n in _ancestors(ancestor)):
                continue
            if not parent.closed:
                raise ReviewError('malformed_html')
            rows.append(node)
    if len(rows) != 1:
        raise ReviewError('result_count')
    row = rows[0]
    if not row.closed:
        raise ReviewError('malformed_html')
    if provider == 'tj':
        direct = [n for n in row.children if isinstance(n, _Node)
                  and n.tag == 'li' and not n.blocked]
        number_node = _single([n for n in _descendants(row, stop_rows=True)
                               if n.tag == 'span' and 'num2' in n.classes()])
        title_node = _single([n for n in direct if 'title3' in n.classes()])
        artist_node = _single([n for n in direct if 'singer' in n.classes()])
        actual, title, artist = _clean(number_node), _clean(title_node), _clean(artist_node)
    else:
        direct = [n for n in row.children if isinstance(n, _Node)
                  and n.tag == 'td' and not n.blocked]
        number_node = _single([n for n in direct if 'search_col02' in n.classes()])
        info_node = _single([n for n in direct if 'search_col03' in n.classes()])
        actual, info = _clean(number_node), _clean(info_node)
        if info.count(' / ') != 1:
            raise ReviewError('missing_identity')
        title, artist = info.split(' / ', 1)
    if actual != number:
        raise ReviewError('number_mismatch')
    if not title.strip() or not artist.strip():
        raise ReviewError('missing_identity')
    return {'number': actual, 'title': title.strip(), 'artist': artist.strip()}


class _OfficialRedirect(urllib.request.HTTPRedirectHandler):
    """Reject an off-contract Location before urllib can issue that request."""

    def __init__(self, official):
        super().__init__()
        self.official = official

    def redirect_request(self, request, response, code, message, headers, new_url):
        if new_url != self.official:
            raise ReviewError('final_url')
        return super().redirect_request(request, response, code, message, headers, new_url)


def fetch_metadata(provider, number, *, opener=None, timeout=20):
    """Return a new unreviewed candidate only after a bounded actual request."""
    url = official_url(provider, number)
    if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or not 0 < timeout <= 60):
        raise ReviewError('invalid_timeout')
    request = urllib.request.Request(url, headers={
        'User-Agent': 'jpop.today metadata review; human verification required',
        'Accept': 'text/html', 'Accept-Encoding': 'identity',
    })
    try:
        # build_opener retains standard ProxyHandler and HTTPS CA trust.
        open_request = opener or urllib.request.build_opener(_OfficialRedirect(url)).open
        with open_request(request, timeout=timeout) as response:
            if response.status != 200:
                raise ReviewError('http_status')
            final_url = response.geturl()
            if final_url != url:
                raise ReviewError('final_url')
            body = response.read(MAX_BYTES + 1)
    except ReviewError:
        raise
    except urllib.error.HTTPError:
        raise ReviewError('http_status') from None
    except Exception:
        raise ReviewError('network_error') from None
    metadata = parse_metadata(body, provider, number)
    checked = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
    return {
        'schemaVersion': 1, 'provider': provider, **metadata,
        'url': url, 'finalUrl': url, 'checkedAt': checked,
        'responseSha256': hashlib.sha256(body).hexdigest(),
        'responseBytes': len(body), 'status': 200, 'verification': 'unreviewed',
    }


_RECORD_KEYS = frozenset({'schemaVersion', 'provider', 'number', 'title', 'artist',
                          'url', 'finalUrl', 'checkedAt', 'responseSha256',
                          'responseBytes', 'status', 'verification'})


def _validate_record(record):
    if not isinstance(record, dict) or set(record) != _RECORD_KEYS:
        raise ReviewError('invalid_record')
    try:
        url = official_url(record['provider'], record['number'])
        checked = datetime.datetime.fromisoformat(record['checkedAt'].replace('Z', '+00:00'))
        valid = (type(record['schemaVersion']) is int and record['schemaVersion'] == 1
                 and type(record['status']) is int and record['status'] == 200
                 and record['verification'] == 'unreviewed'
                 and record['url'] == url and record['finalUrl'] == url
                 and checked.tzinfo is not None
                 and checked <= datetime.datetime.now(datetime.timezone.utc)
                 and isinstance(record['responseSha256'], str)
                 and re.fullmatch(r'[0-9a-f]{64}', record['responseSha256'])
                 and type(record['responseBytes']) is int
                 and 0 < record['responseBytes'] <= MAX_BYTES
                 and all(isinstance(record[k], str) and record[k].strip()
                         and len(record[k]) <= 2000
                         and not any(ord(c) < 32 or 127 <= ord(c) < 160 for c in record[k])
                         for k in ('title', 'artist')))
    except Exception:
        raise ReviewError('invalid_record') from None
    if not valid:
        raise ReviewError('invalid_record')


def write_candidate(path, record):
    """Exclusively publish a separate file. Existing files/links are never replaced."""
    _validate_record(record)
    try:
        destination = Path(path)
        forbidden = {'reviewed', 'staging', 'last-good', 'last_good', 'lastgood'}
        protected_names = {'provider-corrections.json', 'legacy-catalog.json',
                           'catalog.json', 'chart-snapshot.json', 'ledger.json',
                           'last-good.json', 'last_good.json', 'lastgood.json'}
        if (destination.suffix != '.json' or any(p.lower() in forbidden for p in destination.parts)
                or destination.name.lower() in protected_names):
            raise ReviewError('unsafe_output')
        if os.path.lexists(destination):
            raise ReviewError('output_exists')
        # Parent symlinks are rejected as well; a symlink cannot redirect publication.
        absolute = Path(os.path.abspath(destination))
        if any(parent.is_symlink() for parent in absolute.parents):
            raise ReviewError('unsafe_output')
        parent = absolute.parent
        if not parent.is_dir():
            raise ReviewError('unsafe_output')
        payload = (json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')
    except ReviewError:
        raise
    except Exception:
        raise ReviewError('unsafe_output') from None
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix='.provider-candidate-', suffix='.tmp', dir=parent)
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        # link() atomically fails if destination appeared after the initial check.
        os.link(temporary, absolute)
    except FileExistsError:
        raise ReviewError('output_exists') from None
    except Exception:
        raise ReviewError('write_failed') from None
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(args) == 3 and args[0] == 'parse':
            official_url(args[1], args[2])
            body = sys.stdin.buffer.read(MAX_BYTES + 1)
            result = parse_metadata(body, args[1], args[2])
        elif len(args) == 5 and args[0] == 'fetch' and args[3] == '--output':
            result = fetch_metadata(args[1], args[2])
            write_candidate(args[4], result)
        else:
            raise ReviewError('invalid_arguments')
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except ReviewError as error:
        print(json.dumps({'error': error.code}), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({'error': 'invalid_arguments'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
