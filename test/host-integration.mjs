/**
 * test/host-integration.mjs —— 用假 ctx 把 Host 半完整跑一遍
 * ============================================================================
 * 不需要 DSH 进程：伪造 ctx（commands / webServer / sessions / on / effect），
 * 用本地 HTTP 回显服务当通道，验证：
 *   · /api/push-notify 路由（配置、通道 CRUD、会话状态）
 *   · /service_push 命令 handler 与 command/run → 会话状态折叠
 *   · session/event turn/end → 真正发出 HTTP 推送（成功 + 失败路径）
 *   · 带 command/run 的会话（模拟 fork 继承）状态正确
 * 运行：node test/host-integration.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';

/* ────────────────────────── 本地回显服务 ────────────────────────── */

const received = [];
const echoServer = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({ url: request.url, body });
    if (request.url.startsWith('/fail')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 40001, message: 'bad key' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 0, message: '' }));
  });
});
await new Promise((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
const echoBase = `http://127.0.0.1:${String(echoServer.address().port)}`;

/* ────────────────────────── 假 Context ────────────────────────── */

const home = mkdtempSync(join(tmpdir(), 'dsh-serverChan-test-'));
const handlers = new Map();
const liveSessions = new Map();
let commandDefinition;
let routeRegistration;

const fakeCtx = {
  get(name) {
    if (name === 'dshHomePath') return (...parts) => join(home, ...parts);
    if (name === 'sessionTitle') {
      return { get: (session) => (session.title ? { title: session.title } : undefined) };
    }
    if (name === 'sessionController') {
      return {
        async inspect(sessionId) {
          if (sessionId === 'session-cold-on') {
            return { events: [{ type: 'command/run', seq: 10, data: { name: 'service_push', args: ' on' } }] };
          }
          if (sessionId === 'session-cold-off') {
            return { events: [{ type: 'command/run', seq: 11, data: { name: 'service_push', args: ' off' } }] };
          }
          if (sessionId === 'session-cold-none') {
            return { events: [{ type: 'turn/start', seq: 1, data: { turn: 1 } }] };
          }
          throw new Error('inspect failed');
        },
      };
    }
    return undefined;
  },
  effect(callback) {
    return callback() ?? (() => {});
  },
  on(name, callback) {
    handlers.set(name, callback);
    return () => { handlers.delete(name); };
  },
  commands: {
    register(definition) {
      commandDefinition = definition;
      return () => { commandDefinition = undefined; };
    },
  },
  webServer: {
    register(registration) {
      routeRegistration = registration;
      return () => { routeRegistration = undefined; };
    },
  },
  sessions: {
    get(id) { return liveSessions.get(id); },
  },
  logger: { warn() {}, info() {} },
};

apply(fakeCtx);
assert.ok(commandDefinition, 'Host 半应注册 /service_push 命令');
assert.ok(routeRegistration, 'Host 半应注册 /api/push-notify 路由');
assert.equal(commandDefinition.name, 'service_push');

/* ────────────────────────── 路由调用工具 ────────────────────────── */

function callRoute(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter();
    request.method = method;
    request.url = path;
    request.destroy = () => {};
    const response = {
      statusCode: 0,
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      end(text) {
        let parsed;
        try { parsed = text === undefined || text === '' ? undefined : JSON.parse(text); } catch { parsed = text; }
        resolve({ status: this.statusCode, statusCode: this.statusCode, body: parsed });
      },
    };
    try {
      routeRegistration.handler(request, response);
    } catch (error) {
      reject(error);
      return;
    }
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
  });
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`超时等待：${label}`);
}

/* ────────────────────────── 假 Session ────────────────────────── */

function makeSession(id, { title = '测试会话', events = [] } = {}) {
  const session = {
    id,
    title,
    header: { cwd: '/Users/demo/my-workspace', origin: undefined },
    snapshotEvents: () => session.events,
    events,
  };
  liveSessions.set(id, session);
  return session;
}

const turnEvents = (turn) => [
  { type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: '帮我跑一下测试' }] } },
  { type: 'turn/start', time: 2000 + turn * 10_000, data: { turn } },
  {
    type: 'assistant/message',
    time: 9000 + turn * 10_000,
    data: {
      message: {
        content: [{ type: 'text', text: `第 ${String(turn)} 轮的最后回复` }],
        source: { kind: 'model', model: 'deepseek-chat' },
      },
    },
  },
  { type: 'turn/end', time: 10_000 + turn * 10_000, data: { turn, reason: { kind: 'completed' } } },
];

