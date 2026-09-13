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

function setupSwagger(app) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

module.exports = { setupSwagger, swaggerSpec };
