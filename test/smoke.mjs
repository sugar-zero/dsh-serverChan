/**
 * test/smoke.mjs —— 不依赖 DSH 进程的本地冒烟测试
 * 覆盖：通道端点识别 / 字段校验与掩码 / 消息拼装 / 会话状态折叠 / 多通道发送（本地 HTTP 回显）
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  CHANNEL_TYPES,
  maskChannel,
  normalizeChannelFields,
  sendToChannel,
  typeDescriptor,
} from '../lib/channels.mjs';
import { buildPushMessage, collectTurnContext, formatDuration, statusOf } from '../lib/message.mjs';
import {
  commandStateFromEvents,
  parsePushArg,
  resolvePushState,
  shouldNotify,
} from '../lib/state.mjs';
import { __test } from '../lib/channels.mjs';

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL  ${name}`);
      throw error;
    });
}

/* ────────────────────────── 静态逻辑 ────────────────────────── */

await check('ServerChan endpoint 识别：Turbo', () => {
  assert.equal(__test.serverChanEndpoint('SCTabc123'), 'https://sctapi.ftqq.com/SCTabc123.send');
});
await check('ServerChan endpoint 识别：Server酱³', () => {
  assert.equal(__test.serverChanEndpoint('sctp1234tabc'), 'https://1234.push.ft07.com/send/sctp1234tabc.send');
});
await check('ServerChan endpoint 识别：完整 URL', () => {
  assert.equal(__test.serverChanEndpoint('https://example.com/send/abc.send'), 'https://example.com/send/abc.send');
});
await check('通道描述表完整（每个类型都有 send 分支）', () => {
  for (const descriptor of CHANNEL_TYPES) {
    assert.ok(typeDescriptor(descriptor.type), descriptor.type);
  }
  assert.equal(CHANNEL_TYPES.length >= 7, true);
});
await check('字段校验：必填 / 可选 / 未知类型', () => {
  assert.equal(normalizeChannelFields('wecom', {}, { create: true }).ok, false);
  assert.equal(normalizeChannelFields('nope', { a: 'b' }, { create: true }).ok, false);
  const wecom = normalizeChannelFields('wecom', { webhookUrl: '  https://qyapi.weixin.qq.com/x  ' }, { create: true });
  assert.deepEqual(wecom, { ok: true, fields: { webhookUrl: 'https://qyapi.weixin.qq.com/x' } });
  const feishu = normalizeChannelFields('feishu', { webhookUrl: 'https://open.feishu.cn/x' }, { create: false });
  assert.deepEqual(feishu, { ok: true, fields: { webhookUrl: 'https://open.feishu.cn/x' } });
});
await check('掩码只暴露首尾 4 位', () => {
  const masked = maskChannel({
    id: 'ch_1',
    type: 'serverchan',
    name: '我的微信',
    enabled: true,
    config: { sendKey: 'SCTabcdefghijkl' },
  });
  assert.equal(masked.fields.sendKey, 'SCTa••••ijkl');
  assert.equal(masked.typeLabel, 'Server酱');
  assert.equal(masked.name, '我的微信');
});

/* ────────────────────────── 消息拼装 ────────────────────────── */

function fakeSession(id, events) {
  return {
    id,
    header: { cwd: '/Users/demo/my-workspace', origin: undefined },
    snapshotEvents: () => events,
  };
}

const turnEvents = [
  { type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: '帮我看一下这个项目' }] } },
  { type: 'turn/start', time: 2000, data: { turn: 1 } },
  {
    type: 'assistant/message',
    time: 9000,
    data: {
      message: {
        content: [{ type: 'text', text: '这是最后一条回复。' }, { type: 'reasoning', text: '思考过程' }],
        source: { kind: 'model', model: 'deepseek-chat' },
      },
    },
  },
  { type: 'turn/end', time: 10000, data: { turn: 1, reason: { kind: 'completed' } } },
];

