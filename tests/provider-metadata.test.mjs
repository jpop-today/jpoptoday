import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/provider-metadata.py', import.meta.url));
const marker = 'SYNTHETIC_PRIVATE_CONTEXT_DO_NOT_PUBLISH';
const tj = (number = '00123', title = '<span>合成 <em>曲名</em></span>', artist = '合成 <b>歌手</b>') =>
  `<ul class="grid-container list"><li><span class="num2">${number}</span></li><li class="title3">${title}</li><li class="singer">${artist}</li></ul>`;
const ky = (number = '00123', title = '<a>合成 <em>曲名</em></a>', artist = '合成 <b>歌手</b>') =>
  `<table class="search_list_tb"><tbody><tr><td class="search_col01">1</td><td class="search_col02">${number}</td><td class="search_col03">${title} / ${artist}</td></tr></tbody></table>`;

// Capture every subprocess byte. Failures report a fixed message rather than echoing
// untrusted provider HTML, redirect URLs, exceptions, or the process environment.
function python(program, input = {}) {
  const prelude = `import importlib.util,json,sys,os,tempfile,pathlib,hashlib,datetime\nfrom unittest import mock\nspec=importlib.util.spec_from_file_location('provider_metadata',${JSON.stringify(script)})\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\npayload=json.load(sys.stdin)\n`;
  const result = spawnSync('python3', ['-c', prelude + program], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024,
  });
  assert.equal(Boolean(result.error), false, 'Python harness must start and finish within its bound');
  assert.equal(result.status, 0, 'Python harness failed; captured output intentionally withheld');
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { assert.fail('Python harness must emit one metadata-only JSON value'); }
  assert.equal(result.stderr, '', 'Library operations must not write untrusted diagnostics');
  return parsed;
}
const parse = (body, provider = 'tj', number = '00123') => python(
  `print(json.dumps(m.parse_metadata(payload['body'].encode('utf-8'),payload['provider'],payload['number']),ensure_ascii=False))`,
  { body, provider, number });
const errors = cases => python(`out=[]\nfor case in payload['cases']:\n try:\n  body=case['body'].encode('utf-8')\n  m.parse_metadata(body,case.get('provider','tj'),case.get('number','00123'))\n  out.append('accepted')\n except m.ReviewError as error:\n  out.append(error.code)\nprint(json.dumps(out))`, { cases });

test('metadata-only parser retains exact leading-zero numbers and nested identity text for both providers', () => {
  for (const [provider, body] of [['tj', tj()], ['ky', ky()]]) {
    assert.deepEqual(parse(body, provider), { number: '00123', title: '合成 曲名', artist: '合成 歌手' });
  }
});

test('script, style, modal, lyrics and hidden context cannot become title or artist text', () => {
  const extra = `<script>${marker}</script><style>${marker}</style><span hidden>${marker}</span><span aria-hidden="true">${marker}</span><div class="modal">${marker}</div><span class="lyrics">${marker}</span>`;
  for (const [provider, body] of [['tj', tj('00123', `合成曲${extra}`, `合成歌手${extra}`)], ['ky', ky('00123', `合成曲${extra}`, `合成歌手${extra}`)]]) {
    assert.deepEqual(parse(`<aside>${marker}</aside>${body}<div class="lyrics">${marker}</div>`, provider),
      { number: '00123', title: '合成曲', artist: '合成歌手' });
  }
});

test('zero results and multiple official rows fail closed rather than selecting a convenient match', () => {
  assert.deepEqual(errors([
    { body: '<html><p>no results</p></html>' },
    { body: '<table class="search_list_tb"><tbody></tbody></table>', provider: 'ky' },
    { body: tj() + tj('99999') },
    { body: ky() + ky('99999'), provider: 'ky' },
  ]), ['result_count', 'result_count', 'result_count', 'result_count']);
});

test('requested number matching is exact and never coerces away leading zeroes', () => {
  assert.deepEqual(errors([
    { body: tj('123') }, { body: tj('00124') },
    { body: ky('123'), provider: 'ky' }, { body: ky('00124'), provider: 'ky' },
  ]), ['number_mismatch', 'number_mismatch', 'number_mismatch', 'number_mismatch']);
});

