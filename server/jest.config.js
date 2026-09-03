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
    'auth.js',
    'utils.js',
    'db.js',
    'middleware/**/*.js',
    'notification-service.js',
    'logger.js',
    'security_alert.js'
  ],
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      lines: 60,
      statements: 60,
      functions: 50,
      branches: 40
    }
  },
  verbose: true,
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: './coverage', outputName: 'junit.xml' }]
  ]
};
