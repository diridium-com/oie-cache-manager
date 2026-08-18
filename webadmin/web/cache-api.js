// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Diridium Technologies Inc.

/*
 * REST bindings for the cache servlet at /extensions/oie-cache-manager
 * (CacheServletInterface), plus normalization of the engine's XStream JSON
 * wire shapes.
 *
 * Reads go through the host's JSON pipeline (unwrap/asList). Every model
 * class carries an @XStreamAlias (cacheDefinition, cacheStatistics,
 * cacheEntry, cacheSnapshot), so list roots are keyed by those aliases
 * (e.g. {"list":{"cacheDefinition":[...]}}); the host's asList already
 * tolerates the FQCN-root drift by matching the class name's last segment.
 * XStream quirks handled here: one-element collections collapse to a bare
 * object, empty collections arrive as '', numbers can arrive as strings
 * (including the literal "NaN" for an idle cache's hitRate), and booleans
 * can arrive as the STRING 'false'.
 *
 * Writes are hand-built XStream XML (<cacheDefinition>...) sent via
 * api.postXml/putXml — byte-parity with what the Swing client's
 * ObjectXMLSerializer produces (rbac precedent), sidestepping the
 * unverified Jettison JSON request shapes.
 *
 * Errors are NOT toasted here — callers (panel/dialogs) surface failures
 * via platform.ui.toast, mapping 403 to a permission problem and 404/501
 * to plugin-not-installed where relevant.
 */

const EXT = '/extensions/oie-cache-manager';

const enc = encodeURIComponent;

/* ---- wire-shape normalization (pure; unit-testable) ------------------------ */

// Missing/empty -> [], singleton -> [x] (XStream one-element collections arrive
// as a bare object).
function toArray(v) {
    if (v === null || v === undefined || v === '') return [];
    return Array.isArray(v) ? v : [v];
}

function str(v, dflt = '') {
    return v === undefined || v === null ? dflt : String(v);
}

// Numbers can arrive as JSON numbers or as strings ("500", "NaN"); Number()
// maps both, and ''/missing take the model's default.
function num(v, dflt = 0) {
    return v === undefined || v === null || v === '' ? dflt : Number(v);
}

// Server-generated UUID string, or null when absent.
function idOrNull(v) {
    return v === undefined || v === null || v === '' ? null : String(v);
}

/* Coerce a raw wire CacheDefinition into the stable client shape. */
export function normalizeDefinition(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: idOrNull(raw.id),
        name: str(raw.name),
        // Booleans can arrive as the STRING 'false'; missing falls back to the
        // model's default (enabled = true).
        enabled: raw.enabled === undefined || raw.enabled === null
            ? true : String(raw.enabled) !== 'false',
        driver: str(raw.driver),
        url: str(raw.url),
        username: str(raw.username),
        password: str(raw.password),
        query: str(raw.query),
        keyColumn: str(raw.keyColumn),
        valueColumn: str(raw.valueColumn),
        maxSize: num(raw.maxSize),
        evictionDurationMinutes: num(raw.evictionDurationMinutes),
        maxConnections: num(raw.maxConnections, 5)
    };
}

/* Coerce a raw wire CacheStatistics into the stable client shape. */
export function normalizeStatistics(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        cacheDefinitionId: idOrNull(raw.cacheDefinitionId),
        name: str(raw.name),
        size: num(raw.size),
        hitCount: num(raw.hitCount),
        missCount: num(raw.missCount),
        loadSuccessCount: num(raw.loadSuccessCount),
        loadExceptionCount: num(raw.loadExceptionCount),
        // An idle cache reports hitRate NaN, which the wire carries as the
        // STRING "NaN" (not a valid JSON number); Number() maps it back to NaN.
        hitRate: num(raw.hitRate, NaN),
        evictionCount: num(raw.evictionCount),
        requestCount: num(raw.requestCount),
        totalLoadTimeNanos: num(raw.totalLoadTimeNanos),
        averageLoadPenaltyNanos: num(raw.averageLoadPenaltyNanos),
        estimatedMemoryBytes: num(raw.estimatedMemoryBytes)
    };
}

/* Coerce a raw wire CacheEntry into the stable client shape. */
export function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        key: str(raw.key),
        value: str(raw.value),
        loadedAtMillis: num(raw.loadedAtMillis),
        accessCount: num(raw.accessCount)
    };
}

