const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bill_management';
const MAX_RETRIES = 5;
const RETRY_INTERVAL = 5000;

let isConnected = false;
let retryCount = 0;

async function connectDB() {
  const options = {
    dbName: 'bill_management',
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 45000,
  };

  const attemptConnection = async () => {
    try {
      console.log(`[Database] Attempting connection to MongoDB (Attempt ${retryCount + 1}/${MAX_RETRIES})...`);
      await mongoose.connect(MONGODB_URI, options);
      isConnected = true;
      retryCount = 0;
      console.log('[Database] MongoDB connected successfully to:', mongoose.connection.host);
    } catch (err) {
      console.error(`[Database] Connection error: ${err.message}`);
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        console.warn(`[Database] Retrying connection in ${RETRY_INTERVAL / 1000}s...`);
        setTimeout(attemptConnection, RETRY_INTERVAL);
      } else {
        console.error('[Database] Failed to connect to MongoDB after maximum retries. Operating in degraded mode.');
      }
    }
  };

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    console.warn('[Database] Lost MongoDB connection. Reconnecting...');
    setTimeout(attemptConnection, RETRY_INTERVAL);
  });

  mongoose.connection.on('error', (err) => {
    console.error('[Database] MongoDB connection event error:', err.message);
  });

  await attemptConnection();
}

function checkDBHealth() {
  return {
    connected: isConnected && mongoose.connection.readyState === 1,
    state: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown',
    host: mongoose.connection.host || 'none'
  };
}

module.exports = {
  connectDB,
  checkDBHealth
};