test('missing, empty and ambiguous title or artist identities cannot produce candidates', () => {
  const bodies = [tj('00123', '', '歌手'), tj('00123', '曲', ' '),
    tj().replace('</ul>', '<li class="title3">別曲</li></ul>'),
    ky('00123', '曲', ''), ky().replace('</tr>', '<td class="search_col03">別歌手</td></tr>')];
  assert.deepEqual(errors(bodies.map((body, index) => ({ body, provider: index < 3 ? 'tj' : 'ky' }))),
    Array(bodies.length).fill('missing_identity'));
});

test('lookalike tables and unrelated nested result markup never become an official result', () => {
  const values = errors([
    { body: ky().replace('search_list_tb', 'unrelated'), provider: 'ky' },
    { body: '<ul class="unrelated">' + tj().replace(/<\/?ul[^>]*>/g, '') + '</ul>' },
    { body: '<table class="unrelated"><tr><td>' + ky() + '</td></tr></table>', provider: 'ky' },
    { body: ky().replace(/<\/?(?:table|tbody)[^>]*>/g, ''), provider: 'ky' },
  ]);
  assert.deepEqual(values, Array(4).fill('result_count'));
});

test('unclosed result containers, excessive nesting and control characters fail closed', () => {
  assert.deepEqual(errors([
    { body: tj().slice(0, -5) },
    { body: ky().replace('</table>', ''), provider: 'ky' },
    { body: '<div>'.repeat(140) + tj() + '</div>'.repeat(140) },
    { body: tj('00123', '合成\u0001曲', '歌手') },
  ]), ['malformed_html', 'malformed_html', 'malformed_html', 'missing_identity']);
  assert.deepEqual(parse(tj('00123', `合成<ul><li>${marker}</li></ul>曲`, '歌手')),
    { number: '00123', title: '合成曲', artist: '歌手' });
});

test('invalid provider, numeric formats, strict UTF-8 and input size boundaries have bounded errors', () => {
  const result = python(`out=[]\ncases=[(b'', 'tj','00123'),(b'\\xff','tj','00123'),(b'x'*(m.MAX_BYTES+1),'tj','00123'),(b'ok','other','00123')]\nfor number in ['', '0','000','-1','12345678901','１２３',123]:\n cases.append((b'ok','tj',number))\nfor body,provider,number in cases:\n try:\n  m.parse_metadata(body,provider,number)\n  out.append('accepted')\n except m.ReviewError as error:\n  out.append(error.code)\nprint(json.dumps(out))`);
  assert.deepEqual(result, ['result_count', 'invalid_utf8', 'response_too_large', 'invalid_provider', ...Array(7).fill('invalid_number')]);
});

test('official URL builders generate only exact numeric lookups and preserve number strings', () => {
  const result = python(`print(json.dumps([m.official_url('tj','00123'),m.official_url('ky','00123')]))`);
  assert.deepEqual(result, [
    'https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=00123&strWord=Y',
    'https://kygabang.com/chart/search_list.php?mode=SongSearch&val=00123',
  ]);
});

const responsePrelude = `class Response:\n def __init__(self,body,url,status=200): self.body,self.url,self.status=body,url,status\n def __enter__(self): return self\n def __exit__(self,*args): return False\n def geturl(self): return self.url\n def read(self,limit):\n  self.limit=limit\n  return self.body[:limit]\n`;

test('successful bounded fetch creates an unreviewed metadata candidate with actual response hash and UTC time', () => {
  const body = tj();
  const result = python(responsePrelude + `body=payload['body'].encode('utf-8')\nresponse=Response(body,m.official_url('tj','00123'))\ncalls=[]\ndef opener(request,timeout):\n calls.append([request.full_url,timeout])\n return response\nbefore=datetime.datetime.now(datetime.timezone.utc)\nrecord=m.fetch_metadata('tj','00123',opener=opener,timeout=7)\nafter=datetime.datetime.now(datetime.timezone.utc)\nchecked=datetime.datetime.fromisoformat(record['checkedAt'].replace('Z','+00:00'))\nprint(json.dumps({'record':record,'calls':calls,'readLimit':response.limit,'actualTime':before<=checked<=after,'bodyHash':hashlib.sha256(body).hexdigest(),'bodyLength':len(body)}))`, { body });
  const { record } = result;
  assert.deepEqual(Object.keys(record).sort(), ['schemaVersion', 'provider', 'number', 'title', 'artist', 'url', 'finalUrl', 'checkedAt', 'responseSha256', 'responseBytes', 'status', 'verification'].sort());
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.provider, 'tj');
  assert.equal(record.number, '00123');
  assert.equal(record.title, '合成 曲名');
  assert.equal(record.artist, '合成 歌手');
  assert.equal(record.verification, 'unreviewed');
  assert.equal(record.status, 200);
  assert.equal(record.responseSha256, result.bodyHash);
  assert.equal(record.responseBytes, result.bodyLength);
  assert.equal(record.finalUrl, record.url);
  assert.equal(result.actualTime, true);
  assert.deepEqual(result.calls, [[record.url, 7]]);
  assert.equal(result.readLimit, 2 * 1024 * 1024 + 1);
});

