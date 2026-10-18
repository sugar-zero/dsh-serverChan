/**
 * lib/message.mjs —— 从会话日志里取本轮信息，拼出推送标题/正文
 * ============================================================================
 * 只读取 session 的公开面：session.header / session.snapshotEvents()。
 * 这一层保持纯函数，方便 test/smoke.mjs 直接单测。
 * ============================================================================
 */
import { basename } from 'node:path';

/** turn/end 的 reason.kind → 推送里的状态描述。 */
export function statusOf(reason) {
  switch (reason?.kind) {
    case 'completed':
      return { kind: 'completed', label: '完成', emoji: '✅' };
    case 'error':
      return { kind: 'failure', label: '出错', emoji: '❌' };
    case 'max-tokens':
      return { kind: 'failure', label: '超出长度', emoji: '❌' };
    case 'blocked':
      return { kind: 'failure', label: '被阻止', emoji: '⛔' };
    case 'aborted':
      return { kind: 'aborted', label: '已中止', emoji: '⚠️' };
    case 'interrupted':
      return { kind: 'aborted', label: '已中断', emoji: '⚠️' };
    case 'forked':
      return { kind: 'forked', label: '已分叉', emoji: '⑂' };
    default:
      return { kind: 'completed', label: '完成', emoji: '✅' };
  }
}

/** 把一个消息的 content blocks 里的文本抽出来。 */
export function textOfContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const parts = [];
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * 收集本轮上下文（标题兜底、回复、耗时、模型）。
 * @param {object} session Session 实例（有 header / snapshotEvents）
 * @param {{ data?: { turn?: number, reason?: object }, time?: number }} turnEndEvent turn/end 事件
 */
export function collectTurnContext(session, turnEndEvent) {
  const turn = turnEndEvent?.data?.turn;
  let events = [];
  try {
    events = session.snapshotEvents();
  } catch {
    events = [];
  }
  let turnStartedAt;
  let firstUserText = '';
  for (const event of events) {
    if (firstUserText === '' && event.type === 'user/message') {
      firstUserText = textOfContent(event.data?.content);
    }
    if (event.type === 'turn/start' && event.data?.turn === turn) {
      // 取本轮 start，前面已经记过标题兜底，继续找即可
      turnStartedAt = event.time;
    }
  }
  let replyText = '';
  let model;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'turn/start' && event.data?.turn === turn) break;
    if (event.type === 'assistant/message') {
      replyText = textOfContent(event.data?.message?.content);
      model = event.data?.message?.source?.model;
      break;
    }
  }
  return {
    turn,
    turnStartedAt,
    finishedAt: typeof turnEndEvent?.time === 'number' ? turnEndEvent.time : undefined,
    firstUserText,
    replyText,
    model,
  };
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 1) return '不到 1 秒';
  if (seconds < 60) return `${String(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds === 0 ? `${String(minutes)} 分钟` : `${String(minutes)} 分 ${String(restSeconds)} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)} 小时 ${String(minutes % 60)} 分`;
}

export function truncateChars(value, max) {
  const text = String(value ?? '');
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function cleanLine(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * 拼出推送内容。
 * @param {object} input
 * @param {object} input.session Session 实例
 * @param {object} input.context collectTurnContext() 的结果
 * @param {{ emoji: string, label: string, kind: string }} input.status statusOf() 的结果
 * @param {object} input.config 归一化后的插件配置
 * @param {string} [input.titleText] 会话标题（读不到时用首条提问兜底）
 */
export function buildPushMessage({ session, context, status, config, titleText }) {
  const sessionId = String(session?.id ?? '');
  const fallbackTitle = cleanLine(context?.firstUserText) || `会话 ${sessionId.slice(-8)}`;
  const titleTextValue = cleanLine(titleText) || fallbackTitle;
  const sessionTitle = truncateChars(titleTextValue, 48);
  const workspacePath = session?.header?.cwd;
  const workspace = workspacePath ? basename(workspacePath) : undefined;
  const durationMs = context?.turnStartedAt !== undefined && context?.finishedAt !== undefined
    ? context.finishedAt - context.turnStartedAt
    : undefined;
  const duration = formatDuration(durationMs);

  const details = [];
  if (duration !== undefined) details.push(`用时：${duration}`);
  if (workspace !== undefined && workspace !== '') details.push(`工作区：${workspace}`);
  if (context?.model) details.push(`模型：${context.model}`);
  if (sessionId !== '') details.push(`会话：${sessionId.slice(-8)}`);

  const excerptLimit = Number.isFinite(config?.excerptChars) ? Math.max(0, config.excerptChars) : 600;
  const excerpt = config?.includeExcerpt === false
    ? ''
    : truncateChars(String(context?.replyText ?? '').trim(), excerptLimit);

  const header = `${status.emoji} ${status.label}`;
  const title = truncateChars(`${status.emoji} ${sessionTitle} · ${status.label}`, 64);
  const markdownParts = [`**${header}**：${sessionTitle}`];
  if (details.length > 0) markdownParts.push(details.map((line) => `- ${line}`).join('\n'));
  if (excerpt !== '') markdownParts.push(`---\n\n${excerpt}`);
  const textParts = [`${header}：${sessionTitle}`, details.join('\n')];
  if (excerpt !== '') textParts.push(excerpt);

  return {
    title,
    markdown: markdownParts.join('\n\n'),
    text: textParts.filter((part) => part !== '').join('\n\n'),
    meta: {
      session: {
        id: sessionId,
        title: sessionTitle,
        status: status.kind,
        statusLabel: status.label,
        workspace: workspacePath,
        model: context?.model,
        durationMs,
      },
    },
  };
}
