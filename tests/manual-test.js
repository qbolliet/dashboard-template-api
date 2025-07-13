// Script pour tester manuellement l'API
// Importation des modules
import { request } from 'graphql-request';

const endpoint = 'http://localhost:4000/graphql';

/**
 * Teste manuellement l'API avec des requêtes réelles
 */
async function manualTest() {
  console.log('🧪 Test manuel de l\'API GraphQL\n');

  try {
    // Test 1: Métadonnées
    console.log('1. Test des métadonnées...');
    const metadataQuery = `
      query {
        getMetaData(name: "country") {
          name
          label
          is_categorical
        }
      }
    `;
    const metadataResult = await request(endpoint, metadataQuery);
    console.log('✅ Métadonnées:', metadataResult);

    // Test 2: Dimensions
    console.log('\n2. Test des dimensions...');
    const dimensionQuery = `
      query {
        getDimensionTable(name: "country") {
          value
          label
        }
      }
    `;
    const dimensionResult = await request(endpoint, dimensionQuery);
    console.log('✅ Dimensions (premiers 3):', dimensionResult.getDimensionTable.slice(0, 3));

    // Test 3: Faits
    console.log('\n3. Test de la table des faits...');
    const factQuery = `
      query {
        getFactTable(limit: 5, offset: 0) {
          data {
            value
          }
          total
          hasNextPage
        }
      }
    `;
    const factResult = await request(endpoint, factQuery);
    console.log('✅ Faits:', {
      count: factResult.getFactTable.data.length,
      total: factResult.getFactTable.total,
      hasNextPage: factResult.getFactTable.hasNextPage
    });

    // Test 4: Agrégations
    console.log('\n4. Test des agrégations...');
    const aggregationQuery = `
      query {
        getAggregatedFacts(
          groupBy: "country"
          aggregation: AVG
          limit: 5
          offset: 0
        ) {
          key
          keyLabel
          aggregatedValue
          count
        }
      }
    `;
    const aggregationResult = await request(endpoint, aggregationQuery);
    console.log('✅ Agrégations:', aggregationResult.getAggregatedFacts);

    console.log('\n✅ Tous les tests manuels sont passés avec succès !');

  } catch (error) {
    console.error('❌ Erreur lors des tests:', error);
  }
}

// Debug: afficher les valeurs pour diagnostiquer
console.log('Debug - import.meta.url:', import.meta.url);
console.log('Debug - process.argv[1]:', process.argv[1]);

// Exécuter si appelé directement (méthode simplifiée)
manualTest();