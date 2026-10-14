#!/usr/bin/env python3
"""Reversible operations on the existing todayjpop project. Never print bindings."""
import json, os, pathlib, sys, urllib.request, urllib.error

PROJECT = 'todayjpop'
FLAGS = ['production_deployments_enabled', 'preview_deployment_setting',
         'preview_branch_includes', 'preview_branch_excludes']

def api(method, suffix='', body=None):
    account = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
    token = os.environ.get('CLOUDFLARE_API_TOKEN')
    if not account or not token:
        raise RuntimeError('Cloudflare bindings missing')
    req = urllib.request.Request(
        f'https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/{PROJECT}{suffix}',
        method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Cloudflare {method} failed: HTTP {error.code}') from None
    if not value.get('success'):
        raise RuntimeError('Cloudflare operation failed')
    return value['result']

def summarize(project):
    config = project.get('source', {}).get('config', {})
    deployment = project.get('canonical_deployment') or {}
    if project['name'] != PROJECT or 'jpop.today' not in project.get('domains', []):
        raise RuntimeError('Unexpected production project/domain')
    return {'project': PROJECT, 'domains': project['domains'],
            'source': {key: config.get(key) for key in ['owner', 'repo_name', 'production_branch'] + FLAGS},
            'deployment': {key: deployment.get(key) for key in ['id', 'url', 'created_on', 'latest_stage', 'deployment_trigger']}}

def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'inspect'
    before = summarize(api('GET'))
    if action == 'inspect':
        print(json.dumps(before, ensure_ascii=False, indent=2)); return
    if action == 'pause':
        if len(sys.argv) != 4: raise RuntimeError('Usage: pause <backup.json> <expected-current-source-sha>')
        metadata = before['deployment']['deployment_trigger']['metadata']
        if metadata['commit_hash'] != sys.argv[3]: raise RuntimeError('Production source changed: recheck before mutation')
        path = pathlib.Path(sys.argv[2])
        # Exclusive creation: never silently replace the restoration settings.
        with path.open('x') as output: output.write(json.dumps(before, ensure_ascii=False, indent=2) + '\n')
        config = {'production_deployments_enabled': False, 'preview_deployment_setting': 'none'}
        api('PATCH', body={'source': {'type': 'github', 'config': config}})
        after = summarize(api('GET'))
        if after['source']['production_deployments_enabled'] is not False or after['source']['preview_deployment_setting'] != 'none':
            raise RuntimeError('Automatic deployment pause did not persist')
        if before['deployment']['id'] != after['deployment']['id']: raise RuntimeError('Pausing unexpectedly changed current deployment')
    elif action == 'restore':
        if len(sys.argv) != 3: raise RuntimeError('Usage: restore <backup.json>')
        saved = json.loads(pathlib.Path(sys.argv[2]).read_text())
        if saved['project'] != PROJECT: raise RuntimeError('Wrong project backup')
        api('PATCH', body={'source': {'type': 'github', 'config': {key: saved['source'][key] for key in FLAGS}}})
        after = summarize(api('GET'))
        if any(after['source'][key] != saved['source'][key] for key in FLAGS): raise RuntimeError('Restoration did not persist')
    elif action == 'rollback':
        if len(sys.argv) != 3: raise RuntimeError('Usage: rollback <successful-deployment-id>')
        import re
        if not re.fullmatch(r'[a-f0-9-]{36}', sys.argv[2]): raise RuntimeError('Invalid deployment ID')
        target = api('GET', '/deployments/' + sys.argv[2])
        if target.get('environment') != 'production' or target.get('latest_stage', {}).get('status') != 'success':
            raise RuntimeError('Rollback target must be a successful production deployment')
        api('POST', '/deployments/' + sys.argv[2] + '/rollback')
        after = summarize(api('GET'))
        if after['deployment']['id'] != sys.argv[2]: raise RuntimeError('Rollback canonical target mismatch')
    else: raise RuntimeError('Unknown operation')
    print(json.dumps({'action': action, 'before': before, 'after': after}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        # No response bodies, authentication headers or environment dumps.
        print(str(error), file=sys.stderr); sys.exit(1)
