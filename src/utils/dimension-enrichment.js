// Utilitaire pour l'enrichissement en masse des dimensions
/**
 * Utility for bulk dimension enrichment
 * Optimizes dimension loading by pre-loading all unique values
 */

// /!\ Une autre manière de faire serait de faire un JOIN dans la requête SQL des faits, cela serait encore plus efficace mais on perdrait un peu de la flexibilté de graphQL
/**
 * Enrichit un ensemble de faits avec leurs détails de dimension
 * @param {Array} facts - Tableau des faits à enrichir
 * @param {Object} loaders - Loaders GraphQL
 * @returns {Promise<Array>} Faits enrichis avec dimensionDetails
 */
export async function enrichFactsWithDimensions(facts, loaders) {
    if (!facts || facts.length === 0) {
        return facts;
    }

    // Champs à exclure de l'enrichissement
    const excludedFields = ['value', '_groupByField'];
    
    // Collecte de tous les champs de dimension uniques
    const dimensionFieldsSet = new Set();
    const dimensionValuesMap = new Map(); // fieldName -> Set of values
    
    facts.forEach(fact => {
        if (!fact || typeof fact !== 'object') return;
        
        Object.keys(fact).forEach(key => {
            if (!excludedFields.includes(key) && fact[key] !== null) {
                dimensionFieldsSet.add(key);
                
                if (!dimensionValuesMap.has(key)) {
                    dimensionValuesMap.set(key, new Set());
                }
                dimensionValuesMap.get(key).add(fact[key]);
            }
        });
    });

    if (dimensionFieldsSet.size === 0) {
        return facts.map(fact => ({ ...fact, dimensionDetails: [] }));
    }

    const dimensionFields = Array.from(dimensionFieldsSet);
    
    // Chargement des métadonnées pour identifier les dimensions catégorielles
    const metadataPromises = dimensionFields.map(fieldName => 
        loaders.metadata.load(fieldName)
    );
    
    const metadataResults = await Promise.all(metadataPromises);
    
    // Création d'un map des métadonnées pour un accès rapide
    const metadataMap = new Map();
    dimensionFields.forEach((fieldName, index) => {
        metadataMap.set(fieldName, metadataResults[index]);
    });

    // Collecte de toutes les valeurs à charger pour les dimensions catégorielles
    const dimensionLoadRequests = [];
    
    dimensionFields.forEach(fieldName => {
        const metadata = metadataMap.get(fieldName);
        const values = dimensionValuesMap.get(fieldName);
        
        if (metadata && metadata.is_categorical && values.size > 0) {
            values.forEach(value => {
                dimensionLoadRequests.push({
                    dimensionName: fieldName,
                    value: value
                });
            });
        }
    });

    // Chargement en masse de tous les détails de dimension
    let dimensionDetailsMap = new Map();
    
    if (dimensionLoadRequests.length > 0) {
        const dimensionResults = await Promise.all(
            dimensionLoadRequests.map(request => 
                loaders.dimensionValue.load(request)
            )
        );
        
        // Création d'un map pour un accès rapide
        dimensionLoadRequests.forEach((request, index) => {
            const key = `${request.dimensionName}:${request.value}`;
            dimensionDetailsMap.set(key, dimensionResults[index]);
        });
    }

    // Enrichissement de chaque fait avec ses détails de dimension
    return facts.map(fact => {
        if (!fact || typeof fact !== 'object') {
            return { ...fact, dimensionDetails: [] };
        }

        const factDimensionFields = Object.keys(fact).filter(
            key => !excludedFields.includes(key) && fact[key] !== null
        );

        if (factDimensionFields.length === 0) {
            return { ...fact, dimensionDetails: [] };
        }

        const dimensionDetails = factDimensionFields.map(fieldName => {
            const value = fact[fieldName];
            const metadata = metadataMap.get(fieldName);

            if (metadata && metadata.is_categorical) {
                const key = `${fieldName}:${value}`;
                const dimensionDetail = dimensionDetailsMap.get(key);
                
                if (dimensionDetail) {
                    return dimensionDetail;
                }
            }

            // Si non catégorielle ou pas trouvée, retourner la valeur brute
            return {
                name: fieldName,
                value: value,
                label: value
            };
        });

        return {
            ...fact,
            dimensionDetails: dimensionDetails
        };
    });
}

/**
 * Enrichit un ensemble de faits agrégés avec leurs labels de clé
 * @param {Array} aggregatedFacts - Tableau des faits agrégés
 * @param {string} groupByField - Champ utilisé pour le regroupement
 * @param {Object} loaders - Loaders GraphQL
 * @returns {Promise<Array>} Faits agrégés enrichis avec keyLabel
 */
export async function enrichAggregatedFactsWithLabels(aggregatedFacts, groupByField, loaders) {
    if (!aggregatedFacts || aggregatedFacts.length === 0 || !groupByField) {
        return aggregatedFacts;
    }

    // Vérification si le champ de regroupement est catégoriel
    const metadata = await loaders.metadata.load(groupByField);
    
    if (!metadata || !metadata.is_categorical) {
        return aggregatedFacts.map(fact => ({
            ...fact,
            keyLabel: fact.key,
            _groupByField: groupByField
        }));
    }

    // Collecte de toutes les valeurs uniques
    const uniqueKeys = [...new Set(aggregatedFacts.map(fact => fact.key))];
    
    // Chargement en masse des labels
    const labelPromises = uniqueKeys.map(key => 
        loaders.dimensionValue.load({
            dimensionName: groupByField,
            value: key
        })
    );

    const labelResults = await Promise.all(labelPromises);
    
    // Création d'un map pour un accès rapide
    const labelMap = new Map();
    uniqueKeys.forEach((key, index) => {
        labelMap.set(key, labelResults[index]?.label || key);
    });

    // Enrichissement des faits agrégés
    return aggregatedFacts.map(fact => ({
        ...fact,
        keyLabel: labelMap.get(fact.key),
        _groupByField: groupByField
    }));
}