// tests/quick-start.js
// Script de démarrage rapide qui vérifie et configure tout automatiquement

import { spawn } from 'child_process';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class QuickStart {
  constructor() {
    this.steps = [];
    this.errors = [];
  }

  log(message, type = 'info') {
    const prefix = {
      info: chalk.blue('ℹ'),
      success: chalk.green('✓'),
      error: chalk.red('✗'),
      warning: chalk.yellow('⚠')
    };
    
    console.log(`${prefix[type]} ${message}`);
  }

  async checkDependencies() {
    this.log('Vérification des dépendances...');
    
    // Vérifier que node_modules existe
    if (!fs.existsSync(path.join(__dirname, '../node_modules'))) {
      this.log('node_modules non trouvé. Installation des dépendances...', 'warning');
      await this.runCommand('npm', ['install']);
    } else {
      this.log('Dépendances installées', 'success');
    }
  }

  async checkRedis() {
    this.log('Vérification de Redis...');
    
    try {
      const result = await this.runCommand('redis-cli', ['ping'], { capture: true });
      if (result.includes('PONG')) {
        this.log('Redis est actif', 'success');
      } else {
        throw new Error('Redis ne répond pas');
      }
    } catch (error) {
      this.log('Redis n\'est pas démarré ou n\'est pas installé', 'error');
      this.log('Installez Redis et démarrez-le avec: redis-server', 'info');
      this.errors.push('Redis non disponible');
    }
  }

  async checkConfig() {
    this.log('Vérification de la configuration...');
    
    const configFiles = [
      'api.yaml',
      'cache.yaml',
      'database.yaml',
      'logging.yaml',
      'main.yaml',
      'security.yaml',
      'security-patterns.yaml'
    ];
    
    const configDir = path.join(__dirname, '../config');
    let allPresent = true;
    
    for (const file of configFiles) {
      if (!fs.existsSync(path.join(configDir, file))) {
        this.log(`Fichier de configuration manquant: ${file}`, 'error');
        allPresent = false;
      }
    }
    
    if (allPresent) {
      this.log('Tous les fichiers de configuration sont présents', 'success');
    } else {
      this.errors.push('Fichiers de configuration manquants');
    }
  }

  async setupTestDatabase() {
    this.log('Configuration de la base de données de test...');
    
    const testDbPath = path.join(__dirname, '../test-data/test-database.db');
    
    if (fs.existsSync(testDbPath)) {
      this.log('Base de données de test existante trouvée', 'info');
      const response = await this.prompt('Voulez-vous la recréer? (o/N) ');
      
      if (response.toLowerCase() === 'o') {
        await this.runCommand('node', ['tests/setup-test-data.js']);
        this.log('Base de données de test recréée', 'success');
      } else {
        this.log('Utilisation de la base existante', 'info');
      }
    } else {
      this.log('Création de la base de données de test...', 'info');
      await this.runCommand('node', ['tests/setup-test-data.js']);
      this.log('Base de données de test créée', 'success');
    }
  }

  async startAPI() {
    this.log('\nDémarrage de l\'API...', 'info');
    
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: 'test-data/test-database.db',
      LOG_LEVEL: 'info'
    };
    
    const api = spawn('npm', ['start'], {
      env,
      stdio: 'pipe'
    });
    
    // Attendre que l'API soit prête
    return new Promise((resolve) => {
      api.stdout.on('data', (data) => {
        const output = data.toString();
        process.stdout.write(chalk.gray(output));
        
        if (output.includes('Server ready at')) {
          this.log('API démarrée avec succès!', 'success');
          resolve(api);
        }
      });
      
      api.stderr.on('data', (data) => {
        process.stderr.write(chalk.red(data.toString()));
      });
      
      api.on('error', (error) => {
        this.log(`Erreur lors du démarrage de l'API: ${error.message}`, 'error');
        this.errors.push('Impossible de démarrer l\'API');
      });
    });
  }

  async runTests() {
    this.log('\nOptions de test disponibles:', 'info');
    console.log(chalk.cyan(`
  1. Validation automatique complète
  2. Tests unitaires Jest
  3. Tests manuels
  4. Apollo Studio (interface graphique)
  5. Quitter
    `));
    
    const choice = await this.prompt('Votre choix (1-5): ');
    
    switch (choice) {
      case '1':
        await this.runCommand('node', ['tests/validate-api.js']);
        break;
      case '2':
        await this.runCommand('npm', ['test']);
        break;
      case '3':
        await this.runCommand('node', ['tests/manual-test.js']);
        break;
      case '4':
        this.log('Ouvrez https://studio.apollographql.com', 'info');
        this.log('Connectez-vous à http://localhost:4000/graphql', 'info');
        this.log('Utilisez les requêtes du fichier graphql-test-queries.graphql', 'info');
        break;
      case '5':
        return false;
      default:
        this.log('Choix invalide', 'error');
    }
    
    return true;
  }

  async runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        stdio: options.capture ? 'pipe' : 'inherit',
        shell: true
      });
      
      let output = '';
      
      if (options.capture) {
        proc.stdout.on('data', (data) => {
          output += data.toString();
        });
      }
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Command failed with code ${code}`));
        }
      });
      
      proc.on('error', reject);
    });
  }

  prompt(question) {
    return new Promise((resolve) => {
      process.stdout.write(question);
      process.stdin.once('data', (data) => {
        resolve(data.toString().trim());
      });
    });
  }

  async run() {
    console.log(chalk.bold.blue('\n🚀 Démarrage rapide de l\'API GraphQL DuckDB\n'));
    
    // Vérifications préliminaires
    await this.checkDependencies();
    await this.checkRedis();
    await this.checkConfig();
    
    if (this.errors.length > 0) {
      this.log('\nDes erreurs ont été détectées:', 'error');
      this.errors.forEach(err => console.log(chalk.red(`  - ${err}`)));
      this.log('\nCorrigez ces erreurs avant de continuer.', 'warning');
      process.exit(1);
    }
    
    // Configuration de la base de test
    await this.setupTestDatabase();
    
    // Démarrage de l'API
    const apiProcess = await this.startAPI();
    
    // Attendre un peu pour que l'API soit bien démarrée
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Boucle de test
    let continueTests = true;
    while (continueTests) {
      continueTests = await this.runTests();
    }
    
    // Arrêt de l'API
    this.log('\nArrêt de l\'API...', 'info');
    apiProcess.kill('SIGTERM');
    
    this.log('\n✅ Terminé!', 'success');
  }
}

// Exécuter si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  const quickStart = new QuickStart();
  
  // Activer l'entrée stdin
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  
  quickStart.run()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(chalk.red('\n❌ Erreur fatale:'), error);
      process.exit(1);
    });
}

export { QuickStart };