test('fetch rejects HTTP failures, oversized responses, wrong identities and untrusted final URLs without candidates', () => {
  const result = python(responsePrelude + `url=m.official_url('tj','00123')\nbody=payload['body'].encode('utf-8')\ncases=[(body,url,500),(b'x'*(m.MAX_BYTES+1),url,200),(body,url.replace('00123','00124'),200),(body,url+'&token=synthetic',200),(body,url.replace('www.tjmedia.com','tjmedia.com.evil.invalid'),200),(body,url.replace('https:','http:'),200),(body,url+'#fragment',200),(payload['wrong'].encode('utf-8'),url,200)]\nout=[]\nfor body,final,status in cases:\n try:\n  m.fetch_metadata('tj','00123',opener=lambda request,timeout:Response(body,final,status))\n  out.append('accepted')\n except m.ReviewError as error:\n  out.append(error.code)\nprint(json.dumps(out))`, { body: tj(), wrong: tj('00124') });
  assert.deepEqual(result, ['http_status', 'response_too_large', ...Array(5).fill('final_url'), 'number_mismatch']);
});

test('network timeout, response read failure and invalid timeout produce safe fixed error codes', () => {
  const result = python(responsePrelude + `class Broken(Response):\n def read(self,limit): raise OSError(payload['marker'])\ndef timeout(request,timeout): raise TimeoutError(payload['marker'])\ndef http_error(request,timeout): raise m.urllib.error.HTTPError(request.full_url,503,payload['marker'],{},None)\nout=[]\nfor opener in [timeout,lambda request,timeout:Broken(b'',m.official_url('tj','00123')),http_error]:\n try:\n  m.fetch_metadata('tj','00123',opener=opener)\n  out.append('accepted')\n except m.ReviewError as error:\n  out.append([error.code,payload['marker'] in str(error)])\nfor timeout_value in [0,-1,True,float('inf'),float('nan'),'20']:\n try:\n  m.fetch_metadata('tj','00123',opener=timeout,timeout=timeout_value)\n  out.append('accepted')\n except m.ReviewError as error:\n  out.append(error.code)\nprint(json.dumps(out))`, { marker });
  assert.deepEqual(result, [['network_error', false], ['network_error', false], ['http_status', false], ...Array(6).fill('invalid_timeout')]);
});

test('default urllib opener installs a redirect guard that rejects untrusted Locations before following them', () => {
  const result = python(responsePrelude + `url=m.official_url('tj','00123')\nrequest=m.urllib.request.Request(url)\nhandler=m._OfficialRedirect(url)\nout=[]\nfor location in [url.replace('www.tjmedia.com','evil.invalid'),url+'&token=synthetic',url.replace('00123','00124'),url.replace('https:','http:'),url+'#fragment']:\n try:\n  handler.redirect_request(request,None,302,'Found',{},location)\n  out.append('accepted')\n except m.ReviewError as error:\n  out.append(error.code)\nclass FakeOpener:\n def open(self,request,timeout): return Response(payload['body'].encode('utf-8'),url)\nwith mock.patch.object(m.urllib.request,'build_opener',return_value=FakeOpener()) as build:\n record=m.fetch_metadata('tj','00123')\n installed=build.call_count==1 and len(build.call_args.args)==1 and isinstance(build.call_args.args[0],m._OfficialRedirect) and build.call_args.args[0].official==url\nprint(json.dumps({'errors':out,'installed':installed,'verification':record['verification']}))`, { body: tj() });
  assert.deepEqual(result, { errors: Array(5).fill('final_url'), installed: true, verification: 'unreviewed' });
});

