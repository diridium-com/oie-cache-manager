// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Diridium Technologies Inc.

/*
 * Framework-agnostic core for the Cache Manager web UI: the formatters, the
 * definition validator, the vendored default JDBC driver list, and the
 * inspector's status-label builder — ported 1:1 from the Swing client's
 * CacheDefinitionTableModel / DialogUtils / CacheDefinitionDialog /
 * CacheInspectorDialog so the web administrator shows byte-identical texts.
 *
 * No DOM/React here — just data, numbers, and strings. cache-panel.jsx /
 * definition-dialog.jsx / inspector.jsx build on top of this; it is
 * unit-testable with plain `node --test`.
 */

/* ---- input tolerance helpers ------------------------------------------------ */

// Wire numbers can arrive as strings (XStream JSON quirk); null/undefined/NaN
// count as 0 for arithmetic.
function num(v) {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
}

// Trimmed-string view of a form/wire value; null/undefined read as ''.
function str(v) {
    return v == null ? '' : String(v).trim();
}

// NumberFormat.getIntegerInstance() on a US-locale JVM: grouping commas,
// no fraction digits. Hand-rolled so the output does not depend on the
// viewer's browser locale.
function groupInt(n) {
    return String(Math.trunc(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ---- table/statistics formatters (CacheDefinitionTableModel, 1:1) ----------- */

// CacheDefinitionTableModel.formatPercent: NaN (stats missing, or no lookups
// yet) renders as an em-dash; otherwise Java's String.format("%.1f%%") — one
// forced decimal, so 1.0 renders "100.0%".
export function fmtHitRate(rate) {
    const r = Number(rate);
    if (Number.isNaN(r)) return '—';
    return (r * 100).toFixed(1) + '%';
}

// CacheInspectorDialog stats header: NumberFormat.getPercentInstance() with
// max one fraction digit (min 0) — whole percentages carry no ".0" ("95%",
// not "95.0%"). The NaN guard is defensive; the server never sends NaN here
// (Guava reports 1.0 for an idle cache).
export function fmtHitRatePercent(rate) {
    const r = Number(rate);
    if (Number.isNaN(r)) return '—';
    const rounded = Math.round(r * 1000) / 10;
    return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
}

// CacheDefinitionTableModel.formatBytes: "<n> B" below 1 KiB, then one-decimal
// KB / MB / GB (binary units, Java's %.1f).
export function fmtBytes(n) {
    const bytes = num(n);
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// DialogUtils.formatTimestamp: 0 (never loaded) renders "-", otherwise
// "yyyy-MM-dd HH:mm:ss" in the viewer's local time zone (Swing formats with
// the client JVM's ZoneId.systemDefault()).
export function fmtTimestamp(ms) {
    const millis = num(ms);
    if (millis === 0) return '-';
    const d = new Date(millis);
    const pad = (v) => String(v).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/* ---- inspector stats derivations (CacheInspectorDialog, 1:1) ---------------- */

// CacheInspectorDialog.buildStatsPanel — the "Est. Without Cache" figure:
// average load penalty (nanos -> ms) times total lookups. Returns
// milliseconds; render with fmtDuration().
export function estWithoutCacheMs(stats) {
    const s = stats || {};
    return num(s.averageLoadPenaltyNanos) / 1_000_000 * num(s.requestCount);
}

// CacheInspectorDialog.formatDuration — used for "Total DB Time" and
// "Est. Without Cache": "N ms" below a second, then one-decimal s / min / hr.
// (Companion to estWithoutCacheMs; not in the pinned module contract.)
export function fmtDuration(millis) {
    const ms = num(millis);
    if (ms < 1_000) return ms.toFixed(0) + ' ms';
    if (ms < 60_000) return (ms / 1_000).toFixed(1) + ' s';
    if (ms < 3_600_000) return (ms / 60_000).toFixed(1) + ' min';
    return (ms / 3_600_000).toFixed(1) + ' hr';
}

/* ---- query-test result parsing (CacheDefinitionDialog.onTestQuery, 1:1) ----- */

// The servlet's testQueryInline returns a plain string; a successful
// single-row result is "Key: <k>\nValue: <v>" (CacheManager.testQuery). Swing
// splits on the FIRST "\nValue: " and opens the result dialog; anything
// without the separator ("No rows returned for key: ...", "Query failed: ...",
// missing-column reports) is shown as-is. Returns {key, value} for the
// success shape, null otherwise (the caller then toasts/echoes the raw
// string). A multiline value keeps everything after the first separator,
// later "\nValue: " occurrences included.
export function parseQueryTestResult(s) {
    if (s == null) return null;
    const text = String(s);
    const sep = text.indexOf('\nValue: ');
    if (sep < 0) return null;
    const value = text.substring(sep + '\nValue: '.length);
    let key = text.substring(0, sep);
    if (key.startsWith('Key: ')) {
        key = key.substring('Key: '.length);
    }
    return { key, value };
}

/* ---- definition validation (CacheDefinitionDialog.onSave, 1:1) -------------- */

// Swing shows one JOptionPane per problem and stops at the first; here every
// problem is collected in the dialog's field order, so errors[0] is exactly
// what Swing would have shown first. Messages are verbatim. Defaults when
// blank: maxSize 10000, evictionDurationMinutes 60, maxConnections 5 (minimum
// 1). Numerics are parsed with Long.parseLong/Integer.parseInt strictness —
// optional sign and digits only ("1.5", "1e3", "0x10" are rejected).
//
// The duplicate-name check has no Swing counterpart (the server answers 409
// CONFLICT); the web dialog checks up front against existingNames,
// case-insensitively. The PANEL must exclude the definition's own current
// name from existingNames when editing.
//
// The returned value is the normalized definition: strings trimmed (password
// deliberately NOT trimmed — Swing takes the password field raw), numbers as
// numbers, enabled as a real boolean (the string 'false' counts as false),
// id String()-coerced or null. Only meaningful when errors is empty.
export function validateDefinition(def, existingNames) {
    const d = def || {};
    const errors = [];

    const name = str(d.name);
    if (name === '') {
        errors.push({ field: 'name', message: 'Name is required.' });
    } else {
        const lower = name.toLowerCase();
        const names = Array.isArray(existingNames) ? existingNames : [];
        if (names.some((n) => str(n).toLowerCase() === lower)) {
            errors.push({ field: 'name', message: 'A cache definition named "' + name + '" already exists.' });
        }
    }

    const driver = str(d.driver);
    if (driver === '') {
        errors.push({ field: 'driver', message: 'Driver class is required.' });
    }

    const url = str(d.url);
    if (url === '') {
        errors.push({ field: 'url', message: 'JDBC URL is required.' });
    }

    const query = str(d.query);
    if (query === '') {
        errors.push({ field: 'query', message: 'Query is required.' });
    }

    const valueColumn = str(d.valueColumn);
    if (valueColumn === '') {
        errors.push({ field: 'valueColumn', message: 'Value Column is required.' });
    }

    // Long.parseLong strictness, plus a JS-side safety bound: digit strings
    // beyond Number.MAX_SAFE_INTEGER would be silently altered by Number()
    // before hitting the wire (and 2^63+ would 500 server-side), so they are
    // rejected with the same "must be a number." message Swing shows for
    // unparseable input.
    const INT_RE = /^[+-]?\d+$/;
    const parsable = (text) => INT_RE.test(text) && Number.isSafeInteger(Number(text));

    let maxSize = 10000;
    const maxSizeText = str(d.maxSize);
    if (maxSizeText !== '') {
        if (!parsable(maxSizeText)) {
            errors.push({ field: 'maxSize', message: 'Max Size must be a number.' });
        } else if (Number(maxSizeText) < 0) {
            errors.push({ field: 'maxSize', message: 'Max Size must be non-negative.' });
        } else {
            maxSize = Number(maxSizeText);
        }
    }

    let evictionDurationMinutes = 60;
    const evictionText = str(d.evictionDurationMinutes);
    if (evictionText !== '') {
        if (!parsable(evictionText)) {
            errors.push({ field: 'evictionDurationMinutes', message: 'Eviction duration must be a number.' });
        } else if (Number(evictionText) < 0) {
            errors.push({ field: 'evictionDurationMinutes', message: 'Eviction duration must be non-negative.' });
        } else {
            evictionDurationMinutes = Number(evictionText);
        }
    }

    let maxConnections = 5;
    const maxConnectionsText = str(d.maxConnections);
    if (maxConnectionsText !== '') {
        if (!parsable(maxConnectionsText)) {
            errors.push({ field: 'maxConnections', message: 'Max Connections must be a number.' });
        } else if (Number(maxConnectionsText) < 1) {
            errors.push({ field: 'maxConnections', message: 'Max Connections must be at least 1.' });
        } else if (Number(maxConnectionsText) > 2147483647) {
            // Integer.MAX_VALUE — the model field is a Java int.
            errors.push({ field: 'maxConnections', message: 'Max Connections must be a number.' });
        } else {
            maxConnections = Number(maxConnectionsText);
        }
    }

    // new CacheDefinition() defaults enabled to true; the checkbox starts
    // checked. Booleans can arrive as the STRING 'false' off the wire.
    const enabled = d.enabled == null
        ? true
        : (d.enabled !== false && String(d.enabled) !== 'false');

    const value = {
        id: d.id == null ? null : String(d.id),
        name,
        enabled,
        driver,
        url,
        username: str(d.username),
        password: d.password == null ? '' : String(d.password),
        query,
        keyColumn: str(d.keyColumn),
        valueColumn,
        maxSize,
        evictionDurationMinutes,
        maxConnections,
    };

    return { errors, value };
}

/* ---- default JDBC drivers (DriverInfo.getDefaultDrivers(), vendored) -------- */

// The engine's built-in fallback list, vendored verbatim from
// com.mirth.connect.model.DriverInfo so the driver combo works even when the
// host's driver endpoint is unavailable (Swing falls back to exactly this
// list). The dialog itself adds its "Please Select One" / "Custom" sentinel
// rows. alternativeClassNames mirrors the engine and is used to match a
// stored class name back to a combo row.
export const DEFAULT_DRIVERS = [
    {
        name: 'MySQL',
        className: 'com.mysql.cj.jdbc.Driver',
        template: 'jdbc:mysql://host:port/dbname',
        alternativeClassNames: ['com.mysql.jdbc.Driver'],
    },
    {
        name: 'Oracle',
        className: 'oracle.jdbc.driver.OracleDriver',
        template: 'jdbc:oracle:thin:@host:port:dbname',
        alternativeClassNames: [],
    },
    {
        name: 'PostgreSQL',
        className: 'org.postgresql.Driver',
        template: 'jdbc:postgresql://host:port/dbname',
        alternativeClassNames: [],
    },
    {
        name: 'SQL Server/Sybase (jTDS)',
        className: 'net.sourceforge.jtds.jdbc.Driver',
        template: 'jdbc:jtds:sqlserver://host:port/dbname',
        alternativeClassNames: [],
    },
    {
        name: 'Microsoft SQL Server',
        className: 'com.microsoft.sqlserver.jdbc.SQLServerDriver',
        template: 'jdbc:sqlserver://host:port;databaseName=dbname',
        alternativeClassNames: [],
    },
    {
        name: 'SQLite',
        className: 'org.sqlite.JDBC',
        template: 'jdbc:sqlite:dbfile.db',
        alternativeClassNames: [],
    },
];

/* ---- inspector status label (CacheInspectorDialog.updateStatusLabel, 1:1) --- */

// The three Swing variants, with grouping commas and an en dash (U+2013) for
// the range, exactly as NumberFormat.getIntegerInstance() renders on a
// US-locale JVM:
//   filter narrowed the set:  "1–1,000 of 2,500 matches (5,000 total)"
//   paged (unfiltered):       "1,001–2,000 of 5,000 entries"
//   everything on one page:   "42 entries"
export function snapshotStatus(offset, shownCount, matched, total) {
    const off = num(offset);
    const shown = num(shownCount);
    const m = num(matched);
    const t = num(total);

    const from = off + 1;
    const to = off + shown;

    if (m < t) {
        return groupInt(from) + '–' + groupInt(to) + ' of '
            + groupInt(m) + ' matches (' + groupInt(t) + ' total)';
    }
    if (shown < m || off > 0) {
        return groupInt(from) + '–' + groupInt(to) + ' of ' + groupInt(t) + ' entries';
    }
    return groupInt(shown) + ' entries';
}

/* ---- value truncation (CacheInspectorDialog.truncateValue, 1:1) ------------- */

// Entries-table cap on the Value column (VALUE_TRUNCATE_LENGTH = 100).
export const VALUE_TRUNCATE_LENGTH = 100;

// null renders as ""; values at or under the cap pass through unchanged;
// longer values are cut at the cap with a "..." suffix. max overrides the cap.
export function truncateValue(v, max) {
    if (v == null) return '';
    const s = String(v);
    const cap = max == null ? VALUE_TRUNCATE_LENGTH : Number(max);
    if (s.length <= cap) return s;
    return s.substring(0, cap) + '...';
}
