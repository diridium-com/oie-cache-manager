// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Diridium Technologies Inc.

/*
 * Golden tests for cache-core.js against the exact strings the Swing client
 * renders (CacheDefinitionTableModel / DialogUtils / CacheDefinitionDialog /
 * CacheInspectorDialog), so the web administrator stays byte-identical with
 * the desktop client. Timestamp goldens are built from local-time Date
 * components, so they hold in any time zone.
 *
 * Run: npm test   (from webadmin/; node --test web/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fmtHitRate, fmtHitRatePercent, fmtBytes, fmtTimestamp, estWithoutCacheMs, fmtDuration,
    parseQueryTestResult, validateDefinition, DEFAULT_DRIVERS,
    snapshotStatus, truncateValue, VALUE_TRUNCATE_LENGTH,
} from './cache-core.js';

/* ---- fmtHitRate (CacheDefinitionTableModel.formatPercent) ------------------- */

test('fmtHitRate: NaN renders the em-dash placeholder', () => {
    assert.equal(fmtHitRate(NaN), '—');
});

test('fmtHitRate: missing value (stats absent) renders the em-dash', () => {
    assert.equal(fmtHitRate(undefined), '—');
});

test('fmtHitRate: one forced decimal like Java %.1f%%', () => {
    assert.equal(fmtHitRate(0), '0.0%');
    assert.equal(fmtHitRate(1), '100.0%');
    assert.equal(fmtHitRate(0.975), '97.5%');
    assert.equal(fmtHitRate(0.3333), '33.3%');
});

test('fmtHitRate: string-typed rate off the wire is coerced', () => {
    assert.equal(fmtHitRate('0.5'), '50.0%');
});

/* ---- fmtBytes (CacheDefinitionTableModel.formatBytes) ----------------------- */

test('fmtBytes: below 1 KiB renders whole bytes', () => {
    assert.equal(fmtBytes(0), '0 B');
    assert.equal(fmtBytes(512), '512 B');
    assert.equal(fmtBytes(1023), '1023 B');
});

test('fmtBytes: KB / MB / GB with one decimal', () => {
    assert.equal(fmtBytes(1024), '1.0 KB');
    assert.equal(fmtBytes(1536), '1.5 KB');
    assert.equal(fmtBytes(1048576), '1.0 MB');
    assert.equal(fmtBytes(47500000), '45.3 MB');
    assert.equal(fmtBytes(1073741824), '1.0 GB');
    assert.equal(fmtBytes(5368709120), '5.0 GB');
});

test('fmtBytes: string-typed count off the wire is coerced', () => {
    assert.equal(fmtBytes('2048'), '2.0 KB');
});

/* ---- fmtTimestamp (DialogUtils.formatTimestamp) ----------------------------- */

test('fmtTimestamp: 0 (never loaded) renders "-"', () => {
    assert.equal(fmtTimestamp(0), '-');
});

test('fmtTimestamp: yyyy-MM-dd HH:mm:ss with zero padding', () => {
    // Built from local-time components, so the golden holds in any zone.
    const ms = new Date(2001, 1, 3, 4, 5, 6).getTime();
    assert.equal(fmtTimestamp(ms), '2001-02-03 04:05:06');
});

test('fmtTimestamp: double-digit components need no padding', () => {
    const ms = new Date(2026, 11, 31, 23, 59, 59).getTime();
    assert.equal(fmtTimestamp(ms), '2026-12-31 23:59:59');
});

/* ---- estWithoutCacheMs + fmtDuration (CacheInspectorDialog) ----------------- */

test('estWithoutCacheMs: avg load penalty (nanos->ms) times lookups', () => {
    assert.equal(estWithoutCacheMs({ averageLoadPenaltyNanos: 2000000, requestCount: 500 }), 1000);
});

test('estWithoutCacheMs: string-typed wire numbers are coerced', () => {
    assert.equal(estWithoutCacheMs({ averageLoadPenaltyNanos: '1500000', requestCount: '10' }), 15);
});

test('estWithoutCacheMs: empty stats yield 0', () => {
    assert.equal(estWithoutCacheMs({}), 0);
    assert.equal(estWithoutCacheMs(null), 0);
});

test('fmtDuration: ms / s / min / hr breakpoints match Swing formatDuration', () => {
    assert.equal(fmtDuration(0), '0 ms');
    assert.equal(fmtDuration(999), '999 ms');
    assert.equal(fmtDuration(1000), '1.0 s');
    assert.equal(fmtDuration(59999), '60.0 s');
    assert.equal(fmtDuration(60000), '1.0 min');
    assert.equal(fmtDuration(90000), '1.5 min');
    assert.equal(fmtDuration(3600000), '1.0 hr');
    assert.equal(fmtDuration(5400000), '1.5 hr');
});

