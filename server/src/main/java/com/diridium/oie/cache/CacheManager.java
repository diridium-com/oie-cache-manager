/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 Diridium Technologies Inc. */

package com.diridium.oie.cache;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.LongAdder;
import java.util.regex.Pattern;

import com.google.common.cache.CacheBuilder;
import com.google.common.cache.CacheLoader;
import com.google.common.cache.CacheStats;
import com.google.common.cache.LoadingCache;
import com.mirth.connect.server.util.GlobalVariableStore;
import com.zaxxer.hikari.HikariDataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Manages Guava LoadingCache instances keyed by cache definition ID.
 * Each cache lazily loads values from an external database via JDBC.
 *
 * <p>Per-cache state is bundled in a {@link CacheRegistration} record so that
 * registration swaps are atomic for concurrent readers — a reader always sees
 * a complete, consistent registration or none at all.</p>
 */
public final class CacheManager {

    private static final Logger log = LoggerFactory.getLogger(CacheManager.class);

    // jTDS 1.3.1, the SQL Server driver the engine ships alongside Microsoft's, doesn't implement
    // Connection.isValid() (it throws AbstractMethodError), which Test Connection and HikariCP
    // otherwise use to check a connection. Its connections are checked with this query instead.
    // Plain SELECT 1 isn't valid on every database (Oracle, Derby), so only jTDS gets it.
    static final String JTDS_TEST_QUERY = "SELECT 1";

    private static volatile CacheManager instance;

    /**
     * All per-cache state bundled together so a single {@code ConcurrentHashMap.put}
     * swaps everything atomically for readers.
     */
    static final class CacheRegistration {
        final LoadingCache<String, String> cache;
        final CacheDefinition definition;
        final ConcurrentHashMap<String, Long> loadTimestamps;
        final ConcurrentHashMap<String, LongAdder> accessCounts;
        final HikariDataSource pool;

        CacheRegistration(LoadingCache<String, String> cache,
                          CacheDefinition definition,
                          ConcurrentHashMap<String, Long> loadTimestamps,
                          ConcurrentHashMap<String, LongAdder> accessCounts,
                          HikariDataSource pool) {
            this.cache = cache;
            this.definition = definition;
            this.loadTimestamps = loadTimestamps;
            this.accessCounts = accessCounts;
            this.pool = pool;
        }
    }

    private final ConcurrentHashMap<String, CacheRegistration> registrations = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> nameToId = new ConcurrentHashMap<>();

    private CacheManager() {
    }

    public static CacheManager getInstance() {
        var result = instance;
        if (result == null) {
            synchronized (CacheManager.class) {
                result = instance;
                if (result == null) {
                    instance = result = new CacheManager();
                }
            }
        }
        return result;
    }

    public static void shutdown() {
        synchronized (CacheManager.class) {
            if (instance != null) {
                instance.invalidateAll();
                instance = null;
            }
        }
    }

