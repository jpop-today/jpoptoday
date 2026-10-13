/**
 * Best-effort CI/daily report delivery. Node 24.5+ provides standard HTTPS
 * proxyEnv/CONNECT support; inherited proxy settings and CA trust are preserved.
 * CLI: node scripts/discord-notify.mjs <report.json> (0 sent/skipped, 1 failed).
 * Never log a destination, response body, report contents, or underlying error.
 */
import { readFile, stat } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const MAX_REPORT_BYTES = 128 * 1024;
const MAX_RATE_LIMIT_BYTES = 8 * 1024;
const MAX_RETRY_MS = 10_000;
const ERROR_CODES = new Set([
  'INVALID_ARGUMENTS', 'INVALID_WEBHOOK_URL', 'INVALID_REPORT',
  'INVALID_REPORT_URL', 'REPORT_READ_FAILED', 'INVALID_REPORT_JSON',
  'PROXY_CONFIGURATION_ERROR', 'PROXY_RUNTIME_UNSUPPORTED',
  'INVALID_OPTIONS', 'REQUEST_TIMEOUT', 'TRANSPORT_ERROR',
  'HTTP_ERROR', 'RATE_LIMIT_INVALID', 'RATE_LIMIT_EXCEEDED', 'INTERNAL_ERROR',
]);

export class DiscordNotificationError extends Error {
  constructor(code, httpStatus) {
    const safeCode = ERROR_CODES.has(code) ? code : 'INTERNAL_ERROR';
    super(`Discord notification failed: ${safeCode}`);
    this.name = 'DiscordNotificationError';
    this.code = safeCode;
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
      this.httpStatus = httpStatus;
    }
  }
}

/** Strict destination allowlist. Only the notification code adds wait=true. */
export function validateWebhookUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048 ||
      !/^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(value)) {
    throw new DiscordNotificationError('INVALID_WEBHOOK_URL');
  }
  let url;
  try { url = new URL(value); } catch {
    throw new DiscordNotificationError('INVALID_WEBHOOK_URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.hash || url.search || !['discord.com', 'discordapp.com'].includes(url.hostname)) {
    throw new DiscordNotificationError('INVALID_WEBHOOK_URL');
  }
  url.searchParams.set('wait', 'true');
  return url;
}

