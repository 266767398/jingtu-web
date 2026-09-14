// P2-68：eslint v9 flat config。分级收口策略——
//  · 服务端（Node/CJS）：挂 eslint:recommended，作为 errors 强制；
//  · 前端脚本（../public/js）：跨 <script> 隐式全局是既有懒加载架构，no-undef 不成立，
//    其余推荐规则整体降级为 warn（只报不拦），待逐步清偿后升级。
// 首版范围只收真实代码（server 核心 + routes/middleware + public/js + panel 面板）；
// 一次性脚本、覆盖率产物、上传目录全部 ignore。
const js = require('@eslint/js');
const globals = require('globals');

// 把 eslint:recommended 的全部规则降级为 warn（保留各规则的选项参数）
function recommendedAsWarn() {
  const out = {};
  for (const [rule, def] of Object.entries(js.configs.recommended.rules)) {
    out[rule] = Array.isArray(def) ? ['warn', ...def.slice(1)] : 'warn';
  }
  return out;
}

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
      '../public/js/_archive/**',
      '../public/js/_unwired/**',
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
    } },
  {
    files: ['../public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser }
    },
    rules: {
      ...recommendedAsWarn(),
      // 前端跨脚本隐式全局（core.js 定义、其余模块顶层消费）是懒加载架构的一部分，
      // no-undef 在 ESLint 视野内无法闭合，关闭之；其余 recommended 规则以 warn 呈现。
      'no-undef': 'off'
    }
  }
];
