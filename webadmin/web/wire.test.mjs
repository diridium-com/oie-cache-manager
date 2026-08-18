// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Diridium Technologies Inc.

/*
 * Wire-parsing tests for cache-api.js against the engine's XStream JSON
 * shapes: alias-keyed list roots ({"list":{"cacheDefinition":[...]}}),
 * singleton collapse (one-element collections arrive as a bare object),
 * '' for an empty collection, numbers-as-strings (including "NaN" for an
 * idle cache's hitRate), booleans as the STRING 'false', and 204/empty
 * bodies -> null. Plus golden-string asserts on the XStream XML write path.
 *
 * The normalizers receive values AFTER the web host's JSON pipeline has
 * stripped the single root key, so the unwrap/asList below are vendored
 * VERBATIM from the host (oie-web-client web-administrator/client/core/
 * api.js) to exercise the exact pipeline the plugin runs behind.
 *
 * Run: npm test   (from webadmin/; node --test web/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    makeApi, normalizeDefinition, normalizeStatistics, normalizeEntry,
    normalizeSnapshot, definitionXml
} from './cache-api.js';

/* ---- host JSON pipeline, vendored verbatim from client/core/api.js ---------- */

function unwrap(parsed) {
    // XStream JSON puts the payload under a single root key.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length === 1)
            return parsed[keys[0]];
    }
    return parsed;
}

/* When the engine returns a singleton or missing list, normalize to an array.
   XStream JSON renders one-element collections as a bare object, and classes
   without an @XStreamAlias use their fully-qualified name as the wrapper key
   (e.g. {"list":{"com.mirth...ServerLogItem":[...]}}). */
function asList(value, key) {
    if (value === null || value === undefined || value === '')
        return [];
    if (key !== undefined && value && typeof value === 'object' && !Array.isArray(value)) {
        if (value[key] !== undefined) {
            value = value[key];
        }
        else {
            const keys = Object.keys(value).filter(k => !k.startsWith('@'));
            if (keys.length === 1) {
                const lastSegment = (keys[0].split('.').pop() ?? '').toLowerCase();
                // Unwrap when the lone key is the FQCN form of the expected
                // alias, or when it plainly holds the array we asked for.
                if (lastSegment === key.toLowerCase() || Array.isArray(value[keys[0]])) {
                    value = value[keys[0]];
                }
            }
        }
        if (value === null || value === undefined || value === '')
            return [];
    }
    return Array.isArray(value) ? value : [value];
}

// A fake platform.api: reads answer unwrap(JSON.parse(fixture)) exactly like
// the host's parseBody does for JSON bodies (null = empty body / 204), and
// every call is recorded so tests can assert paths, params, and XML bodies.
function fakeApiFor(routes) {
    const calls = [];
    const parse = (body) => body == null ? null : unwrap(JSON.parse(body));
    const route = (method, path) => {
        assert.ok(Object.hasOwn(routes, path), `unexpected ${method} ${path}`);
        return parse(routes[path]);
    };
    return {
        calls,
        asList,
        get: async (path, params) => {
            calls.push({ method: 'GET', path, params });
            return route('GET', path);
        },
        post: async (path, body) => {
            calls.push({ method: 'POST', path, body });
            return Object.hasOwn(routes, path) ? parse(routes[path]) : null;
        },
        postXml: async (path, xml, params) => {
            calls.push({ method: 'POST-XML', path, xml, params });
            return route('POST', path);
        },
        putXml: async (path, xml, params) => {
            calls.push({ method: 'PUT-XML', path, xml, params });
            return route('PUT', path);
        },
        del: async (path) => {
            calls.push({ method: 'DELETE', path });
            return null;
        }
    };
}

const EXT = '/extensions/oie-cache-manager';

/* ---- fixtures: alias-keyed roots per the shared models' @XStreamAlias -------- */

