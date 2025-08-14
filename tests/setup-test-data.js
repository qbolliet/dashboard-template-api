// Script pour créer une base de données de test indépendante
// Imortation des modules
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Crée une base de données de test avec des données fictives
 * Cette base est totalement indépendante de la base de production
 */
async function setupTestData() {
    // Créer le dossier de test s'il n'existe pas
    const testDir = path.resolve(__dirname, '../data');
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    // Base de données de test séparée
    const dbPath = path.resolve(testDir, 'test-database.db');
    
    // Supprimer l'ancienne base de test si elle existe
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        console.log('🗑️  Ancienne base de test supprimée');
    }

    const instance = await DuckDBInstance.create(dbPath);
    const conn = await instance.connect();

    try {
        console.log('🔧 Création de la base de données de test...');
        console.log(`📁 Emplacement : ${dbPath}`);

        // Création de la table metadata
        await conn.run(`
            CREATE TABLE IF NOT EXISTS metadata (
                name VARCHAR PRIMARY KEY,
                label VARCHAR,
                python_type VARCHAR,
                sql_type VARCHAR,
                is_categorical BOOLEAN
            )
        `);
        console.log('✓ Table metadata créée');

        // Création des tables de dimension
        const dimensions = ['country', 'indicator', 'kind', 'model', 'training'];
        for (const dim of dimensions) {
            await conn.run(`
                CREATE TABLE IF NOT EXISTS dim_${dim} (
                    value BIGINT PRIMARY KEY,
                    label VARCHAR
                )
            `);
            console.log(`✓ Table dim_${dim} créée`);
        }

        // Création de la table des faits
        await conn.run(`
            CREATE TABLE IF NOT EXISTS fact_table (
                indicator BIGINT,
                country BIGINT,
                date TIMESTAMP_NS,
                value DOUBLE,
                kind BIGINT,
                horizon DOUBLE,
                week DOUBLE,
                model DOUBLE,
                training DOUBLE
            )
        `);
        console.log('✓ Table fact_table créée');

        // Insertion des métadonnées
        const metadataInserts = [
            ['indicator', 'Economic Indicator', 'int', 'BIGINT', true],
            ['country', 'Country', 'int', 'BIGINT', true],
            ['date', 'Date', 'datetime', 'TIMESTAMP_NS', false],
            ['value', 'Measurement Value', 'float', 'DOUBLE', false],
            ['kind', 'Data Kind', 'int', 'BIGINT', true],
            ['horizon', 'Forecast Horizon', 'float', 'DOUBLE', false],
            ['week', 'Week Number', 'float', 'DOUBLE', false],
            ['model', 'Model Type', 'float', 'DOUBLE', true],
            ['training', 'Training Set', 'float', 'DOUBLE', true]
        ];

        for (const meta of metadataInserts) {
            await conn.run(
                'INSERT INTO metadata (name, label, python_type, sql_type, is_categorical) VALUES (?, ?, ?, ?, ?)',
                meta
            );
        }
        console.log('✓ Métadonnées insérées');

        // Données de dimension avec des valeurs réalistes
        const dimensionData = {
            country: [
                { value: 1, label: 'France' },
                { value: 2, label: 'Germany' },
                { value: 3, label: 'Spain' },
                { value: 4, label: 'Italy' },
                { value: 5, label: 'United Kingdom' },
                { value: 6, label: 'Netherlands' },
                { value: 7, label: 'Belgium' },
                { value: 8, label: 'Portugal' }
            ],
            indicator: [
                { value: 1, label: 'GDP Growth Rate' },
                { value: 2, label: 'Inflation Rate' },
                { value: 3, label: 'Unemployment Rate' },
                { value: 4, label: 'Trade Balance' },
                { value: 5, label: 'Interest Rate' },
                { value: 6, label: 'Consumer Confidence' }
            ],
            kind: [
                { value: 1, label: 'Actual' },
                { value: 2, label: 'Forecast' },
                { value: 3, label: 'Estimate' },
                { value: 4, label: 'Revised' }
            ],
            model: [
                { value: 1, label: 'Linear Regression' },
                { value: 2, label: 'ARIMA' },
                { value: 3, label: 'Neural Network' },
                { value: 4, label: 'Random Forest' },
                { value: 5, label: 'XGBoost' }
            ],
            training: [
                { value: 1, label: 'Training Set 2023' },
                { value: 2, label: 'Training Set 2024' },
                { value: 3, label: 'Validation Set' },
                { value: 4, label: 'Test Set' }
            ]
        };

        // Insérer les données de dimension
        for (const [dimName, data] of Object.entries(dimensionData)) {
            for (const row of data) {
                await conn.run(
                    `INSERT INTO dim_${dimName} (value, label) VALUES (?, ?)`,
                    [row.value, row.label]
                );
            }
            console.log(`✓ Dimension dim_${dimName} remplie avec ${data.length} enregistrements`);
        }

        // Générer des données de fait réalistes
        const startDate = new Date('2022-01-01');
        const endDate = new Date('2024-12-31');
        let insertCount = 0;

        console.log('🔄 Génération des données de fait...');

        // Fonction pour générer une valeur réaliste selon l'indicateur
        const generateValue = (indicator, country, date, kind) => {
            let baseValue;
            const monthVariation = Math.sin(date.getMonth() * Math.PI / 6) * 0.1;
            const randomVariation = (Math.random() - 0.5) * 0.2;
            
            // Valeurs de base par indicateur
            switch (indicator.value) {
                case 1: // GDP Growth Rate
                    baseValue = 2.5 + (country.value % 3) * 0.5;
                    break;
                case 2: // Inflation Rate
                    baseValue = 2.0 + (country.value % 4) * 0.3;
                    break;
                case 3: // Unemployment Rate
                    baseValue = 7.0 - (country.value % 4) * 0.8;
                    break;
                case 4: // Trade Balance (en milliards)
                    baseValue = -20 + (country.value % 5) * 15;
                    break;
                case 5: // Interest Rate
                    baseValue = 3.5 + (country.value % 3) * 0.25;
                    break;
                case 6: // Consumer Confidence
                    baseValue = 100 + (country.value % 4) * 5;
                    break;
                default:
                    baseValue = 50;
            }
            
            // Ajuster selon le type de données
            if (kind.value === 2) { // Forecast
                baseValue *= 1.1; // Les prévisions sont souvent optimistes
            } else if (kind.value === 3) { // Estimate
                baseValue *= 0.95; // Les estimations sont conservatrices
            }
            
            return baseValue + monthVariation + randomVariation;
        };

        // Générer des données mensuelles pour chaque combinaison
        for (const country of dimensionData.country.slice(0, 5)) { // 5 premiers pays
            for (const indicator of dimensionData.indicator.slice(0, 4)) { // 4 premiers indicateurs
                for (const kind of dimensionData.kind.slice(0, 2)) { // Actual et Forecast
                    
                    const currentDate = new Date(startDate);
                    
                    while (currentDate <= endDate) {
                        const value = generateValue(indicator, country, currentDate, kind);
                        const horizon = kind.value === 2 ? Math.floor(Math.random() * 12) + 1 : 0;
                        const week = Math.floor((currentDate.getDate() - 1) / 7) + 1;
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
                        
                        // Afficher la progression tous les 100 enregistrements
                        if (insertCount % 100 === 0) {
                            process.stdout.write(`\r  ${insertCount} enregistrements insérés...`);
                        }
                        
                        // Avancer d'un mois
                        currentDate.setMonth(currentDate.getMonth() + 1);
                    }
                }
            }
        }

        console.log(`\n✓ ${insertCount} enregistrements insérés dans fact_table`);

        // Statistiques finales
        const stats = await conn.run('SELECT COUNT(*) as total FROM fact_table');
        const totalRecords = (await stats.getRowObjects())[0].total;
        
        const dateStats = await conn.run('SELECT MIN(date) as min_date, MAX(date) as max_date FROM fact_table');
        const dateRange = await dateStats.getRowObjects();
        
        console.log(`\n📊 Statistiques finales :`);
        console.log(`   - Total d'enregistrements : ${totalRecords}`);
        console.log(`   - Période couverte : ${new Date(dateRange[0].min_date).toLocaleDateString()} à ${new Date(dateRange[0].max_date).toLocaleDateString()}`);
        console.log(`   - Base de données : ${dbPath}`);

    } catch (error) {
        console.error('❌ Erreur lors de la création de la base de test :', error);
        throw error;
    } finally {
        if (conn) await conn.close();
        // DuckDB instance doesn't have a close method, it's garbage collected
    }
}

// Exécuter si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
    setupTestData()
        .then(() => {
            console.log('\n✅ Base de données de test créée avec succès !');
            console.log('📌 Vous pouvez maintenant exécuter les tests avec cette base.');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Échec de la création de la base de test :', error);
            process.exit(1);
        });
}

export { setupTestData };