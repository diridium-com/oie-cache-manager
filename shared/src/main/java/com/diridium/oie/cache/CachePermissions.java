/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 Diridium Technologies Inc. */

package com.diridium.oie.cache;

/**
 * Permission names for this plugin's operations.
 *
 * These are the plugin's own permissions, published to RBAC via
 * {@code CacheServerPlugin#getExtensionPermissions()}. Extension servlet
 * operations reach the authorization controller under the composite name
 * "OIE Cache Manager#&lt;operation&gt;", so naming a core engine permission
 * (the previous {@code SERVER_SETTINGS_VIEW}/{@code SERVER_SETTINGS_EDIT})
 * in {@code @MirthOperation} would never match; the plugin must declare its
 * own. On a stock install nothing changes: the default authorization
 * controller allows every operation for every authenticated user.
 */
public final class CachePermissions {

    public static final String VIEW = "View Caches";
    public static final String MANAGE = "Manage Caches";

    private CachePermissions() {
    }
}
