module.exports = {
  testEnvironment: 'node',
  // 仅匹配 __tests__/ 目录下的 Jest 测试。
  // 注意：test/ 目录下的 security.test.js、share-auth-boundary.test.js 是 node:test 原生测试，
  // 由 `npm run test:node`（node --test test/*.test.js）运行，P2-68 起已挂入 CI node-test job；
  // 不能用宽泛的 '**/*.test.js' 误匹配进 Jest。
  testMatch: ['**/__tests__/**/*.js'],
  testPathIgnorePatterns: ['/node_modules/', '/test/'],
  coverageDirectory: './coverage',
  collectCoverageFrom: [
    'routes/**/*.js',
    '!routes/_archive/**',
    'auth.js',
    'utils.js',
    'db.js',
    'middleware/**/*.js',
    'notification-service.js',
    'logger.js',
    'security_alert.js',
    // P3-23①：补整机入口与安全/邮件模块——此前 server.js/ws_service/panel_proxy/cache/mailer 零统计
    // （server.js 整机集成已被 server-app.test.js 覆盖但未纳入统计；panel_proxy/cache/mailer 走 Jest 无守卫）
    'server.js',
    'ws_service.js',
    'panel_proxy.js',
    'cache.js',
    'mailer.js'
  ],
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  // 覆盖率阈值基线（棘轮式只升）。规则：阈值 = 实测向下取整且保留 ≥1pt 余量。
  // P2-1 设立 15/6/9/16；09-12 P2-4 复验按实测 17.29/6.99/11.3/19.24 上调为 16/6/10/18；
  // 2026-09-13 P2-66/P3-7 轮实测 语句 17.99 / 分支 6.99 / 函数 12.03 / 行 20.03
  // → 函数 10→11、行 18→19；语句升 17 仅余 0.99pt、分支同 09-12 理由，均暂维持。
  // 原 60/60/50/40 为理想目标、从未达成，会让 CI 恒红；后续随路由层单测补齐继续上调，防止覆盖率回退。
  // P3-12（2026-09-15）：global 阈值会掩盖分域不均（auth 21.67% lines vs admin 14.31%）。
  // 注意 Jest 的 per-glob 阈值按「每个命中文件」分别判定而非聚合，故逐文件设 floor。
  // upload 域现仅命中 middleware/uploads_auth.js（上传主逻辑在 files/avatar 路由，尚无专属测试）；
  // admin/upload 各文件分支实测 0%，floor 无防回退意义故暂不设 branches 项，待 P2-69 补测后回填。
  coverageThreshold: {
    global: {
      lines: 19,
      statements: 16,
      functions: 11,
      branches: 6
    },
    './auth.js': {
      lines: 19,
      statements: 16,
      functions: 20,
      branches: 6
    },
    './routes/auth.js': {
      // P3-23②：per-glob 按文件判定，99 阈值意味着任何新增未测分支即全红（棘轮过紧）；
      // 实测 100 时按「向下取整且保留 ≥1pt 余量」规则应取 98，给测试迭代留缓冲。
      lines: 98,
      statements: 98,
      functions: 98,
      branches: 98
    },
    './routes/admin.js': {
      lines: 14,
      statements: 13,
      functions: 4
    },
    './routes/admin_content_live.js': {
      lines: 11,
      statements: 9,
      functions: 6
    },
    './routes/admin_name_change.js': {
      lines: 19,
      statements: 17,
      functions: 15
    },
    './routes/admin_users.js': {
      lines: 10,
      statements: 8,
      functions: 5
    },
    './middleware/uploads_auth.js': {
      lines: 10,
      statements: 7,
      functions: 15
    }
  },
  verbose: true,
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: './coverage', outputName: 'junit.xml' }]
  ]
};
