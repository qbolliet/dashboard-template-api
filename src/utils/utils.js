// Définition de la condition "WHERE" du filtre
const buildWhereClause = (filters, structuredFilters) => {
    let whereClause = '';
    if (filters) {
      whereClause += `(${filters})`;
    }
    if (structuredFilters && structuredFilters.length > 0) {
      const structuredClause = structuredFilters
        .map((filter) => {
          const { key, operator, value, values } = filter;
          
          // Gestion des opérateurs IN et NOT IN avec des arrays
          if ((operator === 'IN' || operator === 'NOT IN') && values && values.length > 0) {
            // Formatage des valeurs pour les opérateurs IN/NOT IN
            const formattedValues = values.map(val => {
              // Détection automatique du type de données
              if (val === null || val === undefined) {
                return 'NULL';
              }
              // Si c'est un nombre, ne pas mettre de quotes
              if (!isNaN(val) && !isNaN(parseFloat(val))) {
                return val;
              }
              // Si c'est un boolean
              if (val === 'true' || val === 'false') {
                return val;
              }
              // Sinon, traiter comme string et échapper les quotes
              return `'${val.replace(/'/g, "''")}'`;
            }).join(', ');
            
            return `${key} ${operator} (${formattedValues})`;
          }
          
          // Gestion des autres opérateurs avec une seule valeur
          if (value !== undefined && value !== null) {
            // Détection automatique du type de données pour une seule valeur
            if (!isNaN(value) && !isNaN(parseFloat(value))) {
              return `${key} ${operator} ${value}`;
            }
            if (value === 'true' || value === 'false') {
              return `${key} ${operator} ${value}`;
            }
            // Échapper les quotes pour les strings
            return `${key} ${operator} '${value.replace(/'/g, "''")}'`;
          }
          
          // Fallback pour les opérateurs sans valeur (comme IS NULL)
          return `${key} ${operator}`;
        })
        .join(' AND ');
      whereClause += filters ? ` AND (${structuredClause})` : structuredClause;
    }
    return whereClause ? `WHERE ${whereClause}` : '';
};
  
export { buildWhereClause };  