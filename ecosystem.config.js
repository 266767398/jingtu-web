// 境途同游 Web — PM2 进程守护配置
// 用法（在项目根目录执行）：
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup
// 说明：
//   - instances=1 / fork：CSRF token 与接口限流计数已支持 Redis 共享态（配置 REDIS_HOST 后生效），
//     但 WebSocket 用户映射、在线状态、VRChat pipeline 状态仍在进程内存，未做跨实例共享，
//     请勿改为 cluster / 多副本（详见 docs/03-部署与运维.md）。
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
      // P2-96：崩溃重启采用指数退避（500ms 起步逐次翻倍），防止持续失败
      // 窗口（配置错误/数据库不可达）高频拉起放大日志与数据库压力。
      exp_backoff_restart_delay: 500,
      watch: false,
      max_memory_restart: '1024M',
      // P2-80：PM2 stdout/stderr 落盘位置。应用业务日志由 server/logger.js 写入
      // logs/（按天 + 10MB 上限轮转），这里承接的是 console 输出（启动横幅、
      // 未捕获异常栈等），避免默认 ~/.pm2/pm2.log 无限增长。
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // pm2-*.log 自身的按大小轮转与保留份数由 pm2-logrotate 模块管理：
      //   pm2 install pm2-logrotate
      // （install.sh 启动阶段会尝试自动安装，失败时手动执行上句即可）
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