// Two definitions: the first with native JSON types, the second exercising the
// numbers-as-strings and boolean-as-STRING-'false' quirks.
const WIRE_DEFINITIONS = '{"list":{"cacheDefinition":['
    + '{"id":"a1b2-c3","name":"Facilities","enabled":true,"driver":"org.postgresql.Driver",'
    + '"url":"jdbc:postgresql://db:5432/hie","username":"svc","password":"pw",'
    + '"query":"SELECT site_code, config FROM facilities WHERE site_code = ?",'
    + '"keyColumn":"site_code","valueColumn":"config",'
    + '"maxSize":1000,"evictionDurationMinutes":60,"maxConnections":5},'
    + '{"id":"d4e5-f6","name":"Providers","enabled":"false","driver":"com.mysql.cj.jdbc.Driver",'
    + '"url":"jdbc:mysql://db/x","username":"ro","password":"",'
    + '"query":"SELECT npi, name FROM providers WHERE npi = ?",'
    + '"keyColumn":"npi","valueColumn":"name",'
    + '"maxSize":"500","evictionDurationMinutes":"15","maxConnections":"3"}'
    + ']}}';

const WIRE_DEFINITION_SINGLE = '{"cacheDefinition":{"id":"a1b2-c3","name":"Facilities",'
    + '"enabled":true,"driver":"org.postgresql.Driver","url":"jdbc:postgresql://db:5432/hie",'
    + '"username":"svc","password":"pw","query":"SELECT 1","keyColumn":"k","valueColumn":"v",'
    + '"maxSize":1000,"evictionDurationMinutes":60,"maxConnections":5}}';

// An idle cache: Guava has answered no requests yet, so hitRate serializes as
// the string "NaN" (not a valid JSON number). Counters mix native/string types.
const WIRE_STATISTICS_SINGLETON = '{"list":{"cacheStatistics":'
    + '{"cacheDefinitionId":"a1b2-c3","name":"Facilities","size":"0","hitCount":0,'
    + '"missCount":0,"loadSuccessCount":0,"loadExceptionCount":0,"hitRate":"NaN",'
    + '"evictionCount":0,"requestCount":"0","totalLoadTimeNanos":0,'
    + '"averageLoadPenaltyNanos":0.0,"estimatedMemoryBytes":"2048"}}}';

// One cached entry: the entries List<CacheEntry> collapses to a bare object.
const WIRE_SNAPSHOT_SINGLETON = '{"cacheSnapshot":{'
    + '"statistics":{"cacheDefinitionId":"a1b2-c3","name":"Facilities","size":1,'
    + '"hitCount":"250","missCount":10,"loadSuccessCount":10,"loadExceptionCount":0,'
    + '"hitRate":0.9615384615384616,"evictionCount":2,"requestCount":260,'
    + '"totalLoadTimeNanos":"1500000000","averageLoadPenaltyNanos":1.5E8,'
    + '"estimatedMemoryBytes":4096},'
    + '"entries":{"cacheEntry":{"key":"MAIN","value":"{\\"tz\\":\\"UTC\\"}",'
    + '"loadedAtMillis":"1755500000000","accessCount":"7"}},'
    + '"totalEntries":1,"matchedEntries":"1"}}';

const WIRE_SNAPSHOT_EMPTY = '{"cacheSnapshot":{'
    + '"statistics":{"cacheDefinitionId":"a1b2-c3","name":"Facilities","size":0,'
    + '"hitCount":0,"missCount":0,"loadSuccessCount":0,"loadExceptionCount":0,'
    + '"hitRate":"NaN","evictionCount":0,"requestCount":0,"totalLoadTimeNanos":0,'
    + '"averageLoadPenaltyNanos":0.0,"estimatedMemoryBytes":0},'
    + '"entries":"","totalEntries":0,"matchedEntries":0}}';

/* ---- definitions list: plural, singleton collapse, empty ---------------------- */

