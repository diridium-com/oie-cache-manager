// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Diridium Technologies Inc.

/*
 * Cache Inspector overlay — the web port of CacheInspectorDialog +
 * EntryDetailDialog.
 *
 * Read-only point-in-time snapshot of one cache: statistics grid up top (with
 * the "?" help modal porting Swing's HTML explainer), entries table in the
 * middle, filter bar above it. Sort, filter, and pagination are all
 * SERVER-driven through api.getSnapshot — a header click, Apply, Prev/Next,
 * and Refresh each re-fetch; the table never sorts or filters locally.
 *
 * Swing parity notes: like the SwingWorker flow, every fetch reads the
 * CURRENT filter controls (not the last-applied ones), sort/offset state
 * advances before the fetch, and a failed fetch toasts while the previous
 * page stays visible (status label and button enablement keep describing the
 * page actually shown). Right-click = Copy Key / Copy Value (full value);
 * double-click = the Entry Detail modal (monospace value block, word-wrap
 * toggle, Copy Value). Escape closes the overlay, deferring to any host
 * .modal-overlay stacked above it (role-editor precedent).
 *
 * Mounting: openInspector is imperative (the panel calls it from an event
 * handler), so the overlay mounts through platform.reactView — the host's
 * bridge for driving a DOM element with a React root — appended to
 * document.body and torn down on close.
 */

import { fmtHitRatePercent, fmtTimestamp, estWithoutCacheMs, snapshotStatus, truncateValue } from './cache-core.js';

const VALUE_TRUNCATE_LENGTH = 100;   // CacheInspectorDialog.VALUE_TRUNCATE_LENGTH
const PAGE_LIMIT = 1000;             // CacheInspectorDialog.DEFAULT_LIMIT

// Column → server sort field (CacheInspectorDialog.SORT_FIELDS, same order).
const COLUMNS = [
    { label: 'Key', field: 'key' },
    { label: 'Value', field: 'value' },
    { label: 'Loaded At', field: 'loadedAt', width: 150 },
    { label: 'Accesses', field: 'accessCount', width: 90, num: true }
];

/* Own classes, NOT host Tailwind utilities: the host generates utilities from
   ITS source scan, so a class no host file uses simply does not exist in
   app.css. Host COMPONENT classes (.panel, .btn, .dt, .hint, .check) are fine. */
const INSPECTOR_CSS = `
.cachei-overlay {
    position: fixed;
    top: 0; right: 0; bottom: 0; left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
    /* Below the host's .modal-overlay (100): the stats-help and entry-detail
       modals (ui.modal) must stack above this inspector. */
    z-index: 95;
}
.cachei-dialog {
    width: min(1240px, 94vw);
    height: min(800px, 92vh);
    display: flex;
    flex-direction: column;
}
.cachei-dialog > .panel-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 0;
}
.cachei-stats {
    position: relative;
    flex: none;
    overflow-x: auto;
    display: grid;
    grid-template-columns: max-content minmax(70px, max-content) max-content minmax(70px, max-content) max-content max-content;
    gap: 6px 16px;
    padding: 12px 40px 10px 14px;
    font-size: 12px;
    border-bottom: 1px solid var(--line, #8884);
}
.cachei-stat-label { color: var(--text-dim, #888); white-space: nowrap; }
.cachei-stat-value { white-space: nowrap; font-variant-numeric: tabular-nums; }
.cachei-help {
    position: absolute;
    top: 10px; right: 12px;
    width: 20px; height: 20px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--line, #8884);
    background: transparent;
    color: var(--text-dim, #888);
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
}
.cachei-help:hover { color: var(--text, inherit); border-color: var(--text-dim, #888); }
.cachei-filter {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
}
.cachei-filter input[type="text"] { flex: 1; min-width: 0; }
/* The host's base stylesheet gives every <select> width: 100%; unset it or
   the scope dropdown claims the whole row and evicts the input/Regex/Apply
   (flex: none also means it cannot shrink back). */
.cachei-filter select { flex: none; width: auto; }
.cachei-table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-top: 1px solid var(--line, #8884);
}
.cachei-table-wrap table { width: 100%; }
.cachei-dialog > .panel-header {
    flex: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cachei-loading .cachei-table-wrap tbody { opacity: 0.55; }
.cachei-value-cell {
    max-width: 560px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cachei-key-cell {
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cachei-foot {
    flex: none;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--line, #8884);
}
.cachei-foot > div:first-child { min-width: 0; }
.cachei-usage {
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
}
.cachei-usage code {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    user-select: all;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cachei-status {
    font-size: 11px;
    color: var(--text-dim, #888);
    margin-top: 2px;
    min-height: 14px;
}
.cachei-foot-buttons { display: flex; align-items: center; gap: 8px; }
`;

