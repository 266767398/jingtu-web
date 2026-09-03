const { body, param, validationResult } = require('express-validator');

const validateRequest = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map(validation => validation.run(req)));
    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }
    res.status(400).json({
      success: false,
      error: '参数验证失败',
      details: errors.array().map(e => ({ field: e.path, message: e.msg }))
    });
  };
};

const userValidations = {
  create: [
    body('loginId').notEmpty().withMessage('登录ID不能为空'),
    body('displayName').notEmpty().withMessage('显示名不能为空'),
    body('password').isLength({ min: 6 }).withMessage('密码至少6位'),
    body('role').isIn(['super_admin', 'admin', 'member']).withMessage('角色无效')
  ],
  update: [
    param('id').isInt().withMessage('用户ID必须为整数'),
    body('displayName').optional().notEmpty().withMessage('显示名不能为空'),
    body('role').optional().isIn(['super_admin', 'admin', 'member']).withMessage('角色无效')
  ]
};

const eventValidations = {
  create: [
    body('title').notEmpty().withMessage('活动标题不能为空'),
    body('eventTime').isISO8601().withMessage('活动时间格式无效'),
    body('location').optional().isLength({ max: 200 }).withMessage('地点不能超过200字'),
    body('maxParticipants').optional().isInt({ min: 1 }).withMessage('最大人数必须为正整数'),
    body('type').optional().isIn(['normal', 'birthday', 'meeting', 'vrchat']).withMessage('活动类型无效')
  ],
  update: [
    param('id').isInt().withMessage('活动ID必须为整数'),
    body('title').optional().notEmpty().withMessage('活动标题不能为空'),
    body('eventTime').optional().isISO8601().withMessage('活动时间格式无效')
  ]
};

const postValidations = {
  create: [
    body('content').notEmpty().withMessage('动态内容不能为空'),
    body('content').isLength({ max: 2000 }).withMessage('动态内容不能超过2000字'),
    body('privacy').optional().isIn(['public', 'group', 'private']).withMessage('隐私设置无效')
  ]
};

const migrationValidations = {
  testConnection: [
    body('host').notEmpty().withMessage('数据库地址不能为空'),
    body('port').isInt({ min: 1, max: 65535 }).withMessage('端口必须在1-65535之间'),
    body('database').notEmpty().withMessage('数据库名不能为空'),
    body('user').notEmpty().withMessage('用户名不能为空')
  ],
  migrate: [
    body('sourceDb').notEmpty().withMessage('源数据库配置不能为空'),
    body('targetDb').notEmpty().withMessage('目标数据库配置不能为空'),
    body('sourceDb.host').notEmpty().withMessage('源数据库地址不能为空'),
    body('targetDb.host').notEmpty().withMessage('目标数据库地址不能为空')
  ],
  replaceConfig: [
    body('files').isArray().withMessage('文件列表必须为数组'),
    body('dbConfig').notEmpty().withMessage('数据库配置不能为空'),
    body('dbConfig.host').notEmpty().withMessage('数据库地址不能为空'),
    body('dbConfig.port').isInt({ min: 1, max: 65535 }).withMessage('端口必须在1-65535之间'),
    body('dbConfig.database').notEmpty().withMessage('数据库名不能为空'),
    body('dbConfig.user').notEmpty().withMessage('用户名不能为空')
  ]
};

module.exports = {
  validateRequest,
  userValidations,
  eventValidations,
  postValidations,
  migrationValidations,
  body,
  param,
  validationResult
};