    /**
     * Build (or rebuild) a Guava LoadingCache for the given definition.
     * Takes a defensive copy so the caller cannot mutate the stored definition.
     * All per-cache state is constructed locally first, then swapped in atomically
     * via a single {@code registrations.put}. The old pool is closed after the swap
     * so in-flight queries on existing connections can complete.
     */
    public void registerCache(CacheDefinition definition) {
        var def = definition.copy();

        var timestamps = new ConcurrentHashMap<String, Long>();
        var pool = createPool(def);
        var loader = new CacheLoader<String, String>() {
            @Override
            public String load(String key) throws Exception {
                var result = queryExternalDatabase(pool, def, key);
                timestamps.put(key, System.currentTimeMillis());
                return result;
            }
        };

        var builder = CacheBuilder.newBuilder()
                .recordStats();

        if (def.getMaxSize() > 0) {
            builder.maximumSize(def.getMaxSize());
        }
        if (def.getEvictionDurationMinutes() > 0) {
            builder.expireAfterAccess(def.getEvictionDurationMinutes(), TimeUnit.MINUTES);
        }

        var cache = builder.build(loader);

        var reg = new CacheRegistration(cache, def, timestamps, new ConcurrentHashMap<>(), pool);

        // Atomic swap — readers see either the complete old registration or the complete new one.
        // The registrations.put happens first, so concurrent readers always find a valid
        // registration for the ID. The nameToId/GlobalVariableStore updates follow — during
        // that brief window, both old and new names resolve to the same ID, which is safe.
        var old = registrations.put(def.getId(), reg);

        // If the name changed, remove the stale name mapping so it doesn't linger
        if (old != null && !old.definition.getName().equals(def.getName())) {
            nameToId.remove(old.definition.getName());
            GlobalVariableStore.getInstance().remove(old.definition.getName());
        }
        nameToId.put(def.getName(), def.getId());
        GlobalVariableStore.getInstance().put(def.getName(), new CacheLookup(def.getName()));

        // Close old pool AFTER the new registration is visible,
        // so in-flight queries that already obtained the old pool reference can finish
        if (old != null) {
            closePoolQuietly(old.pool);
        }

        log.info("Registered cache '{}'", def.getName());
    }

    /**
     * Remove a cache and its definition.
     */
    public void unregisterCache(String definitionId) {
        var reg = registrations.remove(definitionId);
        if (reg != null) {
            nameToId.remove(reg.definition.getName());
            GlobalVariableStore.getInstance().remove(reg.definition.getName());
            reg.cache.invalidateAll();
            closePoolQuietly(reg.pool);
        }
    }

    /**
     * Look up a value by cache name. Resolves name → ID, then delegates to {@link #get}.
     */
    public String getByName(String name, String key) throws Exception {
        var id = nameToId.get(name);
        if (id == null) {
            throw new IllegalArgumentException("No cache registered with name: " + name);
        }
        return get(id, key);
    }

    /**
     * Look up a value from the cache. Returns null if the key produces no result.
     * Access count is only incremented on successful lookups (hit or null-return),
     * not when the load throws an exception.
     */
    public String get(String definitionId, String key) throws Exception {
        var reg = registrations.get(definitionId);
        if (reg == null) {
            throw new IllegalArgumentException("No cache registered for definition: " + definitionId);
        }
        try {
            var result = reg.cache.get(key);
            incrementAccessCount(reg, key);
            return result;
        } catch (CacheLoader.InvalidCacheLoadException e) {
            // Guava throws this when CacheLoader returns null — means key not found
            incrementAccessCount(reg, key);
            return null;
        }
    }

    /**
     * Refresh all entries currently in the cache (does NOT load new keys).
     * Uses invalidate-then-get to force synchronous reloading so the method
     * does not return until all entries have been re-fetched from the database.
     *
     * @return the number of keys that failed to refresh
     */
    public int refresh(String definitionId) {
        var reg = registrations.get(definitionId);
        if (reg == null) {
            throw new IllegalArgumentException("No cache registered for definition: " + definitionId);
        }
        var keys = new ArrayList<>(reg.cache.asMap().keySet());
        int failures = 0;
        for (var key : keys) {
            reg.cache.invalidate(key);
            try {
                reg.cache.get(key);
            } catch (Exception e) {
                failures++;
                log.warn("Failed to refresh key '{}' in cache '{}': {}",
                        key, reg.definition.getName(), e.getMessage());
            }
        }
        log.info("Refreshed cache '{}': {} keys, {} failures",
                reg.definition.getName(), keys.size(), failures);
        return failures;
    }

    /**
     * Get runtime statistics for all registered caches.
     */
    public List<CacheStatistics> getAllStatistics() {
        var result = new ArrayList<CacheStatistics>();
        for (var entry : registrations.entrySet()) {
            var stats = buildStatistics(entry.getKey(), entry.getValue());
            result.add(stats);
        }
        return result;
    }

