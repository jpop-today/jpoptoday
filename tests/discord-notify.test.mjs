import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createDiscordFetch, DiscordNotificationError, formatDiscordPayload,
  notifyDiscord, readDiscordReport, runCli, validateWebhookUrl,
} from '../scripts/discord-notify.mjs';

// Entirely synthetic destinations/secrets; no tests make a network request.
const token = 'synthetic_webhook_token_for_mock_tests';
const webhook = `https://discord.com/api/webhooks/123456789/${token}`;
const env = { DISCORD_WEBHOOK_URL: webhook };
const report = { title: 'jpop.today CI', summary: 'Preview verified.',
  fields: [{ name: 'Status', value: 'success', inline: true }],
  url: 'https://github.com/jpop-today/jpoptoday/actions/runs/123' };
const response = (status, { retryAfter, body } = {}) => ({
  status, headers: { get: () => retryAfter ?? null },
  json: async () => body ?? {},
});
const failsWith = code => error => {
  assert.ok(error instanceof DiscordNotificationError);
  assert.equal(error.code, code);
  assert.doesNotMatch(String(error), /synthetic_webhook|https:\/\/discord/);
  return true;
};
const capture = () => {
  let output = '';
  return { write: text => { output += text; }, value: () => output };
};

test('missing webhook skips before report or transport processing', async () => {
  let calls = 0;
  assert.deepEqual(await notifyDiscord(null, { env: {}, fetchImpl: () => { calls += 1; } }),
    { status: 'skipped', reason: 'webhook_not_configured' });
  const stdout = capture();
  const stderr = capture();
  assert.equal(await runCli(['missing.json'], { env: {}, stdout, stderr,
    readReport: () => { calls += 1; throw new Error('should not read'); } }), 0);
  assert.equal(calls, 0);
  assert.match(stdout.value(), /skipped: webhook_not_configured/);
  assert.equal(stderr.value(), '');
});

test('webhook allowlist requires exact HTTPS host/path and adds only wait=true', () => {
  assert.equal(validateWebhookUrl(webhook).href, `${webhook}?wait=true`);
  assert.equal(validateWebhookUrl(webhook.replace('discord.com', 'discordapp.com')).search, '?wait=true');
  for (const url of [
    webhook.replace('https:', 'http:'), webhook.replace('discord.com', 'discord.com.evil.invalid'),
    webhook.replace('discord.com', 'canary.discord.com'), webhook.replace('123456789', 'not-numeric'),
    webhook.replace('discord.com', 'user:password@discord.com'), webhook.replace('discord.com', 'discord.com:443'),
    `${webhook}?wait=true`, `${webhook}?arbitrary=yes`, `${webhook}#fragment`, `${webhook}/extra`,
    ` ${webhook}`, `${webhook}\n`, webhook.replace(token, `${token}%2Fextra`),
    webhook.replace('/api/webhooks/', '/api/v10/webhooks/'), null,
  ]) assert.throws(() => validateWebhookUrl(url), failsWith('INVALID_WEBHOOK_URL'));
});

test('invalid destination prevents transport and report file reads without leaking credentials', async () => {
  const stderr = capture();
  let calls = 0;
  const invalid = 'https://operator:secret-password@example.invalid/api/webhooks/123/private-token';
  assert.equal(await runCli(['secret-path.json'], { env: { DISCORD_WEBHOOK_URL: invalid },
    stdout: capture(), stderr, readReport: () => { calls += 1; },
    fetchImpl: () => { calls += 1; } }), 1);
  assert.equal(calls, 0);
  assert.match(stderr.value(), /INVALID_WEBHOOK_URL/);
  assert.doesNotMatch(stderr.value(), /operator|secret-password|private-token|example\.invalid|secret-path/);
});

test('payload selects only contract fields and disables mentions', () => {
  const payload = formatDiscordPayload({ ...report, metadata: { secret: 'ignored-value' },
    content: '@everyone', username: 'ignored', embeds: ['ignored'],
    fields: [{ ...report.fields[0], unexpected: 'ignored' }] });
  assert.deepEqual(payload, { allowed_mentions: { parse: [] }, embeds: [{
    title: report.title, description: report.summary, fields: report.fields, url: report.url,
  }] });
  assert.equal(JSON.stringify(payload).includes('ignored'), false);
});

