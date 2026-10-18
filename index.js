/**
 * dsh-serverChan —— Host 半
 * ============================================================================
 * 1) 监听 `session/event` 的 turn/end，按会话开关把「本轮完成」推送到已启用通道；
 * 2) 注册 `/service_push on|off|status` 命令：会话开关写进会话日志（fork 自动继承）；
 * 3) 暴露 /api/push-notify/* 给设置页与会话开关读写配置 / 通道 / 状态。
 *
 * 设计约束：
 *   · 推送是 fire-and-forget：失败只记日志，绝不向 turn 抛错、绝不阻塞；
 *   · 配置与密钥落在 $DSH_HOME/push-notify/（0600），不写插件包目录、不进 profile patch；
 *   · GET 接口永远不返回完整密钥，只返回掩码。
 * ============================================================================
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL_TYPES,
  maskChannel,
  normalizeChannelFields,
  sendToChannel,
  typeDescriptor,
  typeLabel,
} from './lib/channels.mjs';
import { buildPushMessage, collectTurnContext, statusOf } from './lib/message.mjs';
import {
  PUSH_COMMAND_NAME,
  parsePushArg,
  resolvePushState,
  shouldNotify,
} from './lib/state.mjs';

const API_PREFIX = '/api/push-notify';
const PLUGIN_SLUG = 'push-notify';
const LOG_LIMIT_BYTES = 512 * 1024;
const LAST_LIMIT = 20;
const MAX_CHANNELS = 20;

const DEFAULT_CONFIG = {
  version: 1,
  defaultEnabled: false,
  notifyOnCompleted: true,
  notifyOnFailure: false,
  notifySubagents: false,
  minTurnSeconds: 0,
  cooldownSeconds: 0,
  includeExcerpt: true,
  excerptMode: 'custom',
  excerptChars: 600,
  channels: [],
};

const SETTING_KEYS = [
  'defaultEnabled',
  'notifyOnCompleted',
  'notifyOnFailure',
  'notifySubagents',
  'minTurnSeconds',
  'cooldownSeconds',
  'includeExcerpt',
  'excerptMode',
  'excerptChars',
];

export const inject = ['webServer', 'commands', 'sessions'];

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function errorText(error) {
  if (error === undefined || error === null) return '未知错误';
  if (typeof error === 'string') return error;
  return error?.message ?? String(error);
}

/* ────────────────────────── 家目录 / 配置 ────────────────────────── */

function stateDirOf(ctx) {
  let dir = '';
  try {
    const resolver = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined;
    if (typeof resolver === 'function') {
      const value = resolver(PLUGIN_SLUG);
      if (value) dir = String(value);
    } else if (typeof resolver === 'string' && resolver !== '') {
      dir = join(resolver, PLUGIN_SLUG);
    }
  } catch {
    // 拿不到就退回 DSH_HOME
  }
  if (dir === '') dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), PLUGIN_SLUG);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function normalizeChannels(list) {
  if (!Array.isArray(list)) return [];
  const channels = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const type = String(raw.type ?? '');
    if (typeDescriptor(type) === undefined) continue;
    const config = {};
    const source = raw.config && typeof raw.config === 'object' ? raw.config : {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') config[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') config[key] = String(value);
    }
    channels.push({
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `ch_${randomUUID().slice(0, 8)}`,
      type,
      name: typeof raw.name === 'string' ? raw.name.slice(0, 40) : '',
      enabled: raw.enabled !== false,
      config,
    });
  }
  return channels.slice(0, MAX_CHANNELS);
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    defaultEnabled: source.defaultEnabled === true,
    notifyOnCompleted: source.notifyOnCompleted !== false,
    notifyOnFailure: source.notifyOnFailure === true,
    notifySubagents: source.notifySubagents === true,
    minTurnSeconds: clampInt(source.minTurnSeconds, 0, 600, 0),
    cooldownSeconds: clampInt(source.cooldownSeconds, 0, 3600, 0),
    includeExcerpt: source.includeExcerpt !== false,
    excerptMode: source.excerptMode === 'channel' ? 'channel' : 'custom',
    excerptChars: clampInt(source.excerptChars, 0, 4000, 600),
    channels: normalizeChannels(source.channels),
  };
}

/* ────────────────────────── 插件主体 ────────────────────────── */