await check('collectTurnContext 提取首条提问 / 回复 / 耗时', () => {
  const context = collectTurnContext(fakeSession('session-abcdef123', turnEvents), turnEvents[3]);
  assert.equal(context.firstUserText, '帮我看一下这个项目');
  assert.equal(context.replyText, '这是最后一条回复。');
  assert.equal(context.model, 'deepseek-chat');
  assert.equal(context.turnStartedAt, 2000);
  assert.equal(context.finishedAt, 10000);
});
await check('buildPushMessage 生成标题 / markdown / 纯文本', () => {
  const config = { includeExcerpt: true, excerptChars: 600 };
  const context = collectTurnContext(fakeSession('session-abcdef123', turnEvents), turnEvents[3]);
  const message = buildPushMessage({
    session: fakeSession('session-abcdef123', turnEvents),
    context,
    status: statusOf({ kind: 'completed' }),
    config,
    titleText: '项目检查',
  });
  assert.match(message.title, /✅ 项目检查 · 完成/u);
  assert.match(message.markdown, /\*\*✅ 完成\*\*：项目检查/u);
  assert.match(message.markdown, /用时：8 秒/u);
  assert.match(message.markdown, /工作区：my-workspace/u);
  assert.match(message.markdown, /这是最后一条回复/u);
  assert.match(message.text, /✅ 完成：项目检查/u);
  assert.equal(message.meta.session.status, 'completed');
});
await check('摘要可关闭 / 超长可截断', () => {
  const context = { firstUserText: 'hi', replyText: 'x'.repeat(1000), turnStartedAt: undefined, finishedAt: undefined };
  const off = buildPushMessage({ session: fakeSession('s1', []), context, status: statusOf({ kind: 'completed' }), config: { includeExcerpt: false } });
  assert.doesNotMatch(off.markdown, /xxxx/u);
  const clipped = buildPushMessage({ session: fakeSession('s1', []), context, status: statusOf({ kind: 'completed' }), config: { includeExcerpt: true, excerptChars: 50 } });
  assert.ok(Array.from(clipped.markdown).length < 400);
  assert.match(clipped.markdown, /…/u);
});
await check('摘要字数填 0 时不附带摘要（不留孤立的省略号）', () => {
  const context = { firstUserText: 'hi', replyText: '这是最后回复的内容。', turnStartedAt: undefined, finishedAt: undefined };
  const message = buildPushMessage({
    session: fakeSession('s1', []),
    context,
    status: statusOf({ kind: 'completed' }),
    config: { includeExcerpt: true, excerptChars: 0 },
  });
  assert.doesNotMatch(message.markdown, /…/u);
  assert.doesNotMatch(message.text, /这是最后回复/u);
  assert.equal(message.meta.session.status, 'completed');
});
await check('摘要模式「自定义」按字数截，「通道上限」不截（交给适配器）', () => {
  const long = '长'.repeat(200);
  const context = { firstUserText: 'hi', replyText: long, turnStartedAt: undefined, finishedAt: undefined };
  const base = { session: fakeSession('s1', []), context, status: statusOf({ kind: 'completed' }) };
  const custom = buildPushMessage({ ...base, config: { includeExcerpt: true, excerptMode: 'custom', excerptChars: 10 } });
  assert.match(custom.markdown, /…/u);
  assert.ok(!custom.markdown.includes(long));
  const channel = buildPushMessage({ ...base, config: { includeExcerpt: true, excerptMode: 'channel', excerptChars: 10 } });
  assert.ok(channel.markdown.includes(long));
  assert.doesNotMatch(channel.markdown, /…/u);
});
await check('formatDuration 覆盖秒 / 分 / 小时', () => {
  assert.equal(formatDuration(200), '不到 1 秒');
  assert.equal(formatDuration(8300), '8 秒');
  assert.equal(formatDuration(90_000), '1 分 30 秒');
  assert.equal(formatDuration(3_720_000), '1 小时 2 分');
  assert.equal(formatDuration(-1), undefined);
});
await check('statusOf 覆盖完成 / 错误 / 中止 / 分叉', () => {
  assert.equal(statusOf({ kind: 'completed' }).kind, 'completed');
  assert.equal(statusOf({ kind: 'error' }).kind, 'failure');
  assert.equal(statusOf({ kind: 'aborted' }).kind, 'aborted');
  assert.equal(statusOf({ kind: 'forked' }).kind, 'forked');
});

