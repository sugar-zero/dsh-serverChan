/**
 * dsh-serverChan —— Web Client 半
 * ============================================================================
 * 挂两个位置：
 *   1. conversation.input.left —— composer 工具行里「权限」控件右侧的会话推送开关；
 *   2. settings.section        —— 设置里的「消息推送」页（默认/时机/通道/最近推送）。
 * 与 Host 半通过同源 /api/push-notify/* 通信（GET 只返回掩码，不返回明文密钥）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-serverChan',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = 'push-notify';
    const API = '/api/push-notify';

    /* ────────────────────────── 文案 ────────────────────────── */

    const zh = {
      'page.nav': '消息推送',
      'page.title': '消息推送',
      'page.subtitle': '每轮任务完成后，把结果推到你的手机或群里。',
      'page.hint': 'Server酱 Turbo 免费版每天约 5 条；只在长任务时打开会话开关更划算。',
      'section.default': '默认与时机',
      'section.channels': '推送通道',
      'section.recent': '最近推送',
      'row.defaultEnabled': '新会话默认开启推送',
      'row.defaultEnabledNote': '没写过 /service_push 的新会话按这个默认值；已有会话可在对话里单独开关。',
      'row.notifyCompleted': '每轮正常完成时推送',
      'row.notifyFailure': '出错 / 中止时也推送',
      'row.notifySubagents': '子代理 / 团队会话也推送',
      'row.notifySubagentsNote': '默认只推顶层会话，避免一次任务被多个子代理刷屏。',
      'row.minTurn': '最短耗时（秒）',
      'row.minTurnNote': '耗时不足的轮次不推送；0 = 不限制。',
      'row.cooldown': '同会话冷却（秒）',
      'row.cooldownNote': '同一会话两次推送的最小间隔；0 = 不限制。',
      'row.includeExcerpt': '正文包含最后回复摘要',
      'row.excerptMode': '摘要长度',
      'row.excerptModeNote': '「通道上限」= 不自行截断，由每个通道按自己的能力截；「自定义」= 按下面的字数额。',
      'mode.custom': '自定义',
      'mode.channel': '通道上限',
      'row.excerptChars': '自定义字数上限',
      'row.excerptCharsNote': '0 = 不附带摘要（等同上面的开关关闭）',
      'btn.save': '保存',
      'btn.test': '测试',
      'btn.testing': '测试中…',
      'btn.edit': '编辑',
      'btn.delete': '删除',
      'btn.deleteConfirm': '确认删除？',
      'btn.cancel': '取消',
      'btn.addChannel': '添加通道',
      'channels.empty': '还没有通道。添加一个 Server酱 / 飞书 / 企业微信 / 钉钉 / Telegram / Bark / Webhook。',
      'channels.addTitle': '添加通道',
      'channels.editTitle': '编辑通道',
      'channels.type': '通道类型',
      'channels.name': '备注名（可选）',
      'channels.namePlaceholder': '例如：我的微信',
      'channels.keepSecret': '已设置，留空保持不变',
      'channels.saveChannel': '保存通道',
      'channels.disabled': '已停用',
      'channels.loading': '加载中…',
      'channels.loadFailed': '加载配置失败',
      'channels.retry': '重试',
      'channels.footer': '配置文件：',
      'recent.empty': '还没有推送记录。',
      'recent.ok': '成功',
      'recent.fail': '失败',
      'msg.saved': '已保存',
      'msg.saveFailed': '保存失败',
      'msg.channelSaved': '通道已保存',
      'msg.channelDeleted': '通道已删除',
      'msg.testOk': '测试推送已提交',
      'msg.testFail': '测试推送失败',
      'chip.label': '推送',
      'chip.titleOn': '完成后推送：开（点击关闭）',
      'chip.titleOff': '完成后推送：关（点击开启）',
      'chip.titleNoChannel': '已完成开启，但还没有启用通道；请到「设置 → 消息推送」添加',
      'chip.failed': '切换失败',
      'chip.noCommand': 'Host 没有提供 /service_push 命令',
      'chip.notReady': '当前会话还没准备好，稍后再试',
      'common.on': '开',
      'common.off': '关',
    };

    const en = {
      'page.nav': 'Push',
      'page.title': 'Push notifications',
      'page.subtitle': 'Send each finished turn to your phone or chat groups.',
      'page.hint': 'ServerChan Turbo free tier allows about 5 pushes/day; turn the per-session toggle on only for long tasks.',
      'section.default': 'Defaults & triggers',
      'section.channels': 'Channels',
      'section.recent': 'Recent pushes',
      'row.defaultEnabled': 'New sessions push by default',
      'row.defaultEnabledNote': 'Applies to new sessions without an explicit /service_push; existing sessions have their own toggle.',
      'row.notifyCompleted': 'Push on completed turns',
      'row.notifyFailure': 'Push on errors / aborts too',
      'row.notifySubagents': 'Include subagent / team sessions',
      'row.notifySubagentsNote': 'Off by default so one task does not flood you with subagent pushes.',
      'row.minTurn': 'Minimum duration (s)',
      'row.minTurnNote': 'Skip turns shorter than this; 0 = no limit.',
      'row.cooldown': 'Per-session cooldown (s)',
      'row.cooldownNote': 'Minimum gap between pushes for one session; 0 = no limit.',
      'row.includeExcerpt': 'Include last reply excerpt',
      'row.excerptMode': 'Excerpt length',
      'row.excerptModeNote': '"Channel limit" lets each channel truncate to its own capacity; "Custom" uses the character count below.',
      'mode.custom': 'Custom',
      'mode.channel': 'Channel limit',
      'row.excerptChars': 'Custom character limit',
      'row.excerptCharsNote': '0 = no excerpt (same as turning the switch above off)',
      'btn.save': 'Save',
      'btn.test': 'Test',
      'btn.testing': 'Testing…',
      'btn.edit': 'Edit',
      'btn.delete': 'Delete',
      'btn.deleteConfirm': 'Confirm delete?',
      'btn.cancel': 'Cancel',
      'btn.addChannel': 'Add channel',
      'channels.empty': 'No channel yet. Add ServerChan / Feishu / WeCom / DingTalk / Telegram / Bark / Webhook.',
      'channels.addTitle': 'Add channel',
      'channels.editTitle': 'Edit channel',
      'channels.type': 'Type',
      'channels.name': 'Label (optional)',
      'channels.namePlaceholder': 'e.g. My WeChat',
      'channels.keepSecret': 'Configured — leave empty to keep',
      'channels.saveChannel': 'Save channel',
      'channels.disabled': 'Disabled',
      'channels.loading': 'Loading…',
      'channels.loadFailed': 'Failed to load configuration',
      'channels.retry': 'Retry',
      'channels.footer': 'Config file: ',
      'recent.empty': 'No push yet.',
      'recent.ok': 'OK',
      'recent.fail': 'Failed',
      'msg.saved': 'Saved',
      'msg.saveFailed': 'Save failed',
      'msg.channelSaved': 'Channel saved',
      'msg.channelDeleted': 'Channel deleted',
      'msg.testOk': 'Test push submitted',
      'msg.testFail': 'Test push failed',
      'chip.label': 'Push',
      'chip.titleOn': 'Push after each turn: on (click to turn off)',
      'chip.titleOff': 'Push after each turn: off (click to turn on)',
      'chip.titleNoChannel': 'Turned on, but no channel is enabled yet — add one in Settings → Push',
      'chip.failed': 'Toggle failed',
      'chip.noCommand': 'The host does not provide the /service_push command',
      'chip.notReady': 'This session is not ready yet, try again shortly',
      'common.on': 'On',
      'common.off': 'Off',
    };

    function makeT(dicts, bindFallback) {
      return (key, params) => {
        const dict = dicts[bindFallback()?.id] ?? dicts.zh;
        let text = dict[key] ?? dicts.en?.[key] ?? key;
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text = text.replaceAll(`{${name}}`, String(value));
          }
        }
        return text;
      };
    }

    /* ────────────────────────── HTTP ────────────────────────── */

    async function requestJson(path, options) {
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) throw new Error(data && data.error ? data.error : `HTTP ${String(response.status)}`);
      if (data && data.ok === false) throw new Error(data.error || 'request failed');
      return data;
    }

    const jget = (path) => requestJson(path);
    const jpost = (path, body) => requestJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

    function fmtTime(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    function messageText(error) {
      return error && error.message ? error.message : String(error ?? '');
    }

    /* ────────────────────────── 样式 ────────────────────────── */

    const CSS = `
[data-pn-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 12px;max-width:720px;}
[data-pn-title]{display:flex;flex-direction:column;gap:3px;}
[data-pn-title]>div:first-child{font-size:16px;font-weight:600;}
[data-pn-sub]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pn-sec]{display:flex;flex-direction:column;gap:9px;padding:14px 16px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-pn-h]{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.04em;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pn-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-pn-grow]{flex:1;min-width:0;}
[data-pn-label]{font-size:13px;}
[data-pn-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pn-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-pn-sw][data-on]{background:var(--dsw-alias-state-business-primary,#3b82f6);}
[data-pn-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-pn-sw][data-on] i{left:19px;}
[data-pn-sw][disabled]{opacity:.5;cursor:default;}
[data-pn-input]{box-sizing:border-box;padding:6px 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:inherit;}
[data-pn-input]:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3b82f6);}
[data-pn-input][data-wide]{flex:1;min-width:220px;}
[data-pn-input][data-narrow]{width:110px;}
[data-pn-select]{padding:6px 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:inherit;}
[data-pn-btn]{padding:6px 11px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;}
[data-pn-btn]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.22));}
[data-pn-btn][data-primary]{background:var(--dsw-alias-state-business-primary,#3b82f6);border-color:transparent;color:#fff;}
[data-pn-btn][data-danger]{color:#ef4444;}
[data-pn-btn]:disabled{opacity:.5;cursor:default;}
[data-pn-card]{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.05));}
[data-pn-card-main]{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
[data-pn-card-title]{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;}
[data-pn-card-target]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
[data-pn-card-actions]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;}
[data-pn-badge]{font-size:10px;padding:1px 7px;border-radius:999px;font-weight:500;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-pn-badge][data-tone=good]{background:rgba(34,197,94,.16);color:#22c55e;}
[data-pn-badge][data-tone=warn]{background:rgba(245,158,11,.16);color:#f59e0b;}
[data-pn-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-word;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pn-msg][data-tone=good]{color:#22c55e;}
[data-pn-msg][data-tone=warn]{color:#f59e0b;}
[data-pn-form]{display:flex;flex-direction:column;gap:9px;padding:12px;border-radius:10px;
  border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.28));}
[data-pn-form-row]{display:flex;flex-direction:column;gap:4px;}
[data-pn-field-label]{font-size:11px;color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-pn-form-actions]{display:flex;justify-content:flex-end;gap:8px;}
[data-pn-recent]{display:flex;flex-direction:column;gap:6px;}
[data-pn-recent-item]{display:flex;align-items:center;gap:7px;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-pn-footer]{font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-pn-chip]{border-radius:var(--dsw-radius-sm);min-width:28px;max-width:180px;height:28px;color:var(--dsw-alias-label-secondary);
  cursor:pointer;background:0 0;border:none;outline:none;align-items:center;justify-content:center;gap:5px;padding:0 6px;
  margin-left:-8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;align-self:center;vertical-align:middle;}
[data-pn-chip]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
[data-pn-chip]:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
[data-pn-chip]:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
[data-pn-chip][data-on]{color:var(--dsw-alias-state-business-primary,#3b82f6)}
[data-pn-chip-icon]{flex:none;display:inline-flex;align-items:center;justify-content:center}
[data-pn-chip-icon] svg{display:block;width:14px;height:14px}
[data-pn-chip-label]{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;line-height:20px}
@container (width<=460px){[data-pn-chip]{min-width:28px;max-width:28px;padding:0;margin-left:-4px;justify-content:center}[data-pn-chip] [data-pn-chip-label]{display:none}}
`;

    /* ────────────────────────── 小组件 ────────────────────────── */

    function Section(props) {
      return h('section', { 'data-pn-sec': '' },
        h('div', { 'data-pn-h': '' }, props.title),
        props.children);
    }

    function Row(props) {
      return h('div', { 'data-pn-row': '' },
        h('div', { 'data-pn-grow': '' },
          h('div', { 'data-pn-label': '' }, props.label),
          props.note ? h('div', { 'data-pn-note': '' }, props.note) : null),
        props.children);
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        'data-pn-sw': '',
        'data-on': props.checked ? '1' : undefined,
        role: 'switch',
        'aria-checked': props.checked === true,
        'aria-label': props.label || (props.checked ? 'on' : 'off'),
        title: props.label || (props.checked ? 'on' : 'off'),
        disabled: props.disabled,
        onClick: () => props.onChange(!props.checked),
      }, h('i', null));
    }

    function Btn(props) {
      return h('button', {
        type: 'button',
        'data-pn-btn': '',
        'data-primary': props.primary ? '1' : undefined,
        'data-danger': props.danger ? '1' : undefined,
        disabled: props.disabled,
        onClick: props.onClick,
        title: props.title,
      }, props.children);
    }

    function Msg(props) {
      if (!props.msg) return null;
      return h('div', { 'data-pn-msg': '', 'data-tone': props.msg.tone || 'info' }, props.msg.text);
    }

    function NumberField(props) {
      const [draft, setDraft] = useState(String(props.value ?? 0));
      useEffect(() => { setDraft(String(props.value ?? 0)); }, [props.value]);
      const commit = () => {
        const number = Number(draft);
        if (!Number.isFinite(number)) {
          setDraft(String(props.value ?? 0));
          return;
        }
        const clamped = Math.min(props.max ?? 600, Math.max(props.min ?? 0, Math.round(number)));
        setDraft(String(clamped));
        if (clamped !== props.value) props.onCommit(clamped);
      };
      return h('input', {
        type: 'number',
        'data-pn-input': '',
        'data-narrow': '',
        min: props.min ?? 0,
        max: props.max ?? 600,
        value: draft,
        disabled: props.disabled,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
      });
    }

    /* ────────────────────────── 会话开关 chip ────────────────────────── */

    const BELL_PATH = 'M8 1.6c-2.5 0-4.5 2-4.5 4.5v2.4L2.2 11a.7.7 0 0 0 .6 1h10.4a.7.7 0 0 0 .6-1L12.5 8.5V6.1c0-2.5-2-4.5-4.5-4.5Zm-2 11.2a2 2 0 0 0 4 0H6Z';

    function PushChip(props) {
      const sessionId = props.sessionId;
      const t = props.t || props.translate;
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState('');
      const aliveRef = useRef(true);

      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      const load = useCallback(async () => {
        if (!sessionId) return;
        try {
          const data = await jget(`/session?sessionId=${encodeURIComponent(sessionId)}`);
          if (aliveRef.current) {
            setState(data);
            setFailure('');
          }
        } catch (error) {
          if (aliveRef.current) setFailure(messageText(error));
          if (typeof console !== 'undefined') console.error('[push-notify] 读取会话推送状态失败', error);
        }
      }, [sessionId]);

      useEffect(() => { void load(); }, [load]);

      const toggle = async () => {
        if (busy || state === null) return;
        setBusy(true);
        setFailure('');
        try {
          const sessions = props.sessions;
          const live = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId)?.session : undefined;
          if (!live || typeof live.command !== 'function') throw new Error(t('chip.notReady'));
          const result = await live.command(state.enabled ? '/service_push off' : '/service_push on');
          if (!result || result.ok !== true) throw new Error(result?.error?.message || t('chip.failed'));
          if (result.value && result.value.matched === false) throw new Error(t('chip.noCommand'));
          await load();
        } catch (error) {
          setFailure(messageText(error));
          if (typeof console !== 'undefined') console.error('[push-notify] 切换推送失败', error);
        } finally {
          if (aliveRef.current) setBusy(false);
        }
      };

      if (state === null) return null;
      const on = state.enabled === true;
      const hasChannel = Number(state.channels) > 0;
      const title = failure !== ''
        ? `${t('chip.failed')}：${failure}`
        : on
          ? (hasChannel ? t('chip.titleOn') : t('chip.titleNoChannel'))
          : t('chip.titleOff');
      return h('button', {
        type: 'button',
        'data-pn-chip': '',
        'data-on': on ? '1' : undefined,
        'aria-pressed': on,
        'aria-label': title,
        title,
        disabled: busy,
        onClick: toggle,
      },
      h('span', { 'data-pn-chip-icon': '' },
        h('svg', {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          style: { display: 'block', width: '14px', height: '14px', flex: 'none' },
        },
          h('path', { d: BELL_PATH, fill: 'currentColor' }),
          on ? null : h('path', { d: 'M2.6 2.6 13.4 13.4', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }))),
      h('span', { 'data-pn-chip-label': '' }, t('chip.label')));
    }

    /* ────────────────────────── 设置页 ────────────────────────── */

    function SettingsPage(props) {
      const t = props.t || ((key) => key);
      const [view, setView] = useState(null);
      const [loadError, setLoadError] = useState('');
      const [busy, setBusy] = useState('');
      const [msg, setMsg] = useState(null);
      const [form, setForm] = useState(null);
      const [formBusy, setFormBusy] = useState(false);
      const [deleteId, setDeleteId] = useState(null);
      const deleteTimer = useRef(null);

      const flash = (tone, text) => {
        setMsg({ tone, text });
        if (tone === 'good') {
          globalThis.setTimeout(() => { setMsg((current) => (current && current.text === text ? null : current)); }, 2600);
        }
      };

      const load = useCallback(async () => {
        try {
          const data = await jget('/config');
          setView(data);
          setLoadError('');
        } catch (error) {
          setLoadError(messageText(error));
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const applyPatch = async (patch) => {
        setBusy('config');
        try {
          const data = await jpost('/config', patch);
          setView(data);
          flash('good', t('msg.saved'));
        } catch (error) {
          flash('warn', `${t('msg.saveFailed')}：${messageText(error)}`);
        } finally {
          setBusy('');
        }
      };

      const toggleChannel = async (channel, enabled) => {
        setBusy(channel.id);
        try {
          const data = await jpost('/channels/update', { id: channel.id, enabled });
          setView(data);
        } catch (error) {
          flash('warn', `${t('msg.saveFailed')}：${messageText(error)}`);
        } finally {
          setBusy('');
        }
      };

      const deleteChannel = async (id) => {
        if (deleteId !== id) {
          setDeleteId(id);
          if (deleteTimer.current) clearTimeout(deleteTimer.current);
          deleteTimer.current = globalThis.setTimeout(() => setDeleteId(null), 4000);
          return;
        }
        if (deleteTimer.current) clearTimeout(deleteTimer.current);
        setDeleteId(null);
        setBusy(id);
        try {
          const data = await jpost('/channels/delete', { id });
          setView(data);
          flash('good', t('msg.channelDeleted'));
        } catch (error) {
          flash('warn', `${t('msg.saveFailed')}：${messageText(error)}`);
        } finally {
          setBusy('');
        }
      };

      const testChannel = async (id) => {
        setBusy(`test:${id}`);
        try {
          const data = await jpost('/channels/test', { id });
          setView(data);
          const result = data.result;
          if (result && result.ok === true) flash('good', t('msg.testOk'));
          else flash('warn', `${t('msg.testFail')}：${result?.error || ''}`);
        } catch (error) {
          flash('warn', `${t('msg.testFail')}：${messageText(error)}`);
        } finally {
          setBusy('');
        }
      };

      const startCreate = () => {
        const firstType = view?.channelTypes?.[0]?.type;
        setForm({ mode: 'create', type: firstType, name: '', fields: {} });
        setDeleteId(null);
      };

      const startEdit = (channel) => {
        const fields = {};
        for (const [key, value] of Object.entries(channel.fields ?? {})) {
          const descriptor = view.channelTypes.find((entry) => entry.type === channel.type)?.fields.find((field) => field.key === key);
          fields[key] = descriptor?.secret ? '' : String(value ?? '');
        }
        setForm({ mode: 'edit', id: channel.id, type: channel.type, name: channel.name ?? '', fields });
      };

      const submitForm = async () => {
        if (!form || formBusy) return;
        setFormBusy(true);
        try {
          const payload = { type: form.type, name: form.name, fields: form.fields };
          const data = form.mode === 'edit'
            ? await jpost('/channels/update', { id: form.id, name: form.name, fields: form.fields })
            : await jpost('/channels', payload);
          setView(data);
          setForm(null);
          flash('good', t('msg.channelSaved'));
        } catch (error) {
          flash('warn', `${t('msg.saveFailed')}：${messageText(error)}`);
        } finally {
          setFormBusy(false);
        }
      };

      if (loadError !== '' && view === null) {
        return h('div', { 'data-pn-page': '' },
          h('div', { 'data-pn-title': '' }, h('div', null, t('page.title'))),
          h(Msg, { msg: { tone: 'warn', text: `${t('channels.loadFailed')}：${loadError}` } }),
          h('div', null, h(Btn, { onClick: () => { setLoadError(''); void load(); } }, t('channels.retry'))));
      }
      if (view === null) {
        return h('div', { 'data-pn-page': '' }, h('div', { 'data-pn-sub': '' }, t('channels.loading')));
      }

      const config = view.config;
      const disabled = busy === 'config';

      const defaultSection = h(Section, { title: t('section.default') },
        h(Row, { label: t('row.defaultEnabled'), note: t('row.defaultEnabledNote') },
          h(Toggle, { checked: config.defaultEnabled, onChange: (value) => applyPatch({ defaultEnabled: value }), label: t('row.defaultEnabled') })),
        h(Row, { label: t('row.notifyCompleted') },
          h(Toggle, { checked: config.notifyOnCompleted, onChange: (value) => applyPatch({ notifyOnCompleted: value }), label: t('row.notifyCompleted') })),
        h(Row, { label: t('row.notifyFailure') },
          h(Toggle, { checked: config.notifyOnFailure, onChange: (value) => applyPatch({ notifyOnFailure: value }), label: t('row.notifyFailure') })),
        h(Row, { label: t('row.notifySubagents'), note: t('row.notifySubagentsNote') },
          h(Toggle, { checked: config.notifySubagents, onChange: (value) => applyPatch({ notifySubagents: value }), label: t('row.notifySubagents') })),
        h(Row, { label: t('row.minTurn'), note: t('row.minTurnNote') },
          h(NumberField, { value: config.minTurnSeconds, min: 0, max: 600, disabled, onCommit: (value) => applyPatch({ minTurnSeconds: value }) })),
        h(Row, { label: t('row.cooldown'), note: t('row.cooldownNote') },
          h(NumberField, { value: config.cooldownSeconds, min: 0, max: 3600, disabled, onCommit: (value) => applyPatch({ cooldownSeconds: value }) })),
        h(Row, { label: t('row.includeExcerpt') },
          h(Toggle, { checked: config.includeExcerpt, onChange: (value) => applyPatch({ includeExcerpt: value }), label: t('row.includeExcerpt') })),
        h(Row, { label: t('row.excerptMode'), note: t('row.excerptModeNote') },
          h('select', {
            'data-pn-select': '',
            value: config.excerptMode,
            disabled: !config.includeExcerpt,
            'aria-label': t('row.excerptMode'),
            onChange: (event) => applyPatch({ excerptMode: event.target.value }),
          }, h('option', { value: 'custom' }, t('mode.custom')), h('option', { value: 'channel' }, t('mode.channel')))),
        config.excerptMode === 'custom'
          ? h(Row, { label: t('row.excerptChars'), note: t('row.excerptCharsNote') },
            h(NumberField, {
              value: config.excerptChars,
              min: 0,
              max: 4000,
              disabled: disabled || !config.includeExcerpt,
              onCommit: (value) => applyPatch({ excerptChars: value }),
            }))
          : null);

      const channelCards = view.channels.map((channel) => {
        const targetEntries = Object.entries(channel.fields ?? {});
        const firstTarget = targetEntries.length > 0 ? String(targetEntries[0][1] ?? '') : '';
        return h('div', { 'data-pn-card': '', key: channel.id },
          h('div', { 'data-pn-card-main': '' },
            h('div', { 'data-pn-card-title': '' },
              channel.name !== '' ? channel.name : channel.typeLabel,
              h('span', { 'data-pn-badge': '' }, channel.typeLabel),
              channel.enabled ? null : h('span', { 'data-pn-badge': '', 'data-tone': 'warn' }, t('channels.disabled'))),
            h('div', { 'data-pn-card-target': '' }, firstTarget)),
          h('div', { 'data-pn-card-actions': '' },
            h(Toggle, { checked: channel.enabled, onChange: (value) => toggleChannel(channel, value), label: channel.typeLabel }),
            h(Btn, { onClick: () => testChannel(channel.id), disabled: busy === `test:${channel.id}` || channel.enabled === false },
              busy === `test:${channel.id}` ? t('btn.testing') : t('btn.test')),
            h(Btn, { onClick: () => startEdit(channel) }, t('btn.edit')),
            h(Btn, { danger: true, onClick: () => deleteChannel(channel.id) },
              deleteId === channel.id ? t('btn.deleteConfirm') : t('btn.delete'))));
      });

      const formType = form
        ? view.channelTypes.find((entry) => entry.type === form.type) ?? view.channelTypes[0]
        : null;

      const formView = form === null ? null : h('div', { 'data-pn-form': '' },
        h('div', { 'data-pn-h': '' }, form.mode === 'edit' ? t('channels.editTitle') : t('channels.addTitle')),
        form.mode === 'create'
          ? h('div', { 'data-pn-form-row': '' },
            h('span', { 'data-pn-field-label': '' }, t('channels.type')),
            h('select', {
              'data-pn-select': '',
              value: form.type,
              onChange: (event) => setForm({ ...form, type: event.target.value, fields: {} }),
            }, view.channelTypes.map((entry) => h('option', { value: entry.type, key: entry.type }, entry.label))))
          : null,
        formType && formType.hint ? h('div', { 'data-pn-note': '' }, formType.hint) : null,
        h('div', { 'data-pn-form-row': '' },
          h('span', { 'data-pn-field-label': '' }, t('channels.name')),
          h('input', {
            'data-pn-input': '',
            'data-wide': '',
            type: 'text',
            value: form.name,
            placeholder: t('channels.namePlaceholder'),
            onChange: (event) => setForm({ ...form, name: event.target.value }),
          })),
        ...(formType?.fields ?? []).map((field) => h('div', { 'data-pn-form-row': '', key: field.key },
          h('span', { 'data-pn-field-label': '' }, `${field.label}${field.optional ? '（可选）' : ''}`),
          h('input', {
            'data-pn-input': '',
            'data-wide': '',
            type: field.secret ? 'password' : 'text',
            value: form.fields[field.key] ?? '',
            placeholder: form.mode === 'edit' && field.secret ? t('channels.keepSecret') : field.placeholder,
            autoComplete: 'off',
            onChange: (event) => setForm({ ...form, fields: { ...form.fields, [field.key]: event.target.value } }),
          }))),
        h('div', { 'data-pn-form-actions': '' },
          h(Btn, { onClick: () => setForm(null) }, t('btn.cancel')),
          h(Btn, { primary: true, onClick: submitForm, disabled: formBusy },
            formBusy ? t('channels.loading') : t('channels.saveChannel'))));

      const channelsSection = h(Section, { title: t('section.channels') },
        h('div', { 'data-pn-note': '' }, t('page.hint')),
        view.channels.length === 0 ? h('div', { 'data-pn-note': '' }, t('channels.empty')) : null,
        ...channelCards,
        formView,
        h('div', { 'data-pn-row': '' },
          form === null ? h(Btn, { onClick: startCreate }, t('btn.addChannel')) : null));

      const recentSection = h(Section, { title: t('section.recent') },
        view.last.length === 0
          ? h('div', { 'data-pn-note': '' }, t('recent.empty'))
          : h('div', { 'data-pn-recent': '' }, view.last.slice(0, 8).map((row, index) => h('div', { 'data-pn-recent-item': '', key: `${String(row.time)}-${String(index)}` },
            h('span', { 'data-pn-badge': '', 'data-tone': row.ok ? 'good' : 'warn' }, row.ok ? t('recent.ok') : t('recent.fail')),
            h('span', null, `${fmtTime(row.time)} · ${row.channelName || ''}${row.error ? ` · ${row.error}` : ''}`)))));

      return h('div', { 'data-pn-page': '' },
        h('div', { 'data-pn-title': '' },
          h('div', null, t('page.title')),
          h('div', { 'data-pn-sub': '' }, t('page.subtitle'))),
        h(Msg, { msg }),
        defaultSection,
        channelsSection,
        recentSection,
        h('div', { 'data-pn-footer': '' }, `${t('channels.footer')}${view.storage?.configFile ?? ''}`));
    }

    /* ────────────────────────── 插件入口 ────────────────────────── */

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        const style = document.createElement('style');
        style.setAttribute('data-plugin-css', 'dsh-serverChan');
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'push-notify: 样式');

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'push-notify: 字典');
        const t = ctx.locale.bind(NS);
        const sessions = ctx.get('sessions');

        const slots = ctx.get('slots');
        if (!slots) return;

        function ChipSeat(props) {
          return h(PushChip, { ...props, t: props.t || t, sessions });
        }

        slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: 'push-notify',
          order: 10,
          locale: NS,
        }, ChipSeat));

        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'push-notify',
          order: 40,
          label: () => t('page.nav'),
        }, () => h(SettingsPage, { t })));
      },
    };
  },
});