test('fmtDuration of estWithoutCacheMs composes to the panel string', () => {
    const stats = { averageLoadPenaltyNanos: 2000000, requestCount: 500 };
    assert.equal(fmtDuration(estWithoutCacheMs(stats)), '1.0 s');
});

/* ---- parseQueryTestResult (CacheDefinitionDialog.onTestQuery) --------------- */

test('parseQueryTestResult: success shape from CacheManager.testQuery', () => {
    assert.deepEqual(parseQueryTestResult('Key: ABC\nValue: hello'),
        { key: 'ABC', value: 'hello' });
});

test('parseQueryTestResult: no separator (no rows / failure text) is null', () => {
    assert.equal(parseQueryTestResult('No rows returned for key: X'), null);
    assert.equal(parseQueryTestResult('Query failed: connection refused'), null);
    assert.equal(parseQueryTestResult(''), null);
    assert.equal(parseQueryTestResult(null), null);
});

test('parseQueryTestResult: multiline value keeps everything after the FIRST separator', () => {
    assert.deepEqual(parseQueryTestResult('Key: K\nValue: line1\nline2'),
        { key: 'K', value: 'line1\nline2' });
    // A later "\nValue: " inside the value stays in the value, like Swing's indexOf.
    assert.deepEqual(parseQueryTestResult('Key: K\nValue: a\nValue: b'),
        { key: 'K', value: 'a\nValue: b' });
});

/* ---- validateDefinition (CacheDefinitionDialog.onSave) ---------------------- */

function validDef(overrides) {
    return Object.assign({
        name: 'Facilities',
        enabled: true,
        driver: 'org.postgresql.Driver',
        url: 'jdbc:postgresql://db:5432/app',
        username: 'oie',
        password: ' secret ',
        query: 'SELECT site_code, config FROM facilities WHERE site_code = ?',
        keyColumn: 'site_code',
        valueColumn: 'config',
        maxSize: '10000',
        evictionDurationMinutes: '60',
        maxConnections: '5',
    }, overrides);
}

test('validateDefinition: a valid definition passes and normalizes', () => {
    const { errors, value } = validateDefinition(validDef({ id: 42, name: ' Facilities ' }), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(value, {
        id: '42',
        name: 'Facilities',
        enabled: true,
        driver: 'org.postgresql.Driver',
        url: 'jdbc:postgresql://db:5432/app',
        username: 'oie',
        // Swing reads the password field raw — never trimmed.
        password: ' secret ',
        query: 'SELECT site_code, config FROM facilities WHERE site_code = ?',
        keyColumn: 'site_code',
        valueColumn: 'config',
        maxSize: 10000,
        evictionDurationMinutes: 60,
        maxConnections: 5,
    });
});

test('validateDefinition: each required field carries the verbatim Swing message', () => {
    const cases = [
        ['name', 'Name is required.'],
        ['driver', 'Driver class is required.'],
        ['url', 'JDBC URL is required.'],
        ['query', 'Query is required.'],
        ['valueColumn', 'Value Column is required.'],
    ];
    for (const [field, message] of cases) {
        const { errors } = validateDefinition(validDef({ [field]: '   ' }), []);
        assert.deepEqual(errors, [{ field, message }], field);
    }
});

test('validateDefinition: an empty definition reports errors in dialog field order', () => {
    const { errors } = validateDefinition({}, []);
    assert.deepEqual(errors.map((e) => e.field),
        ['name', 'driver', 'url', 'query', 'valueColumn']);
});

test('validateDefinition: blank numerics apply the Swing defaults 10000/60/5', () => {
    const { errors, value } = validateDefinition(validDef({
        maxSize: '', evictionDurationMinutes: '', maxConnections: '',
    }), []);
    assert.deepEqual(errors, []);
    assert.equal(value.maxSize, 10000);
    assert.equal(value.evictionDurationMinutes, 60);
    assert.equal(value.maxConnections, 5);
});

test('validateDefinition: missing numerics (undefined) also default', () => {
    const def = validDef({});
    delete def.maxSize;
    delete def.evictionDurationMinutes;
    delete def.maxConnections;
    const { errors, value } = validateDefinition(def, []);
    assert.deepEqual(errors, []);
    assert.equal(value.maxSize, 10000);
    assert.equal(value.evictionDurationMinutes, 60);
    assert.equal(value.maxConnections, 5);
});

test('validateDefinition: non-numeric input carries the verbatim Swing messages', () => {
    assert.deepEqual(validateDefinition(validDef({ maxSize: 'abc' }), []).errors,
        [{ field: 'maxSize', message: 'Max Size must be a number.' }]);
    assert.deepEqual(validateDefinition(validDef({ evictionDurationMinutes: 'abc' }), []).errors,
        [{ field: 'evictionDurationMinutes', message: 'Eviction duration must be a number.' }]);
    assert.deepEqual(validateDefinition(validDef({ maxConnections: 'abc' }), []).errors,
        [{ field: 'maxConnections', message: 'Max Connections must be a number.' }]);
});

test('validateDefinition: Long.parseLong strictness — decimals and exponents rejected', () => {
    assert.equal(validateDefinition(validDef({ maxSize: '1.5' }), []).errors[0].message,
        'Max Size must be a number.');
    assert.equal(validateDefinition(validDef({ maxSize: '1e3' }), []).errors[0].message,
        'Max Size must be a number.');
});

test('validateDefinition: range rules — non-negative sizes, connections at least 1', () => {
    assert.deepEqual(validateDefinition(validDef({ maxSize: '-1' }), []).errors,
        [{ field: 'maxSize', message: 'Max Size must be non-negative.' }]);
    assert.deepEqual(validateDefinition(validDef({ evictionDurationMinutes: '-5' }), []).errors,
        [{ field: 'evictionDurationMinutes', message: 'Eviction duration must be non-negative.' }]);
    assert.deepEqual(validateDefinition(validDef({ maxConnections: '0' }), []).errors,
        [{ field: 'maxConnections', message: 'Max Connections must be at least 1.' }]);
    // Zero is a legal size and eviction duration, 1 a legal connection count.
    const ok = validateDefinition(validDef({
        maxSize: '0', evictionDurationMinutes: '0', maxConnections: '1',
    }), []);
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.maxSize, 0);
    assert.equal(ok.value.evictionDurationMinutes, 0);
    assert.equal(ok.value.maxConnections, 1);
});

