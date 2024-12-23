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
        getFactTable: async (_, { indicator, filters, structuredFilters, limit, offset, sort = [] }) => {
            const whereClause = buildWhereClause(filters, structuredFilters);
            
            // Build sorting clause
            const sortClause = sort.length > 0 
                ? `ORDER BY ${sort.map(s => `${s.field} ${s.order}`).join(', ')}` 
                : '';

            const query = `
                SELECT * FROM fact_table
                ${whereClause} 
                ${sortClause}
                LIMIT ${limit} OFFSET ${offset}
            `;
            const countQuery = `SELECT COUNT(*) as total FROM fact_table ${whereClause}`;
            
            try {
                logger.info(`Fetching sorted fact table for indicator: ${indicator}`);
                const data = await db.all(query);
                const total = (await db.all(countQuery))[0].total;
                
                return {
                    data,
                    total,
                    hasNextPage: offset + limit < total,
                };
            } catch (err) {
                logger.error(`Error fetching sorted fact table: ${err.message}`);
                throw new Error('Failed to fetch fact table');
            }
        },
        getAggregatedFacts: async (_, { 
            indicator, 
            filters, 
            structuredFilters, 
            groupBy, 
            aggregation, 
            sort = [] 
        }) => {
            const whereClause = buildWhereClause(filters, structuredFilters);
            const aggregationQuery = {
                SUM: 'SUM',
                AVG: 'AVG',
                MAX: 'MAX',
                MIN: 'MIN',
                COUNT: 'COUNT',
            }[aggregation];

            // Build sorting clause
            const sortClause = sort.length > 0 
                ? `ORDER BY ${sort.map(s => 
                    s.field === 'key' ? s.field : `aggregatedValue ${s.order}`
                ).join(', ')}` 
                : '';

            const query = `
                SELECT ${groupBy} as key, ${aggregationQuery}(value) as aggregatedValue
                FROM fact_table
                ${whereClause}
                GROUP BY ${groupBy}
                ${sortClause}
            `;

            try {
                logger.info(`Fetching sorted aggregated facts for indicator: ${indicator}`);
                return await db.all(query);
            } catch (err) {
                logger.error(`Error fetching sorted aggregated facts: ${err.message}`);
                throw new Error('Failed to fetch aggregated facts');
            }
        },
        const getSelectOptions: async (_, { fieldName, limit, searchTerm }, { connection }) => {
            try {
                // If fieldName is a list of two strings
                if (Array.isArray(fieldName)) {
                    if (fieldName.length !== 2) {
                        throw new Error('fieldName must be a single string or an array of exactly two strings');
                    }
        
                    const [field1, field2] = fieldName;
                    const dimensionResults = await Promise.all([
                        connection.all('SELECT is_categorical FROM metadata WHERE name = ?', [field1]),
                        connection.all('SELECT is_categorical FROM metadata WHERE name = ?', [field2])
                    ]);
        
                    const [field1Metadata, field2Metadata] = dimensionResults;
                    const field1IsCategorical = field1Metadata[0]?.is_categorical;
                    const field2IsCategorical = field2Metadata[0]?.is_categorical;
        
                    // Case 1: Both have dimension tables
                    if (field1IsCategorical && field2IsCategorical) {
                        const [field1Dims, field2Dims] = await Promise.all([
                            connection.all(`SELECT COUNT(*) as count FROM dim_${field1}`),
                            connection.all(`SELECT COUNT(*) as count FROM dim_${field2}`)
                        ]);
        
                        const [groupField, optionField] = field1Dims[0].count <= field2Dims[0].count 
                            ? [field1, field2] 
                            : [field2, field1];
        
                        const groupQuery = `
                            SELECT value, label 
                            FROM dim_${groupField}
                            LIMIT ?
                        `;
        
                        const optionQuery = `
                            SELECT DISTINCT ${optionField} as value
                            FROM fact_table
                            LIMIT ?
                        `;
        
                        const [groupValues, optionValues] = await Promise.all([
                            connection.all(groupQuery, [limit]),
                            connection.all(optionQuery, [limit])
                        ]);
        
                        return {
                            group: groupValues.map(row => ({
                                value: String(row.value),
                                label: row.label
                            })),
                            options: optionValues.map(row => ({
                                value: String(row.value),
                                label: String(row.value)
                            }))
                        };
                    }
        
                    // Case 2: One has a dimension table, the other doesn't
                    if (field1IsCategorical !== field2IsCategorical) {
                        const categoricalField = field1IsCategorical ? field1 : field2;
                        const nonCategoricalField = field1IsCategorical ? field2 : field1;
        
                        const categoricalQuery = `
                            SELECT value, label 
                            FROM dim_${categoricalField}
                            LIMIT ?
                        `;
        
                        const nonCategoricalQuery = `
                            SELECT DISTINCT ${nonCategoricalField} as value
                            FROM fact_table
                            LIMIT ?
                        `;
        
                        const [categoricalValues, nonCategoricalValues] = await Promise.all([
                            connection.all(categoricalQuery, [limit]),
                            connection.all(nonCategoricalQuery, [limit])
                        ]);
        
                        return {
                            group: categoricalValues.map(row => ({
                                value: String(row.value),
                                label: row.label
                            })),
                            options: nonCategoricalValues.map(row => ({
                                value: String(row.value),
                                label: String(row.value)
                            }))
                        };
                    }
        
                    // Case 3: Neither has a dimension table
                    const field1Values = await connection.all(`
                        SELECT DISTINCT ${field1} as value
                        FROM fact_table
                        LIMIT ?
                    `, [limit]);
        
                    const field2Values = await connection.all(`
                        SELECT DISTINCT ${field2} as value
                        FROM fact_table
                        LIMIT ?
                    `, [limit]);
        
                    const [groupField, optionField] = field1Values.length <= field2Values.length 
                        ? [field1, field2] 
                        : [field2, field1];
        
                    return {
                        group: (groupField === field1 ? field1Values : field2Values).map(row => ({
                            value: String(row.value),
                            label: String(row.value)
                        })),
                        options: (optionField === field1 ? field1Values : field2Values).map(row => ({
                            value: String(row.value),
                            label: String(row.value)
                        }))
                    };
                }
        
                // Original single field logic remains the same
                const [metadataRow] = await connection.all(
                    'SELECT is_categorical FROM metadata WHERE name = ?', 
                    [fieldName]
                );
        
                if (metadataRow.is_categorical) {
                    let query = `
                        SELECT value, label 
                        FROM dim_${fieldName}
                    `;
                    const params = [];
        
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
        
                let query = `
                    SELECT DISTINCT ${fieldName} as value
                    FROM fact_table
                `;
                const params = [];
        
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
                }));
            } catch (error) {
                console.error('Error fetching select options:', error);
                throw new Error('Failed to fetch select options');
            }
        },
    },
};

