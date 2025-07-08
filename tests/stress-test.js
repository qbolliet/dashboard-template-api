// Test de charge pour l'API
// Importation des modules
import { request } from 'graphql-request';

const endpoint = 'http://localhost:4000/graphql';

/**
 * Effectue un test de charge sur l'API
 */
async function stressTest() {
  console.log('🔥 Test de charge de l\'API GraphQL\n');

  const queries = [
    // Requête simple
    {
      name: 'Simple Query',
      query: `query { getMetaData(name: "country") { name } }`
    },
    // Requête moyenne
    {
      name: 'Medium Query',
      query: `
        query {
          getFactTable(limit: 100, offset: 0) {
            data { value }
            total
          }
        }
      `
    },
    // Requête complexe
    {
      name: 'Complex Query',
      query: `
        query {
          facts: getFactTable(limit: 50, offset: 0) {
            data {
              value
              dimensionDetails { name value label }
            }
          }
          aggregated: getAggregatedFacts(
            groupBy: "country"
            aggregation: AVG
          ) {
            key
            aggregatedValue
          }
        }
      `
    }
  ];

  for (const testQuery of queries) {
    console.log(`\nTest: ${testQuery.name}`);
    console.log('------------------------');

    const iterations = 100;
    const startTime = Date.now();
    const times = [];

    // Exécuter plusieurs requêtes en parallèle
    const promises = [];
    for (let i = 0; i < iterations; i++) {
      const queryStart = Date.now();
      promises.push(
        request(endpoint, testQuery.query)
          .then(() => {
            times.push(Date.now() - queryStart);
          })
          .catch(error => {
            console.error(`Erreur itération ${i}:`, error.message);
          })
      );
    }

    await Promise.all(promises);
    
    const totalTime = Date.now() - startTime;
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);

    console.log(`✅ ${iterations} requêtes exécutées en ${totalTime}ms`);
    console.log(`   - Temps moyen: ${avgTime.toFixed(2)}ms`);
    console.log(`   - Temps min: ${minTime}ms`);
    console.log(`   - Temps max: ${maxTime}ms`);
    console.log(`   - Requêtes/seconde: ${(iterations / (totalTime / 1000)).toFixed(2)}`);
  }

  console.log('\n✅ Test de charge terminé !');
}

// Exécuter si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  stressTest();
}