function redact(value, redactions) {
  let text = value;
  // Exact values cover opaque provider secrets without guessing their format.
  for (const secret of redactions) {
    if (typeof secret === 'string' && secret.length > 0) {
      text = text.split(secret).join('[redacted]');
    }
  }
  return text
    .replace(/https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[^\s<>"'`\])]+/gi, '[redacted]')
    .replace(/https?:\/\/[^\s/<>]+:[^\s/<>]+@[^\s<>]+/gi, '[redacted]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:[A-Za-z_]*(?:token|secret|password|api[_-]?key|credential)[A-Za-z_]*|authorization|auth|signature)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi, '[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/@/g, '@\u200b')
    .replace(/<#/g, '<\u200b#');
}

function truncate(value, limit) {
  if (value.length <= limit) return value;
  let prefix = value.slice(0, Math.max(0, limit - 1));
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function reportText(value, limit, redactions) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DiscordNotificationError('INVALID_REPORT');
  }
  const text = redact(value, redactions).trim();
  if (!text) throw new DiscordNotificationError('INVALID_REPORT');
  return truncate(text, limit);
}

function reportUrl(value, redactions) {
  if (typeof value !== 'string' || value.length > 2_048 || /[\s\\]/.test(value)) {
    throw new DiscordNotificationError('INVALID_REPORT_URL');
  }
  let url;
  try { url = new URL(value); } catch {
    throw new DiscordNotificationError('INVALID_REPORT_URL');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      [...url.searchParams.keys()].some(key => /token|secret|password|api[_-]?key|credential|authorization|^auth$|signature|^sig$|^key$/i.test(key)) ||
      redact(value, redactions) !== value) {
    throw new DiscordNotificationError('INVALID_REPORT_URL');
  }
  return url.href;
}

/** Reads only title/summary/fields/url. Extra metadata is never forwarded. */
export function formatDiscordPayload(report, { redactions = [] } = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      !Array.isArray(report.fields) || report.fields.length > 25 || !Array.isArray(redactions)) {
    throw new DiscordNotificationError('INVALID_REPORT');
  }
  const embed = {
    title: reportText(report.title, 256, redactions),
    description: reportText(report.summary, 4_096, redactions),
    fields: report.fields.map(field => {
      if (!field || typeof field !== 'object' || Array.isArray(field) ||
          (field.inline !== undefined && typeof field.inline !== 'boolean')) {
        throw new DiscordNotificationError('INVALID_REPORT');
      }
      return {
        name: reportText(field.name, 256, redactions),
        value: reportText(field.value, 1_024, redactions),
        ...(field.inline === undefined ? {} : { inline: field.inline }),
      };
    }),
    ...(report.url === undefined ? {} : { url: reportUrl(report.url, redactions) }),
  };
  // Discord's 6,000-character limit includes every embed text field together.
  // Shrink the longest entries first, preserving all reported field names.
  const entries = [[embed, 'title'], [embed, 'description'],
    ...embed.fields.flatMap(field => [[field, 'name'], [field, 'value']])];
  let total = entries.reduce((sum, [object, key]) => sum + object[key].length, 0);
  while (total > 6_000) {
    entries.sort(([a, ak], [b, bk]) => b[bk].length - a[ak].length);
    const [object, key] = entries[0];
    const oldLength = object[key].length;
    const nextLength = entries[1]?.[0][entries[1][1]].length ?? 1;
    const target = Math.max(1, oldLength - Math.min(total - 6_000,
      Math.max(1, oldLength - nextLength, Math.ceil((total - 6_000) / entries.length))));
    object[key] = truncate(object[key], target);
    total -= oldLength - object[key].length;
  }
  return { allowed_mentions: { parse: [] }, embeds: [embed] };
}

function secretValues(env, destination) {
  const values = Object.entries(env)
    .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|WEBHOOK|API_?KEY|PRIVATE_?KEY|AUTHORIZATION|CREDENTIAL/i.test(key) && typeof value === 'string')
    .map(([, value]) => value);
  values.push(destination.pathname.split('/').at(-1));
  return values.sort((a, b) => b.length - a.length);
}

function proxyEnvironment(env, nodeVersion) {
  const selected = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (selected) {
    let parsed;
    try { parsed = new URL(selected); } catch {
      throw new DiscordNotificationError('PROXY_CONFIGURATION_ERROR');
    }
    if (typeof selected !== 'string' || !/^https?:\/\//.test(selected) ||
        /[\r\n]/.test(selected) || !parsed.hostname || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new DiscordNotificationError('PROXY_CONFIGURATION_ERROR');
    }
    const [major, minor] = nodeVersion.split('.').map(Number);
    if (!(major > 24 || (major === 24 && minor >= 5))) {
      throw new DiscordNotificationError('PROXY_RUNTIME_UNSUPPORTED');
    }
  }
  // HTTPS wins; HTTP_PROXY is a fallback when only one inherited proxy exists.
  // This creates agent options only and never changes process.env.
  return { https_proxy: selected, no_proxy: env.no_proxy, NO_PROXY: env.NO_PROXY };
}

/** A minimal fetch-compatible transport using only Node's verified TLS/HTTPS. */
export function createDiscordFetch({ env = process.env, httpsRequest = request,
  createAgent = options => new Agent(options), nodeVersion = process.versions.node } = {}) {
  const proxyEnv = proxyEnvironment(env, nodeVersion);
  return async (destination, options) => {
    let agent;
    try {
      agent = createAgent({ proxyEnv, keepAlive: false, rejectUnauthorized: true });
      return await new Promise((resolveResponse, rejectResponse) => {
        const req = httpsRequest(destination, {
          method: 'POST', headers: options.headers, signal: options.signal,
          agent, rejectUnauthorized: true,
        }, response => {
          let size = 0;
          let tooLarge = false;
          const chunks = [];
          response.on('data', chunk => {
            if (response.statusCode !== 429 || tooLarge) return;
            size += chunk.length;
            if (size > MAX_RATE_LIMIT_BYTES) {
              tooLarge = true;
              chunks.length = 0;
            } else chunks.push(chunk);
          });
          response.once('error', () => rejectResponse(new DiscordNotificationError('TRANSPORT_ERROR')));
          response.once('aborted', () => rejectResponse(new DiscordNotificationError('TRANSPORT_ERROR')));
          response.once('end', () => {
            resolveResponse({
              status: response.statusCode,
              headers: { get: name => response.headers[name.toLowerCase()] ?? null },
              json: async () => {
                if (tooLarge) throw new DiscordNotificationError('RATE_LIMIT_INVALID');
                return JSON.parse(Buffer.concat(chunks).toString('utf8'));
              },
            });
          });
        });
        req.once('error', () => rejectResponse(new DiscordNotificationError('TRANSPORT_ERROR')));
        req.end(options.body);
      });
    } catch {
      throw new DiscordNotificationError('TRANSPORT_ERROR');
    } finally {
      agent?.destroy();
    }
  };
}

async function retryDelay(response) {
  const values = [];
  const header = response.headers?.get?.('retry-after');
  if (typeof header === 'string' && /^\d+(?:\.\d+)?$/.test(header.trim())) {
    values.push(Number(header.trim()));
  }
  try {
    const body = await response.json();
    if (typeof body?.retry_after === 'number') values.push(body.retry_after);
  } catch { /* Response bodies and JSON parser errors are never logged. */ }
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0 || value * 1_000 > MAX_RETRY_MS)) {
    throw new DiscordNotificationError('RATE_LIMIT_INVALID', 429);
  }
  return Math.ceil(Math.max(...values) * 1_000);
}

