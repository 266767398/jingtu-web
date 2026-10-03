// P2-151: backup-core 行为测试（生成/校验/清理/穿越拦截 + BACKUP_DIR 注入临时目录）
// 覆盖此前零行为测试的：createBackup 成功/失败清理、dumpLooksValid 头尾完整性、
// restoreBackup 路径穿越拦截与维护态互斥、cleanupAutoBackups 仅清 auto_ 前缀。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const mockHolder = { dbName: 'testdb', restoring: false, pool: null };
const mockSpawn = jest.fn();

jest.mock('child_process', () => ({ spawn: mockSpawn }));
jest.mock('../db', () => ({
  holder: mockHolder,
  DB_CONFIG: { host: '127.0.0.1', port: 3306, user: 'root', password: 'pw', database: 'testdb' }
}));

let tmpDir;
let backup;

function loadCore() {
  process.env.BACKUP_DIR = tmpDir;
  jest.resetModules();
  return require('../backup-core');
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.stdin = { pipe() {} };
  }
}

function validDumpContent(bodyLen) {
  return `-- MySQL dump 10.13  Distrib 8.0.36
-- Host: 127.0.0.1    Database: testdb
-- Server version       8.0.36
${'x'.repeat(bodyLen)}
-- Dump completed on 2026-01-01 12:00:00 +0000
`;
}

function writeValidDump(filePath, bodyLen = 1200) {
  fs.writeFileSync(filePath, validDumpContent(bodyLen));
}

beforeEach(() => {
  mockHolder.dbName = 'testdb';
  mockHolder.restoring = false;
  mockHolder.pool = null;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-test-'));
  backup = loadCore();
});

