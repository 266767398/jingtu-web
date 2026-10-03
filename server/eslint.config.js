// P2-68：eslint v9 flat config。分级收口策略——
//  · 服务端（Node/CJS）：挂 eslint:recommended，作为 errors 强制；
//  · 前端脚本（../public/js）：曾设独立配置块（隐式全局架构，no-undef 不成立、
//    其余规则降级 warn），见 P3-146 说明——该块在 CI 下为死配置，已整体删除。
// P3-146：删除前端配置块（files: ../public/js/**/*.js）。CI lint job 只在 server/ 下执行
// `eslint .`，`.` 不会带入 ../public/js → 该块及其 ignores 均为死配置，前端 js 实际从未被
// lint。如未来要接管前端 js：在仓库根新增 lint:front 命令并挂独立 CI job，再按需恢复。
// 排除口径登记（有意为之，非遗漏）：test/、__tests__/、scripts/ 整段不设 lint 门禁——
// 一次性脚本/测试为工程内部工具，避免存量噪声阻塞收口；如需放开请逐目录评估。另：
// node_modules/coverage/uploads/fixtures/migrations/routes/_archive/_unwired/public/_dev、
// vendor/assets/captures/ai-scratch/backups/logs/.workbuddy/.codebuddy/.perf-backup/
// browser-audit/panel/public 均为忽略目录。
// 首版范围只收真实代码（server 核心 + routes/middleware + panel 面板）；
// 一次性脚本、覆盖率产物、上传目录全部 ignore。
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'uploads/**',
      'test/**',
      '__tests__/**',
      'fixtures/**',
      'migrations/**',
      'scripts/**',
      'routes/_archive/**',
      '../public/_dev/**',
      '../vendor/**',
      '../assets/**',
      '../captures/**',
      '../ai-scratch/**',
      '../backups/**',
      '../logs/**',
      '../.workbuddy/**',
      '../.codebuddy/**',
      '../.perf-backup/**',
      '../browser-audit/**',
      '../panel/public/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '../panel/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // 存量代码现实：catch 块注释占位、回调 err 形参备用等，先降噪、保正确性规则
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 存量未用变量 86 处（大头在 routes/groups.js），先 warn 记账、CI 不拦，
      // 清偿完毕后再升级回 error（棘轮策略，与 jest coverage 阈值同思路）。
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
    }
  }
];
