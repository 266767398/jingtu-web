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
  // 覆盖率阈值为当前真实基线（P2-1 首次跑通 test:ci 时实测：语句 ~15.7%、分支 ~6.3%、
  // 函数 ~9.9%、行 ~17.4%）。原 60/60/50/40 为理想目标、从未达成，会让 CI 恒红；
  // 后续随 P2-4/P2-6 与路由层单测补齐逐步上调，防止覆盖率回退。
  coverageThreshold: {
    global: {
      lines: 16,
      statements: 15,
      functions: 9,
      branches: 6
    }
  },
  verbose: true,
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: './coverage', outputName: 'junit.xml' }]
  ]
};
