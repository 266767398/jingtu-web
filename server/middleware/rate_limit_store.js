const { MemoryStore } = require('express-rate-limit');
const cache = require('../cache');

const KEY_PREFIX = 'rl';

/**
 * 限流计数存储：Redis 可用时走共享态，否则回退进程内 MemoryStore。
 *
 * - 判定发生在每次请求（而非构造时），因为 Redis 在 server 启动后才异步初始化；
 * - 每个 limiter 需要独立实例（不同的 name），避免默认 keyGenerator 生成的
 *   IP 键在多个 limiter 之间互相污染；
 * - Redis 分支异常时回退本地计数，保证限流能力不因缓存故障而完全失效。
 */
class HybridStore {
  constructor(name) {
    if (!name) throw new Error('HybridStore requires a name');
    this.name = String(name);
    this.local = new MemoryStore();
    this.windowMs = 60 * 1000;
    this.localKeys = false;
    this.prefix = `${KEY_PREFIX}:${this.name}:`;
  }

  init(options) {
    this.local.init(options);
    if (options && Number.isFinite(options.windowMs)) {
      this.windowMs = options.windowMs;
    }
  }

  redisKey(key) {
    return `${this.prefix}${key}`;
  }

  async increment(key) {
    if (cache.isEnabled()) {
      const result = await cache.incr(this.redisKey(key), Math.ceil(this.windowMs / 1000));
      if (result) {
        const ttlSeconds = result.ttl > 0 ? result.ttl : Math.ceil(this.windowMs / 1000);
        return {
          totalHits: result.total,
          resetTime: new Date(Date.now() + ttlSeconds * 1000)
        };
      }
    }
    return this.local.increment(key);
  }

  async decrement(key) {
    if (cache.isEnabled()) {
      const info = await this.get(key);
      if (info && info.totalHits > 0) {
        const next = Math.max(info.totalHits - 1, 0);
        const ttlSeconds = Math.max(
          1,
          info.resetTime ? Math.ceil((info.resetTime.getTime() - Date.now()) / 1000) : Math.ceil(this.windowMs / 1000)
        );
        await cache.set(this.redisKey(key), String(next), ttlSeconds);
        return;
      }
      return;
    }
    await this.local.decrement(key);
  }

  async get(key) {
    if (cache.isEnabled()) {
      const [value, remaining] = await Promise.all([
        cache.get(this.redisKey(key)),
        cache.ttl(this.redisKey(key))
      ]);
      const total = Number.parseInt(value, 10);
      if (Number.isFinite(total)) {
        const ttlSeconds = remaining > 0 ? remaining : Math.ceil(this.windowMs / 1000);
        return { totalHits: total, resetTime: new Date(Date.now() + ttlSeconds * 1000) };
      }
      return { totalHits: 0, resetTime: undefined };
    }
    return this.local.get(key);
  }

  async resetKey(key) {
    if (cache.isEnabled()) {
      await cache.del(this.redisKey(key));
    }
    await this.local.resetKey(key);
  }

  async resetAll() {
    await this.local.resetAll();
  }

  shutdown() {
    this.local.shutdown();
  }
}

const registry = new Map();

/**
 * 为每个 limiter 生成独立的 store 实例。
 *
 * express-rate-limit v8 的 unsharedStore 校验禁止同一 store 实例被多个 limiter
 * 复用；同名重复调用时自动追加序号，保证 Redis 键空间同样互相隔离。
 */
function hybridStore(name) {
  const base = name || `limiter`;
  const seen = registry.get(base) || 0;
  registry.set(base, seen + 1);
  return new HybridStore(seen === 0 ? base : `${base}#${seen + 1}`);
}

module.exports = { HybridStore, hybridStore };
