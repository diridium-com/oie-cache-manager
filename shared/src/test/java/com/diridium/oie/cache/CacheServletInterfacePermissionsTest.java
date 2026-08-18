/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 Diridium Technologies Inc. */

package com.diridium.oie.cache;

import static org.junit.jupiter.api.Assertions.*;

import java.lang.reflect.Method;


import com.mirth.connect.client.core.api.MirthOperation;

import org.junit.jupiter.api.Test;

/**
 * Verifies that each @MirthOperation on CacheServletInterface maps to the correct
 * permission and auditable setting.
 */
class CacheServletInterfacePermissionsTest {

    @Test
    void readOperations_requireViewCaches() throws Exception {
        assertPermission("getCacheDefinitions", CachePermissions.VIEW, false);
        assertPermission("getCacheDefinition", CachePermissions.VIEW, false);
        assertPermission("getAllCacheStatistics", CachePermissions.VIEW, false);
        assertPermission("getCacheStatistics", CachePermissions.VIEW, false);
        assertPermission("getCacheSnapshot", CachePermissions.VIEW, false);
    }

    @Test
    void writeOperations_requireManageCaches() throws Exception {
        assertPermission("createCacheDefinition", CachePermissions.MANAGE, true);
        assertPermission("updateCacheDefinition", CachePermissions.MANAGE, true);
        assertPermission("deleteCacheDefinition", CachePermissions.MANAGE, true);
        assertPermission("refreshCache", CachePermissions.MANAGE, true);
        assertPermission("testConnection", CachePermissions.MANAGE, true);
        assertPermission("testConnectionInline", CachePermissions.MANAGE, true);
    }

    private void assertPermission(String methodName, String expectedPermission, boolean expectedAuditable) {
        for (Method method : CacheServletInterface.class.getDeclaredMethods()) {
            var op = method.getAnnotation(MirthOperation.class);
            if (op != null && op.name().equals(methodName)) {
                assertEquals(expectedPermission, op.permission(),
                        methodName + " should require " + expectedPermission);
                assertEquals(expectedAuditable, op.auditable(),
                        methodName + " auditable should be " + expectedAuditable);
                return;
            }
        }
        fail("No @MirthOperation found with name '" + methodName + "'");
    }
}
