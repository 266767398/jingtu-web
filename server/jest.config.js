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
    'mailer.js',
    // P2-152①：此前 vrc_pipeline/webhook/backup-core/schedule/tasks/auth_*_service/settings/validation 等
    // 核心模块完全不在统计范围，缺失被掩盖——先全部纳入立可见基线（0% 也照实呈现），
    // 后续按「向下取整+1pt余量」棘轮逐轮上调门槛。
    'vrc_pipeline.js',
    'webhook.js',
    'backup-core.js',
    'schedule.js',
    'tasks.js',
    'auth_local_service.js',
    'auth_reset_service.js',
    'auth_vrc_service.js',
    'auth_session.js',
    'settings.js',
    'validation.js',
    'share-auth-util.js',
    'activation_code_service.js',
    'cache_service.js',
    'media_providers.js',
    'world_cache.js',
    'route_guard.js',
    'video_utils.js'
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
  // P2-152（2026-10-01）：collectCoverageFrom 纳入核心模块后统计口径扩大，
  // 新增的 schedule/tasks/cache_service 等零守卫模块摊薄整体，实测基线
  // 20.18/9.41/16.41/21.95 → 按「向下取整+1pt 余量」棘轮定为 19/8/15/20
  // （仍高于原 16/6/11/19，符合只升规则）。
  // 同时为本轮补测模块（auth_local/auth_reset/auth_session/webhook/backup-core）与
  // P2-153 覆盖的 routes/files、routes/backups 逐文件设 floor：阈值 = 实测向下取整 -1pt。
  coverageThreshold: {
    global: {
      lines: 20,
      statements: 19,
      functions: 15,
      branches: 8
    },
    './auth.js': {
      lines: 81,
      statements: 78,
      functions: 84,
      branches: 56
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
      // P2-153：uploads_auth 补测后实测 90.54/77.04/100/92.98，回填 branches 并整体上调
      // P3-140（2026-10-01）：shareVerifyCache 缓存路径补 11 例动态测试后实测 98.68/97.89/100/89.04，
      // 门槛维持不动（棘轮只升不降，余量更宽）
      lines: 91,
      statements: 89,
      functions: 98,
      branches: 76
    },
    // P2-152：本轮补测模块逐文件 floor（阈值 = 实测向下取整 -1pt）
    './auth_session.js': {
      lines: 99,
      statements: 99,
      functions: 99,
      branches: 94
    },
    './auth_local_service.js': {
      lines: 61,
      statements: 53,
      functions: 86,
      branches: 40
    },
    './auth_reset_service.js': {
      lines: 79,
      statements: 76,
      functions: 82,
      branches: 72
    },
    './webhook.js': {
      lines: 86,
      statements: 84,
      functions: 58,
      branches: 84
    },
    './backup-core.js': {
      lines: 58,
      statements: 55,
      functions: 59,
      branches: 53
    },
    './routes/files.js': {
      lines: 46,
      statements: 45,
      functions: 59,
      branches: 36
    },
    './routes/backups.js': {
      lines: 55,
      statements: 55,
      functions: 54,
      branches: 21
    }
  },
  verbose: true,
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: './coverage', outputName: 'junit.xml' }]
  ]
};