test('getDefinitions parses a two-definition list and coerces string-typed fields', async () => {
    const cache = makeApi(fakeApiFor({ [`${EXT}/definitions`]: WIRE_DEFINITIONS }));
    const defs = await cache.getDefinitions();
    assert.equal(defs.length, 2);

    assert.equal(defs[0].id, 'a1b2-c3');
    assert.equal(defs[0].name, 'Facilities');
    assert.equal(defs[0].enabled, true);
    assert.equal(defs[0].maxSize, 1000);

    assert.equal(defs[1].enabled, false, 'the STRING "false" reads as false');
    assert.equal(defs[1].maxSize, 500, 'numeric string coerced');
    assert.equal(defs[1].evictionDurationMinutes, 15);
    assert.equal(defs[1].maxConnections, 3);
    assert.equal(defs[1].password, '');
});

test('getDefinitions parses a singleton list (bare object, not array)', async () => {
    const singleton = '{"list":{"cacheDefinition":{"id":"a1b2-c3","name":"Facilities",'
        + '"enabled":true,"maxSize":1000,"evictionDurationMinutes":60,"maxConnections":5}}}';
    const cache = makeApi(fakeApiFor({ [`${EXT}/definitions`]: singleton }));
    const defs = await cache.getDefinitions();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].name, 'Facilities');
    assert.equal(defs[0].driver, '', 'missing string field defaults to ""');
});

test('getDefinitions answers [] for an empty list - {"list":""}', async () => {
    const cache = makeApi(fakeApiFor({ [`${EXT}/definitions`]: '{"list":""}' }));
    assert.deepEqual(await cache.getDefinitions(), []);
});

/* ---- single definition: aliased root / 204 ------------------------------------ */

test('getDefinition parses the aliased cacheDefinition root', async () => {
    const cache = makeApi(fakeApiFor({ [`${EXT}/definitions/a1b2-c3`]: WIRE_DEFINITION_SINGLE }));
    const def = await cache.getDefinition('a1b2-c3');
    assert.equal(def.id, 'a1b2-c3');
    assert.equal(def.query, 'SELECT 1');
    assert.equal(def.maxConnections, 5);
});

test('getDefinition answers null for a 204 / empty body', async () => {
    const cache = makeApi(fakeApiFor({ [`${EXT}/definitions/gone`]: null }));
    assert.equal(await cache.getDefinition('gone'), null);
});

/* ---- statistics: singleton collapse + NaN hitRate ------------------------------ */

test('getAllStatistics parses a singleton list and maps the wire "NaN" hitRate to NaN', async () => {
    const cache = makeApi(fakeApiFor({ [`${EXT}/statistics`]: WIRE_STATISTICS_SINGLETON }));
    const stats = await cache.getAllStatistics();
    assert.equal(stats.length, 1);
    const s = stats[0];
    assert.equal(s.cacheDefinitionId, 'a1b2-c3');
    assert.equal(s.size, 0, 'numeric string coerced');
    assert.ok(Number.isNaN(s.hitRate), 'string "NaN" -> the number NaN');
    assert.equal(s.estimatedMemoryBytes, 2048);
    assert.equal(typeof s.requestCount, 'number');
});

test('getAllStatistics answers [] for an empty list', async () => {
    const cache = makeApi(fakeApiFor({ [`${EXT}/statistics`]: '{"list":""}' }));
    assert.deepEqual(await cache.getAllStatistics(), []);
});

/* ---- snapshot: entries singleton, empty entries, params, 204 ------------------- */

