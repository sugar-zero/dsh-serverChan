/**
 * test/client-load.mjs —— 验证 Web 半模块格式与注册位置（不渲染 React）
 * ============================================================================
 * 只做「模块加载 + apply 装配」冒烟：伪造 window.__ModuleLoader__ / document /
 * React / 客户端 ctx，确认：
 *   · client.js 是 loader 期待的 { id, factory } 形式；
 *   · factory 返回 { inject, apply }，apply 能注册 conversation.input.left 与 settings.section；
 *   · 注册 id/order/locale 与设计一致。
 * 不替代真实浏览器里的视觉验证。
 * ============================================================================
 */
import assert from 'node:assert/strict';

const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition);
    },
  },
};

const styleTags = [];
globalThis.document = {
  createElement(tag) {
    return {
      tag,
      attrs: {},
      textContent: '',
      setAttribute(name, value) { this.attrs[name] = value; },
      remove() { this.removed = true; },
    };
  },
  head: {
    appendChild(node) { styleTags.push(node); },
  },
};

const ReactStub = {
  createElement: (...args) => ({ args }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
};

await import('../client.js');
assert.equal(loaded.length, 1, 'client.js 应调用一次 window.__ModuleLoader__.load');
assert.equal(loaded[0].id, 'dsh-push-notify');
assert.equal(typeof loaded[0].factory, 'function');

const exportsObject = loaded[0].factory((name) => (name === 'react' ? ReactStub : {}));
assert.ok(Array.isArray(exportsObject.inject), 'factory 应返回 inject 数组');
for (const service of ['slots', 'locale', 'sessions']) {
  assert.ok(exportsObject.inject.includes(service), `inject 应包含 ${service}`);
}

const registrations = [];
const injections = [];
const fakeLocale = {
  register(namespace, dicts) {
    assert.equal(namespace, 'push-notify');
    assert.ok(dicts.zh && dicts.en);
    return () => {};
  },
  bind() {
    return (key) => key;
  },
};
const fakeSlots = {
  inject(key, callback) {
    injections.push(key);
    callback();
    return () => {};
  },
  register(options, component) {
    registrations.push({ options, component });
    return () => {};
  },
};

exportsObject.apply({
  slots: fakeSlots,
  locale: fakeLocale,
  get(name) {
    if (name === 'slots') return fakeSlots;
    if (name === 'sessions') return { binding: () => undefined };
    return undefined;
  },
  effect(callback) {
    return callback() ?? (() => {});
  },
});

assert.deepEqual(injections.sort(), ['conversation.input.left', 'settings.section']);
const chip = registrations.find((entry) => entry.options.name === 'conversation.input.left');
const settings = registrations.find((entry) => entry.options.name === 'settings.section');
assert.ok(chip, '应注册 conversation.input.left');
assert.equal(chip.options.id, 'push-notify');
assert.equal(chip.options.order, 10);
assert.equal(chip.options.locale, 'push-notify');
assert.equal(typeof chip.component, 'function');
assert.ok(settings, '应注册 settings.section');
assert.equal(settings.options.id, 'push-notify');
assert.equal(settings.options.order, 40);
assert.equal(typeof settings.options.label, 'function');
assert.equal(typeof settings.component, 'function');

assert.ok(styleTags.length >= 1, '应注入插件样式表');
assert.ok(styleTags[0].textContent.includes('[data-pn-chip]'), '样式应包含 chip 规则');
assert.ok(styleTags[0].textContent.includes('[data-pn-page]'), '样式应包含设置页规则');

console.log('  ok  client.js 模块格式与两个 slot 注册');
console.log('\nClient 装配测试全部通过。');