test('validateDefinition: duplicate name is case-insensitive', () => {
    const { errors } = validateDefinition(validDef({ name: 'FACILITIES' }),
        ['Facilities', 'Other']);
    assert.deepEqual(errors, [{
        field: 'name',
        message: 'A cache definition named "FACILITIES" already exists.',
    }]);
    // Exact-case duplicate too.
    assert.equal(validateDefinition(validDef(), ['Facilities']).errors.length, 1);
    // No existingNames -> no duplicate check.
    assert.deepEqual(validateDefinition(validDef()).errors, []);
});

test('validateDefinition: enabled coercion (wire boolean quirks)', () => {
    assert.equal(validateDefinition(validDef({ enabled: 'false' }), []).value.enabled, false);
    assert.equal(validateDefinition(validDef({ enabled: false }), []).value.enabled, false);
    assert.equal(validateDefinition(validDef({ enabled: 'true' }), []).value.enabled, true);
    // new CacheDefinition() defaults enabled to true.
    assert.equal(validateDefinition(validDef({ enabled: undefined }), []).value.enabled, true);
});

test('validateDefinition: id passes through String()-coerced, null when absent', () => {
    assert.equal(validateDefinition(validDef({ id: 7 }), []).value.id, '7');
    assert.equal(validateDefinition(validDef(), []).value.id, null);
});

/* ---- DEFAULT_DRIVERS (DriverInfo.getDefaultDrivers(), vendored) ------------- */

test('DEFAULT_DRIVERS: the engine fallback list, verbatim', () => {
    assert.deepEqual(DEFAULT_DRIVERS.map((d) => [d.name, d.className, d.template]), [
        ['MySQL', 'com.mysql.cj.jdbc.Driver', 'jdbc:mysql://host:port/dbname'],
        ['Oracle', 'oracle.jdbc.driver.OracleDriver', 'jdbc:oracle:thin:@host:port:dbname'],
        ['PostgreSQL', 'org.postgresql.Driver', 'jdbc:postgresql://host:port/dbname'],
        ['SQL Server/Sybase (jTDS)', 'net.sourceforge.jtds.jdbc.Driver', 'jdbc:jtds:sqlserver://host:port/dbname'],
        ['Microsoft SQL Server', 'com.microsoft.sqlserver.jdbc.SQLServerDriver', 'jdbc:sqlserver://host:port;databaseName=dbname'],
        ['SQLite', 'org.sqlite.JDBC', 'jdbc:sqlite:dbfile.db'],
    ]);
});

test('DEFAULT_DRIVERS: MySQL carries the legacy alternative class name', () => {
    assert.deepEqual(DEFAULT_DRIVERS[0].alternativeClassNames, ['com.mysql.jdbc.Driver']);
});

