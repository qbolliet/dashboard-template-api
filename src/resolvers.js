// Importation des modules
const fs = require('fs');
const yaml = require('js-yaml');
const duckdb = require('duckdb');

// Modules ad hoc
const { logger } = require("./utils/logger");
const { buildWhereClause } = require("./utils/utils");

// Chargement du fichier de configuration
const config = yaml.load(fs.readFileSync('./config/config.yaml', 'utf8'));

// Connexion à la base de données
const db = new duckdb.Database(config.PATH);


// Resolver functions
const resolvers = {
    Query: {
        getMetaData: async (_, { name }) => {
            logger.info(`Fetching metadata for variable: ${name}`);
            try {
                return await metadataLoader.load(name);
            } catch (err) {
                logger.error(`Error fetching metadata: ${err.message}`);
                throw new Error('Failed to fetch metadata');
            }
        },
        getDimensionTable: async (_, { name }) => {
            const query = `SELECT * FROM dim_${name}`;
            try {
                logger.info(`Fetching dimension table for: ${name}`);
                return await db.all(query);
            } catch (err) {
                logger.error(`Error fetching dimension table: ${err.message}`);
                throw new Error('Failed to fetch dimension table');
            }
        },
        getFactTable: async (_, { indicator, filters, structuredFilters, limit, offset }) => {
            const whereClause = buildWhereClause(filters, structuredFilters);
            const query = `
                SELECT * FROM fact_table
                ${whereClause} 
                LIMIT ${limit} OFFSET ${offset}
            `;
            const countQuery = `SELECT COUNT(*) as total FROM fact_table ${whereClause}`;
            try {
                logger.info(`Fetching fact table for indicator: ${indicator}`);
                const data = await db.all(query);
                const total = (await db.all(countQuery))[0].total;
            return {
                data,
                total,
                hasNextPage: offset + limit < total,
            };
            } catch (err) {
                logger.error(`Error fetching fact table: ${err.message}`);
                throw new Error('Failed to fetch fact table');
            }
        },
        getAggregatedFacts: async (_, { indicator, filters, structuredFilters, groupBy, aggregation }) => {
            const whereClause = buildWhereClause(filters, structuredFilters);
            const aggregationQuery = {
                SUM: 'SUM',
                AVG: 'AVG',
                MAX: 'MAX',
                MIN: 'MIN',
                COUNT: 'COUNT',
            }[aggregation];
            const query = `
                SELECT ${groupBy} as key, ${aggregationQuery}(value) as aggregatedValue
                FROM fact_table
                ${whereClause}
            GROUP BY ${groupBy}
            `;
            try {
                logger.info(`Fetching aggregated facts for indicator: ${indicator}, aggregation: ${aggregation}`);
                return await db.all(query);
            } catch (err) {
                logger.error(`Error fetching aggregated facts: ${err.message}`);
                throw new Error('Failed to fetch aggregated facts');
            }
        },
        getSelectOptions: async (_, { fieldName, limit, searchTerm }, { connection }) => {
            try {
                // First, check if the field is categorical
                const [metadataRow] = await connection.all(
                'SELECT is_categorical FROM metadata WHERE name = ?', 
                [fieldName]
                );
        
                // If categorical, fetch from dimension table
                if (metadataRow.is_categorical) {
                    let query = `
                        SELECT value, label 
                        FROM dim_${fieldName}
                    `;
                    const params = [];
            
                    // Add optional search term if provided
                    if (searchTerm) {
                        query += ' WHERE LOWER(label) LIKE LOWER(?)';
                        params.push(`%${searchTerm}%`);
                    }
            
                    query += ' LIMIT ?';
                    params.push(limit);
            
                    const dimensionValues = await connection.all(query, params);
                    
                    return dimensionValues.map(row => ({
                        value: String(row.value),
                        label: row.label
                    }));
                } 
                // If not categorical, extract distinct values from fact table
                else {
                    let query = `
                        SELECT DISTINCT ${fieldName} as value
                        FROM fact_table
                    `;
                    const params = [];
            
                    // For non-categorical fields, we might want to handle search differently
                    if (searchTerm) {
                        query += ' WHERE CAST(value AS VARCHAR) LIKE ?';
                        params.push(`%${searchTerm}%`);
                    }
            
                    query += ' LIMIT ?';
                    params.push(limit);
            
                    const distinctValues = await connection.all(query, params);
                    
                    return distinctValues.map(row => ({
                        value: String(row.value),
                        label: String(row.value)
                    }
                ));
            }
            } catch (error) {
                console.error('Error fetching select options:', error);
                throw new Error('Failed to fetch select options');
            }
        }
    },
};

exports.resolvers = resolvers;