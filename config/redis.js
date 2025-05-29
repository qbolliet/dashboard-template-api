// Configuration du cache
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 10000,
  // Optionel : configuration du cluster
  // cluster: process.env.REDIS_CLUSTER === 'true' ? [
  //   { host: 'localhost', port: 6379 },
  //   { host: 'localhost', port: 6380 }
  // ] : null
};

export { redisConfig };