export function apply(ctx) {
  const stateDir = stateDirOf(ctx);
  const configFile = join(stateDir, 'config.json');
  const lastFile = join(stateDir, 'last.json');
  const logFile = join(stateDir, 'plugin.log');

  function logLine(level, text) {
    try {
      const line = `${new Date().toISOString()} [${level}] ${text}\n`;
      try {
        if (statSync(logFile).size > LOG_LIMIT_BYTES) renameSync(logFile, `${logFile}.1`);
      } catch {
        // 日志还没生成
      }
      appendFileSync(logFile, line, { mode: 0o600 });
    } catch {
      // 写日志失败不能影响推送主流程
    }
  }

  let configCache = { mtimeMs: -1, config: normalizeConfig(DEFAULT_CONFIG) };

  function loadConfigFromDisk() {
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
      return normalizeConfig(parsed);
    } catch {
      return normalizeConfig(DEFAULT_CONFIG);
    }
  }

  function getConfig() {
    try {
      const mtimeMs = statSync(configFile).mtimeMs;
      if (mtimeMs !== configCache.mtimeMs) {
        configCache = { mtimeMs, config: loadConfigFromDisk() };
      }
    } catch {
      // 文件不存在：沿用当前缓存（首次即默认值）
    }
    return configCache.config;
  }

  function saveConfig(next) {
    const normalized = normalizeConfig(next);
    const tmpFile = `${configFile}.${String(process.pid)}.tmp`;
    writeFileSync(tmpFile, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpFile, configFile);
    try {
      chmodSync(configFile, 0o600);
      configCache = { mtimeMs: statSync(configFile).mtimeMs, config: normalized };
    } catch {
      configCache = { mtimeMs: -1, config: normalized };
    }
    return normalized;
  }

  function readLast() {
    try {
      const parsed = JSON.parse(readFileSync(lastFile, 'utf8'));
      return Array.isArray(parsed) ? parsed.slice(0, LAST_LIMIT) : [];
    } catch {
      return [];
    }
  }

  function pushLast(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    try {
      const next = [...rows, ...readLast()].slice(0, LAST_LIMIT);
      writeFileSync(lastFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      logLine('warn', `写 last.json 失败：${errorText(error)}`);
    }
  }

  /* ── 会话状态 ─────────────────────────────────────────────── */

  const explicitStates = new Map();
  const lastPushAt = new Map();

  function sessionTitleOf(session) {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined;
      const snapshot = service?.get?.(session);
      return typeof snapshot?.title === 'string' ? snapshot.title : undefined;
    } catch {
      return undefined;
    }
  }

  function stateFor(session) {
    return resolvePushState(session, getConfig(), explicitStates);
  }

  /* ── 推送执行 ─────────────────────────────────────────────── */

  async function deliver(session, turnEndEvent) {
    const event = turnEndEvent;
    const status = statusOf(event?.data?.reason);
    const config = getConfig();
    if (!shouldNotify(status, config)) return;
    if (session?.header?.origin === 'subagent' && config.notifySubagents !== true) return;
    const state = stateFor(session);
    if (!state.enabled) return;
    const channels = config.channels.filter((channel) => channel.enabled);
    if (channels.length === 0) {
      logLine('warn', `会话 ${String(session?.id)} turn 完成但未配置启用通道，跳过推送`);
      return;
    }
    const context = collectTurnContext(session, event);
    const durationMs = context.turnStartedAt !== undefined && context.finishedAt !== undefined
      ? context.finishedAt - context.turnStartedAt
      : undefined;
    if (config.minTurnSeconds > 0 && durationMs !== undefined && durationMs < config.minTurnSeconds * 1000) {
      return;
    }
    const now = Date.now();
    const sessionId = String(session?.id ?? '');
    const previous = lastPushAt.get(sessionId) ?? 0;
    if (config.cooldownSeconds > 0 && now - previous < config.cooldownSeconds * 1000) return;
    lastPushAt.set(sessionId, now);

    const titleText = sessionTitleOf(session) ?? context.firstUserText;
    const message = buildPushMessage({ session, context, status, config, titleText });
    const results = await Promise.all(channels.map(async (channel) => {
      const sent = await sendToChannel(channel, message);
      return {
        channelId: channel.id,
        channelName: channel.name !== '' ? channel.name : typeLabel(channel.type),
        type: channel.type,
        ok: sent.ok === true,
        error: sent.ok === true ? undefined : (sent.error ?? '发送失败'),
      };
    }));
    const time = Date.now();
    pushLast(results.map((result) => ({
      time,
      sessionId,
      sessionTitle: message.meta.session.title,
      status: status.kind,
      statusLabel: status.label,
      ...result,
    })));
    const failures = results.filter((result) => !result.ok);
    logLine(
      failures.length === 0 ? 'info' : 'warn',
      `会话 ${sessionId.slice(-8)} · ${status.label} · ${results.map((result) => `${result.channelName}:${result.ok ? 'ok' : result.error}`).join(' / ')}`,
    );
  }

  function onTurnEnd(session, event) {
    void deliver(session, event).catch((error) => {
      logLine('error', `推送处理失败：${errorText(error)}`);
    });
  }

  /* ── 事件监听 ─────────────────────────────────────────────── */

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (!session || !event) return;
    if (event.type === 'command/run') {
      const data = event.data ?? {};
      if (data.name === PUSH_COMMAND_NAME) {
        const arg = parsePushArg(data.args);
        if (arg === 'on') explicitStates.set(String(session.id), true);
        else if (arg === 'off') explicitStates.set(String(session.id), false);
      }
      return;
    }
    if (event.type === 'turn/end') onTurnEnd(session, event);
  }), 'push-notify: session/event 监听');

  ctx.effect(() => ctx.on('session/disposed', (session) => {
    const id = String(session?.id ?? '');
    if (id !== '') {
      explicitStates.delete(id);
      lastPushAt.delete(id);
    }
  }), 'push-notify: session/disposed 清理');

  /* ── /service_push 命令 ───────────────────────────────────────────── */

  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-serverChan',
    name: PUSH_COMMAND_NAME,
    description: '开启/关闭当前会话「每轮任务完成后推送通知」',
    input: { hint: 'on | off | status' },
    handler: ({ agent, rawInput }) => {
      const session = agent?.session;
      const arg = parsePushArg(rawInput);
      if (arg === 'invalid') {
        return { kind: 'error', text: '用法：/service_push on | /service_push off | /service_push status' };
      }
      if (arg === 'on' || arg === 'off') {
        // command/run 已由框架先写入日志；这里同步缓存，避免下一次读取前出现闪烁。
        if (session) explicitStates.set(String(session.id), arg === 'on');
        return { kind: 'success', text: `本会话完成后推送：${arg === 'on' ? '已开启' : '已关闭'}` };
      }
      const config = getConfig();
      const state = session ? stateFor(session) : { enabled: config.defaultEnabled, source: 'default' };
      const enabledChannels = config.channels.filter((channel) => channel.enabled).length;
      const defaultText = state.source === 'default' ? `（默认：${config.defaultEnabled ? '开' : '关'}）` : '';
      return {
        kind: 'success',
        text: `本会话完成后推送：${state.enabled ? '开启' : '关闭'}${defaultText}；可用通道 ${String(enabledChannels)} 个`,
      };
    },
  }), 'push-notify: /service_push 命令');

  /* ── HTTP 路由（设置页 + 会话开关） ────────────────────────── */

  function viewConfig() {
    const config = getConfig();
    return {
      ok: true,
      config: {
        defaultEnabled: config.defaultEnabled,
        notifyOnCompleted: config.notifyOnCompleted,
        notifyOnFailure: config.notifyOnFailure,
        notifySubagents: config.notifySubagents,
        minTurnSeconds: config.minTurnSeconds,
        cooldownSeconds: config.cooldownSeconds,
        includeExcerpt: config.includeExcerpt,
        excerptMode: config.excerptMode,
        excerptChars: config.excerptChars,
      },
      channelTypes: CHANNEL_TYPES.map((descriptor) => ({
        type: descriptor.type,
        label: descriptor.label,
        hint: descriptor.hint,
        fields: descriptor.fields.map((field) => ({
          key: field.key,
          label: field.label,
          placeholder: field.placeholder ?? '',
          secret: field.secret === true,
          optional: field.optional === true,
        })),
      })),
      channels: config.channels.map(maskChannel),
      last: readLast(),
      storage: { configFile },
    };
  }

  function sendJson(res, status, value) {
    const body = `${JSON.stringify(value)}\n`;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 512 * 1024) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim() === '') {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(text);
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function testMessage() {
    const now = new Date();
    return {
      title: '✅ DSH 推送测试',
      markdown: `**✅ DSH 推送测试**\n\n这是一条来自 DSH「消息推送」的测试消息。\n\n- 时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
      text: `✅ DSH 推送测试\n\n这是一条来自 DSH「消息推送」的测试消息。\n\n时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
      meta: { session: { id: 'test', title: '推送测试', status: 'test', statusLabel: '测试' } },
    };
  }

  async function handleHttp(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith(API_PREFIX)) {
      sendJson(res, 404, { ok: false, error: `unknown ${pathname}` });
      return;
    }
    const sub = pathname.slice(API_PREFIX.length) || '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && (sub === '/' || sub === '')) {
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-serverChan',
        endpoints: ['config', 'channels', 'channels/update', 'channels/delete', 'channels/test', 'session'],
      });
      return;
    }

    if (method === 'GET' && sub === '/config') {
      sendJson(res, 200, viewConfig());
      return;
    }

    if (method === 'POST' && sub === '/config') {
      const body = await readBody(req);
      const patch = {};
      for (const key of SETTING_KEYS) {
        if (key in body) patch[key] = body[key];
      }
      saveConfig({ ...getConfig(), ...patch });
      sendJson(res, 200, viewConfig());
      return;
    }

    if (method === 'POST' && sub === '/channels') {
      const body = await readBody(req);
      const type = String(body.type ?? '');
      const descriptor = typeDescriptor(type);
      if (descriptor === undefined) {
        sendJson(res, 400, { ok: false, error: `未知通道类型：${type}` });
        return;
      }
      const normalized = normalizeChannelFields(type, body.fields, { create: true });
      if (normalized.ok !== true) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return;
      }
      const config = getConfig();
      if (config.channels.length >= MAX_CHANNELS) {
        sendJson(res, 400, { ok: false, error: `通道数量已达上限 ${String(MAX_CHANNELS)} 个` });
        return;
      }
      const channel = {
        id: `ch_${randomUUID().slice(0, 8)}`,
        type,
        name: String(body.name ?? '').trim().slice(0, 40),
        enabled: body.enabled !== false,
        config: normalized.fields,
      };
      saveConfig({ ...config, channels: [...config.channels, channel] });
      logLine('info', `新增推送通道 ${descriptor.label}（${channel.id}）`);
      sendJson(res, 200, viewConfig());
      return;
    }

    if (method === 'POST' && sub === '/channels/update') {
      const body = await readBody(req);
      const config = getConfig();
      const index = config.channels.findIndex((channel) => channel.id === body.id);
      if (index === -1) {
        sendJson(res, 404, { ok: false, error: '通道不存在' });
        return;
      }
      const current = config.channels[index];
      const next = {
        ...current,
        name: typeof body.name === 'string' ? body.name.trim().slice(0, 40) : current.name,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
        config: { ...current.config },
      };
      if (body.fields && typeof body.fields === 'object') {
        const normalized = normalizeChannelFields(current.type, body.fields, { create: false });
        if (normalized.ok !== true) {
          sendJson(res, 400, { ok: false, error: normalized.error });
          return;
        }
        Object.assign(next.config, normalized.fields);
      }
      const channels = [...config.channels];
      channels[index] = next;
      saveConfig({ ...config, channels });
      sendJson(res, 200, viewConfig());
      return;
    }

    if (method === 'POST' && sub === '/channels/delete') {
      const body = await readBody(req);
      const config = getConfig();
      const channels = config.channels.filter((channel) => channel.id !== body.id);
      if (channels.length === config.channels.length) {
        sendJson(res, 404, { ok: false, error: '通道不存在' });
        return;
      }
      saveConfig({ ...config, channels });
      sendJson(res, 200, viewConfig());
      return;
    }

    if (method === 'POST' && sub === '/channels/test') {
      const body = await readBody(req);
      const config = getConfig();
      const channel = config.channels.find((entry) => entry.id === body.id);
      if (channel === undefined) {
        sendJson(res, 404, { ok: false, error: '通道不存在' });
        return;
      }
      const sent = await sendToChannel(channel, testMessage());
      const result = {
        channelId: channel.id,
        channelName: channel.name !== '' ? channel.name : typeLabel(channel.type),
        type: channel.type,
        ok: sent.ok === true,
        error: sent.ok === true ? undefined : (sent.error ?? '发送失败'),
      };
      pushLast([{ time: Date.now(), sessionId: 'test', sessionTitle: '推送测试', status: 'test', statusLabel: '测试', ...result }]);
      logLine(sent.ok === true ? 'info' : 'warn', `通道测试 ${result.channelName}:${result.ok ? 'ok' : result.error}`);
      sendJson(res, 200, { ...viewConfig(), result });
      return;
    }

    if (method === 'GET' && sub === '/session') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const config = getConfig();
      let session;
      try {
        session = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined;
      } catch {
        session = undefined;
      }
      const state = session !== undefined
        ? stateFor(session)
        : { enabled: config.defaultEnabled, source: 'default', overridden: false };
      sendJson(res, 200, {
        ok: true,
        sessionId,
        live: session !== undefined,
        enabled: state.enabled === true,
        source: state.source,
        overridden: state.overridden === true,
        defaultEnabled: config.defaultEnabled,
        channels: config.channels.filter((channel) => channel.enabled).length,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: `unknown ${method} ${pathname}` });
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        handleHttp(req, res, url).catch((error) => {
          logLine('error', `路由处理失败：${errorText(error)}`);
          try {
            sendJson(res, 500, { ok: false, error: errorText(error) });
          } catch {
            // 响应可能已经发出
          }
        });
      },
    }), 'push-notify: /api/push-notify 路由');
  } catch (error) {
    logLine('error', `HTTP 路由没挂上：${errorText(error)}`);
  }

  logLine('info', `已挂载（命令 /${PUSH_COMMAND_NAME}，家目录 ${stateDir}，通道 ${String(getConfig().channels.length)} 个，新会话默认${getConfig().defaultEnabled ? '开' : '关'}）`);
}
