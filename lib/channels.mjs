/**
 * lib/channels.mjs —— 推送通道适配层
 * ============================================================================
 * 一个通道 = { id, type, name, enabled, config: { ...字段 } }。
 * 每个 type 只做两件事：描述自己的字段（设置页据此动态渲染表单）、把一条消息发出去。
 * 新增通道时只需在 CHANNEL_TYPES 里加一项 + 在 senders 里加一个发送函数。
 * ============================================================================
 */
import { createHmac } from 'node:crypto';

/* ────────────────────────── 通道描述 ────────────────────────── */

export const CHANNEL_TYPES = [
  {
    type: 'serverchan',
    label: 'Server酱',
    hint: 'Turbo（SCT 开头）或 Server酱³（sctp 开头）的 SendKey；也可以直接粘贴完整 API URL。免费版每天约 5 条，长任务再开更划算。',
    fields: [
      {
        key: 'sendKey',
        label: 'SendKey / API URL',
        secret: true,
        placeholder: 'SCTxxxxxx 或 sctp123txxxxxx 或 https://…',
      },
    ],
  },
  {
    type: 'feishu',
    label: '飞书群机器人',
    hint: '群设置 → 群机器人 → 自定义机器人，复制 Webhook 地址；开启「签名校验」时把密钥填到可选字段。',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook 地址',
        secret: true,
        placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
      },
      { key: 'secret', label: '签名密钥（可选）', secret: true, optional: true },
    ],
  },
  {
    type: 'wecom',
    label: '企业微信群机器人',
    hint: '群设置 → 群机器人 → 添加机器人，复制 Webhook 地址（key 在查询参数里）。',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook 地址',
        secret: true,
        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
      },
    ],
  },
  {
    type: 'dingtalk',
    label: '钉钉群机器人',
    hint: '群设置 → 智能群助手 → 添加机器人 → 自定义，复制 Webhook 地址；开启「加签」时把密钥填到可选字段。',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook 地址',
        secret: true,
        placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…',
      },
      { key: 'secret', label: '加签密钥（可选）', secret: true, optional: true },
    ],
  },
  {
    type: 'telegram',
    label: 'Telegram',
    hint: '用 @BotFather 创建 Bot 拿 Token；chat_id 可填自己的用户 id（可先给 bot 发一句话再从 getUpdates 里看）或群组 id（负数）。',
    fields: [
      { key: 'botToken', label: 'Bot Token', secret: true, placeholder: '123456789:AA…' },
      { key: 'chatId', label: 'Chat ID', placeholder: '例如 123456789 或 -100…' },
    ],
  },
  {
    type: 'bark',
    label: 'Bark（iOS）',
    hint: '填 Bark App 里的设备地址（含 device key），例如 https://api.day.app/xxxxxxxx。',
    fields: [
      {
        key: 'url',
        label: '设备 URL',
        secret: true,
        placeholder: 'https://api.day.app/xxxxxxxx',
      },
    ],
  },
  {
    type: 'webhook',
    label: '自定义 Webhook',
    hint: '收到 POST JSON：{ source, title, text, markdown, session, time }。可附加 headers（JSON 对象，适合放鉴权头）。',
    fields: [
      { key: 'url', label: 'URL', secret: true, placeholder: 'https://example.com/hook' },
      { key: 'headers', label: '附加 Header（JSON，可选）', optional: true, placeholder: '{"X-Token":"…"}' },
    ],
  },
];

/** 取通道类型描述（未知类型返回 undefined）。 */
export function typeDescriptor(type) {
  return CHANNEL_TYPES.find((entry) => entry.type === type);
}

export function typeLabel(type) {
  return typeDescriptor(type)?.label ?? String(type ?? '');
}

/* ────────────────────────── 掩码 / 校验 ────────────────────────── */