// Swing's formatDuration: %.0f ms / %.1f s / %.1f min / %.1f hr.
function fmtDuration(millis) {
    const ms = Number(millis);
    if (!isFinite(ms)) return '-';
    if (ms < 1000) return ms.toFixed(0) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    if (ms < 3600000) return (ms / 60000).toFixed(1) + ' min';
    return (ms / 3600000).toFixed(1) + ' hr';
}

// Swing's "%.1f ms" of averageLoadPenaltyNanos / 1e6.
function fmtAvgLoadMs(stats) {
    const ms = Number(stats.averageLoadPenaltyNanos) / 1e6;
    return isFinite(ms) ? ms.toFixed(1) + ' ms' : '-';
}

// 403 reads as a permission problem; 404/501 as plugin-not-installed
// (host ApiError carries .status).
function snapshotErrorMessage(e) {
    const status = e && e.status;
    if (status === 403) {
        return 'You do not have permission to view cache snapshots'
            + ' (viewing server settings is required).';
    }
    if (status === 404 || status === 501) {
        return 'The OIE Cache Manager plugin is not installed on this engine.';
    }
    return String(e && e.message || e);
}

export function openInspector(platform, api, { definition }) {
    const React = platform.React;
    const ui = platform.ui;
    const cacheName = definition && definition.name != null ? String(definition.name) : '';
    const definitionId = definition ? definition.id : null;

    let handle = null;
    let closed = false;
    const close = () => {
        if (closed || !handle) return;   // idempotent: Escape + Close can race
        closed = true;
        handle.teardown();
        handle.el.remove();
    };

    function copyToClipboard(text, what) {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
            ui.toast('Clipboard is not available in this browser context.', 'error');
            return;
        }
        navigator.clipboard.writeText(text == null ? '' : String(text)).then(
            () => ui.toast(what + ' copied to clipboard', 'success'),
            (e) => ui.toast('Copy failed: ' + String(e && e.message || e), 'error'));
    }

    /* Swing's showStatsHelp() HTML, ported term by term (JOptionPane INFO). */
    function showStatsHelp() {
        const item = (term, ...text) => ui.h('p', { style: 'margin: 0 0 10px' },
            ui.h('b', term), ' — ', ...text);
        ui.modal({
            title: 'Cache Statistics Help',
            body: ui.h('div', { style: 'max-width: 430px; font-size: 13px; line-height: 1.5' },
                item('Entries', 'Number of key-value pairs currently in the cache.'),
                item('Hit Rate', 'Percentage of lookups served from cache without a database call.'),
                item('Avg Load', 'Average time per database round-trip on a cache miss.'),
                item('Hits', 'Lookups served from cache (no database call).'),
                item('Misses', 'Lookups that required a database call to load the value.'),
                item('Evictions', 'Entries removed due to max size or expiration.'),
                item('Total DB Time', 'Cumulative time spent waiting on database loads (cache misses only).'),
                item('Est. Without Cache',
                    'Approximate total time that would have been spent on database calls'
                    + ' if every lookup had been a cache miss. Calculated as ',
                    ui.h('i', 'Avg Load × total lookups'),
                    '. This is a rough estimate — actual database performance may'
                    + ' vary under different load conditions.')),
            buttons: [{ label: 'OK', primary: true }]
        });
    }

    /* Entry Detail (EntryDetailDialog): key, full value in a monospace block
       with a word-wrap toggle (wrap on by default, like Swing's line-wrapped
       JTextArea), Loaded At, Accesses, plus Copy Value. Rendered as a host
       ui.modal so it stacks above the overlay (z-100 over z-95) and owns
       Escape while open. */
    function openEntryDetail(entry) {
        const value = entry.value == null ? '' : String(entry.value);
        const valueBlock = ui.h('pre', {
            style: 'margin: 0; border: 1px solid var(--line, #8884); border-radius: 4px;'
                + ' padding: 8px 10px; max-height: 45vh; overflow: auto; font-size: 12px;'
                + ' font-family: var(--font-mono, monospace);'
                + ' white-space: pre-wrap; overflow-wrap: anywhere;'
        }, value);
        const wrap = ui.checkbox('Word Wrap', true);
        wrap.input.addEventListener('change', () => {
            valueBlock.style.whiteSpace = wrap.input.checked ? 'pre-wrap' : 'pre';
            valueBlock.style.overflowWrap = wrap.input.checked ? 'anywhere' : 'normal';
        });
        const row = (label, control) => [
            ui.h('div', { style: 'color: var(--text-dim, #888); padding-top: 5px' }, label),
            control
        ];
        ui.modal({
            title: 'Entry Detail',
            body: ui.h('div', {
                style: 'display: grid; grid-template-columns: max-content 1fr;'
                    + ' gap: 8px 10px; align-items: start;'
                    + ' min-width: min(760px, 86vw); max-width: 90vw'
            },
                ...row('Key:', ui.textInput(entry.key == null ? '' : String(entry.key), { readOnly: true })),
                ...row('Value:', ui.h('div', { style: 'min-width: 0' },
                    valueBlock,
                    ui.h('div', { style: 'margin-top: 6px; font-size: 12px' }, wrap.el))),
                ...row('Loaded At:', ui.textInput(fmtTimestamp(entry.loadedAtMillis), { readOnly: true })),
                ...row('Accesses:', ui.textInput(String(entry.accessCount), { readOnly: true }))),
            buttons: [
                { label: 'Copy Value', onClick: () => { copyToClipboard(value, 'Value'); return false; } },
                { label: 'Close', primary: true }
            ]
        });
    }

    function Inspector() {
        // view = the page actually shown: { snapshot, offset } captured on
        // success. The pending sort/offset/filter states below feed the NEXT
        // fetch (Swing advances currentSortBy/currentOffset before fetching;
        // status label and buttons keep describing the fetched page).
        const [view, setView] = React.useState(null);
        const [error, setError] = React.useState(null);      // initial load only
        const [loading, setLoading] = React.useState(true);
        const [sortBy, setSortBy] = React.useState('key');
        const [sortDir, setSortDir] = React.useState('asc');
        const [offset, setOffset] = React.useState(0);
        const [filterText, setFilterText] = React.useState('');
        const [filterScope, setFilterScope] = React.useState('key');
        const [filterRegex, setFilterRegex] = React.useState(false);

        // Last-fetch-wins guard: an out-of-order response is dropped, so rapid
        // Next/Next or sort-while-loading never paints a stale page.
        const seqRef = React.useRef(0);
        const hasPageRef = React.useRef(false);

        // Escape closes (Swing dialog parity) — unless a host modal (help /
        // entry detail) or a context menu (.ctx-surface, both host renderers)
        // is stacked on top, which owns the key. Swing's popup consumes the
        // first Escape the same way.
        React.useEffect(() => {
            const onKey = (e) => {
                if (e.key === 'Escape'
                        && !document.querySelector('.modal-overlay')
                        && !document.querySelector('.ctx-surface')) close();
            };
            document.addEventListener('keydown', onKey);
            return () => document.removeEventListener('keydown', onKey);
        }, []);

        async function doFetch(o, sb, sd) {
            const seq = ++seqRef.current;
            setLoading(true);
            try {
                const trimmed = filterText.trim();
                const snapshot = await api.getSnapshot(definitionId, {
                    offset: o,
                    limit: PAGE_LIMIT,
                    sortBy: sb,
                    sortDir: sd,
                    filter: trimmed === '' ? null : trimmed,
                    filterScope,
                    filterRegex
                });
                if (seq !== seqRef.current) return;
                if (!snapshot) throw new Error('Empty snapshot response from server');
                hasPageRef.current = true;
                setView({ snapshot, offset: o });
                setError(null);
            } catch (e) {
                if (seq !== seqRef.current) return;
                const message = snapshotErrorMessage(e);
                if (hasPageRef.current) {
                    // Swing's "Failed to refresh" dialog: toast, keep the page.
                    ui.toast('Failed to refresh: ' + message, 'error');
                } else {
                    ui.toast('Failed to load cache snapshot: ' + message, 'error');
                    setError(message);
                }
            } finally {
                if (seq === seqRef.current) setLoading(false);
            }
        }

        // Advance the pending state, then fetch with exactly those values.
        function requestFetch(next) {
            const o = next.offset !== undefined ? next.offset : offset;
            const sb = next.sortBy !== undefined ? next.sortBy : sortBy;
            const sd = next.sortDir !== undefined ? next.sortDir : sortDir;
            setOffset(o);
            setSortBy(sb);
            setSortDir(sd);
            doFetch(o, sb, sd);
        }

        // Initial page: Swing's panel fetches (0, 1000, key, asc, no filter).
        React.useEffect(() => { doFetch(0, 'key', 'asc'); }, []);

        // Header click: same field toggles asc/desc, new field starts asc;
        // either way back to page 1 (CacheInspectorDialog header listener).
        function clickSort(field) {
            if (field === sortBy) {
                requestFetch({ offset: 0, sortDir: sortDir === 'asc' ? 'desc' : 'asc' });
            } else {
                requestFetch({ offset: 0, sortBy: field, sortDir: 'asc' });
            }
        }

        const applyFilter = () => requestFetch({ offset: 0 });

        function rowContextMenu(entry, e) {
            e.preventDefault();
            ui.contextMenu(e.clientX, e.clientY, [
                { label: 'Copy Key', onClick: () => copyToClipboard(entry.key, 'Key') },
                { label: 'Copy Value', onClick: () => copyToClipboard(entry.value, 'Value') }
            ]);
        }

        const snapshot = view ? view.snapshot : null;
        const stats = snapshot ? snapshot.statistics || {} : null;
        const entries = snapshot ? snapshot.entries || [] : [];
        const prevEnabled = view != null && view.offset > 0;
        const nextEnabled = view != null
            && view.offset + entries.length < Number(snapshot.matchedEntries);
        const status = loading
            ? 'Loading…'
            : view != null
                ? snapshotStatus(view.offset, entries.length,
                    Number(snapshot.matchedEntries), Number(snapshot.totalEntries))
                : '';

        const stat = (label, value) => [
            <div key={label + '-l'} className="cachei-stat-label">{label}</div>,
            <div key={label + '-v'} className="cachei-stat-value">{value}</div>
        ];

        return (
            <div className="cachei-overlay">
                <style>{INSPECTOR_CSS}</style>
                <div className={'panel cachei-dialog' + (loading ? ' cachei-loading' : '')}>
                    <div className="panel-header">{'Cache Inspector: "' + cacheName + '"'}</div>
                    <div className="panel-body">
                        <div className="cachei-stats">
                            {stats ? [
                                ...stat('Entries:', ui.fmtNumber(stats.size)),
                                ...stat('Hit Rate:', fmtHitRatePercent(stats.hitRate)),
                                ...stat('Avg Load:', fmtAvgLoadMs(stats)),
                                ...stat('Hits:', ui.fmtNumber(stats.hitCount)),
                                ...stat('Misses:', ui.fmtNumber(stats.missCount)),
                                ...stat('Evictions:', ui.fmtNumber(stats.evictionCount)),
                                ...stat('Total DB Time:', fmtDuration(Number(stats.totalLoadTimeNanos) / 1e6)),
                                <div key="est-l" className="cachei-stat-label">Est. Without Cache:</div>,
                                <div key="est-v" className="cachei-stat-value" style={{ gridColumn: 'span 3' }}>
                                    {fmtDuration(estWithoutCacheMs(stats))}
                                </div>
                            ] : (
                                <div className="cachei-stat-label" style={{ gridColumn: 'span 6' }}>
                                    {loading ? 'Loading…' : 'Statistics unavailable'}
                                </div>
                            )}
                            <button type="button" className="cachei-help" title="Cache Statistics Help"
                                onClick={() => showStatsHelp()}>?</button>
                        </div>

                        <div className="cachei-filter">
                            <select value={filterScope}
                                onChange={(e) => setFilterScope(e.target.value)}>
                                <option value="key">Key</option>
                                <option value="value">Value</option>
                                <option value="both">Both</option>
                            </select>
                            <input type="text" value={filterText}
                                title="Filter entries (case-insensitive). Press Enter or Apply to search."
                                onChange={(e) => setFilterText(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') applyFilter(); }} />
                            <label className="check"
                                title={'Treat search text as a Java regular expression (java.util.regex), '
                                    + 'matched case-insensitively on the engine — not JavaScript regex.'}
                                style={{ whiteSpace: 'nowrap' }}>
                                <input type="checkbox" checked={filterRegex}
                                    onChange={(e) => setFilterRegex(e.target.checked)} />
                                Regex (Java)
                            </label>
                            <button className="btn" onClick={() => applyFilter()}>Apply</button>
                        </div>

                        <div className="cachei-table-wrap">
                            {view == null ? (
                                <div className="hint" style={{ padding: 16 }}>
                                    {loading ? 'Loading snapshot…'
                                        : 'Failed to load cache snapshot: ' + error}
                                </div>
                            ) : (
                                <table className="dt">
                                    <thead>
                                        <tr>
                                            {COLUMNS.map((col) => (
                                                <th key={col.field} className="sortable"
                                                    style={col.width ? { width: col.width } : null}
                                                    onClick={() => clickSort(col.field)}>
                                                    {col.label}
                                                    {sortBy === col.field ? (
                                                        <span className="sort-arrow" aria-hidden="true">
                                                            {sortDir === 'asc' ? '▲' : '▼'}
                                                        </span>
                                                    ) : null}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {entries.length === 0 ? (
                                            <tr><td colSpan={4} className="text-text-faint"
                                                style={{ padding: 12 }}>No entries</td></tr>
                                        ) : entries.map((entry, i) => (
                                            <tr key={i} tabIndex={0}
                                                onDoubleClick={() => openEntryDetail(entry)}
                                                onContextMenu={(e) => rowContextMenu(entry, e)}
                                                onKeyDown={(e) => {
                                                    // Swing's Ctrl+C cell copy: full untruncated value.
                                                    // Defer to native copy when text is selected.
                                                    if ((e.ctrlKey || e.metaKey) && e.key === 'c'
                                                            && String(window.getSelection()) === '') {
                                                        e.preventDefault();
                                                        copyToClipboard(entry.value, 'Value');
                                                    }
                                                }}>
                                                <td className="cachei-key-cell"
                                                    title={entry.key == null ? '' : String(entry.key)}>
                                                    {entry.key == null ? '' : String(entry.key)}
                                                </td>
                                                <td className="cachei-value-cell"
                                                    title={entry.value == null ? '' : String(entry.value)}>
                                                    {truncateValue(entry.value, VALUE_TRUNCATE_LENGTH)}
                                                </td>
                                                <td>{fmtTimestamp(entry.loadedAtMillis)}</td>
                                                <td className="num">{ui.fmtNumber(entry.accessCount)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>

                    <div className="cachei-foot">
                        <div>
                            <div className="cachei-usage">
                                <span>Usage:</span>
                                <code>{"$g('" + cacheName + "').lookup(key)"}</code>
                            </div>
                            <div className="cachei-status">{status}</div>
                        </div>
                        <div className="cachei-foot-buttons">
                            <button className="btn" title="Previous page" disabled={!prevEnabled}
                                onClick={() => requestFetch({ offset: Math.max(0, offset - PAGE_LIMIT) })}>
                                {'◀'}
                            </button>
                            <button className="btn" title="Next page" disabled={!nextEnabled}
                                onClick={() => requestFetch({ offset: offset + PAGE_LIMIT })}>
                                {'▶'}
                            </button>
                            <button className="btn"
                                onClick={() => requestFetch({})}>Refresh</button>
                            <button className="btn btn-primary" onClick={() => close()}>Close</button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // platform.reactView wraps a component as a { el, teardown } handler; called
    // directly (not routed) it gives us an imperatively mounted React root. The
    // wrapper el is display:contents, so appending it to body is layout-inert
    // and the fixed overlay inside owns the viewport.
    handle = platform.reactView(Inspector)({ params: {}, query: {} });
    document.body.appendChild(handle.el);
    return { close };
}