/* ---- snapshotStatus (CacheInspectorDialog.updateStatusLabel) ---------------- */

test('snapshotStatus: empty cache', () => {
    assert.equal(snapshotStatus(0, 0, 0, 0), '0 entries');
});

test('snapshotStatus: everything on one page, unfiltered', () => {
    assert.equal(snapshotStatus(0, 42, 42, 42), '42 entries');
});

test('snapshotStatus: first page of many, unfiltered (en dash, grouping)', () => {
    assert.equal(snapshotStatus(0, 1000, 5000, 5000), '1–1,000 of 5,000 entries');
});

test('snapshotStatus: middle page, unfiltered', () => {
    assert.equal(snapshotStatus(1000, 1000, 5000, 5000), '1,001–2,000 of 5,000 entries');
});

test('snapshotStatus: last page keeps the ranged form (offset > 0)', () => {
    assert.equal(snapshotStatus(4000, 1000, 5000, 5000), '4,001–5,000 of 5,000 entries');
});

test('snapshotStatus: filter narrowed the set — matches plus grand total', () => {
    assert.equal(snapshotStatus(0, 1000, 2500, 5000),
        '1–1,000 of 2,500 matches (5,000 total)');
});

test('snapshotStatus: small filtered set still shows the matches form', () => {
    assert.equal(snapshotStatus(0, 3, 3, 10), '1–3 of 3 matches (10 total)');
});

test('snapshotStatus: string-typed wire numbers are coerced', () => {
    assert.equal(snapshotStatus('0', '42', '42', '42'), '42 entries');
});

/* ---- truncateValue (CacheInspectorDialog.truncateValue) --------------------- */

test('truncateValue: null and undefined render as empty string', () => {
    assert.equal(truncateValue(null), '');
    assert.equal(truncateValue(undefined), '');
});

test('truncateValue: at the 100-char cap the value passes unchanged', () => {
    const exact = 'x'.repeat(VALUE_TRUNCATE_LENGTH);
    assert.equal(truncateValue(exact), exact);
    assert.equal(truncateValue('short'), 'short');
});

test('truncateValue: one over the cap cuts to 100 chars plus "..."', () => {
    const over = 'x'.repeat(VALUE_TRUNCATE_LENGTH + 1);
    const result = truncateValue(over);
    assert.equal(result, 'x'.repeat(VALUE_TRUNCATE_LENGTH) + '...');
    assert.equal(result.length, VALUE_TRUNCATE_LENGTH + 3);
});

test('truncateValue: explicit max overrides the cap', () => {
    assert.equal(truncateValue('abcdef', 3), 'abc...');
    assert.equal(truncateValue('abc', 3), 'abc');
});

/* ---- fmtHitRatePercent (CacheInspectorDialog stats header) ------------------ */

test('fmtHitRatePercent: whole percentages carry no ".0" (NumberFormat.getPercentInstance)', () => {
    assert.equal(fmtHitRatePercent(0.95), '95%');
    assert.equal(fmtHitRatePercent(1), '100%');
    assert.equal(fmtHitRatePercent(0), '0%');
});

test('fmtHitRatePercent: fractional percentages keep one decimal', () => {
    assert.equal(fmtHitRatePercent(0.8617), '86.2%');
    assert.equal(fmtHitRatePercent('0.505'), '50.5%');
});

test('fmtHitRatePercent: NaN/missing renders the em-dash placeholder', () => {
    assert.equal(fmtHitRatePercent(NaN), '—');
    assert.equal(fmtHitRatePercent(undefined), '—');
});

/* ---- validateDefinition: unsafe-integer rejection --------------------------- */

test('validateDefinition: digit strings beyond Number.MAX_SAFE_INTEGER are rejected, not silently altered', () => {
    const base = { name: 'c', driver: 'd', url: 'u', query: 'q', valueColumn: 'v' };
    for (const field of ['maxSize', 'evictionDurationMinutes', 'maxConnections']) {
        const { errors } = validateDefinition({ ...base, [field]: '9007199254740993' }, []);
        assert.equal(errors.length, 1, field);
        assert.equal(errors[0].field, field);
        assert.match(errors[0].message, /must be a number\.$/);
    }
});

test('validateDefinition: maxConnections above Integer.MAX_VALUE is rejected', () => {
    const base = { name: 'c', driver: 'd', url: 'u', query: 'q', valueColumn: 'v' };
    const { errors } = validateDefinition({ ...base, maxConnections: '2147483648' }, []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].field, 'maxConnections');
    const ok = validateDefinition({ ...base, maxConnections: '2147483647' }, []);
    assert.equal(ok.errors.length, 0);
    assert.equal(ok.value.maxConnections, 2147483647);
});
