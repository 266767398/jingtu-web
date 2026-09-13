module.exports = {
  testEnvironment: 'node',
  // 仅匹配 __tests__/ 目录下的 Jest 测试。
  // 注意：test/ 目录下的 security.test.js、share-auth-boundary.test.js 是 node:test 原生测试，
  // 由 `node --test` 运行，不能用宽泛的 '**/*.test.js' 误匹配进来。
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
    'security_alert.js'
  ],
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  // 覆盖率阈值基线（P2-1 设立 15/6/9/16；2026-09-12 P2-4 复验时按「随 P2-4/P2-6 上调」
  // 承诺实测上调：真实值 语句 17.29 / 分支 6.99 / 函数 11.3 / 行 19.24，取留 ~1pt 余量）。
  // 原 60/60/50/40 为理想目标、从未达成，会让 CI 恒红；分支因真实值距阈值余量不足暂维持 6，
  // 后续随路由层单测补齐继续上调，防止覆盖率回退。
  coverageThreshold: {
    global: {
      lines: 18,
      statements: 16,
      functions: 10,
      branches: 6
    }
  },
  verbose: true,
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: './coverage', outputName: 'junit.xml' }]
  ]
};
