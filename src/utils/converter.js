// Fonction de conversion d'un array en objet
/**
 * Converts array results from DuckDB to properly structured objects
 * @param {Array} results - The query results
 * @param {Array} columnNames - The column names for the query
 * @returns {Array} Array of objects with named properties
 */
function convertArrayToObject(results, columnNames) {
    console.log('Converting results:', results);
    console.log('Column names:', columnNames);
    
    // Si le résultat est déjà un array d'objets, il est renvoyé tel quel
    if (results.length > 0 && typeof results[0] === 'object' && !Array.isArray(results[0])) {
      console.log('Results already in object format');
      return results;
    }
    
    // Sinon l'array est converti en objet
    return results.map(row => {
      if (Array.isArray(row)) {
        // Création d'un objet en utilisant les noms de colonnes
        return columnNames.reduce((obj, colName, index) => {
          if (index < row.length) {
            obj[colName] = row[index];
          }
          return obj;
        }, {});
      }
      return row; // Si n'est pas un array, renvoi le résultat tel quel
    });
  }
  
  module.exports = { convertArrayToObject };