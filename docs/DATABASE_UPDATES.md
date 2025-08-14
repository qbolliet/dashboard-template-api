# Database Update Management

This document describes how the API handles daily database updates and the tools available for managing them.

## Overview

The API is designed to handle daily database updates smoothly with minimal downtime and automatic cache management. The system includes:

- **Cache invalidation** to ensure data freshness after database updates
- **Automated update handling** scripts for post-update processing  
- **API endpoints** for manual cache management
- **Multi-database support** with isolated cache management

**Note:** Database health monitoring is handled by external scripts in separate repositories. This API focuses on serving data and managing caches efficiently.

## Architecture

### Cache Invalidation System
- **Database-specific cache isolation** - Each database has its own cache namespace
- **Manual and automated invalidation** - Support for both API calls and script-based invalidation
- **Batch processing** for efficient cache clearing with configurable batch sizes
- **Graceful error handling** - Failed invalidation on one database doesn't affect others

### Multi-Database Support
- **Independent cache management** for each database (default, macroeconomics, public_finance)
- **Cross-database queries** supported with proper cache isolation
- **Database-specific connection pools** with individual configuration
- **Flexible routing** via HTTP headers or GraphQL parameters

## Daily Update Process

### Automated Workflow

1. **Database files are updated** (typically overnight by external scripts)
2. **API continues running** without interruption  
3. **External update script calls** cache invalidation endpoint
4. **Cache invalidation is executed** for affected databases
5. **New data is served** with fresh cache entries on next requests

### Manual Workflow

If you prefer manual control:

```bash
# Handle database update manually (invalidate caches + warm up)
npm run db:update

# Just invalidate all caches
npm run db:invalidate

# Check cache statistics
npm run db:stats
```

## Configuration

### Cache Settings (`config/cache.yaml`)
```yaml
CACHE:
  INVALIDATION:
    GRACE_PERIOD: 60          # Wait time before invalidation
    AUTO_INVALIDATE: true     # Enable automatic invalidation
    BATCH_SIZE: 1000         # Keys to delete per batch
    TIMEOUT: 30000           # Max time for invalidation
```

### Database Settings (`config/database.yaml`)
```yaml
DATABASES:
  default:
    PATH: ../dashboard-template-database/outputs/database.db
  macroeconomics:
    PATH: ../dashboard-template-database/outputs/macroeconomics.db
  public_finance:
    PATH: ../dashboard-template-database/outputs/public_finance.db
```

## API Endpoints

### Cache Management Endpoints

**Invalidate all caches:**
```http
POST /api/cache/invalidate-all
```

**Invalidate specific database cache:**
```http
POST /api/cache/invalidate/macroeconomics
```

**Get cache statistics:**
```http
GET /api/cache/stats
```

## Scripts

### Database Update Handler

The main script for handling database updates:

```bash
# Handle updates for all databases
node scripts/handle-database-update.js

# Handle specific databases only
node scripts/handle-database-update.js --databases default,macroeconomics

# Dry run (no actual changes)
node scripts/handle-database-update.js --dry-run

# Skip cache invalidation
node scripts/handle-database-update.js --skip-cache-invalidation

# Skip cache warming
node scripts/handle-database-update.js --skip-cache-warming
```

### NPM Scripts

```bash
# Handle database update (invalidate caches + warm up)
npm run db:update

# Dry run database update
npm run db:update:dry

# Invalidate all caches only
npm run db:invalidate

# Get cache statistics
npm run db:stats
```

## Integration with Update Process

### Option 1: Cron Job (Recommended)
```bash
# Add to crontab to run after database updates
0 2 * * * cd /path/to/api && npm run db:update >> /var/log/db-updates.log 2>&1
```

### Option 2: Webhook Integration
```bash
# Call from your database update script
curl -X POST "http://localhost:4000/api/cache/invalidate-all"

# Or use the full handler
node /path/to/api/scripts/handle-database-update.js
```

### Option 3: CI/CD Integration
```yaml
# Example GitHub Action step
- name: Handle Database Update
  run: |
    npm run db:health
    npm run db:update
    npm run db:stats
```

## Monitoring and Alerting

### Cache Statistics Monitoring
```bash
# Check cache statistics and status
curl "http://localhost:4000/api/cache/stats"
```

### Log Monitoring
Key log messages to monitor:
- `Starting cache invalidation` - Cache invalidation process started
- `Invalidated X cache entries` - Confirms cache was cleared successfully
- `Cache invalidation failed` - Requires investigation
- `Cache warming failed` - May indicate database connectivity issues

### Metrics Collection
The cache statistics endpoint provides metrics suitable for monitoring tools:
- Cache entry counts by database and type
- Cache invalidation frequency and duration
- Connection pool utilization
- Cache warming success/failure rates

## Troubleshooting

### Common Issues

**Cache not invalidating:**
- Verify Redis connectivity and configuration
- Check application logs for cache invalidation errors
- Ensure sufficient Redis memory and proper key expiration policies

**Database connection errors:**
- Verify database file paths in configuration
- Check file permissions and disk space
- Monitor connection pool statistics via database manager

**Cache warming failures:**
- Check if databases are accessible and contain expected tables
- Verify loader configuration and field names
- Review connection timeout settings

### Debug Commands

```bash
# Check cache contents
redis-cli KEYS "graphql-api:*"

# Monitor Redis activity
redis-cli MONITOR

# Check application logs
tail -f logs/application.log

# Test cache invalidation manually
node -e "import('./src/cache/cache-invalidation.js').then(c => c.cacheInvalidationManager.getCacheStats().then(console.log))"
```

## Best Practices

1. **Monitor cache statistics** regularly via the API endpoint
2. **Set up alerting** for cache invalidation failures
3. **Use dry-run mode** to test update scripts before production
4. **Schedule cache warming** after database updates during low-traffic periods
5. **Keep database files** on fast storage for optimal performance
6. **Monitor cache hit ratios** and adjust TTL settings accordingly
7. **Use database-specific routing** to isolate cache issues per database

## Performance Considerations

- **Cache warming** reduces initial query latency after updates
- **Graceful cache invalidation** prevents cache stampedes
- **Connection pooling** maintains performance during updates
- **Health check frequency** balances detection speed vs. overhead

## Security Notes

- Cache management endpoints should be **restricted to internal networks**
- Consider **authentication** for cache invalidation endpoints in production
- **Log all cache operations** for audit trails and debugging
- **Validate database accessibility** before attempting cache warming
- **Rate limit** cache invalidation endpoints to prevent abuse