test('getSnapshot parses a snapshot whose entries List collapsed to one bare cacheEntry', async () => {
    const api = fakeApiFor({ [`${EXT}/definitions/a1b2-c3/snapshot`]: WIRE_SNAPSHOT_SINGLETON });
    const cache = makeApi(api);
    const snap = await cache.getSnapshot('a1b2-c3', {
        offset: 0, limit: 100, sortBy: 'key', sortDir: 'asc',
        filter: 'MAIN', filterScope: 'key', filterRegex: false
    });

    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0].key, 'MAIN');
    assert.equal(snap.entries[0].value, '{"tz":"UTC"}');
    assert.equal(snap.entries[0].loadedAtMillis, 1755500000000, 'millis string coerced');
    assert.equal(snap.entries[0].accessCount, 7);
    assert.equal(snap.statistics.hitCount, 250);
    assert.equal(snap.totalEntries, 1);
    assert.equal(snap.matchedEntries, 1, 'numeric string coerced');

    // The servlet's exact query-param names ride through untouched.
    assert.deepEqual(api.calls[0].params, {
        offset: 0, limit: 100, sortBy: 'key', sortDir: 'asc',
        filter: 'MAIN', filterScope: 'key', filterRegex: false
    });
});

test('getSnapshot tolerates an empty entries collection ("")', async () => {
    const cache = makeApi(fakeApiFor({ [`${EXT}/definitions/a1b2-c3/snapshot`]: WIRE_SNAPSHOT_EMPTY }));
    const snap = await cache.getSnapshot('a1b2-c3');
    assert.deepEqual(snap.entries, []);
    assert.ok(Number.isNaN(snap.statistics.hitRate));
    assert.equal(snap.totalEntries, 0);
});

test('getSnapshot answers null for a 204 / empty body', async () => {
    const cache = makeApi(fakeApiFor({ [`${EXT}/definitions/x/snapshot`]: null }));
    assert.equal(await cache.getSnapshot('x'), null);
});

/* ---- normalizer edges ----------------------------------------------------------- */

test('normalizers reject non-objects and default missing fields', () => {
    assert.equal(normalizeDefinition(null), null);
    assert.equal(normalizeStatistics('x'), null);
    assert.equal(normalizeEntry(undefined), null);
    assert.equal(normalizeSnapshot(''), null);

    const bare = normalizeDefinition({});
    assert.equal(bare.id, null);
    assert.equal(bare.enabled, true, 'model default (enabled = true)');
    assert.equal(bare.maxSize, 0);
    assert.equal(bare.maxConnections, 5, 'model default');

    assert.equal(normalizeDefinition({ id: '' }).id, null);
    assert.equal(normalizeDefinition({ id: 7 }).id, '7', 'ids String()-coerced');
    assert.equal(normalizeDefinition({ enabled: 'false' }).enabled, false);
    assert.equal(normalizeDefinition({ enabled: 'true' }).enabled, true);
});

/* ---- definitionXml: the XStream XML write path ----------------------------------- */

const XML_DEF = {
    id: 'a1b2-c3',
    name: 'Facilities & Sites',
    enabled: true,
    driver: 'org.postgresql.Driver',
    url: 'jdbc:postgresql://db:5432/hie?ssl=true&sslmode=require',
    username: 'svc',
    password: 'p<w>d',
    query: "SELECT config FROM facilities WHERE site_code = ? AND beds < 100 AND beds > 1 AND region = 'x & y'",
    keyColumn: 'site_code',
    valueColumn: 'config',
    maxSize: 1000,
    evictionDurationMinutes: 60,
    maxConnections: 5
};

const XML_BODY =
    '<name>Facilities &amp; Sites</name>'
    + '<enabled>true</enabled>'
    + '<driver>org.postgresql.Driver</driver>'
    + '<url>jdbc:postgresql://db:5432/hie?ssl=true&amp;sslmode=require</url>'
    + '<username>svc</username>'
    + '<password>p&lt;w&gt;d</password>'
    + '<query>SELECT config FROM facilities WHERE site_code = ? AND beds &lt; 100 '
    + 'AND beds &gt; 1 AND region = \'x &amp; y\'</query>'
    + '<keyColumn>site_code</keyColumn>'
    + '<valueColumn>config</valueColumn>'
    + '<maxSize>1000</maxSize>'
    + '<evictionDurationMinutes>60</evictionDurationMinutes>'
    + '<maxConnections>5</maxConnections>';