/** 把密钥类字段掩码成「前 4 + **** + 后 4」，只用于展示。 */
export function maskValue(value) {
  const text = String(value ?? '');
  if (text === '') return '';
  if (text.length <= 8) return '••••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

/** 设置页展示用的通道视图：secret 字段掩码，普通字段原样。 */
export function maskChannel(channel) {
  const descriptor = typeDescriptor(channel.type);
  const fields = {};
  for (const field of descriptor?.fields ?? []) {
    const value = channel.config?.[field.key];
    fields[field.key] = field.secret ? maskValue(value) : (value ?? '');
  }
  return {
    id: channel.id,
    type: channel.type,
    typeLabel: typeLabel(channel.type),
    name: channel.name ?? '',
    enabled: channel.enabled !== false,
    fields,
  };
}

/**
 * 校验 / 规整一个通道的字段。
 * @param {string} type 通道类型
 * @param {Record<string, unknown>} fields 用户输入
 * @param {{ create?: boolean }} options create 时必填字段必须给值；update 时空字符串表示保持原值
 * @returns {{ ok: true, fields: Record<string,string> } | { ok: false, error: string }}
 */
export function normalizeChannelFields(type, fields, options = {}) {
  const descriptor = typeDescriptor(type);
  if (!descriptor) return { ok: false, error: `未知通道类型：${String(type)}` };
  const input = fields && typeof fields === 'object' ? fields : {};
  const output = {};
  for (const field of descriptor.fields) {
    const raw = input[field.key];
    const value = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw).trim();
    if (value === '') {
      if (field.optional) continue;
      if (!options.create) continue; // update：留空 = 保持原值
      return { ok: false, error: `请填写「${field.label}」` };
    }
    output[field.key] = value;
  }
  if (type === 'webhook' && typeof output.headers === 'string' && output.headers !== '') {
    try {
      const parsed = JSON.parse(output.headers);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: '附加 Header 必须是一个 JSON 对象' };
      }
    } catch {
      return { ok: false, error: '附加 Header 不是合法 JSON' };
    }
  }
  return { ok: true, fields: output };
}

/* ────────────────────────── 发送 ────────────────────────── */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 发送一条推送。
 * @param {{ id?: string, type: string, name?: string, config: Record<string,string> }} channel
 * @param {{ title: string, markdown: string, text: string, meta?: object }} message
 * @param {{ fetch?: Function, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: boolean, error?: string, detail?: string }>}
 */
export async function sendToChannel(channel, message, options = {}) {
  const descriptor = typeDescriptor(channel?.type);
  if (!descriptor) return { ok: false, error: `未知通道类型：${String(channel?.type)}` };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前 Host 没有可用的 fetch' };
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await senders[channel.type](channel.config ?? {}, message, fetchImpl, signal);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/* ────────────────────────── 内部工具 ────────────────────────── */

function errorText(error) {
  if (error === undefined || error === null) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error.name === 'TimeoutError') return '请求超时';
  if (typeof error === 'object' && error.name === 'AbortError') return '请求被取消';
  const code = error?.cause?.code ?? error?.code;
  const message = error?.message ?? String(error);
  return code ? `${code}: ${message}` : message;
}

function truncateChars(value, max) {
  const text = String(value ?? '');
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function truncateBytes(value, maxBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return `${text.slice(0, end)}…`;
}

function plainLines(message) {
  const lines = String(message?.text ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [String(message?.title ?? 'DSH')];
}

async function readResponse(response) {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status: response.status, ok: response.ok, body, json };
}

/** 统一收尾：HTTP 失败或业务 code 失败都转成可读错误。 */
function settle(parsed, label, failureOf) {
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${label} HTTP ${String(parsed.status)}${parsed.body ? `：${truncateChars(parsed.body, 200)}` : ''}`,
    };
  }
  const failure = failureOf?.(parsed.json, parsed);
  if (failure) return { ok: false, error: `${label}：${failure}`, detail: truncateChars(parsed.body, 300) };
  return { ok: true, detail: truncateChars(parsed.body, 300) };
}

async function postJson(fetchImpl, url, body, signal, headers = {}) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
}

function serverChanEndpoint(sendKey) {
  const value = String(sendKey ?? '').trim();
  if (/^https?:\/\//iu.test(value)) return value;
  const uid = /^sctp(\d+)t/iu.exec(value)?.[1];
  if (uid !== undefined) {
    return `https://${uid}.push.ft07.com/send/${encodeURIComponent(value)}.send`;
  }
  return `https://sctapi.ftqq.com/${encodeURIComponent(value)}.send`;
}