/* Coerce a raw wire CacheSnapshot into the stable client shape. The entries
   List<CacheEntry> arrives as {cacheEntry:[...]}, a singleton {cacheEntry:{...}},
   or '' when the cache is empty. */
export function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let entries = raw.entries;
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
        entries = entries.cacheEntry;
    }
    return {
        statistics: normalizeStatistics(raw.statistics),
        entries: toArray(entries).map(normalizeEntry).filter(Boolean),
        totalEntries: num(raw.totalEntries),
        matchedEntries: num(raw.matchedEntries)
    };
}

/* ---- XStream XML writes ----------------------------------------------------- */

function escapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/* Serialize a definition the way XStream expects <cacheDefinition>, in the
   model's declared field order (id, name, enabled, connection, query, cache
   settings). The <id> element is omitted on create (the server assigns it);
   primitives are always written, string fields default to ''. */
export function definitionXml(def, { includeId = false } = {}) {
    const parts = [];
    if (includeId && def.id !== null && def.id !== undefined && def.id !== '') {
        parts.push(`<id>${escapeXml(def.id)}</id>`);
    }
    parts.push(`<name>${escapeXml(def.name ?? '')}</name>`);
    // Tolerate the boolean-as-string wire quirk on round-tripped definitions;
    // missing falls back to the model's default (enabled = true).
    parts.push(`<enabled>${String(def.enabled ?? true) !== 'false'}</enabled>`);
    parts.push(`<driver>${escapeXml(def.driver ?? '')}</driver>`);
    parts.push(`<url>${escapeXml(def.url ?? '')}</url>`);
    parts.push(`<username>${escapeXml(def.username ?? '')}</username>`);
    parts.push(`<password>${escapeXml(def.password ?? '')}</password>`);
    parts.push(`<query>${escapeXml(def.query ?? '')}</query>`);
    parts.push(`<keyColumn>${escapeXml(def.keyColumn ?? '')}</keyColumn>`);
    parts.push(`<valueColumn>${escapeXml(def.valueColumn ?? '')}</valueColumn>`);
    parts.push(`<maxSize>${Number(def.maxSize ?? 0)}</maxSize>`);
    parts.push(`<evictionDurationMinutes>${Number(def.evictionDurationMinutes ?? 0)}</evictionDurationMinutes>`);
    parts.push(`<maxConnections>${Number(def.maxConnections ?? 5)}</maxConnections>`);
    return `<cacheDefinition>${parts.join('')}</cacheDefinition>`;
}

/* ---- REST client (the CacheServletInterface endpoints) ----------------------- */

// testConnectionInline/testQueryInline answer a plain String, which the host
// pipeline unwraps from {"string":"..."} (or passes through as text).
function text(v) {
    return v === null || v === undefined ? '' : String(v);
}

export function makeApi(api) {
    return {
        // Definition CRUD
        getDefinitions: async () =>
            api.asList(await api.get(`${EXT}/definitions`), 'cacheDefinition').map(normalizeDefinition),
        getDefinition: async (id) =>
            normalizeDefinition(await api.get(`${EXT}/definitions/${enc(id)}`)),
        createDefinition: async (def) =>
            normalizeDefinition(await api.postXml(`${EXT}/definitions`, definitionXml(def))),
        updateDefinition: async (id, def) =>
            normalizeDefinition(await api.putXml(`${EXT}/definitions/${enc(id)}`, definitionXml(def, { includeId: true }))),
        deleteDefinition: (id) => api.del(`${EXT}/definitions/${enc(id)}`),
        // Cache operations
        refreshCache: (id) => api.post(`${EXT}/definitions/${enc(id)}/refresh`, null),
        testConnectionInline: async (def) =>
            text(await api.postXml(`${EXT}/testConnectionInline`, definitionXml(def))),
        testQueryInline: async (def, sampleKey) =>
            text(await api.postXml(`${EXT}/testQueryInline`, definitionXml(def), { sampleKey })),
        // Statistics & snapshot
        getAllStatistics: async () =>
            api.asList(await api.get(`${EXT}/statistics`), 'cacheStatistics').map(normalizeStatistics),
        getSnapshot: async (id, { offset, limit, sortBy, sortDir, filter, filterScope, filterRegex } = {}) =>
            normalizeSnapshot(await api.get(`${EXT}/definitions/${enc(id)}/snapshot`,
                { offset, limit, sortBy, sortDir, filter, filterScope, filterRegex }))
    };
}