/* ────────────────────────── 会话状态 ────────────────────────── */

await check('parsePushArg', () => {
  assert.equal(parsePushArg(''), 'status');
  assert.equal(parsePushArg(' status '), 'status');
  assert.equal(parsePushArg('ON'), 'on');
  assert.equal(parsePushArg('off'), 'off');
  assert.equal(parsePushArg('maybe'), 'invalid');
});
await check('commandStateFromEvents：只看 /service_push，且以最后一次 on/off 为准', () => {
  const events = [
    { type: 'command/run', data: { name: 'service_push', args: 'on' } },
    { type: 'command/run', data: { name: 'push', args: 'off' } },
    { type: 'command/run', data: { name: 'service_push', args: 'status' } },
  ];
  assert.equal(commandStateFromEvents(events), true);
  events.push({ type: 'command/run', data: { name: 'service_push', args: 'off' } });
  assert.equal(commandStateFromEvents(events), false);
  assert.equal(commandStateFromEvents([]), undefined);
  // 通用 /push 关键词不再被占用：别的 /push 命令不参与状态折叠
  assert.equal(commandStateFromEvents([
    { type: 'command/run', data: { name: 'push', args: 'on' } },
  ]), undefined);
});
await check('resolvePushState：显式命令优先，否则回落默认', () => {
  const session = fakeSession('s-fork', [
    ...turnEvents,
    { type: 'command/run', time: 11_000, data: { name: 'service_push', args: 'on' } },
  ]);
  const cache = new Map();
  const explicit = resolvePushState(session, { defaultEnabled: false }, cache);
  assert.deepEqual(explicit, { enabled: true, source: 'command', overridden: true });
  assert.equal(cache.get('s-fork'), true);
  const fresh = fakeSession('s-fresh', [...turnEvents]);
  assert.deepEqual(resolvePushState(fresh, { defaultEnabled: false }, new Map()), { enabled: false, source: 'default', overridden: false });
  assert.deepEqual(resolvePushState(fresh, { defaultEnabled: true }, new Map()), { enabled: true, source: 'default', overridden: false });
  assert.deepEqual(resolvePushState(undefined, { defaultEnabled: true }, new Map()), { enabled: true, source: 'default', overridden: false });
});
await check('shouldNotify：完成/失败开关 + 分叉永不推送', () => {
  assert.equal(shouldNotify(statusOf({ kind: 'completed' }), { notifyOnCompleted: true, notifyOnFailure: false }), true);
  assert.equal(shouldNotify(statusOf({ kind: 'completed' }), { notifyOnCompleted: false }), false);
  assert.equal(shouldNotify(statusOf({ kind: 'error' }), { notifyOnFailure: true }), true);
  assert.equal(shouldNotify(statusOf({ kind: 'error' }), { notifyOnFailure: false }), false);
  assert.equal(shouldNotify(statusOf({ kind: 'forked' }), { notifyOnCompleted: true, notifyOnFailure: true }), false);
});

/* ────────────────────────── 多通道发送（本地回显服务） ────────────────────────── */