const senders = {
  async serverchan(config, message, fetchImpl, signal) {
    const url = serverChanEndpoint(config.sendKey);
    const body = new URLSearchParams({
      title: truncateChars(message.title, 32),
      desp: truncateBytes(message.markdown, 30_000),
    });
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
    const parsed = await readResponse(response);
    return settle(parsed, 'Server酱', (json) => {
      if (json === undefined) return undefined;
      if (typeof json.code === 'number' && json.code !== 0) {
        return String(json.message ?? json.info ?? `code ${String(json.code)}`);
      }
      if (typeof json.errno === 'number' && json.errno !== 0) {
        return String(json.errmsg ?? `errno ${String(json.errno)}`);
      }
      return undefined;
    });
  },

  async feishu(config, message, fetchImpl, signal) {
    const body = {
      msg_type: 'post',
      content: {
        post: {
          zh_cn: {
            title: truncateChars(message.title, 80),
            content: plainLines(message).slice(0, 40).map((line) => [{ tag: 'text', text: line }]),
          },
        },
      },
    };
    const secret = String(config.secret ?? '').trim();
    if (secret !== '') {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
      body.timestamp = timestamp;
      body.sign = sign;
    }
    const response = await postJson(fetchImpl, config.webhookUrl, body, signal);
    const parsed = await readResponse(response);
    return settle(parsed, '飞书', (json) => {
      if (json === undefined) return undefined;
      const code = json.code ?? json.StatusCode;
      if (typeof code === 'number' && code !== 0) return String(json.msg ?? json.StatusMessage ?? `code ${String(code)}`);
      return undefined;
    });
  },

  async wecom(config, message, fetchImpl, signal) {
    const response = await postJson(fetchImpl, config.webhookUrl, {
      msgtype: 'markdown',
      markdown: { content: truncateBytes(message.markdown, 4000) },
    }, signal);
    const parsed = await readResponse(response);
    return settle(parsed, '企业微信', (json) => {
      if (json === undefined) return undefined;
      if (typeof json.errcode === 'number' && json.errcode !== 0) {
        return String(json.errmsg ?? `errcode ${String(json.errcode)}`);
      }
      return undefined;
    });
  },

  async dingtalk(config, message, fetchImpl, signal) {
    let url = String(config.webhookUrl ?? '').trim();
    const secret = String(config.secret ?? '').trim();
    if (secret !== '') {
      const timestamp = String(Date.now());
      const sign = encodeURIComponent(
        createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'),
      );
      const parsedUrl = new URL(url);
      parsedUrl.searchParams.set('timestamp', timestamp);
      parsedUrl.searchParams.set('sign', sign);
      url = parsedUrl.href;
    }
    const response = await postJson(fetchImpl, url, {
      msgtype: 'markdown',
      markdown: {
        title: truncateChars(message.title, 64),
        text: truncateBytes(message.markdown, 18_000),
      },
    }, signal);
    const parsed = await readResponse(response);
    return settle(parsed, '钉钉', (json) => {
      if (json === undefined) return undefined;
      if (typeof json.errcode === 'number' && json.errcode !== 0) {
        return String(json.errmsg ?? `errcode ${String(json.errcode)}`);
      }
      return undefined;
    });
  },

  async telegram(config, message, fetchImpl, signal) {
    const token = String(config.botToken ?? '').trim();
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await postJson(fetchImpl, url, {
      chat_id: String(config.chatId ?? '').trim(),
      text: truncateChars(`${message.title}\n\n${message.text}`, 4000),
      disable_web_page_preview: true,
    }, signal);
    const parsed = await readResponse(response);
    return settle(parsed, 'Telegram', (json) => {
      if (json !== undefined && json.ok === false) return String(json.description ?? '发送失败');
      return undefined;
    });
  },

  async bark(config, message, fetchImpl, signal) {
    const base = String(config.url ?? '').trim().replace(/\/+$/u, '');
    const url = `${base}/${encodeURIComponent(truncateChars(message.title, 40))}/${encodeURIComponent(truncateChars(message.text, 1200))}?group=DSH`;
    const response = await fetchImpl(url, { method: 'GET', signal });
    const parsed = await readResponse(response);
    return settle(parsed, 'Bark', (json) => {
      if (json === undefined) return undefined;
      if (typeof json.code === 'number' && json.code !== 200) {
        return String(json.message ?? `code ${String(json.code)}`);
      }
      return undefined;
    });
  },

  async webhook(config, message, fetchImpl, signal) {
    const headers = { 'content-type': 'application/json' };
    const extra = String(config.headers ?? '').trim();
    if (extra !== '') {
      try {
        for (const [key, value] of Object.entries(JSON.parse(extra))) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            headers[key] = String(value);
          }
        }
      } catch {
        // 校验阶段已经拦截；这里静默忽略坏 header
      }
    }
    const response = await postJson(fetchImpl, config.url, {
      source: 'dsh-push-notify',
      title: message.title,
      text: message.text,
      markdown: message.markdown,
      session: message.meta?.session,
      time: Date.now(),
    }, signal, headers);
    const parsed = await readResponse(response);
    return settle(parsed, 'Webhook', () => undefined);
  },
};

export const __test = { serverChanEndpoint, truncateChars, truncateBytes, plainLines };
