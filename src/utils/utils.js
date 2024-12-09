// Définition de la condition "WHERE" du filtre
const buildWhereClause = (filters, structuredFilters) => {
    let whereClause = '';
    if (filters) {
      whereClause += `(${filters})`;
    }
    if (structuredFilters && structuredFilters.length > 0) {
      const structuredClause = structuredFilters
        .map((filter) => `${filter.key} ${filter.operator} '${filter.value}'`)
        .join(' AND ');
      whereClause += filters ? ` AND (${structuredClause})` : structuredClause;
    }
    return whereClause ? `WHERE ${whereClause}` : '';
};
  
exports.buildWhereClause = buildWhereClause;  