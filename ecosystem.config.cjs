// PM2 process file for production (CloudPanel). Start with: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'weatherback',
      script: 'server.js',
      instances: 1,
      // Values can be overridden from the shell when running `pm2 start`; `pm2 save` stores them.
      env: {
        NODE_ENV: 'production',
        // Must match the "App Port" set when creating the Node.js site in CloudPanel.
        PORT: process.env.PORT || 3000,
        HOST: process.env.HOST || '127.0.0.1',
        // NOAA asks API clients to identify themselves. Use your email or site URL.
        WEATHERBACK_CONTACT: process.env.WEATHERBACK_CONTACT || 'you@example.com',
      },
    },
  ],
};