test('formatter protects secrets and neutralizes mentions in all text fields', () => {
  const githubToken = `ghp_${'A'.repeat(30)}`;
  const exactSecret = 'opaque-cloud-secret-value';
  const payload = formatDiscordPayload({ title: '@everyone <@123> <#456>',
    summary: `${webhook} ${githubToken} Bearer bearer-token-value token=another-secret\u0000`,
    fields: [{ name: 'password="sensitive value"', value: exactSecret }],
  }, { redactions: [exactSecret] });
  const serialized = JSON.stringify(payload);
  for (const secret of [webhook, token, githubToken, 'bearer-token-value', 'another-secret', 'sensitive value', exactSecret]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(payload.embeds[0].title, /@\u200beveryone/);
  assert.equal(payload.embeds[0].title.includes('<@123>'), false);
  assert.equal(payload.embeds[0].title.includes('<#456>'), false);
  assert.equal(payload.embeds[0].description.includes('\u0000'), false);
});

test('notify redacts opaque configured secret values and the isolated webhook token', async () => {
  const opaqueSecret = 'opaque-token-injected-by-environment';
  let payload;
  const result = await notifyDiscord({ ...report, summary: `${token} ${webhook} ${opaqueSecret}` }, {
    env: { ...env, CLOUDFLARE_API_TOKEN: opaqueSecret },
    fetchImpl: async (_, options) => { payload = JSON.parse(options.body); return response(204); },
  });
  assert.equal(result.status, 'sent');
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(opaqueSecret), false);
  assert.match(payload.embeds[0].description, /\[redacted\]/);
});

test('embed obeys individual, field count, and aggregate Discord limits without broken surrogate pairs', () => {
  const payload = formatDiscordPayload({ title: '😀'.repeat(500), summary: '요약'.repeat(5_000),
    fields: Array.from({ length: 25 }, () => ({ name: '이름'.repeat(500), value: '😀'.repeat(2_000) })) });
  const embed = payload.embeds[0];
  assert.equal(embed.fields.length, 25);
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4_096);
  let total = embed.title.length + embed.description.length;
  for (const field of embed.fields) {
    assert.ok(field.name.length > 0 && field.name.length <= 256);
    assert.ok(field.value.length > 0 && field.value.length <= 1_024);
    total += field.name.length + field.value.length;
  }
  assert.ok(total <= 6_000);
  for (const text of [embed.title, embed.description, ...embed.fields.flatMap(field => [field.name, field.value])]) {
    assert.equal(text.isWellFormed(), true);
  }
});

test('malformed reports and unsafe optional links fail before sending', async () => {
  let calls = 0;
  const malformed = [null, [], {}, { ...report, title: '' }, { ...report, summary: 10 },
    { ...report, fields: null }, { ...report, fields: Array(26).fill(report.fields[0]) },
    { ...report, fields: [null] }, { ...report, fields: [{ name: 'ok', value: ' ' }] },
    { ...report, fields: [{ name: 'ok', value: 'ok', inline: 'yes' }] }];
  for (const value of malformed) {
    await assert.rejects(notifyDiscord(value, { env, fetchImpl: () => { calls += 1; } }), failsWith('INVALID_REPORT'));
  }
  for (const url of ['http://example.invalid', 'javascript:alert(1)',
    'https://user:password@example.invalid', 'https://example.invalid?token=private-secret',
    'https://example.invalid?%74oken=private-secret', 'https://example.invalid?key=private-secret',
    webhook, 'https://example.invalid/with space', 42]) {
    await assert.rejects(notifyDiscord({ ...report, url }, { env,
      fetchImpl: () => { calls += 1; } }), failsWith('INVALID_REPORT_URL'));
  }
  assert.equal(calls, 0);
});

test('HTTP 200 and 204 confirm completion with POST, wait=true, no redirects, and a bounded signal', async () => {
  for (const status of [200, 204]) {
    let calls = 0;
    const result = await notifyDiscord(report, { env, fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, `${webhook}?wait=true`);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['content-type'], 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body).allowed_mentions, { parse: [] });
      return response(status);
    } });
    assert.deepEqual(result, { status: 'sent', attempts: 1 });
    assert.equal(calls, 1);
  }
});

test('429 waits for Discord retry_after and uses at most three total attempts', async () => {
  const waits = [];
  let calls = 0;
  const result = await notifyDiscord(report, { env,
    sleep: async ms => { waits.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? response(429, { retryAfter: '0.5', body: { retry_after: 0.75 } }) : response(200);
    },
  });
  assert.deepEqual(result, { status: 'sent', attempts: 3 });
  assert.deepEqual(waits, [750, 750]);
  calls = 0;
  await assert.rejects(notifyDiscord(report, { env, sleep: async () => {},
    fetchImpl: async () => { calls += 1; return response(429, { body: { retry_after: 0 } }); },
  }), failsWith('RATE_LIMIT_EXCEEDED'));
  assert.equal(calls, 3);
});