    /**
     * Get runtime statistics for a cache.
     */
    public CacheStatistics getStatistics(String definitionId) {
        var reg = registrations.get(definitionId);
        if (reg == null) {
            return null;
        }
        return buildStatistics(definitionId, reg);
    }

    private CacheStatistics buildStatistics(String definitionId, CacheRegistration reg) {
        CacheStats stats = reg.cache.stats();
        var result = new CacheStatistics();
        result.setCacheDefinitionId(definitionId);
        result.setName(reg.definition.getName());
        result.setSize(reg.cache.size());
        result.setHitCount(stats.hitCount());
        result.setMissCount(stats.missCount());
        result.setLoadSuccessCount(stats.loadSuccessCount());
        result.setLoadExceptionCount(stats.loadExceptionCount());
        result.setHitRate(stats.hitRate());
        result.setEvictionCount(stats.evictionCount());
        result.setRequestCount(stats.requestCount());
        result.setTotalLoadTimeNanos(stats.totalLoadTime());
        result.setAverageLoadPenaltyNanos(stats.averageLoadPenalty());

        // Estimate memory: Java String uses ~2 bytes per char + object overhead
        long memoryEstimate = 0;
        for (var entry : reg.cache.asMap().entrySet()) {
            var k = entry.getKey();
            var v = entry.getValue();
            memoryEstimate += (k != null ? k.length() * 2L : 0)
                    + (v != null ? v.length() * 2L : 0);
        }
        result.setEstimatedMemoryBytes(memoryEstimate);

        return result;
    }

    /**
     * Get a point-in-time snapshot of a cache with server-side filtering, sorting, and limiting.
     */
    public CacheSnapshot getSnapshot(String definitionId, int offset, int limit, String sortBy,
                                     String sortDir, String filter, String filterScope,
                                     boolean filterRegex) {
        var reg = registrations.get(definitionId);
        if (reg == null) {
            return null;
        }

        var stats = buildStatistics(definitionId, reg);
        var allEntries = new ArrayList<CacheEntry>();

        for (var entry : reg.cache.asMap().entrySet()) {
            var loadedAt = reg.loadTimestamps.getOrDefault(entry.getKey(), 0L);
            var adder = reg.accessCounts.get(entry.getKey());
            var accessCount = adder != null ? adder.sum() : 0L;
            allEntries.add(new CacheEntry(entry.getKey(), entry.getValue(), loadedAt, accessCount));
        }

        long totalEntries = allEntries.size();

        // Filter
        List<CacheEntry> filtered;
        if (filter != null && !filter.isBlank()) {
            var pattern = filterRegex
                    ? Pattern.compile(filter, Pattern.CASE_INSENSITIVE)
                    : Pattern.compile(Pattern.quote(filter), Pattern.CASE_INSENSITIVE);
            filtered = allEntries.stream().filter(e -> {
                var scope = filterScope != null ? filterScope : "key";
                return switch (scope) {
                    case "value" -> e.getValue() != null && pattern.matcher(e.getValue()).find();
                    case "both" -> pattern.matcher(e.getKey()).find()
                            || (e.getValue() != null && pattern.matcher(e.getValue()).find());
                    default -> pattern.matcher(e.getKey()).find();
                };
            }).collect(java.util.stream.Collectors.toCollection(ArrayList::new));
        } else {
            filtered = allEntries;
        }

        long matchedEntries = filtered.size();

        // Sort
        Comparator<CacheEntry> comparator = switch (sortBy != null ? sortBy : "key") {
            case "value" -> Comparator.comparing(
                    e -> e.getValue() != null ? e.getValue() : "", String.CASE_INSENSITIVE_ORDER);
            case "loadedAt" -> Comparator.comparingLong(CacheEntry::getLoadedAtMillis);
            case "accessCount" -> Comparator.comparingLong(CacheEntry::getAccessCount);
            default -> Comparator.comparing(CacheEntry::getKey, String.CASE_INSENSITIVE_ORDER);
        };
        if ("desc".equalsIgnoreCase(sortDir)) {
            comparator = comparator.reversed();
        }
        filtered.sort(comparator);

        // Offset + Limit
        int fromIndex = Math.max(0, Math.min(offset, filtered.size()));
        int toIndex = limit > 0 ? Math.min(fromIndex + limit, filtered.size()) : filtered.size();
        var page = filtered.subList(fromIndex, toIndex);

        return new CacheSnapshot(stats, page, totalEntries, matchedEntries);
    }

