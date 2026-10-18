/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 Diridium Technologies Inc. */

package com.diridium.oie.cache;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Logger;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * jTDS 1.3.1, the SQL Server driver the engine ships alongside Microsoft's, throws
 * AbstractMethodError from Connection.isValid(). A stub driver for jdbc:jtds: URLs does the same,
 * so these run without a SQL Server.
 */
class CacheManagerJtdsTest {

    private static final String JTDS_URL = "jdbc:jtds:sqlserver://stub:1433/lookups";
    static final List<String> executed = new CopyOnWriteArrayList<>();

    @BeforeEach
    void clear() {
        executed.clear();
    }

    @Test
    void testConnectionSucceedsWithoutIsValid() {
        var result = CacheManager.getInstance().testConnection(definition(StubJtdsDriver.class.getName(), JTDS_URL));

        assertEquals("Connection successful", result);
        assertEquals(List.of(CacheManager.JTDS_TEST_QUERY), executed);
    }

    @Test
    void poolHandsOutConnectionsWithoutIsValid() throws SQLException {
        try (var pool = CacheManager.createPool(definition(StubJtdsDriver.class.getName(), JTDS_URL));
                var connection = pool.getConnection()) {
            assertTrue(executed.contains(CacheManager.JTDS_TEST_QUERY), executed.toString());
        }
    }

    @Test
    void onlyJtdsGetsTheTestQuery() {
        try (var byDriver = CacheManager.createPool(definition("net.sourceforge.jtds.jdbc.Driver", JTDS_URL));
                var byUrl = CacheManager.createPool(definition("", JTDS_URL));
                var byUpperCaseUrl = CacheManager.createPool(definition("", "JDBC:JTDS:sqlserver://stub:1433/lookups"));
                var microsoft = CacheManager.createPool(definition("com.microsoft.sqlserver.jdbc.SQLServerDriver",
                        "jdbc:sqlserver://host:1433;databaseName=lookups"));
                var oracle = CacheManager.createPool(definition("oracle.jdbc.OracleDriver",
                        "jdbc:oracle:thin:@host:1521:lookups"))) {
            assertEquals(CacheManager.JTDS_TEST_QUERY, byDriver.getConnectionTestQuery());
            assertEquals(CacheManager.JTDS_TEST_QUERY, byUrl.getConnectionTestQuery());
            assertEquals(CacheManager.JTDS_TEST_QUERY, byUpperCaseUrl.getConnectionTestQuery());
            assertNull(microsoft.getConnectionTestQuery());
            assertNull(oracle.getConnectionTestQuery());
        }
    }

    private static CacheDefinition definition(String driver, String url) {
        var def = new CacheDefinition();
        def.setId("jtds-test");
        def.setName("jtds-test");
        def.setDriver(driver);
        def.setUrl(url);
        def.setUsername("sa");
        def.setPassword("secret");
        def.setQuery("SELECT k, v FROM lookups WHERE k = ?");
        def.setKeyColumn("k");
        def.setValueColumn("v");
        def.setMaxConnections(1);
        return def;
    }

    /** Accepts jdbc:jtds: URLs. Its connections throw AbstractMethodError from isValid(), as jTDS 1.3.1's do. */
    public static class StubJtdsDriver implements Driver {
        static {
            try {
                DriverManager.registerDriver(new StubJtdsDriver());
            } catch (SQLException e) {
                throw new ExceptionInInitializerError(e);
            }
        }

        @Override
        public Connection connect(String url, Properties info) {
            if (!acceptsURL(url)) {
                return null;
            }
            return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(),
                    new Class<?>[] { Connection.class }, (proxy, method, args) -> switch (method.getName()) {
                        case "isValid" -> throw new AbstractMethodError("isValid");
                        case "createStatement" -> statement();
                        case "getAutoCommit" -> true;
                        default -> defaultValue(method.getReturnType());
                    });
        }

        private static Statement statement() {
            return (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(),
                    new Class<?>[] { Statement.class }, (proxy, method, args) -> {
                        if (method.getName().equals("execute") && args != null && args[0] instanceof String sql) {
                            executed.add(sql);
                            return false;
                        }
                        return defaultValue(method.getReturnType());
                    });
        }

        private static Object defaultValue(Class<?> type) {
            if (type == boolean.class) {
                return false;
            }
            if (type == int.class) {
                return 0;
            }
            if (type == long.class) {
                return 0L;
            }
            return null;
        }

        @Override
        public boolean acceptsURL(String url) {
            return url != null && url.startsWith("jdbc:jtds:");
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
            return new DriverPropertyInfo[0];
        }

        @Override
        public int getMajorVersion() {
            return 1;
        }

        @Override
        public int getMinorVersion() {
            return 3;
        }

        @Override
        public boolean jdbcCompliant() {
            return false;
        }

        @Override
        public Logger getParentLogger() throws SQLFeatureNotSupportedException {
            throw new SQLFeatureNotSupportedException();
        }
    }
}