test('429 supports a numeric Retry-After header when the body is unavailable', async () => {
  let calls = 0;
  const waits = [];
  await notifyDiscord(report, { env, sleep: async ms => { waits.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? { status: 429, headers: { get: () => '1.25' },
        json: async () => { throw new Error('private-response-body'); } } : response(204);
    },
  });
  assert.deepEqual(waits, [1_250]);
});

test('unusable or excessive rate limits fail immediately without sleep or retries', async () => {
  for (const settings of [{}, { body: { retry_after: '1' } }, { body: { retry_after: -1 } },
    { body: { retry_after: Infinity } }, { body: { retry_after: 10.001 } },
    { retryAfter: '11', body: { retry_after: 1 } }, { retryAfter: 'not-a-number' }]) {
    let calls = 0;
    let sleeps = 0;
    await assert.rejects(notifyDiscord(report, { env,
      fetchImpl: async () => { calls += 1; return response(429, settings); },
      sleep: async () => { sleeps += 1; },
    }), failsWith('RATE_LIMIT_INVALID'));
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  }
});

test('redirects, client errors, and 5xx do not retry potentially accepted POSTs', async () => {
  for (const status of [301, 302, 400, 401, 403, 404, 500, 502, 503]) {
    let calls = 0;
    const stderr = capture();
    const exit = await runCli(['report.json'], { env, stdout: capture(), stderr,
      readReport: async () => report, sleep: () => assert.fail('must not retry'),
      fetchImpl: async () => {
        calls += 1;
        return { status, json: () => assert.fail('must not read error body') };
      },
    });
    assert.equal(exit, 1);
    assert.equal(calls, 1);
    assert.match(stderr.value(), new RegExp(`HTTP_ERROR; HTTP ${status}`));
  }
});

test('network errors expose only sanitized failure state and never retry', async () => {
  let calls = 0;
  const stderr = capture();
  const exit = await runCli(['report.json'], { env, stdout: capture(), stderr,
    readReport: async () => report,
    fetchImpl: async () => {
      calls += 1;
      throw new Error(`${webhook} Authorization: Bearer private-credential response-body-secret`);
    },
  });
  assert.equal(exit, 1);
  assert.equal(calls, 1);
  assert.equal(stderr.value(), 'Discord notification failed: TRANSPORT_ERROR.\n');
});

test('request and rate-limit-body timeouts abort without an automatic duplicate POST', async () => {
  for (const bodyHang of [false, true]) {
    let calls = 0;
    let signal;
    await assert.rejects(notifyDiscord(report, { env, timeoutMs: 20,
      fetchImpl: async (_, options) => {
        calls += 1;
        signal = options.signal;
        if (!bodyHang) return new Promise(() => {});
        return { status: 429, json: () => new Promise(() => {}) };
      },
    }), failsWith('REQUEST_TIMEOUT'));
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  }
});

