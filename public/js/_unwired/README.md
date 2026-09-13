# 未接线的前端模块（parked）

这里的文件**不会被任何 HTML 页面加载**，放在这里是为了不再伪装成"已实现的功能"。

## admin-db.js

一整套数据库管理面板（25 个函数：表列表、慢查询、进程、OPTIMIZE/REPAIR 等）。

未接线的证据：

- `public/index.html` 里没有任何 `<script src="/js/admin-db.js">`
- 它引用的 25 个 DOM id（`dbTableList`、`[data-dbtab]`、`dbStatusContent` …）
  在 index.html 里**一个都不存在**
- 它定义的 `checkDbPermission` / `switchDbTab` 与 `admin-vrc.js` / `ui.js` 里的
  同名函数冲突。由于本项目所有 JS 都是全局脚本，真接进来会**静默覆盖**，
  且哪一份生效取决于 `<script>` 的先后顺序

它留下的痕迹曾经骗过人：`admin-vrc.js` 里写着
`function checkDbPermission() { if (typeof window.showDbSection === 'function') showDbSection(); }`,
`ui.js` 的 `switchTab('admin')` 里写着
`if (typeof checkDbPermission === 'function') checkDbPermission();` ——
看起来接好了，实际上 `showDbSection` 从来不存在，永远是空操作。这些残留已删除。

**后端接口仍然可用**（`server/routes/database.js`、`server/routes/backups.js`），
将来要恢复这个面板，需要：

1. 在 `public/index.html` 的管理标签页里补上对应的 DOM
2. 加 `<script defer src="/js/admin-db.js">`
3. 解决与 `admin-vrc.js` / `ui.js` 的同名函数冲突
   （`server/__tests__/round6-sync-regressions.test.js` 里有专门的重复定义扫描会拦住）