async function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DiscordNotificationError('REQUEST_TIMEOUT'));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw new DiscordNotificationError('REQUEST_TIMEOUT');
    if (error instanceof DiscordNotificationError) throw error;
    throw new DiscordNotificationError('TRANSPORT_ERROR');
  } finally { clearTimeout(timer); }
}

/** Result: {status:'sent',attempts} or {status:'skipped',reason}; failures throw. */
export async function notifyDiscord(report, { env = process.env, fetchImpl,
  sleep = delay, timeoutMs = 10_000, maxAttempts = 3 } = {}) {
  if (env.DISCORD_WEBHOOK_URL === undefined || env.DISCORD_WEBHOOK_URL === '') {
    return { status: 'skipped', reason: 'webhook_not_configured' };
  }
  const destination = validateWebhookUrl(env.DISCORD_WEBHOOK_URL);
  const payload = formatDiscordPayload(report, { redactions: secretValues(env, destination) });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 ||
      (fetchImpl !== undefined && typeof fetchImpl !== 'function') || typeof sleep !== 'function') {
    throw new DiscordNotificationError('INVALID_OPTIONS');
  }
  let transport;
  try { transport = fetchImpl ?? createDiscordFetch({ env }); } catch (error) {
    if (error instanceof DiscordNotificationError) throw error;
    throw new DiscordNotificationError('TRANSPORT_ERROR');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await withTimeout(async signal => {
      const response = await transport(destination.href, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), redirect: 'error', signal,
      });
      if (response?.status === 200 || response?.status === 204) return { sent: true };
      if (response?.status === 429) {
        if (attempt === maxAttempts) throw new DiscordNotificationError('RATE_LIMIT_EXCEEDED', 429);
        return { retryMs: await retryDelay(response) };
      }
      throw new DiscordNotificationError('HTTP_ERROR', response?.status);
    }, timeoutMs);
    if (outcome.sent) return { status: 'sent', attempts: attempt };
    try { await sleep(outcome.retryMs); } catch {
      throw new DiscordNotificationError('TRANSPORT_ERROR');
    }
  }
  throw new DiscordNotificationError('RATE_LIMIT_EXCEEDED', 429);
}

export async function readDiscordReport(path) {
  let bytes;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_REPORT_BYTES) {
      throw new DiscordNotificationError('INVALID_REPORT');
    }
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof DiscordNotificationError) throw error;
    throw new DiscordNotificationError('REPORT_READ_FAILED');
  }
  if (bytes.length > MAX_REPORT_BYTES) throw new DiscordNotificationError('INVALID_REPORT');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new DiscordNotificationError('INVALID_REPORT_JSON');
  }
}

export async function runCli(args, { env = process.env, stdout = process.stdout,
  stderr = process.stderr, readReport = readDiscordReport, ...options } = {}) {
  try {
    if (args.length !== 1) throw new DiscordNotificationError('INVALID_ARGUMENTS');
    if (env.DISCORD_WEBHOOK_URL === undefined || env.DISCORD_WEBHOOK_URL === '') {
      stdout.write('Discord notification skipped: webhook_not_configured.\n');
      return 0;
    }
    // Destination validation occurs before reading an operator-supplied path.
    validateWebhookUrl(env.DISCORD_WEBHOOK_URL);
    const report = await readReport(args[0]);
    const result = await notifyDiscord(report, { ...options, env });
    stdout.write(`Discord notification sent (${result.attempts} attempt${result.attempts === 1 ? '' : 's'}).\n`);
    return 0;
  } catch (error) {
    const code = error instanceof DiscordNotificationError && ERROR_CODES.has(error.code) ? error.code : 'INTERNAL_ERROR';
    const status = error instanceof DiscordNotificationError && Number.isInteger(error.httpStatus) &&
      error.httpStatus >= 100 && error.httpStatus <= 599 ? `; HTTP ${error.httpStatus}` : '';
    stderr.write(`Discord notification failed: ${code}${status}.\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
