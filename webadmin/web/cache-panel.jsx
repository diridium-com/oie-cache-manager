// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Diridium Technologies Inc.

/*
 * "OIE Cache Manager" settings tab — the web port of CacheSettingsPanel.
 *
 * One single-select table of cache definitions joined with their runtime
 * statistics (Name / Enabled / Max Size / Eviction (min) / Size / Hit Rate /
 * Evictions / Memory / Lookups), a live name filter above it, and the Swing
 * button row: New, Edit, Duplicate, Delete, Inspect, Refresh Cache. All
 * mutations commit via REST the moment the definition dialog confirms — the
 * tab never participates in the settings view's Save/dirty tracking (it
 * registers no save() and never calls markDirty), and says so up front via
 * the italic notice.
 *
 * Task pane = Refresh only (settings_OIE Cache Manager/doRefresh). The
 * mutating buttons (New/Edit/Duplicate/Delete/Refresh Cache) are gated on
 * checkTask(…, 'doSave'); Inspect is read-only and needs only the view
 * access that showed the tab. Like Swing, a statistics fetch failure is
 * silent (the table renders without stats); a definitions fetch failure
 * toasts and clears the table.
 */

import { fmtHitRate, fmtBytes } from './cache-core.js';
import { openDefinitionEditor } from './definition-dialog.jsx';
import { openInspector } from './inspector.jsx';

// CacheServletInterface.PLUGIN_NAME — the Swing tab name and the task group key.
const TAB_LABEL = 'OIE Cache Manager';
const CACHE_GROUP = 'settings_OIE Cache Manager';

/* Own classes, NOT host Tailwind utilities: the host generates utilities from
   ITS source scan, so a class no host file uses does not exist in app.css.
   Host COMPONENT classes (.panel, .btn, .dt, .text-text-faint) are fine. */
const PANEL_CSS = `
.cachemgr-filter-row {
    padding: 8px 10px;
    border-bottom: 1px solid var(--line, #8884);
}
.cachemgr-filter {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    font-size: 12px;
    border: 1px solid var(--line, #8884);
    border-radius: 4px;
    background: transparent;
    color: inherit;
}
.cachemgr-table th { cursor: pointer; user-select: none; white-space: nowrap; }
.cachemgr-num { text-align: right; }
.cachemgr-arrow { font-size: 9px; opacity: 0.7; margin-left: 3px; }
`;

// CacheSettingsPanel — immediate-commit notice (the rbac panel precedent).
const IMMEDIATE_NOTICE =
    'Changes on this tab are applied to the server immediately'
    + ' when you confirm each action. The Save button does not stage changes here.';

/* Sort comparator: strings via case-insensitive collation (Swing's Collator
   default), everything else numerically. */
function cmp(a, b) {
    if (typeof a === 'string' && typeof b === 'string') {
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
    }
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : (na < nb ? -1 : 1);
}

