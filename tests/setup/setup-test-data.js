// Creates (or resets) the test DuckLake catalogs.
// Must be run as a separate process (npm run test:setup) BEFORE npm test,
// because DuckLake allows only one write connection at a time on Windows.
// During tests the pool opens the catalogs in READ_ONLY mode (set via DEFAULT_READ_ONLY=true
// in setup-env.js), allowing all Jest VM contexts to share the same files concurrently.
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const metadataRows = [
    ['indicator', 'Economic Indicator', 'int', 'BIGINT', true, true],
    ['country', 'Country', 'int', 'BIGINT', true, true],
    ['date', 'Date', 'datetime', 'TIMESTAMP_NS', false, false],
    ['value', 'Measurement Value', 'float', 'DOUBLE', false, false],
    ['kind', 'Data Kind', 'int', 'BIGINT', true, false],
    ['horizon', 'Forecast Horizon', 'float', 'DOUBLE', false, false],
    ['week', 'Week Number', 'float', 'DOUBLE', false, false],
    ['model', 'Model Type', 'float', 'DOUBLE', true, false],
    ['training', 'Training Set', 'float', 'DOUBLE', true, false]
];

function generateValue(indicator, country, date, kind, multiplier = 1.0) {
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
    return (baseValue + monthVariation + randomVariation) * multiplier;
}

async function createCatalog(conn, alias, catalogPath, dataPath, valueMultiplier = 1.0) {
    if (fs.existsSync(catalogPath)) {
        fs.unlinkSync(catalogPath);
    }
    if (fs.existsSync(dataPath)) {
        fs.rmSync(dataPath, { recursive: true, force: true });
    }
    fs.mkdirSync(dataPath, { recursive: true });

    await conn.run(
        `ATTACH 'ducklake:${catalogPath}' AS "${alias}" (DATA_PATH '${dataPath}/')`
    );

    await conn.run(`
        CREATE TABLE "${alias}".main.metadata (
            name VARCHAR,
            label VARCHAR,
            python_type VARCHAR,
            sql_type VARCHAR,
            is_categorical BOOLEAN,
            is_primary_key BOOLEAN
        )
    `);

    const dimensions = ['country', 'indicator', 'kind', 'model', 'training'];
    for (const dim of dimensions) {
        await conn.run(`
            CREATE TABLE "${alias}".main.dim_${dim} (
                value BIGINT,
                label VARCHAR
            )
        `);
    }

    await conn.run(`
        CREATE TABLE "${alias}".main.fact_table (
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

    for (const meta of metadataRows) {
        await conn.run(
            `INSERT INTO "${alias}".main.metadata (name, label, python_type, sql_type, is_categorical, is_primary_key) VALUES (?, ?, ?, ?, ?, ?)`,
            meta
        );
    }

    for (const [dimName, rows] of Object.entries(dimensionData)) {
        for (const row of rows) {
            await conn.run(
                `INSERT INTO "${alias}".main.dim_${dimName} (value, label) VALUES (?, ?)`,
                [row.value, row.label]
            );
        }
    }

    const startDate = new Date('2022-01-01');
    const endDate = new Date('2024-12-31');
    let insertCount = 0;

    for (const country of dimensionData.country.slice(0, 5)) {
        for (const indicator of dimensionData.indicator.slice(0, 4)) {
            for (const kind of dimensionData.kind.slice(0, 2)) {
                const currentDate = new Date(startDate);
                while (currentDate <= endDate) {
                    const value = generateValue(indicator, country, currentDate, kind, valueMultiplier);
                    const horizon = kind.value === 2 ? Math.floor(Math.random() * 12) + 1 : 0;
                    const week = Math.floor((currentDate.getDate() - 1) / 7) + 1;
                    const model = dimensionData.model[Math.floor(Math.random() * dimensionData.model.length)].value;
                    const training = dimensionData.training[Math.floor(Math.random() * dimensionData.training.length)].value;

                    await conn.run(
                        `INSERT INTO "${alias}".main.fact_table
                         (indicator, country, date, value, kind, horizon, week, model, training)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [indicator.value, country.value, currentDate.toISOString(),
                         value, kind.value, horizon, week, model, training]
                    );

                    insertCount++;
                    if (insertCount % 100 === 0) {
                        process.stdout.write(`\r  [${alias}] ${insertCount} records...`);
                    }
                    currentDate.setMonth(currentDate.getMonth() + 1);
                }
            }
        }
    }

    console.log(`\n  [${alias}] ${insertCount} records inserted (multiplier: ×${valueMultiplier})`);
}

async function setupTestData() {
    const dataDir = path.resolve(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();

    try {
        try {
            await conn.run("LOAD ducklake;");
        } catch (_) {
            await conn.run("FORCE INSTALL ducklake FROM community; LOAD ducklake;");
        }

        await createCatalog(
            conn,
            'default',
            path.resolve(dataDir, 'test-default.ducklake'),
            path.resolve(dataDir, 'test-default_data'),
            1.00
        );

        await createCatalog(
            conn,
            'macroeconomics',
            path.resolve(dataDir, 'test-macroeconomics.ducklake'),
            path.resolve(dataDir, 'test-macroeconomics_data'),
            1.05
        );

        await createCatalog(
            conn,
            'public_finance',
            path.resolve(dataDir, 'test-public-finance.ducklake'),
            path.resolve(dataDir, 'test-public-finance_data'),
            0.93
        );

    } finally {
        // closeSync exists but does NOT release the Windows file lock on DuckLake's SQLite
        // metadata file. This is intentional when run as a standalone setup process — the
        // process exits immediately after, which releases all file handles.
        instance.closeSync();
    }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    setupTestData()
        .then(() => {
            console.log('Test DuckLake catalogs ready.');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Failed to set up test data:', error);
            process.exit(1);
        });
}

export { setupTestData };