const candidatePrelude = responsePrelude + `record=m.fetch_metadata('tj','00123',opener=lambda request,timeout:Response(payload['body'].encode('utf-8'),m.official_url('tj','00123')))\n`;

test('candidate publication is exclusive and existing output, symlink targets and unrelated last-good bytes survive', () => {
  const result = python(candidatePrelude + `with tempfile.TemporaryDirectory() as directory:\n root=pathlib.Path(directory)\n ledger=root/'ledger.json'; staging=root/'staging.json'; lastgood=root/'last-good.json'\n for target in [ledger,staging,lastgood]: target.write_bytes(b'last-known-good')\n candidate=root/'candidate.json'\n m.write_candidate(candidate,record)\n first=candidate.read_bytes()\n outcomes=[]\n for target in [candidate,ledger,staging,lastgood]:\n  try:\n   m.write_candidate(target,record)\n   outcomes.append('accepted')\n  except m.ReviewError as error:\n   outcomes.append(error.code)\n alias=root/'alias.json'; alias.symlink_to(candidate)\n try:\n  m.write_candidate(alias,record)\n  outcomes.append('accepted')\n except m.ReviewError as error:\n  outcomes.append(error.code)\n print(json.dumps({'saved':json.loads(first),'unchanged':candidate.read_bytes()==first and all(target.read_bytes()==b'last-known-good' for target in [ledger,staging,lastgood]),'outcomes':outcomes,'aliasStillSymlink':alias.is_symlink()}))`, { body: tj() });
  assert.equal(result.saved.verification, 'unreviewed');
  assert.equal(result.unchanged, true);
  assert.equal(result.aliasStillSymlink, true);
  assert.ok(result.outcomes.every(code => ['output_exists', 'unsafe_output'].includes(code)));
});

test('invalid or already-confirmed records cannot be written or modify a last-good file', () => {
  const result = python(candidatePrelude + `out=[]\nwith tempfile.TemporaryDirectory() as directory:\n root=pathlib.Path(directory); lastgood=root/'last-good.json'; lastgood.write_bytes(b'last-known-good')\n for index,change in enumerate([{'verification':'provider-confirmed'},{'lyrics':payload['marker']},{'number':123},{'status':500},{'checkedAt':'tomorrow'},{'url':record['url']+'&token=synthetic'},{'responseSha256':'not-a-sha'}]):\n  changed={**record,**change}\n  target=root/f'candidate-{index}.json'\n  try:\n   m.write_candidate(target,changed)\n   out.append('accepted')\n  except m.ReviewError as error:\n   out.append(error.code)\n  if target.exists(): out.append('published-invalid')\n print(json.dumps({'outcomes':out,'preserved':lastgood.read_bytes()==b'last-known-good'}))`, { body: tj(), marker });
  assert.deepEqual(result.outcomes, Array(7).fill('invalid_record'));
  assert.equal(result.preserved, true);
});

test('publication failure leaves no destination or temporary candidate and preserves last-good bytes', () => {
  const result = python(candidatePrelude + `out=[]\nwith tempfile.TemporaryDirectory() as directory:\n root=pathlib.Path(directory); lastgood=root/'last-good.json'; lastgood.write_bytes(b'last-known-good')\n for boundary in ['link','fsync']:\n  target=root/f'candidate-{boundary}.json'\n  with mock.patch.object(m.os,boundary,side_effect=OSError(payload['marker'])):\n   try:\n    m.write_candidate(target,record)\n    out.append('accepted')\n   except m.ReviewError as error:\n    out.append([error.code,payload['marker'] in str(error)])\n  out.append(target.exists())\n print(json.dumps({'outcomes':out,'preserved':lastgood.read_bytes()==b'last-known-good','files':sorted(target.name for target in root.iterdir())}))`, { body: tj(), marker });
  assert.deepEqual(result.outcomes, [['write_failed', false], false, ['write_failed', false], false]);
  assert.equal(result.preserved, true);
  assert.deepEqual(result.files, ['last-good.json']);
});

