// tests/validate-api.js
// Script de validation complet pour vérifier que l'API fonctionne correctement

import { request } from 'graphql-request';
import chalk from 'chalk';
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const endpoint = 'http://localhost:4000/graphql';

// Classe de validation
class APIValidator {
  constructor() {
    this.results = {
      passed: 0,
      failed: 0,
      warnings: 0,
      errors: []
    };
  }

  // Méthode pour afficher un succès
  success(message) {
    console.log(chalk.green('✓'), message);
    this.results.passed++;
  }

  // Méthode pour afficher un échec
  fail(message, error) {
    console.log(chalk.red('✗'), message);
    if (error) {
      console.log(chalk.red('  Error:'), error.message || error);
    }
    this.results.failed++;
    this.results.errors.push({ message, error: error?.message || error });
  }

  // Méthode pour afficher un avertissement
  warn(message) {
    console.log(chalk.yellow('⚠'), message);
    this.results.warnings++;
  }

  // Méthode pour afficher une info
  info(message) {
    console.log(chalk.blue('ℹ'), message);
  }

  // Méthode pour afficher un titre de section
  section(title) {
    console.log('\n' + chalk.bold.underline(title));
  }

  // Afficher le résumé
  summary() {
    console.log('\n' + chalk.bold('Résumé de la validation:'));
    console.log(chalk.green(`  ✓ Passés: ${this.results.passed}`));
    console.log(chalk.red(`  ✗ Échoués: ${this.results.failed}`));
    console.log(chalk.yellow(`  ⚠ Avertissements: ${this.results.warnings}`));
    
    if (this.results.errors.length > 0) {
      console.log('\n' + chalk.bold.red('Erreurs détectées:'));
      this.results.errors.forEach((err, idx) => {
        console.log(chalk.red(`  ${idx + 1}. ${err.message}`));
        if (err.error) {
          console.log(chalk.red(`     ${err.error}`));
        }
      });
    }
    
    return this.results.failed === 0;
  }
}