    /**
     * Test the parameterized query with a sample key and return a user-friendly result.
     */
    public String testQuery(CacheDefinition definition, String sampleKey) {
        var driverError = loadDriver(definition.getDriver());
        if (driverError != null) return driverError;

        Connection conn = null;
        PreparedStatement stmt = null;
        ResultSet rs = null;
        try {
            conn = DriverManager.getConnection(
                    definition.getUrl(), definition.getUsername(), definition.getPassword());
            conn.setAutoCommit(true);

            stmt = conn.prepareStatement(definition.getQuery());
            stmt.setString(1, sampleKey);

            rs = stmt.executeQuery();

            // Validate that configured columns exist in the result set
            var meta = rs.getMetaData();
            var columnNames = new ArrayList<String>();
            for (int i = 1; i <= meta.getColumnCount(); i++) {
                columnNames.add(meta.getColumnLabel(i));
            }

            var missing = new ArrayList<String>();
            if (definition.getKeyColumn() != null && !definition.getKeyColumn().isEmpty()
                    && columnNames.stream().noneMatch(c -> c.equalsIgnoreCase(definition.getKeyColumn()))) {
                missing.add("Key Column '" + definition.getKeyColumn() + "'");
            }
            if (definition.getValueColumn() != null && !definition.getValueColumn().isEmpty()
                    && columnNames.stream().noneMatch(c -> c.equalsIgnoreCase(definition.getValueColumn()))) {
                missing.add("Value Column '" + definition.getValueColumn() + "'");
            }
            if (!missing.isEmpty()) {
                return String.join(" and ", missing)
                        + " not found in result set. Available columns: "
                        + String.join(", ", columnNames);
            }

            var actualKeyCol = findColumnName(columnNames, definition.getKeyColumn());
            var actualValCol = findColumnName(columnNames, definition.getValueColumn());

            if (rs.next()) {
                return "Key: " + rs.getString(actualKeyCol)
                        + "\nValue: " + rs.getString(actualValCol);
            }
            return "No rows returned for key: " + sampleKey;
        } catch (Exception e) {
            return "Query failed: " + e.getMessage();
        } finally {
            closeStatementAndResultSet(rs, stmt);
            if (conn != null) {
                try { conn.close(); } catch (Exception e) { log.error("Failed to close database connection", e); }
            }
        }
    }

    /**
     * Test the JDBC connection for a cache definition.
     */
    public String testConnection(CacheDefinition definition) {
        var driverError = loadDriver(definition.getDriver());
        if (driverError != null) return driverError;

        try (Connection conn = DriverManager.getConnection(
                definition.getUrl(), definition.getUsername(), definition.getPassword())) {
            if (isJtds(definition)) {
                try (Statement stmt = conn.createStatement()) {
                    stmt.setQueryTimeout(10);
                    stmt.execute(JTDS_TEST_QUERY);
                }
                return "Connection successful";
            }
            if (conn.isValid(10)) {
                return "Connection successful";
            } else {
                return "Connection returned but is not valid";
            }
        } catch (Exception e) {
            return "Connection failed: " + e.getMessage();
        }
    }

    private void invalidateAll() {
        var globalStore = GlobalVariableStore.getInstance();
        for (var reg : registrations.values()) {
            reg.cache.invalidateAll();
            closePoolQuietly(reg.pool);
            globalStore.remove(reg.definition.getName());
        }
        registrations.clear();
        nameToId.clear();
    }

