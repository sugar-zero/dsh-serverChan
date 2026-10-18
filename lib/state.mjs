/**
 * lib/state.mjs —— 会话级推送状态（从会话日志推导，fork 自动继承）
 * ============================================================================
 * 约定：状态不另存文件，而是由 `/service_push on|off` 命令在会话日志里留下的
 * `command/run` 事件决定（框架自动记录 name/args）。这样：
 *   · fork 复制事件前缀 ⇒ 新会话自动继承推送状态；
 *   · 状态可以重新从日志折叠出来，跨重启不丢；
 *   · UI 的开关和手敲 `/service_push on` 走同一条写路径。
 * 没写过 /service_push 的会话回落到设置里的「新会话默认」。
 * ============================================================================
 */

export const PUSH_COMMAND_NAME = 'service_push';

/** 把 `/service_push` 的原始参数规整成 'on' | 'off' | 'status' | 'invalid'。 */
export function parsePushArg(rawInput) {
  const value = String(rawInput ?? '').trim().toLowerCase();
  if (value === '' || value === 'status') return 'status';
  if (value === 'on' || value === '1' || value === 'true') return 'on';
  if (value === 'off' || value === '0' || value === 'false') return 'off';
  return 'invalid';
}

/**
 * 从事件数组里从后往前找最近一次 /service_push on|off。
 * @param {readonly object[]} events SessionEvent 数组（顺序）
 * @returns {boolean | undefined} 找到显式开关返回布尔；没有则 undefined
 */
export function commandStateFromEvents(events) {
  const list = Array.isArray(events) ? events : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    if (event?.type !== 'command/run') continue;
    const data = event.data ?? {};
    if (data.name !== PUSH_COMMAND_NAME) continue;
    const arg = parsePushArg(data.args);
    if (arg === 'on') return true;
    if (arg === 'off') return false;
  }
  return undefined;
}

/** 从一个 Session 实例折叠显式状态。 */
export function commandStateOfSession(session) {
  try {
    return commandStateFromEvents(session.snapshotEvents());
  } catch {
    return undefined;
  }
}

/**
 * 计算某会话当前是否推送。
 * @param {object|null} session 活着的 Session；undefined 表示会话不在内存里
 * @param {object} config 归一化配置
 * @param {Map<string, boolean>} explicitCache 已从日志折叠出的显式状态缓存
 */
export function resolvePushState(session, config, explicitCache) {
  const defaultEnabled = config?.defaultEnabled === true;
  if (!session) return { enabled: defaultEnabled, source: 'default', overridden: false };
  const id = String(session.id ?? '');
  if (explicitCache?.has(id)) {
    return { enabled: explicitCache.get(id), source: 'command', overridden: true };
  }
  const explicit = commandStateOfSession(session);
  if (explicit !== undefined) {
    explicitCache?.set(id, explicit);
    return { enabled: explicit, source: 'command', overridden: true };
  }
  return { enabled: defaultEnabled, source: 'default', overridden: false };
}

/** 本轮是否落在配置的推送时机里。 */
export function shouldNotify(status, config) {
  if (!status || status.kind === 'forked') return false;
  if (status.kind === 'completed') return config?.notifyOnCompleted !== false;
  return config?.notifyOnFailure === true;
}
