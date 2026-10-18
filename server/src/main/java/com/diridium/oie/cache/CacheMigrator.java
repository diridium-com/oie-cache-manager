/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 Diridium Technologies Inc. */

package com.diridium.oie.cache;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Locale;

import com.mirth.connect.server.migration.Migrator;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Creates the cache_definition table on first startup, adds the max_connections column to a
 * table created before that column existed, and drops the duplicate index on name that earlier
 * releases created. Detects the database type and runs the matching dialect-specific SQL.
 */
public class CacheMigrator extends Migrator {

    private static final Logger log = LoggerFactory.getLogger(CacheMigrator.class);

    private static final String TABLE = "cache_definition";
    private static final String MAX_CONNECTIONS = "max_connections";
    // The table scripts up to 1.3.0 built this on name, which its UNIQUE constraint already indexes.
    // MySQL, PostgreSQL and SQL Server kept it; Derby skipped it as a duplicate and Oracle refused it.
    private static final String DUPLICATE_NAME_INDEX = "idx_cache_definition_name";

    /**
     * The engine runs every plugin migrator on every startup, so each step runs only when there is
     * something to add or drop. Derby has no CREATE TABLE IF NOT EXISTS and Oracle only has it from
     * 23ai, and letting the create or the ALTER fail logged a warning with a stack trace on every
     * restart. Failures are logged at ERROR because stock OIE logs nothing below it.
     */
    @Override
    public void migrate() {
        try {
            if (!tableExists(TABLE)) {
                executeScript("/" + getDatabaseType() + "-cache-tables.sql");
                log.info("Cache definition table created");
                return;
            }
            if (!columnExists(TABLE, MAX_CONNECTIONS)) {
                executeStatement(addMaxConnectionsSql());
                log.info("Added max_connections column to cache_definition");
            }
            if (indexExists(TABLE, DUPLICATE_NAME_INDEX)) {
                executeStatement(dropDuplicateNameIndexSql());
                log.info("Dropped the duplicate index on cache_definition.name");
            }
        } catch (Exception e) {
            log.error("Cache definition table migration failed: {}", e.getMessage(), e);
        }
    }

    private String addMaxConnectionsSql() {
        // Oracle and SQL Server use ADD (no COLUMN keyword); Postgres/MySQL/Derby use ADD COLUMN
        return switch (getDatabaseType()) {
            case "oracle" -> "ALTER TABLE cache_definition ADD max_connections NUMBER DEFAULT 5";
            case "sqlserver" -> "ALTER TABLE cache_definition ADD max_connections INT DEFAULT 5";
            default -> "ALTER TABLE cache_definition ADD COLUMN max_connections INTEGER DEFAULT 5";
        };
    }

    private String dropDuplicateNameIndexSql() {
        // MySQL and SQL Server name the table; the others name only the index
        return switch (getDatabaseType()) {
            case "mysql", "sqlserver" -> "DROP INDEX idx_cache_definition_name ON cache_definition";
            default -> "DROP INDEX idx_cache_definition_name";
        };
    }

    /*
     * The lookups look only in the engine's own database and schema: given no catalog, MySQL
     * Connector/J answers from every database the user can see. Derby and Oracle store unquoted
     * names in upper case, the others in lower case, so both are tried.
     */

    private boolean tableExists(String table) throws SQLException {
        return storedTableName(table) != null;
    }

    // The table's name as the database stores it, or null if there is no such table.
    private String storedTableName(String table) throws SQLException {
        Connection connection = getConnection();
        DatabaseMetaData meta = connection.getMetaData();
        for (boolean upper : new boolean[] { true, false }) {
            try (ResultSet rs = meta.getTables(connection.getCatalog(), currentSchema(connection),
                    pattern(meta, table, upper), new String[] { "TABLE" })) {
                if (rs.next()) {
                    return rs.getString("TABLE_NAME");
                }
            }
        }
        return null;
    }

    // getIndexInfo takes a table name, not a pattern, so it gets the name as stored. Approximate, so
    // that Oracle doesn't gather statistics first.
    private boolean indexExists(String table, String index) throws SQLException {
        String stored = storedTableName(table);
        if (stored == null) {
            return false;
        }
        Connection connection = getConnection();
        try (ResultSet rs = connection.getMetaData().getIndexInfo(connection.getCatalog(), currentSchema(connection),
                stored, false, true)) {
            while (rs.next()) {
                if (index.equalsIgnoreCase(rs.getString("INDEX_NAME"))) {
                    return true;
                }
            }
        }
        return false;
    }

    private boolean columnExists(String table, String column) throws SQLException {
        Connection connection = getConnection();
        DatabaseMetaData meta = connection.getMetaData();
        for (boolean upper : new boolean[] { true, false }) {
            try (ResultSet rs = meta.getColumns(connection.getCatalog(), currentSchema(connection),
                    pattern(meta, table, upper), pattern(meta, column, upper))) {
                if (rs.next()) {
                    return true;
                }
            }
        }
        return false;
    }

    // '_' is a wildcard in metadata patterns
    private static String pattern(DatabaseMetaData meta, String name, boolean upper) throws SQLException {
        String cased = upper ? name.toUpperCase(Locale.ROOT) : name.toLowerCase(Locale.ROOT);
        String escape = meta.getSearchStringEscape();
        return escape == null ? cased : cased.replace("_", escape + "_");
    }

    // jTDS 1.3.1 (the engine's default SQL Server driver) implements Connection.getSchema() as a stub
    // that throws AbstractMethodError; a driver that doesn't support it otherwise throws SQLException.
    // A null schema still finds the table, since the catalog narrows the search.
    private static String currentSchema(Connection connection) {
        try {
            return connection.getSchema();
        } catch (AbstractMethodError | SQLException e) {
            return null;
        }
    }

    @Override
    public List<String> getUninstallStatements() {
        return List.of("DROP TABLE cache_definition");
    }

    @Override
    public void migrateSerializedData() {
        // No serialized data migration needed
    }
}
