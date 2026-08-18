/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 Diridium Technologies Inc. */

package com.diridium.oie.cache;

import java.util.Properties;

import com.mirth.connect.client.core.TaskConstants;
import com.mirth.connect.client.core.api.util.OperationUtil;
import com.mirth.connect.model.ExtensionPermission;
import com.mirth.connect.plugins.ServicePlugin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Server-side plugin entry point. Initializes the cache definition repository
 * and registers all persisted cache definitions on startup.
 */
public class CacheServerPlugin implements ServicePlugin {

    private static final Logger log = LoggerFactory.getLogger(CacheServerPlugin.class);

    @Override
    public String getPluginPointName() {
        return CacheServletInterface.PLUGIN_NAME;
    }

    @Override
    public void init(Properties properties) {
        // Called during server initialization
    }

    @Override
    public void start() {
        log.info("Starting OIE Cache Manager plugin");
        SerializationController.registerSerializableClasses();
        CacheDefinitionRepository.init();
        loadCacheDefinitions();
    }

    @Override
    public void stop() {
        log.info("Stopping OIE Cache Manager plugin");
        CacheManager.shutdown();
        CacheDefinitionRepository.close();
    }

    @Override
    public void update(Properties properties) {
        // No runtime property updates needed
    }

    @Override
    public Properties getDefaultProperties() {
        return new Properties();
    }

    @Override
    public ExtensionPermission[] getExtensionPermissions() {
        // Operation names are derived by reflection so an operation added to the
        // servlet interface later cannot ship unregistered. The settings-tab
        // composite task name lets RBAC hide the tab from users without view.
        return new ExtensionPermission[] {
                new ExtensionPermission(
                        CacheServletInterface.PLUGIN_NAME,
                        CachePermissions.VIEW,
                        "View cache definitions, statistics, and cached entries",
                        OperationUtil.getOperationNamesForPermission(
                                CachePermissions.VIEW, CacheServletInterface.class),
                        new String[] {
                                TaskConstants.SETTINGS_KEY_PREFIX + CacheServletInterface.PLUGIN_NAME
                                        + "/" + TaskConstants.SETTINGS_REFRESH
                        }),
                new ExtensionPermission(
                        CacheServletInterface.PLUGIN_NAME,
                        CachePermissions.MANAGE,
                        "Create, edit, delete, refresh, and test cache definitions",
                        OperationUtil.getOperationNamesForPermission(
                                CachePermissions.MANAGE, CacheServletInterface.class),
                        new String[0])
        };
    }

    private void loadCacheDefinitions() {
        try {
            var repo = CacheDefinitionRepository.getInstance();
            var manager = CacheManager.getInstance();
            var definitions = repo.getAll();
            for (var def : definitions) {
                if (!def.isEnabled()) {
                    log.info("Skipping disabled cache '{}'", def.getName());
                    continue;
                }
                try {
                    manager.registerCache(def);
                } catch (Exception e) {
                    log.warn("Failed to register cache '{}': {}", def.getName(), e.getMessage());
                }
            }
            log.info("Loaded {} cache definition(s)", definitions.size());
        } catch (Exception e) {
            log.error("Failed to load cache definitions on startup", e);
        }
    }
}
