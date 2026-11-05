module.exports = {
  apps: [
    {
      name: "Shovelfishadmin",
      script: "./artifacts/api-server/dist/index.mjs",
      cwd: "/var/www/SovelfishadminV1",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 3024,
        BASE_URL: "http://187.127.169.225:3024",
        MONGODB_URI: process.env.MONGODB_URI,
        SESSION_SECRET: process.env.SESSION_SECRET,
        WABA_API_KEY: process.env.WABA_API_KEY,
        WABA_PHONE_ID: process.env.WABA_PHONE_ID,
        CUSTOMER_EXPORT_PASSWORD: process.env.CUSTOMER_EXPORT_PASSWORD,
        QZ_PRIVATE_KEY: process.env.QZ_PRIVATE_KEY,
        QZ_CERTIFICATE: process.env.QZ_CERTIFICATE,
      },
    },
  ],
};
