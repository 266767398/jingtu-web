// 境途同游 Web — PM2 进程守护配置
// 用法（在项目根目录执行）：
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup
// 说明：
//   - instances=1 / fork：CSRF token 与接口限流计数已支持 Redis 共享态（配置 REDIS_HOST 后生效），
//     但 WebSocket 用户映射、在线状态、VRChat pipeline 状态仍在进程内存，未做跨实例共享，
//     请勿改为 cluster / 多副本（详见 docs/06-部署与运维.md）。
//   - cwd 用 __dirname 推导为 server/，无论在哪里启动 pm2 都能正确定位。
//   - .env 由应用自身从项目根目录读取，无需在此重复列环境变量。
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'jingtu-web',
      cwd: path.join(__dirname, 'server'),
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1024M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
