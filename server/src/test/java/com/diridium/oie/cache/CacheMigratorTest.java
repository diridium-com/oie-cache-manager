/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 Diridium Technologies Inc. */

package com.diridium.oie.cache;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Runs the migrator against a real in-memory Derby database and records every SQL statement it
 * runs, including any that fail. The engine runs plugin migrators on every startup, so a run
 * against a database that already has the table must run nothing.
 */
class CacheMigratorTest {

    private Connection database;
    private final List<String> executed = new ArrayList<>();

    @BeforeEach
    void openDatabase() throws SQLException {
        database = DriverManager.getConnection("jdbc:derby:memory:" + UUID.randomUUID() + ";create=true");
    }

    @AfterEach
    void closeDatabase() throws SQLException {
        database.close();
    }

    @Test
    void createsTheTableOnAFreshDatabase() throws SQLException {
        migrate();

        assertEquals(1, executed.size(), "the Derby script's one statement: " + executed);
        assertTrue(executed.get(0).startsWith("CREATE TABLE cache_definition"), executed.get(0));
        assertTrue(maxConnectionsExists());
        assertFalse(duplicateNameIndexExists());
    }

    @Test
    void runsNothingWhenTheTableExists() throws SQLException {
        migrate();
        executed.clear();

        migrate();

        assertEquals(List.of(), executed);
    }

    @Test
    void addsMaxConnectionsToATableWithoutIt() throws SQLException {
        migrate();
        try (Statement s = database.createStatement()) {
            s.executeUpdate("ALTER TABLE cache_definition DROP COLUMN max_connections");
        }
        executed.clear();

        migrate();

        assertEquals(List.of("ALTER TABLE cache_definition ADD COLUMN max_connections INTEGER DEFAULT 5"), executed);
        assertTrue(maxConnectionsExists());

        executed.clear();
        migrate();
        assertEquals(List.of(), executed);
    }

    @Test
    void dropsTheDuplicateNameIndexOnce() throws SQLException {
        migrate();
        // The scripts up to 1.3.0 built it on (name), which Derby skips as a duplicate of the UNIQUE
        // constraint's index (warning 01504). On (name, id) Derby keeps it, so there is one to drop.
        // The e2e upgrade covers the real one on MySQL, PostgreSQL and SQL Server.
        try (Statement s = database.createStatement()) {
            s.executeUpdate("CREATE INDEX idx_cache_definition_name ON cache_definition(name, id)");
        }
        assertTrue(duplicateNameIndexExists());
        executed.clear();

        migrate();

        assertEquals(List.of("DROP INDEX idx_cache_definition_name"), executed);
        assertFalse(duplicateNameIndexExists());
        try (Statement s = database.createStatement()) {
            s.executeUpdate(insertNamed("a"));
            var e = assertThrows(SQLException.class, () -> s.executeUpdate(insertNamed("a")));
            assertEquals("23505", e.getSQLState(), "name is still unique: " + e.getMessage());
        }

        executed.clear();
        migrate();
        assertEquals(List.of(), executed);
    }

    private void migrate() {
        var migrator = new CacheMigrator();
        migrator.setConnection(recording(database));
        migrator.setDatabaseType("derby");
        migrator.migrate();
    }

    private boolean maxConnectionsExists() throws SQLException {
        try (ResultSet rs = database.getMetaData().getColumns(null, null, "CACHE_DEFINITION", "MAX_CONNECTIONS")) {
            return rs.next();
        }
    }

    // Read from Derby's catalog rather than DatabaseMetaData, which the migrator itself uses.
    private boolean duplicateNameIndexExists() throws SQLException {
        try (Statement s = database.createStatement();
                ResultSet rs = s.executeQuery("SELECT COUNT(*) FROM SYS.SYSCONGLOMERATES "
                        + "WHERE CONGLOMERATENAME = 'IDX_CACHE_DEFINITION_NAME'")) {
            rs.next();
            return rs.getInt(1) > 0;
        }
    }

    private static String insertNamed(String name) {
        return "INSERT INTO cache_definition (id, name, driver, url, query) VALUES ('" + UUID.randomUUID()
                + "', '" + name + "', 'd', 'u', 'q')";
    }

    /** The real connection, except that its statements record their SQL. */
    private Connection recording(Connection real) {
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] { Connection.class },
                (p, method, args) -> {
                    Object result = invoke(method, real, args);
                    return method.getName().equals("createStatement") ? recording((Statement) result) : result;
                });
    }

    // Records before running, so a statement that fails is recorded too.
    private Statement recording(Statement real) {
        return (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(), new Class<?>[] { Statement.class },
                (p, method, args) -> {
                    if (method.getName().startsWith("execute") && args != null && args[0] instanceof String sql) {
                        executed.add(sql.strip());
                    }
                    return invoke(method, real, args);
                });
    }

    private static Object invoke(Method method, Object target, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
    }
}
