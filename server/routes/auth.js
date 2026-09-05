/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: 用户认证相关接口
 */

/**
 * 境途同游 V5.2 — 认证路由（委托壳）
 * 本地密码登录 + VRChat 双轨登录 + /init 引导。
 * 业务实现按域拆分：本地认证 auth_local_service.js / VRChat 认证 auth_vrc_service.js /
 * 密码找回 auth_reset_service.js。本文件只做原位委托注册，挂载顺序与拆分前一致。
 */
const express = require('express');
const router = express.Router();

// ==================== 本地认证（/init /preview /login /logout /session /change-password）（业务层 auth_local_service.js） ====================
require('../auth_local_service').registerLocalRoutes(router);

// ==================== VRChat 登录/绑定/解绑（业务层 auth_vrc_service.js） ====================
require('../auth_vrc_service').registerVrcRoutes(router);

// ==================== 密码找回（忘记密码）（业务层 auth_reset_service.js） ====================
require('../auth_reset_service').registerResetRoutes(router);

module.exports = router;
