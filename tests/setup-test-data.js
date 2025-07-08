// Script pour insérer des données de test dans la base
// Importation des modules
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Insère des données de test dans la base DuckDB
 */
async function setupTestData() {
    const dbPath = path.resolve(__dirname, '../outputs/database.db');
    const instance = await DuckDBInstance.create(dbPath);
    const conn = await instance.connect();

    try {
        console.log('🔧 Configuration des données de test...');

        // Nettoyage des tables existantes (optionnel)
        await conn.run('DELETE FROM fact_table');
        console.log('✓ Table fact_table nettoyée');

        // Insertion de données dans les dimensions
        const dimensionData = {
            country: [
                { value: 1, label: 'France' },
                { value: 2, label: 'Germany' },
                { value: 3, label: 'Spain' },
                { value: 4, label: 'Italy' },
                { value: 5, label: 'United Kingdom' }
            ],
            indicator: [
                { value: 1, label: 'GDP Growth' },
                { value: 2, label: 'Inflation Rate' },
                { value: 3, label: 'Unemployment Rate' },
                { value: 4, label: 'Trade Balance' }
            ],
            kind: [
                { value: 1, label: 'Actual' },
                { value: 2, label: 'Forecast' },
                { value: 3, label: 'Estimate' }
            ],
            model: [
                { value: 1, label: 'Linear Regression' },
                { value: 2, label: 'ARIMA' },
                { value: 3, label: 'Neural Network' }
            ],
            training: [
                { value: 1, label: 'Training Set A' },
                { value: 2, label: 'Training Set B' },
                { value: 3, label: 'Validation Set' }
            ]
        };

        // Vérifier et insérer les données de dimension
        for (const [dimName, data] of Object.entries(dimensionData)) {
            const checkQuery = `SELECT COUNT(*) as count FROM dim_${dimName}`;
            const result = await conn.run(checkQuery);
            const count = (await result.getRowsObject())[0].count;
            
            if (count === 0) {
                for (const row of data) {
                    await conn.run(
                        `INSERT INTO dim_${dimName} (value, label) VALUES (?, ?)`,
                        [row.value, row.label]
                    );
                }
                console.log(`✓ Dimension dim_${dimName} remplie avec ${data.length} enregistrements`);
            }
        }

        // Générer des données de fait
        const startDate = new Date('2023-01-01');
        const endDate = new Date('2024-12-31');
        let insertCount = 0;

        // Génération de données pour chaque combinaison
        for (const country of dimensionData.country) {
            for (const indicator of dimensionData.indicator) {
                for (const kind of dimensionData.kind) {
                    // Générer des données mensuelles
                    const currentDate = new Date(startDate);
                    
                    while (currentDate <= endDate) {
                        const value = Math.random() * 100 + (indicator.value * 10); // Valeur aléatoire basée sur l'indicateur
                        const horizon = Math.floor(Math.random() * 12) + 1; // Horizon 1-12 mois
                        const week = Math.floor((currentDate.getDate() - 1) / 7) + 1; // Semaine du mois
                        const model = dimensionData.model[Math.floor(Math.random() * dimensionData.model.length)].value;
                        const training = dimensionData.training[Math.floor(Math.random() * dimensionData.training.length)].value;

                        await conn.run(
                            `INSERT INTO fact_table (indicator, country, date, value, kind, horizon, week, model, training) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                indicator.value,
                                country.value,
                                currentDate.toISOString(),
                                value,
                                kind.value,
                                horizon,
                                week,
                                model,
                                training
                            ]
                        );
                        
                        insertCount++;
                        currentDate.setMonth(currentDate.getMonth() + 1);
                    }
                }
            }
        }

        console.log(`✓ ${insertCount} enregistrements insérés dans fact_table`);

        // Vérifier les métadonnées
        const metadataCheck = await conn.run('SELECT COUNT(*) as count FROM metadata');
        const metaCount = (await metadataCheck.getRowsObject())[0].count;
        
        if (metaCount === 0) {
            // Insérer les métadonnées si elles n'existent pas
            const metadataInserts = [
                ['indicator', 'Indicator', 'int', 'BIGINT', true],
                ['country', 'Country', 'int', 'BIGINT', true],
                ['date', 'Date', 'datetime', 'TIMESTAMP_NS', false],
                ['value', 'Value', 'float', 'DOUBLE', false],
                ['kind', 'Kind', 'int', 'BIGINT', true],
                ['horizon', 'Horizon', 'float', 'DOUBLE', false],
                ['week', 'Week', 'float', 'DOUBLE', false],
                ['model', 'Model', 'float', 'DOUBLE', true],
                ['training', 'Training', 'float', 'DOUBLE', true]
            ];

            for (const meta of metadataInserts) {
                await conn.run(
                    'INSERT INTO metadata (name, label, python_type, sql_type, is_categorical) VALUES (?, ?, ?, ?, ?)',
                    meta
                );
            }
            console.log('✓ Métadonnées insérées');
        }

        // Statistiques finales
        const stats = await conn.run('SELECT COUNT(*) as total FROM fact_table');
        const totalRecords = (await stats.getRowsObject())[0].total;
        console.log(`\n📊 Statistiques finales :`);
        console.log(`   - Total d'enregistrements dans fact_table : ${totalRecords}`);

    } catch (error) {
        console.error('❌ Erreur lors de la configuration des données de test :', error);
        throw error;
    } finally {
        await conn.close();
        await instance.close();
    }
}

// Exécuter si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
    setupTestData()
        .then(() => {
            console.log('\n✅ Configuration des données de test terminée avec succès !');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Échec de la configuration des données de test :', error);
            process.exit(1);
        });
}

export { setupTestData };