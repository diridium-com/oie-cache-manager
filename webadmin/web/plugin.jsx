// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Diridium Technologies Inc.

/*
 * OIE Cache Manager — web administrator entry.
 *
 * Registers the Cache Manager settings tab (the web equivalent of the Swing
 * CacheSettingsPanelPlugin). All UI is client-side; it talks only to the
 * existing engine servlet at /api/extensions/oie-cache-manager. The engine
 * enforces SERVER_SETTINGS_VIEW / SERVER_SETTINGS_EDIT on every operation;
 * the panel additionally hides mutating buttons via the host's task checks.
 */

import { makeApi } from './cache-api.js';
import { registerCachePanel } from './cache-panel.jsx';

export function register(platform) {
    const api = makeApi(platform.api);
    registerCachePanel(platform, api);
}
