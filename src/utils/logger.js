// Importation des modules
const winston = require('winston');


// Initialisation du logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: 'logs/api.log' }),
    ],
});

exports.logger = logger;