const received = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({ method: request.method, url: request.url, headers: request.headers, body });
    let payload = { code: 0 };
    if (request.url.includes('fail')) payload = { code: 40001, message: 'bad key' };
    if (request.url.includes('wecom')) payload = { errcode: 0, errmsg: 'ok' };
    if (request.url.includes('dingtalk')) payload = { errcode: 0, errmsg: 'ok' };
    if (request.url.includes('feishu')) payload = { code: 0, msg: 'success' };
    if (request.url.includes('bark')) payload = { code: 200, message: 'ok' };
    if (request.url.includes('telegram')) payload = { ok: true };
    response.writeHead(request.url.includes('http-fail') ? 500 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${String(port)}`;

const testMessage = {
  title: '✅ 测试标题',
  markdown: '**✅ 完成**：测试\n\n- 用时：1 秒',
  text: '✅ 完成：测试\n\n用时：1 秒',
  meta: { session: { id: 'session-x', title: '测试' } },
};

await check('通用 Webhook：POST JSON 字段齐全 + 自定义 header', async () => {
  received.length = 0;
  const result = await sendToChannel({
    type: 'webhook',
    config: { url: `${base}/hook`, headers: '{"X-Token":"t-1"}' },
  }, testMessage);
  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  const record = received[0];
  assert.equal(record.method, 'POST');
  assert.equal(record.headers['x-token'], 't-1');
  const payload = JSON.parse(record.body);
  assert.equal(payload.source, 'dsh-serverChan');
  assert.equal(payload.title, testMessage.title);
  assert.equal(payload.session.id, 'session-x');
});
await check('企业微信：markdown payload', async () => {
  received.length = 0;
  const result = await sendToChannel({ type: 'wecom', config: { webhookUrl: `${base}/wecom` } }, testMessage);
  assert.equal(result.ok, true);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.msgtype, 'markdown');
  assert.match(payload.markdown.content, /完成/u);
});
await check('钉钉：带加签的 URL + markdown payload', async () => {
  received.length = 0;
  const result = await sendToChannel({
    type: 'dingtalk',
    config: { webhookUrl: `${base}/dingtalk?access_token=x`, secret: 'SECabc' },
  }, testMessage);
  assert.equal(result.ok, true);
  assert.match(received[0].url, /timestamp=\d+/u);
  assert.match(received[0].url, /sign=/u);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.msgtype, 'markdown');
});
await check('飞书：post payload + 签名字段', async () => {
  received.length = 0;
  const result = await sendToChannel({
    type: 'feishu',
    config: { webhookUrl: `${base}/feishu`, secret: 'SECxyz' },
  }, testMessage);
  assert.equal(result.ok, true);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.msg_type, 'post');
  assert.ok(Array.isArray(payload.content.post.zh_cn.content));
  assert.equal(typeof payload.timestamp, 'string');
  assert.equal(typeof payload.sign, 'string');
});
await check('Bark / Telegram：成功响应', async () => {
  received.length = 0;
  const bark = await sendToChannel({ type: 'bark', config: { url: `${base}/bark/key` } }, testMessage);
  assert.equal(bark.ok, true);
  const telegram = await sendToChannel({ type: 'telegram', config: { botToken: '123:abc', chatId: '42' } }, testMessage);
  assert.equal(telegram.ok, false); // telegram 走真实域名，本地服务接不到
  assert.ok(String(telegram.error).length > 0);
});
await check('ServerChan：自定义完整 URL 走 form，成功与失败都能识别', async () => {
  received.length = 0;
  const ok = await sendToChannel({ type: 'serverchan', config: { sendKey: `${base}/send` } }, testMessage);
  assert.equal(ok.ok, true);
  assert.equal(received[0].method, 'POST');
  assert.match(received[0].headers['content-type'], /application\/x-www-form-urlencoded/u);
  const form = new URLSearchParams(received[0].body);
  assert.equal(form.get('title'), testMessage.title);
  assert.match(form.get('desp'), /完成/u);

  const failure = await sendToChannel({ type: 'serverchan', config: { sendKey: `${base}/fail` } }, testMessage);
  assert.equal(failure.ok, false);
  assert.match(String(failure.error), /bad key/u);
});
await check('HTTP 500 归类为失败并可读', async () => {
  const result = await sendToChannel({ type: 'webhook', config: { url: `${base}/http-fail` } }, testMessage);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /HTTP 500/u);
});

server.close();

console.log(`\n${String(passed)} checks passed.`);