await (async () => {
  /* ── 配置默认值 ── */
  {
    const response = await callRoute('GET', '/api/push-notify/config');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.config.defaultEnabled, false);
    assert.equal(response.body.config.notifyOnCompleted, true);
    assert.equal(response.body.channels.length, 0);
    assert.ok(response.body.channelTypes.length >= 7);
    console.log('  ok  GET /config 默认值');
  }

  /* ── 冷会话（重启后还没打开）：从持久化日志读状态，不能退回「默认灰」 ── */
  {
    const on = await callRoute('GET', '/api/push-notify/session?sessionId=session-cold-on');
    assert.equal(on.statusCode, 200);
    assert.equal(on.body.ok, true);
    assert.equal(on.body.live, false);
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.source, 'command');
    assert.equal(on.body.overridden, true);

    const off = await callRoute('GET', '/api/push-notify/session?sessionId=session-cold-off');
    assert.equal(off.body.live, false);
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.source, 'command');

    const none = await callRoute('GET', '/api/push-notify/session?sessionId=session-cold-none');
    assert.equal(none.body.live, false);
    assert.equal(none.body.enabled, false);
    assert.equal(none.body.source, 'default');

    const broken = await callRoute('GET', '/api/push-notify/session?sessionId=session-cold-broken');
    assert.equal(broken.statusCode, 200);
    assert.equal(broken.body.enabled, false);
    assert.equal(broken.body.source, 'default');
    console.log('  ok  冷会话从持久化日志读状态（on/off/default/读取失败）');
  }

  /* ── 通道 CRUD ── */
  let channelId;
  {
    const response = await callRoute('POST', '/api/push-notify/channels', {
      type: 'webhook',
      name: '本地回显',
      fields: { url: `${echoBase}/echo` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.channels.length, 1);
    channelId = response.body.channels[0].id;
    assert.equal(response.body.channels[0].typeLabel, '自定义 Webhook');
    assert.equal(response.body.channels[0].fields.url, `${`${echoBase}/echo`.slice(0, 4)}••••${`${echoBase}/echo`.slice(-4)}`);
    console.log('  ok  POST /channels 创建 + 掩码');
  }
  {
    const response = await callRoute('POST', '/api/push-notify/channels/update', { id: channelId, name: '回显2' });
    assert.equal(response.body.channels[0].name, '回显2');
    console.log('  ok  POST /channels/update');
  }

  /* ── 默认配置打开 → 会话默认开启 ── */
  {
    const response = await callRoute('POST', '/api/push-notify/config', {
      defaultEnabled: true,
      notifySubagents: true,
      excerptMode: 'channel',
      excerptChars: 100,
    });
    assert.equal(response.body.config.defaultEnabled, true);
    assert.equal(response.body.config.excerptMode, 'channel');
    console.log('  ok  POST /config 修改默认');
  }

  /* ── 会话状态：默认值 ── */
  const session = makeSession('session-11111111', { title: '集成测试会话', events: [...turnEvents(1)] });
  {
    const response = await callRoute('GET', '/api/push-notify/session?sessionId=session-11111111');
    assert.equal(response.body.live, true);
    assert.equal(response.body.enabled, true);
    assert.equal(response.body.source, 'default');
    console.log('  ok  GET /session 默认开启（新会话默认）');
  }

  /* ── /service_push on 命令 → 状态来自日志 ── */
  {
    session.events.push({ type: 'command/run', time: 11_000, data: { name: 'service_push', args: 'on' } });
    const result = commandDefinition.handler({ agent: { session }, rawInput: 'on' });
    assert.equal(result.kind, 'success');
    const response = await callRoute('GET', '/api/push-notify/session?sessionId=session-11111111');
    assert.equal(response.body.enabled, true);
    assert.equal(response.body.source, 'command');
    console.log('  ok  /service_push on → source=command');
  }

  /* ── turn/end 真发推送（成功） ── */
  {
    const before = received.length;
    handlers.get('session/event')(session, session.events.find((event) => event.type === 'turn/end'));
    await waitFor(() => received.length > before, '收到推送请求');
    const record = received[received.length - 1];
    assert.ok(record.url.startsWith('/echo'));
    const payload = JSON.parse(record.body);
    assert.equal(payload.source, 'dsh-serverChan');
    assert.match(payload.title, /完成/u);
    assert.match(payload.text, /集成测试会话/u);
    assert.match(payload.text, /第 1 轮的最后回复/u);
    await waitFor(async () => {
      const response = await callRoute('GET', '/api/push-notify/config');
      return response.body.last.length > 0 && response.body.last[0].ok === true;
    }, 'last 记录成功');
    console.log('  ok  turn/end → Webhook 收到真实推送 + last 记录');
  }

  /* ── /service_push off → 不再推送 ── */
  {
    session.events.push({ type: 'command/run', time: 12_000, data: { name: 'service_push', args: 'off' } });
    const result = commandDefinition.handler({ agent: { session }, rawInput: 'off' });
    assert.equal(result.kind, 'success');
    const state = await callRoute('GET', '/api/push-notify/session?sessionId=session-11111111');
    assert.equal(state.body.enabled, false);
    assert.equal(state.body.source, 'command');
    const before = received.length;
    handlers.get('session/event')(session, { type: 'turn/end', time: 20_000, data: { turn: 2, reason: { kind: 'completed' } } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received.length, before);
    console.log('  ok  /service_push off → 不再推送');
  }

  /* ── fork 继承：复制来的 command/run 直接生效 ── */
  {
    const forked = makeSession('session-22222222', {
      title: 'fork 出来的会话',
      events: [
        ...turnEvents(1),
        { type: 'command/run', time: 11_000, data: { name: 'service_push', args: 'on' } },
      ],
    });
    const response = await callRoute('GET', '/api/push-notify/session?sessionId=session-22222222');
    assert.equal(response.body.enabled, true);
    assert.equal(response.body.source, 'command');
    // 关闭默认值也应保持显式 on
    await callRoute('POST', '/api/push-notify/config', { defaultEnabled: false });
    const afterDefaultOff = await callRoute('GET', '/api/push-notify/session?sessionId=session-22222222');
    assert.equal(afterDefaultOff.body.enabled, true);
    assert.equal(afterDefaultOff.body.source, 'command');
    assert.ok(forked.events.length > 0);
    console.log('  ok  fork 继承（command/run 事件前缀）');
  }

  /* ── 失败通道：ServerChan 收到 40001 → last 记录失败 ── */
  {
    await callRoute('POST', '/api/push-notify/channels', {
      type: 'serverchan',
      name: '坏 key',
      fields: { sendKey: `${echoBase}/fail` },
    });
    const session3 = makeSession('session-33333333', {
      title: '失败路径',
      events: [
        ...turnEvents(1),
        { type: 'command/run', time: 11_000, data: { name: 'service_push', args: 'on' } },
      ],
    });
    const before = received.length;
    handlers.get('session/event')(session3, session3.events.find((event) => event.type === 'turn/end'));
    await waitFor(() => received.length > before, '失败通道请求');
    await waitFor(async () => {
      const response = await callRoute('GET', '/api/push-notify/config');
      return response.body.last.some((row) => row.ok === false && /bad key/u.test(String(row.error)));
    }, 'last 记录失败');
    console.log('  ok  失败通道 → last 记录错误，不影响其它通道');
  }

  /* ── 通道测试接口 ── */
  {
    const response = await callRoute('GET', '/api/push-notify/config');
    const testChannel = response.body.channels.find((channel) => channel.name === '回显2');
    const tested = await callRoute('POST', '/api/push-notify/channels/test', { id: testChannel.id });
    assert.equal(tested.statusCode, 200);
    assert.equal(tested.body.result.ok, true);
    assert.match(JSON.parse(received[received.length - 1].body).title, /DSH 推送测试/u);
    console.log('  ok  POST /channels/test');
  }

  /* ── 删除通道 ── */
  {
    const response = await callRoute('GET', '/api/push-notify/config');
    const target = response.body.channels[0];
    const deleted = await callRoute('POST', '/api/push-notify/channels/delete', { id: target.id });
    assert.equal(deleted.body.channels.length, response.body.channels.length - 1);
    console.log('  ok  POST /channels/delete');
  }

  console.log('\nHost 集成测试全部通过。');
})().finally(async () => {
  echoServer.close();
  rmSync(home, { recursive: true, force: true });
});
