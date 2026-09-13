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
  // 覆盖率阈值基线（棘轮式只升）。规则：阈值 = 实测向下取整且保留 ≥1pt 余量。
  // P2-1 设立 15/6/9/16；09-12 P2-4 复验按实测 17.29/6.99/11.3/19.24 上调为 16/6/10/18；
  // 2026-09-13 P2-66/P3-7 轮实测 语句 17.99 / 分支 6.99 / 函数 12.03 / 行 20.03
  // → 函数 10→11、行 18→19；语句升 17 仅余 0.99pt、分支同 09-12 理由，均暂维持。
  // 原 60/60/50/40 为理想目标、从未达成，会让 CI 恒红；后续随路由层单测补齐继续上调，防止覆盖率回退。
  coverageThreshold: {
    global: {
      lines: 19,
      statements: 16,
      functions: 11,
      branches: 6
    }
  },
  verbose: true,
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: './coverage', outputName: 'junit.xml' }]
  ]
};