test('definitionXml create omits <id> and escapes & < > (golden string)', () => {
    assert.equal(definitionXml(XML_DEF), `<cacheDefinition>${XML_BODY}</cacheDefinition>`);
});

test('definitionXml update includes <id> (golden string)', () => {
    assert.equal(
        definitionXml(XML_DEF, { includeId: true }),
        `<cacheDefinition><id>a1b2-c3</id>${XML_BODY}</cacheDefinition>`);
});

test('definitionXml defaults missing fields (empty strings, model defaults)', () => {
    const xml = definitionXml({ name: 'Min' });
    assert.ok(xml.startsWith('<cacheDefinition><name>Min</name><enabled>true</enabled><driver></driver>'));
    assert.ok(xml.endsWith('<maxSize>0</maxSize><evictionDurationMinutes>0</evictionDurationMinutes>'
        + '<maxConnections>5</maxConnections></cacheDefinition>'));
    assert.ok(!xml.includes('<id>'), 'no id element without includeId');
});

/* ---- write endpoints: XML bodies, paths, params ----------------------------------- */

test('createDefinition POSTs id-less XStream XML and normalizes the echoed definition', async () => {
    const api = fakeApiFor({ [`${EXT}/definitions`]: WIRE_DEFINITION_SINGLE });
    const created = await makeApi(api).createDefinition(XML_DEF);
    assert.deepEqual(api.calls[0], {
        method: 'POST-XML',
        path: `${EXT}/definitions`,
        xml: `<cacheDefinition>${XML_BODY}</cacheDefinition>`,
        params: undefined
    });
    assert.equal(created.id, 'a1b2-c3', 'server-assigned id read back');
});

test('updateDefinition PUTs XML including <id> to the definition path', async () => {
    const api = fakeApiFor({ [`${EXT}/definitions/a1b2-c3`]: WIRE_DEFINITION_SINGLE });
    await makeApi(api).updateDefinition('a1b2-c3', XML_DEF);
    assert.equal(api.calls[0].method, 'PUT-XML');
    assert.equal(api.calls[0].path, `${EXT}/definitions/a1b2-c3`);
    assert.ok(api.calls[0].xml.startsWith('<cacheDefinition><id>a1b2-c3</id>'));
});

test('deleteDefinition and refreshCache hit the servlet paths', async () => {
    const api = fakeApiFor({});
    const cache = makeApi(api);
    await cache.deleteDefinition('a1b2-c3');
    await cache.refreshCache('a1b2-c3');
    assert.deepEqual(api.calls[0], { method: 'DELETE', path: `${EXT}/definitions/a1b2-c3` });
    assert.equal(api.calls[1].method, 'POST');
    assert.equal(api.calls[1].path, `${EXT}/definitions/a1b2-c3/refresh`);
});

test('testConnectionInline unwraps the {"string":...} reply to plain text', async () => {
    const api = fakeApiFor({ [`${EXT}/testConnectionInline`]: '{"string":"Connection successful"}' });
    const msg = await makeApi(api).testConnectionInline(XML_DEF);
    assert.equal(msg, 'Connection successful');
    assert.equal(api.calls[0].path, `${EXT}/testConnectionInline`);
    assert.ok(api.calls[0].xml.startsWith('<cacheDefinition><name>'), 'inline test sends the id-less definition');
});

test('testQueryInline sends sampleKey as a query param and returns the reply text', async () => {
    const api = fakeApiFor({ [`${EXT}/testQueryInline`]: '{"string":"MAIN = {\\"tz\\":\\"UTC\\"}"}' });
    const msg = await makeApi(api).testQueryInline(XML_DEF, 'MAIN');
    assert.equal(msg, 'MAIN = {"tz":"UTC"}');
    assert.deepEqual(api.calls[0].params, { sampleKey: 'MAIN' });
});