test('partial writes and a destination created during publication cannot overwrite last-good or concurrent output', () => {
  const result = python(candidatePrelude + `real_fdopen=m.os.fdopen\nclass PartialWriter:\n def __init__(self,handle): self.handle=handle\n def __enter__(self): return self\n def __exit__(self,*args): self.handle.close(); return False\n def write(self,value): self.handle.write(value[:len(value)//2]); raise OSError(payload['marker'])\nwith tempfile.TemporaryDirectory() as directory:\n root=pathlib.Path(directory); lastgood=root/'last-good.json'; lastgood.write_bytes(b'last-known-good')\n partial=root/'partial.json'; outcomes=[]\n with mock.patch.object(m.os,'fdopen',side_effect=lambda descriptor,mode:PartialWriter(real_fdopen(descriptor,mode))):\n  try:\n   m.write_candidate(partial,record)\n   outcomes.append('accepted')\n  except m.ReviewError as error:\n   outcomes.append([error.code,payload['marker'] in str(error)])\n raced=root/'raced.json'\n def race(source,destination):\n  with open(destination,'xb') as handle: handle.write(b'concurrent-known-good')\n  raise FileExistsError(payload['marker'])\n with mock.patch.object(m.os,'link',side_effect=race):\n  try:\n   m.write_candidate(raced,record)\n   outcomes.append('accepted')\n  except m.ReviewError as error:\n   outcomes.append([error.code,payload['marker'] in str(error)])\n print(json.dumps({'outcomes':outcomes,'partialAbsent':not partial.exists(),'racedPreserved':raced.read_bytes()==b'concurrent-known-good','lastgoodPreserved':lastgood.read_bytes()==b'last-known-good','temporaryAbsent':not any(path.name.startswith('.provider-candidate-') for path in root.iterdir())}))`, { body: tj(), marker });
  assert.deepEqual(result, { outcomes: [['write_failed', false], ['output_exists', false]], partialAbsent: true, racedPreserved: true, lastgoodPreserved: true, temporaryAbsent: true });
});

function cli(args, input = '') {
  const result = spawnSync('python3', [script, ...args], { input, encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024 });
  assert.equal(Boolean(result.error), false, 'CLI must finish within its bound');
  return result;
}

test('parse CLI emits metadata alone without response, confirmation, invented timestamp or hidden context', () => {
  const result = cli(['parse', 'ky', '00123'], ky('00123', `合成曲<span class="lyrics">${marker}</span>`, '合成歌手'));
  assert.equal(result.status, 0, 'Parse command must succeed');
  assert.equal(result.stderr, '');
  let record;
  try { record = JSON.parse(result.stdout); } catch { assert.fail('Parse command must emit JSON'); }
  assert.deepEqual(record, { number: '00123', title: '合成曲', artist: '合成歌手' });
  assert.equal(result.stdout.includes(marker), false);
});

test('CLI invalid arguments and malformed UTF-8 never echo arguments, input, exception details or traceback', () => {
  for (const [args, input] of [
    [['parse', 'tj', marker], ''], [['parse', marker, '00123'], ''], [[marker], ''],
    [['parse', 'tj', '00123'], Buffer.from([0xff])],
  ]) {
    const result = cli(args, input);
    assert.notEqual(result.status, 0, 'Invalid CLI request must fail');
    assert.equal(result.stdout.includes(marker) || result.stderr.includes(marker), false, 'Untrusted input must not be echoed');
    assert.equal(/Traceback|UnicodeDecodeError|usage:.*SYNTHETIC/s.test(result.stdout + result.stderr), false);
  }
});

test('CLI suppresses untrusted exception details and does not publish a candidate when collection fails', () => {
  const result = python(`import contextlib,io\nwith tempfile.TemporaryDirectory() as directory:\n target=pathlib.Path(directory)/'candidate.json'\n stdout,stderr=io.StringIO(),io.StringIO()\n with mock.patch.object(m,'fetch_metadata',side_effect=RuntimeError(payload['marker'])),contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(stderr):\n  code=m.main(['fetch','tj','00123','--output',str(target)])\n print(json.dumps({'code':code,'stdoutEmpty':stdout.getvalue()=='','safeError':stderr.getvalue().strip()=='{\"error\": \"invalid_arguments\"}','notEchoed':payload['marker'] not in stdout.getvalue()+stderr.getvalue(),'absent':not target.exists()}))`, { marker });
  assert.deepEqual(result, { code: 1, stdoutEmpty: true, safeError: true, notEchoed: true, absent: true });
});