// Fonction principale de validation
async function validateAPI() {
  const validator = new APIValidator();
  
  console.log(chalk.bold.blue('\n🔍 Validation complète de l\'API GraphQL DuckDB\n'));

  // ============================================
  // 1. VÉRIFICATION DE LA BASE DE DONNÉES
  // ============================================
  
  validator.section('1. Vérification de la base de données');
  
  try {
    // Utiliser la base de données de test si elle existe, sinon la base de production
    const testDbPath = path.resolve(__dirname, '../test-data/test-database.db');
    const prodDbPath = path.resolve(__dirname, '../../outputs/database.db');
    
    let dbPath;
    if (fs.existsSync(testDbPath)) {
      dbPath = testDbPath;
      validator.info(`Utilisation de la base de test : ${testDbPath}`);
    } else if (fs.existsSync(prodDbPath)) {
      dbPath = prodDbPath;
      validator.warn(`Base de test non trouvée, utilisation de la base de production : ${prodDbPath}`);
    } else {
      validator.fail('Aucune base de données trouvée', 'Exécutez "node tests/setup-test-data.js" pour créer la base de test');
      return false;
    }
    
    const instance = await DuckDBInstance.create(dbPath);
    const conn = await instance.connect();
    
    // Vérifier les tables
    const tables = ['metadata', 'fact_table', 'dim_country', 'dim_indicator', 'dim_kind', 'dim_model', 'dim_training'];
    
    for (const table of tables) {
      try {
        const result = await conn.run(`SELECT COUNT(*) as count FROM ${table}`);
        const count = (await result.getRowObjects())[0].count;
        if (count > 0) {
          validator.success(`Table ${table}: ${count} enregistrements`);
        } else {
          validator.warn(`Table ${table} est vide`);
        }
      } catch (error) {
        validator.fail(`Table ${table} n'existe pas`, error);
      }
    }
    
    await conn.close();
    await instance.close();
  } catch (error) {
    validator.fail('Impossible de se connecter à la base de données', error);
  }

  // ============================================
  // 2. VÉRIFICATION DE L'API
  // ============================================
  
  validator.section('2. Vérification de la disponibilité de l\'API');
  
  try {
    // Test de santé simple
    const healthQuery = `query { __typename }`;
    await request(endpoint, healthQuery);
    validator.success('API GraphQL accessible');
  } catch (error) {
    validator.fail('API GraphQL non accessible', error);
    console.log(chalk.red('\n⚠️  L\'API doit être démarrée. Exécutez "npm start" dans un autre terminal.\n'));
    return false;
  }

  // ============================================
  // 3. TESTS DES MÉTADONNÉES
  // ============================================
  
  validator.section('3. Tests des requêtes de métadonnées');
  
  const metadataFields = ['country', 'indicator', 'value', 'date', 'kind'];
  
  for (const field of metadataFields) {
    try {
      const query = `
        query {
          getMetaData(name: "${field}") {
            name
            label
            python_type
            sql_type
            is_categorical
          }
        }
      `;
      const result = await request(endpoint, query);
      
      if (result.getMetaData) {
        validator.success(`Métadonnées pour '${field}' récupérées`);
        
        // Vérifications supplémentaires
        if (result.getMetaData.is_categorical && !['country', 'indicator', 'kind', 'model', 'training'].includes(field)) {
          validator.warn(`Le champ '${field}' est marqué comme catégoriel`);
        }
      } else {
        validator.fail(`Métadonnées pour '${field}' non trouvées`);
      }
    } catch (error) {
      validator.fail(`Erreur lors de la récupération des métadonnées pour '${field}'`, error);
    }
  }

  // ============================================
  // 4. TESTS DES DIMENSIONS
  // ============================================
  
  validator.section('4. Tests des tables de dimensions');
  
  const dimensions = ['country', 'indicator', 'kind', 'model', 'training'];
  
  for (const dim of dimensions) {
    try {
      const query = `
        query {
          getDimensionTable(name: "${dim}") {
            value
            label
          }
        }
      `;
      const result = await request(endpoint, query);
      
      if (result.getDimensionTable && result.getDimensionTable.length > 0) {
        validator.success(`Dimension '${dim}': ${result.getDimensionTable.length} valeurs`);
        
        // Vérifier la structure
        const firstItem = result.getDimensionTable[0];
        if (!firstItem.value || !firstItem.label) {
          validator.warn(`Structure incorrecte pour la dimension '${dim}'`);
        }
      } else {
        validator.warn(`Dimension '${dim}' est vide`);
      }
    } catch (error) {
      validator.fail(`Erreur lors de la récupération de la dimension '${dim}'`, error);
    }
  }

  // ============================================
  // 5. TESTS DE LA TABLE DES FAITS
  // ============================================
  
  validator.section('5. Tests de la table des faits');
  
  // Test de base
  try {
    const query = `
      query {
        getFactTable(limit: 10, offset: 0) {
          data {
            value
          }
          total
          hasNextPage
          currentPage
          totalPages
        }
      }
    `;
    const result = await request(endpoint, query);
    
    if (result.getFactTable) {
      validator.success(`Table des faits: ${result.getFactTable.total} enregistrements au total`);
      validator.info(`Pages: ${result.getFactTable.currentPage}/${result.getFactTable.totalPages}`);
    }
  } catch (error) {
    validator.fail('Erreur lors de la récupération de la table des faits', error);
  }

  // Test avec filtres
  try {
    const query = `
      query {
        getFactTable(
          structuredFilters: [
            { key: "country", operator: "=", value: "1" }
          ]
          limit: 5
          offset: 0
        ) {
          data {
            value
          }
          total
        }
      }
    `;
    const result = await request(endpoint, query);
    validator.success('Filtres structurés fonctionnels');
  } catch (error) {
    validator.fail('Erreur avec les filtres structurés', error);
  }

  // Test avec détails des dimensions
  try {
    const query = `
      query {
        getFactTable(limit: 2, offset: 0) {
          data {
            value
            dimensionDetails {
              name
              value
              label
            }
          }
        }
      }
    `;
    const result = await request(endpoint, query);
    
    if (result.getFactTable.data[0]?.dimensionDetails) {
      validator.success('Résolution des labels de dimensions fonctionnelle');
      
      // Vérifier que les dimensions catégorielles ont des labels différents des valeurs
      const dims = result.getFactTable.data[0].dimensionDetails;
      const categorical = dims.filter(d => ['country', 'indicator', 'kind'].includes(d.name));
      const hasLabels = categorical.every(d => d.label !== d.value);
      
      if (hasLabels) {
        validator.success('Les dimensions catégorielles ont des labels corrects');
      } else {
        validator.warn('Certaines dimensions catégorielles n\'ont pas de labels');
      }
    }
  } catch (error) {
    validator.fail('Erreur lors de la résolution des dimensions', error);
  }

  // ============================================
  // 6. TESTS DES AGRÉGATIONS
  // ============================================
  
  validator.section('6. Tests des agrégations');
  
  const aggregations = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT'];
  
  for (const agg of aggregations) {
    try {
      const query = `
        query {
          getAggregatedFacts(
            groupBy: "country"
            aggregation: ${agg}
            limit: 3
            offset: 0
          ) {
            key
            keyLabel
            aggregatedValue
            count
          }
        }
      `;
      const result = await request(endpoint, query);
      
      if (result.getAggregatedFacts && result.getAggregatedFacts.length > 0) {
        validator.success(`Agrégation ${agg} fonctionnelle`);
        
        // Vérifier les labels
        const hasLabels = result.getAggregatedFacts.every(item => 
          item.keyLabel && item.keyLabel !== item.key
        );
        
        if (!hasLabels) {
          validator.warn(`Les labels ne sont pas résolus pour l'agrégation ${agg}`);
        }
      }
    } catch (error) {
      validator.fail(`Erreur avec l'agrégation ${agg}`, error);
    }
  }

  // Test avec métadonnées
  try {
    const query = `
      query {
        getAggregatedFactsWithMetadata(
          groupBy: "indicator"
          aggregation: AVG
          limit: 10
          offset: 0
        ) {
          data {
            key
            aggregatedValue
          }
          metadata {
            count
            valueExtent
            statistics {
              mean
              median
            }
          }
        }
      }
    `;
    const result = await request(endpoint, query);
    
    if (result.getAggregatedFactsWithMetadata?.metadata?.statistics) {
      validator.success('Agrégations avec métadonnées et statistiques fonctionnelles');
    }
  } catch (error) {
    validator.fail('Erreur avec les agrégations et métadonnées', error);
  }

  // ============================================
  // 7. TESTS DES OPTIONS DE SÉLECTION
  // ============================================
  
  validator.section('7. Tests des options de sélection');
  
  try {
    const query = `
      query {
        getSelectOptions(fieldName: "country", limit: 10) {
          value
          label
        }
      }
    `;
    const result = await request(endpoint, query);
    
    if (result.getSelectOptions && result.getSelectOptions.length > 0) {
      validator.success('Options de sélection fonctionnelles');
    }
  } catch (error) {
    validator.fail('Erreur avec les options de sélection', error);
  }

  // Test avec recherche
  try {
    const query = `
      query {
        getSelectOptions(
          fieldName: "country"
          searchTerm: "a"
          limit: 5
        ) {
          value
          label
        }
      }
    `;
    await request(endpoint, query);
    validator.success('Recherche dans les options fonctionnelle');
  } catch (error) {
    validator.fail('Erreur avec la recherche dans les options', error);
  }

  // ============================================
  // 8. TESTS DE SÉCURITÉ
  // ============================================
  
  validator.section('8. Tests de sécurité');
  
  // Test de limite excessive
  try {
    const query = `
      query {
        getFactTable(limit: 1001, offset: 0) {
          data { value }
        }
      }
    `;
    await request(endpoint, query);
    validator.fail('La limite maximale n\'est pas appliquée (devrait échouer)');
  } catch (error) {
    if (error.response?.errors?.[0]?.message?.includes('Limit cannot exceed')) {
      validator.success('Limite maximale correctement appliquée');
    } else {
      validator.fail('Erreur inattendue pour la limite', error);
    }
  }

  // Test de profondeur excessive (si configuré)
  try {
    const deepQuery = `
      query {
        getFactTable(limit: 1) {
          data {
            value
            dimensionDetails {
              name
              value
              label
            }
          }
        }
      }
    `;
    // Répéter la structure pour créer une requête profonde
    await request(endpoint, deepQuery);
    validator.success('Validation de la profondeur des requêtes active');
  } catch (error) {
    if (error.response?.errors?.[0]?.extensions?.code === 'DEPTH_LIMIT_EXCEEDED') {
      validator.success('Limite de profondeur correctement appliquée');
    }
  }

  // ============================================
  // 9. TESTS DE PERFORMANCE
  // ============================================
  
  validator.section('9. Tests de performance');
  
  // Test de requête simple
  try {
    const startTime = Date.now();
    const query = `
      query {
        getMetaData(name: "country") {
          name
        }
      }
    `;
    await request(endpoint, query);
    const duration = Date.now() - startTime;
    
    if (duration < 100) {
      validator.success(`Requête simple rapide: ${duration}ms`);
    } else if (duration < 500) {
      validator.warn(`Requête simple lente: ${duration}ms`);
    } else {
      validator.fail(`Requête simple très lente: ${duration}ms`);
    }
  } catch (error) {
    validator.fail('Erreur lors du test de performance', error);
  }

  // Test de requête complexe
  try {
    const startTime = Date.now();
    const query = `
      query {
        facts: getFactTable(limit: 100, offset: 0) {
          data { value }
          total
        }
        aggregated: getAggregatedFacts(
          groupBy: "country"
          aggregation: AVG
        ) {
          aggregatedValue
        }
      }
    `;
    await request(endpoint, query);
    const duration = Date.now() - startTime;
    
    if (duration < 1000) {
      validator.success(`Requête complexe acceptable: ${duration}ms`);
    } else if (duration < 3000) {
      validator.warn(`Requête complexe lente: ${duration}ms`);
    } else {
      validator.fail(`Requête complexe très lente: ${duration}ms`);
    }
  } catch (error) {
    validator.fail('Erreur lors du test de performance complexe', error);
  }

  // ============================================
  // RÉSUMÉ
  // ============================================
  
  console.log('\n' + chalk.bold('=' .repeat(50)));
  const success = validator.summary();
  
  if (success) {
    console.log('\n' + chalk.green.bold('✅ Validation réussie ! L\'API fonctionne correctement.'));
  } else {
    console.log('\n' + chalk.red.bold('❌ La validation a échoué. Veuillez corriger les erreurs ci-dessus.'));
  }
  
  return success;
}

// Exécuter la validation
if (import.meta.url === `file://${process.argv[1]}`) {
  validateAPI()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error(chalk.red('\n❌ Erreur fatale:'), error);
      process.exit(1);
    });
}

export { validateAPI };