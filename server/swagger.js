const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: '境途同游 API',
      version: '1.0.0',
      description: '境途同游 VRChat群组管理网站 API文档',
      contact: { name: 'JingTu Team' }
    },
    servers: [
      { url: 'http://localhost:3456/api', description: '本地开发环境' },
      { url: '/api', description: '生产环境' }
    ],
    components: {
      securitySchemes: {
        SessionAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'connect.sid',
          description: '用户登录会话cookie'
        },
        CSRFToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-csrf-token',
          description: 'CSRF防护token'
        }
      }
    },
    security: [{ SessionAuth: [], CSRFToken: [] }]
  },
  // 注意：登录/2FA 等认证端点的 @swagger 块写在 service 层
  // （auth_local_service.js），只扫 routes/ 会让这些接口从文档里整体消失。
  apis: ['./routes/*.js', './auth_local_service.js']
};

const swaggerSpec = swaggerJsdoc(options);

function setupSwagger(app, deps = {}) {
  const { requireSuperAdmin } = deps;
  // P2-169：/api-docs 与 /api-docs.json 叠加超管鉴权——即使误开 ENABLE_SWAGGER=1，
  // 未登录/非超管用户也无法读取全量 API 文档（含管理端点与安全注解），
  // 防止 /ops 式的无鉴权公开信息收集面。未传入鉴权函数时退化为不设防中间件。
  const guard = requireSuperAdmin || ((req, res, next) => next());
  app.use('/api-docs', guard, swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/api-docs.json', guard, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

module.exports = { setupSwagger, swaggerSpec };