test('proxy configuration is preserved in the standard HTTPS transport with TLS verification', async () => {
  const inherited = { HTTPS_PROXY: 'http://mock-proxy.invalid:8080', HTTP_PROXY: 'http://fallback.invalid:8080',
    NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/mock/ca.crt' };
  const original = { ...inherited };
  let agentOptions;
  let requestOptions;
  let destroyed = false;
  const transport = createDiscordFetch({ env: inherited, nodeVersion: '24.19.0',
    createAgent: options => { agentOptions = options; return { destroy: () => { destroyed = true; } }; },
    httpsRequest: (url, options, callback) => {
      assert.equal(url, `${webhook}?wait=true`);
      requestOptions = options;
      const req = new EventEmitter();
      req.end = body => {
        assert.equal(body, 'mock-body');
        queueMicrotask(() => {
          const res = new PassThrough();
          res.statusCode = 429;
          res.headers = { 'retry-after': '0.5' };
          callback(res);
          res.end('{"retry_after":0.5}');
        });
      };
      return req;
    },
  });
  const result = await transport(`${webhook}?wait=true`, {
    headers: { 'content-type': 'application/json' }, body: 'mock-body', signal: new AbortController().signal,
  });
  assert.deepEqual(inherited, original);
  assert.equal(agentOptions.proxyEnv.https_proxy, inherited.HTTPS_PROXY);
  assert.equal(agentOptions.proxyEnv.NO_PROXY, inherited.NO_PROXY);
  assert.equal(agentOptions.rejectUnauthorized, true);
  assert.equal(requestOptions.rejectUnauthorized, true);
  assert.equal(destroyed, true);
  assert.equal(result.status, 429);
  assert.deepEqual(await result.json(), { retry_after: 0.5 });
});

test('HTTP_PROXY fallback is supported, and unsupported proxies/runtimes fail instead of connecting directly', async () => {
  let options;
  const transport = createDiscordFetch({ env: { HTTP_PROXY: 'http://fallback.invalid:8080' },
    nodeVersion: '24.19.0', createAgent: value => { options = value; return { destroy() {} }; },
    httpsRequest: () => { throw new Error('mock only'); },
  });
  assert.equal(typeof transport, 'function');
  await assert.rejects(transport(`${webhook}?wait=true`, { headers: {}, body: '{}' }), failsWith('TRANSPORT_ERROR'));
  assert.equal(options.proxyEnv.https_proxy, 'http://fallback.invalid:8080');
  for (const value of ['socks5://private-user:private-pass@proxy.invalid', 'not-a-url', 'http://proxy.invalid\n']) {
    assert.throws(() => createDiscordFetch({ env: { HTTPS_PROXY: value } }), failsWith('PROXY_CONFIGURATION_ERROR'));
  }
  for (const nodeVersion of ['22.0.0', '24.0.0', '24.4.9']) {
    assert.throws(() => createDiscordFetch({ env: { HTTPS_PROXY: 'http://proxy.invalid:8080' }, nodeVersion }),
      failsWith('PROXY_RUNTIME_UNSUPPORTED'));
  }
});

test('even injected structured errors cannot expose arbitrary code or status values in CLI output', async () => {
  const error = new DiscordNotificationError('HTTP_ERROR');
  error.code = 'private-mutated-secret';
  error.httpStatus = 'private-status-secret';
  const stderr = capture();
  assert.equal(await runCli(['report.json'], { env, stdout: capture(), stderr,
    readReport: async () => { throw error; } }), 1);
  assert.equal(stderr.value(), 'Discord notification failed: INTERNAL_ERROR.\n');
});

test('file reader rejects invalid JSON, UTF-8, directories, missing paths, and excessive files safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jpoptoday-discord-'));
  try {
    const path = join(directory, 'report.json');
    await writeFile(path, JSON.stringify(report));
    assert.deepEqual(await readDiscordReport(path), report);
    await writeFile(path, '{ private-secret-json');
    await assert.rejects(readDiscordReport(path), failsWith('INVALID_REPORT_JSON'));
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await assert.rejects(readDiscordReport(path), failsWith('INVALID_REPORT_JSON'));
    await writeFile(path, 'x'.repeat(128 * 1024 + 1));
    await assert.rejects(readDiscordReport(path), failsWith('INVALID_REPORT'));
    await assert.rejects(readDiscordReport(directory), failsWith('INVALID_REPORT'));
    await assert.rejects(readDiscordReport(join(directory, 'private-path.json')), failsWith('REPORT_READ_FAILED'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI from another cwd explicitly skips with no configured secret, and invalid arguments fail safely', () => {
  const cli = fileURLToPath(new URL('../scripts/discord-notify.mjs', import.meta.url));
  const cleanEnv = { PATH: process.env.PATH, DISCORD_WEBHOOK_URL: '' };
  const skipped = spawnSync(process.execPath, [cli, 'missing-report.json'], {
    cwd: tmpdir(), encoding: 'utf8', env: cleanEnv,
  });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /skipped: webhook_not_configured/);
  assert.equal(skipped.stderr, '');
  const invalid = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: cleanEnv });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /INVALID_ARGUMENTS/);
});

test('CLI reports sent and malformed report failures as separate outcomes', async () => {
  const stdout = capture();
  const stderr = capture();
  assert.equal(await runCli(['report.json'], { env, stdout, stderr, readReport: async () => report,
    fetchImpl: async () => response(200) }), 0);
  assert.equal(stdout.value(), 'Discord notification sent (1 attempt).\n');
  assert.equal(stderr.value(), '');
  assert.equal(await runCli(['report.json'], { env, stdout: capture(), stderr,
    readReport: async () => ({ ...report, summary: '' }), fetchImpl: () => assert.fail('must not send') }), 1);
  assert.equal(stderr.value(), 'Discord notification failed: INVALID_REPORT.\n');
});
