module.exports = {
  apps: [
    {
      name: "Shovelfishadmin",
      script: "./artifacts/api-server/dist/index.mjs",
      cwd: "/var/www/ShovelfishadminV1",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 3024,
        BASE_URL: "http://187.127.169.225:3024",
        MONGODB_URI: "mongodb+srv://sairajkoyande_db_user:NdEdiAfOxPf43dek@fishfrontend.7sexpjs.mongodb.net",
        SESSION_SECRET: "N+sLoTPRIVALoyG9KZg8BEhKC9NNxOSlqfNCDEyxEMIej55cNCHOE1bjIaGh+VFlDXgg9Oh8Wbtgr73PTjkfDQ==",
        WABA_API_KEY: "",
        WABA_PHONE_ID: "",
        CUSTOMER_EXPORT_PASSWORD: "Sovel@132231",
        QZ_PRIVATE_KEY: ``,
        QZ_CERTIFICATE: ``,
        RAZORPAY_KEY_ID: '',
        RAZORPAY_KEY_SECRET: '',
      },
    },
  ],
};
