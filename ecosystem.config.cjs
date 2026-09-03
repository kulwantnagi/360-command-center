// PM2 process file for a VPS. Start with: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'kn360',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
