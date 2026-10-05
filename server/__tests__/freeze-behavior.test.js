// 浏览器行为级验证 freeze.js（页面空闲冻结/交互解冻）：纯前端逻辑，不触及后端。
// jest 环境为 node；此处以最小 DOM stub（addEventListener/dispatchEvent/classList）
// 支撑 freeze.js 运行，fake timers 跳过 2 分钟空闲等待。
jest.useFakeTimers();

const FREEZE_PATH = '../../public/js/freeze.js';
const IDLE_MS = 2 * 60 * 1000;
const MOVE_THROTTLE_MS = 3000;

function installMinDom() {
  const listeners = {};
  const classSet = new Set();
  global.window = global;
  global.document = {
    hidden: false,
    documentElement: {
      classList: {
        add: (cls) => classSet.add(cls),
        remove: (cls) => classSet.delete(cls),
        contains: (cls) => classSet.has(cls)
      }
    },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatchEvent: (e) => {
      const list = listeners[e.type] || [];
      for (const fn of list) fn.call(global.document, e);
    }
  };
  global.CustomEvent = class {
    constructor(type) { this.type = type; }
  };
  return {
    classSet
  };
}

function loadFreeze() {
  jest.resetModules();
  installMinDom();
  require(FREEZE_PATH);
  return window.__freeze;
}

function fireEvent(type, init) {
  document.dispatchEvent(Object.assign({ type }, init || {}));
}

beforeEach(() => {
  // jest node 环境无 window；统一指向 global 并清掉上次用例留下的 __freeze
  global.window = global;
  delete global.__freeze;
});

describe('freeze.js 空闲冻结行为', () => {
  test('初始未冻结，且不带 site-frozen class', () => {
    const freeze = loadFreeze();
    expect(freeze.isFrozen()).toBe(false);
    expect(document.documentElement.classList.contains('site-frozen')).toBe(false);
  });

  test('连续 2 分钟无操作触发冻结：回调执行、class 写入、isFrozen 为 true', () => {
    const freeze = loadFreeze();
    const onFreeze = jest.fn();
    const onUnfreeze = jest.fn();
    freeze.register({ onFreeze, onUnfreeze });

    jest.advanceTimersByTime(IDLE_MS);
    expect(onFreeze).toHaveBeenCalledTimes(1);
    expect(onUnfreeze).not.toHaveBeenCalled();
    expect(freeze.isFrozen()).toBe(true);
    expect(document.documentElement.classList.contains('site-frozen')).toBe(true);
  });

  test('用户点击立即解冻：onUnfreeze 回调执行、class 移除、计时重置', () => {
    const freeze = loadFreeze();
    const onFreeze = jest.fn();
    const onUnfreeze = jest.fn();
    freeze.register({ onFreeze, onUnfreeze });

    jest.advanceTimersByTime(IDLE_MS); // 冻结
    expect(freeze.isFrozen()).toBe(true);

    fireEvent('mousedown');
    expect(onUnfreeze).toHaveBeenCalledTimes(1);
    expect(freeze.isFrozen()).toBe(false);
    expect(document.documentElement.classList.contains('site-frozen')).toBe(false);

    // 解冻后空闲计时重新开始，不会立即再冻结
    jest.advanceTimersByTime(IDLE_MS - 1);
    expect(freeze.isFrozen()).toBe(false);
  });

  test('冻结后再次闲置到点才重新冻结（交互会重置计时）', () => {
    const freeze = loadFreeze();
    const onFreeze = jest.fn();
    freeze.register({ onFreeze });

    jest.advanceTimersByTime(IDLE_MS);            // 第一次冻结
    expect(onFreeze).toHaveBeenCalledTimes(1);

    fireEvent('keydown');                          // 解冻
    expect(freeze.isFrozen()).toBe(false);

    jest.advanceTimersByTime(IDLE_MS - 1);         // 未到点
    expect(freeze.isFrozen()).toBe(false);

    jest.advanceTimersByTime(1);                   // 正好到点
    expect(freeze.isFrozen()).toBe(true);
    expect(onFreeze).toHaveBeenCalledTimes(2);
  });

  test('冻结后才 register 的模块立即同步 onFreeze（懒加载场景）', () => {
    const freeze = loadFreeze();
    jest.advanceTimersByTime(IDLE_MS); // 已冻结

    const lateModule = jest.fn();
    freeze.register({ onFreeze: lateModule });
    expect(lateModule).toHaveBeenCalledTimes(1);

    // 解冻后再注册的模块不触发 onFreeze
    fireEvent('pointerdown');
    const lateModule2 = jest.fn();
    freeze.register({ onFreeze: lateModule2 });
    expect(lateModule2).not.toHaveBeenCalled();
  });

  test('原地悬停的 mousemove（无位移）不解冻；有位移才解冻', () => {
    const freeze = loadFreeze();

    // 先制造一次位移，记录基准位置
    fireEvent('mousemove', { clientX: 100, clientY: 100 });
    jest.advanceTimersByTime(MOVE_THROTTLE_MS + 1);
    jest.advanceTimersByTime(IDLE_MS); // 冻结

    // 相同坐标的 mousemove：位移为 0，不应解冻
    fireEvent('mousemove', { clientX: 100, clientY: 100 });
    expect(freeze.isFrozen()).toBe(true);

    // 位移超过阈值的 mousemove：解冻
    fireEvent('mousemove', { clientX: 200, clientY: 150 });
    expect(freeze.isFrozen()).toBe(false);
  });
});