// Script pour créer une base de données de test DuckLake indépendante
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Crée un catalogue DuckLake de test avec des données fictives.
 * Ce catalogue est totalement indépendant de la base de production.
 * Il est attaché en mode READ_ONLY=false pour permettre les insertions.
 */
async function setupTestData() {
    const dataDir = path.resolve(__dirname, '../data');

    // Création du dossier de données si nécessaire
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    // Chemins du catalogue DuckLake de test (catalogue "main" du test config)
    const catalogPath = path.resolve(dataDir, 'test-main.ducklake');
    const dataPath = path.resolve(dataDir, 'test-main_data');

    // Suppression de l'ancienne base de test si elle existe
    if (fs.existsSync(catalogPath)) {
        fs.unlinkSync(catalogPath);
        console.log('Ancienne base de test supprimée');
    }
    if (fs.existsSync(dataPath)) {
        fs.rmSync(dataPath, { recursive: true, force: true });
        console.log('Anciens fichiers Parquet supprimés');
    }

    // Création du répertoire de données Parquet
    fs.mkdirSync(dataPath, { recursive: true });

    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();

    try {
        console.log('Installation de l\'extension DuckLake...');
        await conn.run("INSTALL ducklake FROM community; LOAD ducklake;");

        // Attachement du catalogue DuckLake de test (alias "main")
        await conn.run(
            `ATTACH 'ducklake:${catalogPath}' AS main (DATA_PATH '${dataPath}/')`
        );
        console.log(`Catalogue DuckLake attaché : ${catalogPath}`);

        // Création de la table metadata
        await conn.run(`
            CREATE TABLE main.main.metadata (
                name VARCHAR PRIMARY KEY,
                label VARCHAR,
                python_type VARCHAR,
                sql_type VARCHAR,
                is_categorical BOOLEAN
            )
        `);
        console.log('Table metadata créée');

        // Création des tables de dimension
        const dimensions = ['country', 'indicator', 'kind', 'model', 'training'];
        for (const dim of dimensions) {
            await conn.run(`
                CREATE TABLE main.main.dim_${dim} (
                    value BIGINT PRIMARY KEY,
                    label VARCHAR
                )
            `);
            console.log(`Table dim_${dim} créée`);
        }

        // Création de la table des faits
        await conn.run(`
            CREATE TABLE main.main.fact_table (
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
        console.log('Table fact_table créée');

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
                'INSERT INTO main.main.metadata (name, label, python_type, sql_type, is_categorical) VALUES (?, ?, ?, ?, ?)',
                meta
            );
        }
        console.log('Métadonnées insérées');

        // Données de dimension
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

        for (const [dimName, data] of Object.entries(dimensionData)) {
            for (const row of data) {
                await conn.run(
                    `INSERT INTO main.main.dim_${dimName} (value, label) VALUES (?, ?)`,
                    [row.value, row.label]
                );
            }
            console.log(`Dimension dim_${dimName} remplie avec ${data.length} enregistrements`);
        }

        // Génération des données de fait
        const startDate = new Date('2022-01-01');
        const endDate = new Date('2024-12-31');
        let insertCount = 0;

        console.log('Génération des données de fait...');

        const generateValue = (indicator, country, date, kind) => {
            let baseValue;
            const monthVariation = Math.sin(date.getMonth() * Math.PI / 6) * 0.1;
            const randomVariation = (Math.random() - 0.5) * 0.2;

            switch (indicator.value) {
                case 1: baseValue = 2.5 + (country.value % 3) * 0.5; break;
                case 2: baseValue = 2.0 + (country.value % 4) * 0.3; break;
                case 3: baseValue = 7.0 - (country.value % 4) * 0.8; break;
                case 4: baseValue = -20 + (country.value % 5) * 15; break;
                case 5: baseValue = 3.5 + (country.value % 3) * 0.25; break;
                case 6: baseValue = 100 + (country.value % 4) * 5; break;
                default: baseValue = 50;
            }

            if (kind.value === 2) baseValue *= 1.1;
            else if (kind.value === 3) baseValue *= 0.95;

            return baseValue + monthVariation + randomVariation;
        };

        for (const country of dimensionData.country.slice(0, 5)) {
            for (const indicator of dimensionData.indicator.slice(0, 4)) {
                for (const kind of dimensionData.kind.slice(0, 2)) {
                    const currentDate = new Date(startDate);

                    while (currentDate <= endDate) {
                        const value = generateValue(indicator, country, currentDate, kind);
                        const horizon = kind.value === 2 ? Math.floor(Math.random() * 12) + 1 : 0;
                        const week = Math.floor((currentDate.getDate() - 1) / 7) + 1;
                        const model = dimensionData.model[Math.floor(Math.random() * dimensionData.model.length)].value;
                        const training = dimensionData.training[Math.floor(Math.random() * dimensionData.training.length)].value;

                        await conn.run(
                            `INSERT INTO main.main.fact_table
                             (indicator, country, date, value, kind, horizon, week, model, training)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [indicator.value, country.value, currentDate.toISOString(),
                             value, kind.value, horizon, week, model, training]
                        );

                        insertCount++;
                        if (insertCount % 100 === 0) {
                            process.stdout.write(`\r  ${insertCount} enregistrements insérés...`);
                        }

                        currentDate.setMonth(currentDate.getMonth() + 1);
                    }
                }
            }
        }

        console.log(`\n${insertCount} enregistrements insérés dans fact_table`);
        console.log(`Catalogue DuckLake de test créé : ${catalogPath}`);

    } catch (error) {
        console.error('Erreur lors de la création de la base de test :', error);
        throw error;
    } finally {
        if (conn) await conn.close();
    }
}

// Exécuter si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
    setupTestData()
        .then(() => {
            console.log('\nBase de données de test DuckLake créée avec succès !');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\nÉchec de la création de la base de test :', error);
            process.exit(1);
        });
}

export { setupTestData };