exports.resolvers = resolvers;

// Enhanced resolvers with timeout handling
const resolvers = {
    Query: {
      getMetaData: async (_, { name }, { metadataLoader }) => {
        try {
          return await Promise.race([
            metadataLoader.load(name),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Request timeout')), 5000)
            )
          ]);
        } catch (err) {
          logger.error(`Error fetching metadata: ${err.message}`);
          throw new Error(err.message === 'Request timeout' 
            ? 'Request timed out' 
            : 'Failed to fetch metadata'
          );
        }
      },
  
      getDimensionTable: async (_, { name }, { dimensionLoader }) => {
        try {
          return await Promise.race([
            dimensionLoader.load(name),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Request timeout')), 5000)
            )
          ]);
        } catch (err) {
          logger.error(`Error fetching dimension table: ${err.message}`);
          throw new Error(err.message === 'Request timeout'
            ? 'Request timed out'
            : 'Failed to fetch dimension table'
          );
        }
      },
  
      getFactTable: async (_, args, { factLoader }) => {
        try {
          const data = await Promise.race([
            factLoader.load(args),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Request timeout')), 10000)
            )
          ]);
  
          const countKey = `count:${JSON.stringify(args)}`;
          let total = await redis.get(countKey);
          
          if (!total) {
            const db = await dbPool.acquire();
            try {
              const whereClause = buildWhereClause(args.filters, args.structuredFilters);
              const countQuery = `SELECT COUNT(*) as total FROM fact_table ${whereClause}`;
              const result = await promisify(db.all.bind(db))(countQuery);
              total = result[0].total;
              await redis.set(countKey, total, 'EX', 300);
            } finally {
              dbPool.release(db);
            }
          }
  
          return {
            data,
            total: parseInt(total),
            hasNextPage: args.offset + args.limit < parseInt(total),
          };
        } catch (err) {
          logger.error(`Error fetching fact table: ${err.message}`);
          throw new Error(err.message === 'Request timeout'
            ? 'Request timed out'
            : 'Failed to fetch fact table'
          );
        }
      },
  
      // ... (keep other resolver implementations with similar timeout handling)
    }
  };