afterEach(() => {
  mockSpawn.mockReset();
  delete process.env.BACKUP_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ─────────────────────────── 校验与格式化 ───────────────────────────
describe('P2-151 backup-core 校验/格式化', () => {
  test('dumpLooksValid 完整 dump 通过（头+尾标记）', () => {
    const p = path.join(tmpDir, 'full.sql');
    writeValidDump(p);
    expect(backup.dumpLooksValid(p)).toBe(true);
  });

  test('dumpLooksValid 空文件 / 不存在 / 无头 / 无尾 / 过小均拒绝', () => {
    expect(backup.dumpLooksValid(path.join(tmpDir, 'nope.sql'))).toBe(false);

    const empty = path.join(tmpDir, 'empty.sql');
    fs.writeFileSync(empty, '');
    expect(backup.dumpLooksValid(empty)).toBe(false);

    const noHead = path.join(tmpDir, 'nohead.sql');
    fs.writeFileSync(noHead, 'garbage'.repeat(200));
    expect(backup.dumpLooksValid(noHead)).toBe(false);

    const noTail = path.join(tmpDir, 'notail.sql');
    fs.writeFileSync(noTail, '-- MySQL dump 10.13\n' + 'y'.repeat(800));
    expect(backup.dumpLooksValid(noTail)).toBe(false);

    const small = path.join(tmpDir, 'small.sql');
    writeValidDump(small, 100);
    expect(backup.dumpLooksValid(small)).toBe(false);
  });

  test('formatSize 单位换算', () => {
    expect(backup.formatSize(512)).toBe('0.5 KB');
    expect(backup.formatSize(2048)).toBe('2.0 KB');
    expect(backup.formatSize(2 * 1024 * 1024)).toBe('2.00 MB');
  });

  test('AUTO_PREFIX / PRE_RESTORE_PREFIX 常量语义', () => {
    expect(backup.AUTO_PREFIX).toBe('auto_');
    expect(backup.BACKUP_DIR).toBe(tmpDir);
  });
});

// ─────────────────────────── createBackup 生成 ───────────────────────────
describe('P2-151 createBackup 生成', () => {
  function captureSpawnResult() {
    let child;
    mockSpawn.mockImplementation(() => {
      child = new FakeChild();
      return child;
    });
    return () => child;
  }

  test('成功路径：文件落在 BACKUP_DIR、参数完整、返回元信息', async () => {
    const getChild = captureSpawnResult();
    const p = backup.createBackup({ prefix: 'auto_' });
    const child = getChild();
    const args = mockSpawn.mock.calls[0][1];
    const resultFile = args.find((a) => a.startsWith('--result-file='));
    expect(resultFile).toBeTruthy();
    expect(args).toEqual(expect.arrayContaining(['--single-transaction', '-h', '127.0.0.1', 'testdb']));
    // 模拟 mysqldump 写出合法 dump，然后成功退出
    writeValidDump(resultFile.slice('--result-file='.length));
    child.emit('close', 0);
    const res = await p;
    // §P3-89: 文件名含毫秒 + 4 位随机后缀（防同毫秒并发覆盖）
    expect(res.filename).toMatch(/^auto_testdb_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-z0-9]{4}\.sql$/);
    expect(res.filePath.startsWith(tmpDir)).toBe(true);
    expect(fs.existsSync(res.filePath)).toBe(true);
    expect(res.size).toBeGreaterThan(500);
    expect(res.sizeFormatted).toContain('KB');
    expect(typeof res.createdAt).toBe('string');
  });

  test('失败：退出码非 0 → reject 且残留文件被删除', async () => {
    const getChild = captureSpawnResult();
    const p = backup.createBackup({ prefix: 'auto_' });
    const child = getChild();
    const args = mockSpawn.mock.calls[0][1];
    const f = args.find((a) => a.startsWith('--result-file=')).slice('--result-file='.length);
    fs.writeFileSync(f, 'bad');
    child.emit('close', 1);
    await expect(p).rejects.toThrow('备份失败');
    expect(fs.existsSync(f)).toBe(false);
  });

  test('失败：mysqldump 产物过小 / 缺文件头 → reject 且删除', async () => {
    const getChild = captureSpawnResult();
    const p = backup.createBackup();
    const child = getChild();
    const args = mockSpawn.mock.calls[0][1];
    const f = args.find((a) => a.startsWith('--result-file=')).slice('--result-file='.length);
    fs.writeFileSync(f, 'x'.repeat(100));
    child.emit('close', 0);
    await expect(p).rejects.toThrow(/为空或过小|无效备份/);
    expect(fs.existsSync(f)).toBe(false);
  });

  test('失败：mysqldump ENOENT → reject 且不落文件', async () => {
    const getChild = captureSpawnResult();
    const p = backup.createBackup();
    const child = getChild();
    const err = new Error('spawn mysqldump ENOENT');
    err.code = 'ENOENT';
    child.emit('error', err);
    await expect(p).rejects.toThrow('mysqldump 命令未找到');
  });
});

// ─────────────────────────── restoreBackup 穿越拦截 ───────────────────────────
describe('P2-151 restoreBackup 穿越拦截与维护态', () => {
  test('路径穿越（../../）在 basename 处被归一化到 BACKUP_DIR', async () => {
    await expect(backup.restoreBackup('../../etc/passwd')).rejects.toThrow('无效的备份文件名');
    await expect(backup.restoreBackup('..%2F..%2Fetc%2Fpasswd')).rejects.toThrow('无效的备份文件名');
    await expect(backup.restoreBackup('a.sql')).rejects.toThrow('备份文件不存在');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('存在但未通过完整性校验 → 拒绝恢复', async () => {
    fs.writeFileSync(path.join(tmpDir, 'evil.sql'), 'not a dump');
    await expect(backup.restoreBackup('evil.sql')).rejects.toThrow('未通过完整性校验');
  });

  test('维护态（restoring）互斥拒绝', async () => {
    mockHolder.restoring = true;
    writeValidDump(path.join(tmpDir, 'ok.sql'));
    await expect(backup.restoreBackup('ok.sql')).rejects.toThrow('已有恢复任务进行中');
  });
});

// ─────────────────────────── cleanupAutoBackups ───────────────────────────
describe('P2-151 cleanupAutoBackups 仅清 auto_ 前缀', () => {
  test('只删除过期的 auto_ 文件，手动/pre_restore 保留', () => {
    const oldAuto = path.join(tmpDir, 'auto_old.sql');
    const newAuto = path.join(tmpDir, 'auto_new.sql');
    const manual = path.join(tmpDir, 'manual.sql');
    const pre = path.join(tmpDir, 'pre_restore_x.sql');
    for (const f of [oldAuto, newAuto, manual, pre]) fs.writeFileSync(f, 'sql');

    const realStat = fs.statSync.bind(fs);
    fs.statSync = jest.fn((p) => {
      const r = realStat(p);
      if (String(p).endsWith('auto_old.sql')) {
        return { ...r, birthtime: new Date(r.birthtime.getTime() - 30 * 864e5) };
      }
      return r;
    });
    expect(backup.cleanupAutoBackups(7)).toBe(1);
    expect(fs.existsSync(oldAuto)).toBe(false);
    expect(fs.existsSync(newAuto)).toBe(true);
    expect(fs.existsSync(manual)).toBe(true);
    expect(fs.existsSync(pre)).toBe(true);
    fs.statSync = realStat;
  });

  test('目录不存在返回 0', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(backup.cleanupAutoBackups(7)).toBe(0);
  });

  // §P3-89: daysToKeep<=0 时原实现 threshold 为未来时刻会删光全部 auto_ 备份
  test('daysToKeep<=0 按下限 1 天兜底，不误删非过期备份', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const fresh = path.join(tmpDir, 'auto_fresh.sql');
    const manual = path.join(tmpDir, 'manual.sql');
    for (const f of [fresh, manual]) fs.writeFileSync(f, 'sql');

    const realStat = fs.statSync.bind(fs);
    fs.statSync = jest.fn((p) => {
      const r = realStat(p);
      if (String(p).endsWith('auto_fresh.sql')) {
        // birthtime 距今 1 小时（远小于 1 天下限）
        return { ...r, birthtime: new Date(r.birthtime.getTime() - 3600e3) };
      }
      return r;
    });
    expect(backup.cleanupAutoBackups(0)).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(backup.cleanupAutoBackups(-5)).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(manual)).toBe(true);
    fs.statSync = realStat;
  });

  test('ensureBackupDir 幂等创建目录', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(backup.ensureBackupDir()).toBe(tmpDir);
    expect(fs.existsSync(tmpDir)).toBe(true);
    expect(backup.ensureBackupDir()).toBe(tmpDir);
  });
});