    private static void incrementAccessCount(CacheRegistration reg, String key) {
        reg.accessCounts.computeIfAbsent(key, k -> new LongAdder()).increment();
    }

    /**
     * Execute the parameterized query against the external database.
     * Uses the pool captured by the CacheLoader closure, so in-flight queries
     * are not affected by concurrent re-registration.
     * Returns null if no row matches (Guava will translate this to InvalidCacheLoadException).
     */
    private String queryExternalDatabase(HikariDataSource pool, CacheDefinition definition, String key) throws Exception {
        try (var conn = pool.getConnection()) {
            PreparedStatement stmt = null;
            ResultSet rs = null;
            try {
                stmt = conn.prepareStatement(definition.getQuery());
                stmt.setString(1, key);

                rs = stmt.executeQuery();
                if (rs.next()) {
                    // Resolve column name case-insensitively (some DBs return uppercase labels)
                    var meta = rs.getMetaData();
                    var columnNames = new ArrayList<String>();
                    for (int i = 1; i <= meta.getColumnCount(); i++) {
                        columnNames.add(meta.getColumnLabel(i));
                    }
                    var actualValCol = findColumnName(columnNames, definition.getValueColumn());
                    return rs.getString(actualValCol);
                }
                return null;
            } finally {
                closeStatementAndResultSet(rs, stmt);
            }
        }
    }

    static HikariDataSource createPool(CacheDefinition definition) {
        // Pre-register the driver with DriverManager (needed for non-JDBC4 drivers)
        try {
            Class.forName(definition.getDriver());
        } catch (ClassNotFoundException e) {
            log.warn("JDBC driver class '{}' not found for cache '{}' — will rely on URL auto-detection",
                    definition.getDriver(), definition.getName());
        }

        var maxConn = definition.getMaxConnections() > 0 ? definition.getMaxConnections() : 5;

        // Use no-arg constructor for lazy initialization — pool starts on first getConnection(),
        // not at construction time. This avoids eagerly validating the driver/URL at registration.
        var ds = new HikariDataSource();
        ds.setJdbcUrl(definition.getUrl());
        ds.setUsername(definition.getUsername());
        ds.setPassword(definition.getPassword());
        ds.setMaximumPoolSize(maxConn);
        ds.setMinimumIdle(0);
        ds.setAutoCommit(true);
        ds.setPoolName("oie-cache-" + definition.getName());
        if (isJtds(definition)) {
            ds.setConnectionTestQuery(JTDS_TEST_QUERY);
        }
        return ds;
    }

    // By driver class or, when the class is left to URL auto-detection, by URL.
    private static boolean isJtds(CacheDefinition definition) {
        return "net.sourceforge.jtds.jdbc.Driver".equals(definition.getDriver())
                || (definition.getUrl() != null && definition.getUrl().startsWith("jdbc:jtds:"));
    }

    private static void closePoolQuietly(HikariDataSource pool) {
        try {
            pool.close();
        } catch (Exception e) {
            log.debug("Failed to close connection pool '{}'", pool.getPoolName(), e);
        }
    }

    private static String loadDriver(String driverClassName) {
        try {
            Class.forName(driverClassName);
            return null;
        } catch (ClassNotFoundException e) {
            return "Driver not found: " + driverClassName;
        }
    }

    private static String findColumnName(List<String> availableColumns, String requestedColumn) {
        return availableColumns.stream()
                .filter(c -> c.equalsIgnoreCase(requestedColumn))
                .findFirst().orElse(requestedColumn);
    }

    private static void closeStatementAndResultSet(ResultSet rs, PreparedStatement stmt) {
        if (rs != null) {
            try { rs.close(); } catch (Exception e) { log.debug("Failed to close ResultSet", e); }
        }
        if (stmt != null) {
            try { stmt.close(); } catch (Exception e) { log.debug("Failed to close PreparedStatement", e); }
        }
    }

}
