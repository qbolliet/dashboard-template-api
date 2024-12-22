// Fonction de Timeout
const withTimeout = (promise, ms, message) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(message)), ms)
      )
    ]);
  };
  
  exports.withTimeout = withTimeout;