export function registerCachePanel(platform, api) {
    const React = platform.React;
    const ui = platform.ui;

    /* REST failures, translated: 403 is a permission problem, 404/501 means
       the server-side plugin is missing; anything else keeps its message.
       idScoped: the call targeted a definition id, so a 404 means THAT
       definition is gone (deleted by another admin), not that the plugin is
       missing. */
    function errText(e, idScoped) {
        const status = e && e.status;
        if (status === 403) {
            return 'permission denied (check your Server Settings permissions)';
        }
        if (status === 404 && idScoped) {
            return 'the cache definition no longer exists on the server';
        }
        if (status === 404 || status === 501) {
            return 'the OIE Cache Manager plugin does not appear to be installed on this server';
        }
        return String(e && e.message || e);
    }

    /* CacheDefinitionTableModel's nine columns, 1:1 — including its quirk of
       left-aligning Hit Rate and Memory (String columns in Swing) while the
       Long columns right-align. No-stats rows render 0 / "—" / "0 B" exactly
       like Swing's null-stats branch. Sorting deviates from Swing on purpose:
       Hit Rate and Memory sort by their numeric values, not the formatted
       strings Swing's TableRowSorter collates. */
    const COLUMNS = [
        {
            key: 'name', label: 'Name',
            value: (d) => d.name,
            sort: (d) => String(d.name || '')
        },
        {
            key: 'enabled', label: 'Enabled',
            value: (d) => (d.enabled ? 'Yes' : 'No'),
            sort: (d) => (d.enabled ? 'Yes' : 'No')
        },
        {
            key: 'maxSize', label: 'Max Size', numeric: true,
            value: (d) => ui.fmtNumber(d.maxSize),
            sort: (d) => Number(d.maxSize)
        },
        {
            key: 'eviction', label: 'Eviction (min)', numeric: true,
            value: (d) => ui.fmtNumber(d.evictionDurationMinutes),
            sort: (d) => Number(d.evictionDurationMinutes)
        },
        {
            key: 'size', label: 'Size', numeric: true,
            value: (d, s) => ui.fmtNumber(s ? s.size : 0),
            sort: (d, s) => (s ? Number(s.size) : 0)
        },
        {
            key: 'hitRate', label: 'Hit Rate',
            value: (d, s) => (s ? fmtHitRate(s.hitRate) : '—'),
            // NaN/no-stats sorts below every real rate (0..1).
            sort: (d, s) => {
                const rate = s ? Number(s.hitRate) : NaN;
                return Number.isNaN(rate) ? -1 : rate;
            }
        },
        {
            key: 'evictions', label: 'Evictions', numeric: true,
            value: (d, s) => ui.fmtNumber(s ? s.evictionCount : 0),
            sort: (d, s) => (s ? Number(s.evictionCount) : 0)
        },
        {
            key: 'memory', label: 'Memory',
            value: (d, s) => fmtBytes(s ? s.estimatedMemoryBytes : 0),
            sort: (d, s) => (s ? Number(s.estimatedMemoryBytes) : 0)
        },
        {
            key: 'lookups', label: 'Lookups', numeric: true,
            value: (d, s) => ui.fmtNumber(s ? s.requestCount : 0),
            sort: (d, s) => (s ? Number(s.requestCount) : 0)
        }
    ];

    function CachePanel({ setTasks }) {
        const [defs, setDefs] = React.useState([]);
        const [statsMap, setStatsMap] = React.useState({}); // String(defId) -> stats
        const [selectedId, setSelectedId] = React.useState(null);
        const [filter, setFilter] = React.useState('');
        const [sortKey, setSortKey] = React.useState('name');
        const [sortDir, setSortDir] = React.useState(1);    // 1 asc, -1 desc
        const [loading, setLoading] = React.useState(true);

        const loadingRef = React.useRef(false);
        const pendingRef = React.useRef(false);

        // The imperatively mounted overlays (definition editor / inspector)
        // outlive nothing: close whichever is open if the settings view
        // unmounts underneath it (route change). close() is idempotent.
        const overlayRef = React.useRef(null);
        React.useEffect(() => () => {
            if (overlayRef.current) overlayRef.current.close();
        }, []);

        const load = React.useCallback(async () => {
            // Overlap guard (the SwingWorker equivalent): drop concurrent
            // refreshes, but remember one requested mid-flight so a
            // post-mutation refresh is never silently lost.
            if (loadingRef.current) { pendingRef.current = true; return; }
            loadingRef.current = true;
            setLoading(true);
            try {
                const [defsRes, statsRes] = await Promise.allSettled([
                    api.getDefinitions(),
                    api.getAllStatistics()
                ]);
                if (defsRes.status === 'fulfilled') {
                    setDefs(defsRes.value);
                    if (statsRes.status === 'fulfilled') {
                        const map = {};
                        for (const s of statsRes.value) {
                            map[String(s.cacheDefinitionId)] = s;
                        }
                        setStatsMap(map);
                    } else {
                        // Statistics failure is silent (Swing's log.debug) —
                        // the table renders without stats.
                        setStatsMap({});
                    }
                } else {
                    // Swing clears the whole table on a definitions failure.
                    setDefs([]);
                    setStatsMap({});
                    ui.toast(`Failed to load cache definitions: ${errText(defsRes.reason)}`, 'error');
                }
            } finally {
                loadingRef.current = false;
                setLoading(false);
                if (pendingRef.current) { pendingRef.current = false; load(); }
            }
        }, []);

        React.useEffect(() => {
            load();
            // Refresh is the ONLY rail task — no Save participation (the panel
            // never calls setSave, so it can't trip the settings dirty tracking).
            setTasks('OIE Cache Manager Tasks', [
                ui.taskButton('Refresh', 'refresh', () => load(), { task: 'doRefresh', group: CACHE_GROUP })
            ]);
        }, [load, setTasks]);

        const canManage = platform.checkTask(CACHE_GROUP, 'doSave');
        const selected = defs.find((d) => String(d.id) === String(selectedId)) || null;

        /* Filter (live, case-insensitive, literal, Name column only — Swing's
           quoted (?i) regexFilter on column 0) + client-side sort. */
        const rows = React.useMemo(() => {
            const col = COLUMNS.find((c) => c.key === sortKey) || COLUMNS[0];
            const text = filter.trim().toLowerCase();
            const out = defs
                .filter((d) => !text || String(d.name || '').toLowerCase().includes(text))
                .map((d) => ({ def: d, stats: statsMap[String(d.id)] || null }));
            out.sort((a, b) => sortDir * cmp(col.sort(a.def, a.stats), col.sort(b.def, b.stats)));
            return out;
        }, [defs, statsMap, filter, sortKey, sortDir]);

        function toggleSort(key) {
            if (sortKey === key) {
                setSortDir((d) => -d);
            } else {
                setSortKey(key);
                setSortDir(1);
            }
        }

        // Every mutation: commit, surface engine errors as a toast, always reload.
        async function mutate(call, failMsg, idScoped) {
            try {
                await call();
            } catch (e) {
                ui.toast(`${failMsg}: ${errText(e, idScoped)}`, 'error');
            } finally {
                load();
            }
        }

        function newDefinition() {
            overlayRef.current = openDefinitionEditor(platform, api, {
                definition: null,
                existingNames: defs.map((d) => d.name),
                onApply: (d) => mutate(() => api.createDefinition(d), 'Failed to create cache definition')
            });
        }

        function editDefinition(def) {
            const target = def || selected;
            if (!target || !canManage) return;
            overlayRef.current = openDefinitionEditor(platform, api, {
                definition: target,
                existingNames: defs.filter((d) => String(d.id) !== String(target.id)).map((d) => d.name),
                onApply: (d) => mutate(() => api.updateDefinition(target.id, d), 'Failed to update cache definition', true)
            });
        }

        function duplicateDefinition() {
            if (!selected) return;
            // CacheDefinition.copyWithoutId + "Copy of X", opened as a NEW
            // definition (committed via create).
            const copy = { ...selected, id: null, name: `Copy of ${selected.name}` };
            overlayRef.current = openDefinitionEditor(platform, api, {
                definition: copy,
                title: 'Duplicate Cache Definition',
                existingNames: defs.map((d) => d.name),
                onApply: (d) => mutate(() => api.createDefinition(d), 'Failed to create cache definition')
            });
        }

        async function deleteDefinition() {
            if (!selected) return;
            const ok = await ui.confirmDialog('Confirm Delete',
                `Delete cache definition '${selected.name}'?`,
                { danger: true, okLabel: 'Delete' });
            if (!ok) return;
            await mutate(() => api.deleteDefinition(selected.id), 'Failed to delete cache definition', true);
        }

        function inspectCache() {
            if (!selected) return;
            overlayRef.current = openInspector(platform, api, { definition: selected });
        }

        async function refreshCache() {
            if (!selected) return;
            const ok = await ui.confirmDialog('Refresh Cache',
                `This will re-fetch all cached entries for '${selected.name}' from the database. Continue?`,
                { okLabel: 'OK' });
            if (!ok) return;
            try {
                await api.refreshCache(selected.id);
                // Swing's information dialog: the refresh is queued, no polling —
                // the completion notice lands on the Events page.
                ui.modal({
                    title: 'Refresh Cache',
                    body: ui.h('div', { style: 'white-space: pre-line' },
                        `Refresh request queued for '${selected.name}'.\n`
                        + 'Consult the Events page to see the completion notice.'),
                    buttons: [{ label: 'OK', primary: true }]
                });
            } catch (e) {
                ui.toast(`Failed to refresh cache: ${errText(e, true)}`, 'error');
            }
        }

        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <style>{PANEL_CSS}</style>
                <div className="text-text-faint" style={{ fontStyle: 'italic', fontSize: 12 }}>
                    {IMMEDIATE_NOTICE}
                </div>

                <div className="panel">
                    <div className="panel-header">Caches
                        <div className="panel-tools" style={{ display: 'flex', gap: 8 }}>
                            {canManage ? (
                                <button className="btn" onClick={() => newDefinition()}>New</button>
                            ) : null}
                            {canManage ? (
                                <button className="btn" disabled={!selected} onClick={() => editDefinition()}>Edit</button>
                            ) : null}
                            {canManage ? (
                                <button className="btn" disabled={!selected} onClick={() => duplicateDefinition()}>Duplicate</button>
                            ) : null}
                            {canManage ? (
                                <button className="btn" disabled={!selected} onClick={() => deleteDefinition()}>Delete</button>
                            ) : null}
                            <button className="btn" disabled={!selected} onClick={() => inspectCache()}>Inspect</button>
                            {canManage ? (
                                <button className="btn" disabled={!selected} onClick={() => refreshCache()}>Refresh Cache</button>
                            ) : null}
                        </div>
                    </div>
                    <div className="panel-body flush">
                        <div className="cachemgr-filter-row">
                            <input
                                type="text"
                                className="cachemgr-filter"
                                placeholder="Filter by name..."
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)} />
                        </div>
                        <table className="dt cachemgr-table" style={{ width: '100%' }}>
                            <thead>
                                <tr>
                                    {COLUMNS.map((col) => (
                                        <th key={col.key}
                                            className={col.numeric ? 'cachemgr-num' : ''}
                                            onClick={() => toggleSort(col.key)}>
                                            {col.label}
                                            {sortKey === col.key ? (
                                                <span className="cachemgr-arrow">
                                                    {sortDir === 1 ? '▲' : '▼'}
                                                </span>
                                            ) : null}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {defs.length === 0 ? (
                                    <tr><td colSpan={COLUMNS.length} className="text-text-faint" style={{ padding: 12 }}>
                                        {loading ? 'Loading…' : 'No caches defined'}
                                    </td></tr>
                                ) : rows.map((row) => (
                                    <tr key={String(row.def.id)}
                                        className={String(row.def.id) === String(selectedId) ? 'selected' : ''}
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => setSelectedId(row.def.id)}
                                        onDoubleClick={() => { setSelectedId(row.def.id); editDefinition(row.def); }}>
                                        {COLUMNS.map((col) => (
                                            <td key={col.key} className={col.numeric ? 'cachemgr-num' : ''}>
                                                {col.value(row.def, row.stats)}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        );
    }

    platform.registerSettingsPanel({ label: TAB_LABEL, component: CachePanel });
}
