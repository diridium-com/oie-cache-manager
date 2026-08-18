// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Diridium Technologies Inc.

/*
 * Add/Edit Cache Definition overlay — the web port of CacheDefinitionDialog.
 *
 * Name + Enabled, the JDBC connection block (driver combo synced both ways
 * with the driver-class field, URL with an Insert-URL-Template button, the
 * integration credentials with autofill disabled), the SQL query in the
 * host's code editor, key/value columns, and the cache sizing fields.
 *
 * The driver combo is loaded from the engine's driver list
 * (platform.api.server.databaseDrivers()) with "Please Select One" first and
 * "Custom" last, falling back to cache-core's DEFAULT_DRIVERS when the call
 * fails (Swing's DriverInfo.getDefaultDrivers() fallback). Picking a driver
 * fills the class field; typing a class that matches no driver (by className
 * or alternativeClassNames) flips the combo to Custom.
 *
 * Test Connection / Test Query post the CURRENT unsaved fields through the
 * inline servlet endpoints, exactly the subset Swing's
 * buildDefinitionFromFields() serializes. Apply runs cache-core's
 * validateDefinition (Swing's onSave chain, plus the duplicate-name check
 * against existingNames), highlights failing fields inline without closing,
 * and on success calls onApply(def) — the PANEL commits the create/update —
 * then closes. Cancel/Escape closes without calling onApply.
 */

import { DEFAULT_DRIVERS, parseQueryTestResult, validateDefinition } from './cache-core.js';

const DRIVER_DEFAULT = 'Please Select One';
const DRIVER_CUSTOM = 'Custom';

/* Validator fields with a dedicated row (anything else lands in the summary
   line above the footer, so an unexpected field key still surfaces). */
const KNOWN_FIELDS = new Set([
    'name', 'driver', 'url', 'username', 'password', 'query',
    'keyColumn', 'valueColumn', 'maxSize', 'evictionDurationMinutes', 'maxConnections'
]);

/* Own classes, NOT host Tailwind utilities: the host generates utilities from
   ITS source scan, so a class no host file uses does not exist in app.css.
   Host COMPONENT classes (.panel, .btn, .check) are fine. */
const DIALOG_CSS = `
.cachedef-overlay {
    position: fixed;
    top: 0; right: 0; bottom: 0; left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
    /* Below the host's .modal-overlay (100): prompts, confirms, and the
       test-result modals (ui.modal / ui.promptDialog) must stack above. */
    z-index: 95;
}
.cachedef-editor {
    width: min(880px, 94vw);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
}
.cachedef-editor > .panel-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
}
.cachedef-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cachedef-row.top { align-items: flex-start; }
.cachedef-row > label { flex: none; width: 120px; margin: 0; font-size: 12px; }
.cachedef-row.top > label { padding-top: 6px; }
.cachedef-field { flex: 1; min-width: 0; }
.cachedef-field input[type="text"],
.cachedef-field input[type="password"],
.cachedef-field select { width: 100%; }
.cachedef-inline { display: flex; gap: 8px; align-items: center; }
.cachedef-inline > input { flex: 1; min-width: 0; }
.cachedef-inline > .btn { flex: none; }
.cachedef-field.invalid input,
.cachedef-field.invalid select,
.cachedef-field.invalid .cachedef-sqlhost {
    border-color: var(--err, #e5484d);
    box-shadow: 0 0 0 1px var(--err, #e5484d);
    border-radius: 4px;
}
.cachedef-field-err { color: var(--err, #e5484d); font-size: 11px; margin-top: 2px; }
.cachedef-sqlhost {
    border: 1px solid transparent;
    max-height: 320px;
    overflow: auto;
}
.cachedef-tests { display: flex; gap: 8px; }
.cachedef-foot {
    flex: none;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--line, #8884);
}
`;

/* ---- pure helpers (wire-quirk tolerant) ------------------------------------ */

function strOf(v) {
    return v === undefined || v === null ? '' : String(v);
}

// Missing/empty -> [], singleton -> [x] (XStream one-element collections
// arrive as a bare object/string, empty ones as '').
function toArray(v) {
    if (v === null || v === undefined || v === '') return [];
    return Array.isArray(v) ? v : [v];
}

/* List<String> after the host's unwrap: {string:[...]}, singleton
   {string:'x'}, '' (empty), or a bare array/string. */
function stringList(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) v = v.string;
    return toArray(v).map(String);
}

function normalizeDriver(raw) {
    return {
        name: strOf(raw && raw.name),
        className: strOf(raw && raw.className),
        template: strOf(raw && raw.template),
        alternativeClassNames: stringList(raw && raw.alternativeClassNames)
    };
}

/* Swing's fixDriversList(): fall back to the defaults when empty, then ensure
   "Please Select One" is first and "Custom" is last. Never mutates the input. */
function fixDrivers(list) {
    let out = (list || []).filter((d) => d && d.name);
    if (out.length === 0) out = DEFAULT_DRIVERS.map(normalizeDriver);
    out = out.slice();
    if (out[0].name !== DRIVER_DEFAULT) {
        out.unshift({ name: DRIVER_DEFAULT, className: '', template: '', alternativeClassNames: [] });
    }
    if (out[out.length - 1].name !== DRIVER_CUSTOM) {
        out.push({ name: DRIVER_CUSTOM, className: '', template: '', alternativeClassNames: [] });
    }
    return out;
}

function fallbackDrivers() {
    return fixDrivers(DEFAULT_DRIVERS.map(normalizeDriver));
}

/* Swing's updateDriverComboFromField(): first driver whose className or an
   alternativeClassName equals the typed class (the sentinels' empty classes
   make a blank field land on "Please Select One"), else "Custom". */
function matchDriverName(drivers, className) {
    for (const di of drivers) {
        if (className === di.className) return di.name;
        if (di.alternativeClassNames.some((alt) => className === alt)) return di.name;
    }
    return drivers.length > 0 ? drivers[drivers.length - 1].name : DRIVER_CUSTOM;
}

/* Blank when not set: Swing's populateFields only fills numerics when > 0. */
function numText(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? String(n) : '';
}

// Booleans can arrive as the STRING 'false' on odd wire paths.
function boolOf(v, dflt) {
    if (v === undefined || v === null || v === '') return dflt;
    return String(v) !== 'false';
}

/* ---- the dialog ------------------------------------------------------------- */

/* definition: normalized definition to edit, or null for a new one.
   existingNames: names the validator rejects as duplicates (the panel excludes
   the definition's own current name when editing).
   onApply(def): receives the validated definition (id preserved when editing,
   null when new); the PANEL commits it (create/update) — the dialog has
   already closed, matching the Swing dispose-then-save flow.
   Returns { close } so the opener can dismiss it programmatically. */
export function openDefinitionEditor(platform, api, { definition = null, existingNames = [], onApply, title } = {}) {
    const React = platform.React;
    const ui = platform.ui;

    let closed = false;
    let mounted = null;
    function close() {
        if (closed) return;
        closed = true;
        if (mounted) {
            mounted.teardown();
            if (mounted.el && mounted.el.parentNode) mounted.el.parentNode.removeChild(mounted.el);
        }
    }

    /* Info/error alert (Swing's JOptionPane message dialogs): titled, OK-only,
       \n kept — JDBC failure messages are multi-line. */
    function alertDialog(title, message) {
        return new Promise((resolve) => {
            ui.modal({
                title,
                body: ui.h('div', { style: 'white-space: pre-line; overflow-wrap: anywhere; max-width: 560px' }, message),
                onClose: () => resolve(),
                buttons: [{ label: 'OK', primary: true, onClick: () => resolve() }]
            });
        });
    }

    /* Yes/No confirm (Swing's YES_NO_OPTION) — the role-editor precedent. */
    function confirmYesNo(title, message) {
        return new Promise((resolve) => {
            ui.modal({
                title,
                body: ui.h('div', { style: 'white-space: pre-line' }, message),
                onClose: () => resolve(false),
                buttons: [
                    { label: 'No', onClick: () => resolve(false) },
                    { label: 'Yes', primary: true, onClick: () => resolve(true) }
                ]
            });
        });
    }

    /* QueryTestResultDialog: read-only key row, monospace value block with
       word wrap on by default; the checkbox — and, like Swing's popup menu,
       a right-click on the value — toggles the wrap. */
    function showQueryResult(parsed) {
        const h = ui.h;
        const valuePre = h('pre', {
            style: 'margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;'
                + ' border: 1px solid var(--line, #8884); border-radius: 4px; padding: 8px 10px;'
                + ' min-height: 120px; max-height: 320px; overflow: auto;'
        }, strOf(parsed.value));
        const applyWrap = (on) => {
            valuePre.style.whiteSpace = on ? 'pre-wrap' : 'pre';
            valuePre.style.overflowWrap = on ? 'anywhere' : 'normal';
        };
        applyWrap(true);
        const wrapInput = h('input', {
            type: 'checkbox', checked: true,
            onChange: (e) => applyWrap(e.target.checked)
        });
        valuePre.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            wrapInput.checked = !wrapInput.checked;
            applyWrap(wrapInput.checked);
        });
        const body = h('div', { style: 'display: flex; flex-direction: column; gap: 8px; min-width: 440px; max-width: 70vw' },
            h('div', { style: 'display: flex; align-items: center; gap: 8px' },
                h('span', { style: 'flex: none; font-size: 12px' }, 'Key:'),
                h('input', { type: 'text', value: strOf(parsed.key), readOnly: true, style: 'flex: 1; min-width: 0' })),
            h('div', { style: 'font-size: 12px' }, 'Value:'),
            valuePre,
            h('label', { style: 'display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer' },
                wrapInput, 'Word Wrap'));
        ui.modal({ title: 'Query Test Result', body, buttons: [{ label: 'Close', primary: true }] });
    }

    function DefinitionDialog() {
        const [name, setName] = React.useState(() => strOf(definition && definition.name));
        const [enabled, setEnabled] = React.useState(() => (definition ? boolOf(definition.enabled, true) : true));
        const [drivers, setDrivers] = React.useState(() => fallbackDrivers());
        const [driverClass, setDriverClass] = React.useState(() => strOf(definition && definition.driver));
        const [driverName, setDriverName] = React.useState(
            () => matchDriverName(fallbackDrivers(), strOf(definition && definition.driver)));
        const [url, setUrl] = React.useState(() => strOf(definition && definition.url));
        const [username, setUsername] = React.useState(() => strOf(definition && definition.username));
        const [password, setPassword] = React.useState(() => strOf(definition && definition.password));
        const [keyColumn, setKeyColumn] = React.useState(() => strOf(definition && definition.keyColumn));
        const [valueColumn, setValueColumn] = React.useState(() => strOf(definition && definition.valueColumn));
        const [maxSize, setMaxSize] = React.useState(() => numText(definition && definition.maxSize));
        const [eviction, setEviction] = React.useState(() => numText(definition && definition.evictionDurationMinutes));
        // Swing pre-fills a NEW definition with the model default (5).
        const [maxConnections, setMaxConnections] = React.useState(() => (definition ? numText(definition.maxConnections) : '5'));
        const [errors, setErrors] = React.useState([]);
        const [testingConn, setTestingConn] = React.useState(false);
        const [testingQuery, setTestingQuery] = React.useState(false);

        // The class field's latest text, readable from the drivers-loaded
        // effect without a stale closure (Swing's driverAdjusting dance is
        // unnecessary in React — state setters don't echo events).
        const driverClassRef = React.useRef(strOf(definition && definition.driver));
        const queryRef = React.useRef(strOf(definition && definition.query));
        const sqlHostRef = React.useRef(null);
        const sqlEditorRef = React.useRef(null);

        // Escape cancels (Swing dialog parity) — unless a host modal (prompt/
        // confirm/test result) is stacked on top, which owns the key.
        React.useEffect(() => {
            const onKey = (e) => {
                if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) close();
            };
            document.addEventListener('keydown', onKey);
            return () => document.removeEventListener('keydown', onKey);
        }, []);

        // The SQL editor (Swing's MirthRTextScrollPane with SQL highlighting):
        // the host code editor mounted into a ref container, disposed on unmount.
        React.useEffect(() => {
            const editor = platform.createCodeEditor({
                language: 'sql',
                value: queryRef.current,
                minHeight: '140px',
                onChange: (v) => { queryRef.current = v; }
            });
            if (sqlHostRef.current) sqlHostRef.current.appendChild(editor.el);
            sqlEditorRef.current = editor;
            return () => {
                sqlEditorRef.current = null;
                editor.dispose();
            };
        }, []);

        // Swing's loadDrivers(): the engine's list, defaults on failure. The
        // fallback is already in place, so a failure changes nothing (Swing
        // only logs it).
        React.useEffect(() => {
            let alive = true;
            (async () => {
                try {
                    const list = await platform.api.server.databaseDrivers();
                    if (!alive) return;
                    setDrivers(fixDrivers(toArray(list).map(normalizeDriver)));
                } catch (e) {
                    /* keep DEFAULT_DRIVERS */
                }
            })();
            return () => { alive = false; };
        }, []);

        // Re-derive the combo selection from the class field whenever the
        // driver list (fallback -> engine list) changes.
        React.useEffect(() => {
            setDriverName(matchDriverName(drivers, driverClassRef.current));
        }, [drivers]);

        const selectedDriver = drivers.find((d) => d.name === driverName) || null;

        function onDriverPick(pickedName) {
            setDriverName(pickedName);
            // Swing fills the class field for everything but Custom — including
            // "Please Select One", whose empty className clears it.
            if (pickedName !== DRIVER_CUSTOM) {
                const di = drivers.find((d) => d.name === pickedName);
                if (di) {
                    driverClassRef.current = di.className;
                    setDriverClass(di.className);
                }
            }
        }

        function onDriverClassChange(v) {
            driverClassRef.current = v;
            setDriverClass(v);
            setDriverName(matchDriverName(drivers, v));
        }

        async function insertUrlTemplate() {
            if (!selectedDriver || !selectedDriver.template) return;
            if (url !== '') {
                const ok = await confirmYesNo('Insert URL Template', 'Replace current URL with the template?');
                if (!ok) return;
            }
            setUrl(selectedDriver.template);
        }

        function getQuery() {
            return sqlEditorRef.current ? sqlEditorRef.current.getValue() : queryRef.current;
        }

        /* Swing's buildDefinitionFromFields(): only the connection fields
           are set; the rest carry a fresh CacheDefinition's Java defaults.
           Wire note: definitionXml still emits empty <query>/<keyColumn>/
           <valueColumn> elements where Swing's XStream omits the null fields;
           the server reads both as absent, so semantics match even though the
           bytes differ. */
        function connDef() {
            return {
                id: null,
                name: name.trim(),
                enabled: true,
                driver: driverClass.trim(),
                url: url.trim(),
                username: username.trim(),
                password: password,
                maxSize: 0,
                evictionDurationMinutes: 0,
                maxConnections: 5
            };
        }

        function queryTestDef() {
            const def = connDef();
            def.query = getQuery().trim();
            def.keyColumn = keyColumn.trim();
            def.valueColumn = valueColumn.trim();
            return def;
        }

        const msgOf = (e) => String((e && e.message) || e);

        async function testConnection() {
            setTestingConn(true);
            try {
                const result = await api.testConnectionInline(connDef());
                await alertDialog('Connection Test', strOf(result));
            } catch (e) {
                await alertDialog('Connection Test', 'Connection failed: ' + msgOf(e));
            } finally {
                setTestingConn(false);
            }
        }

        async function testQuery() {
            const sampleKey = await ui.promptDialog('Test Query', 'Enter a sample key:');
            if (sampleKey === null || sampleKey.trim() === '') return;
            const key = sampleKey.trim();
            setTestingQuery(true);
            try {
                const result = strOf(await api.testQueryInline(queryTestDef(), key));
                const parsed = parseQueryTestResult(result);
                // Swing echoes the TYPED sample key, not the key parsed back
                // out of the reply (they can differ under case-insensitive
                // collation or numeric coercion).
                if (parsed) showQueryResult({ key, value: parsed.value });
                else await alertDialog('Query Test', result);
            } catch (e) {
                await alertDialog('Query Test', 'Query test failed: ' + msgOf(e));
            } finally {
                setTestingQuery(false);
            }
        }

        function apply() {
            const raw = {
                id: definition && definition.id != null ? definition.id : null,
                name: name.trim(),
                enabled: enabled,
                driver: driverClass.trim(),
                url: url.trim(),
                username: username.trim(),
                // Swing keeps the password exactly as typed (no trim).
                password: password,
                query: getQuery().trim(),
                keyColumn: keyColumn.trim(),
                valueColumn: valueColumn.trim(),
                // Raw field text: the validator owns numeric parsing and the
                // Swing defaults (blank maxSize -> 10000, eviction -> 60,
                // maxConnections -> 5, min 1).
                maxSize: maxSize.trim(),
                evictionDurationMinutes: eviction.trim(),
                maxConnections: maxConnections.trim()
            };
            let result;
            try {
                result = validateDefinition(raw, existingNames) || {};
            } catch (e) {
                ui.toast(msgOf(e), 'error');
                return;
            }
            const errs = Array.isArray(result.errors) ? result.errors : [];
            if (errs.length > 0) {
                setErrors(errs);
                ui.toast(strOf(errs[0].message) || 'Validation failed.', 'error');
                return;
            }
            setErrors([]);
            const def = Object.assign({}, result.value || raw);
            def.id = definition && definition.id != null ? definition.id : null;
            // Panel commits (create/update) and surfaces engine errors; the
            // dialog is done the moment validation passes (Swing dispose flow).
            onApply(def);
            close();
        }

        /* One label/control row. Plain function, NOT a component — an inline
           component type would remount its inputs (and drop focus) on every
           keystroke. */
        function row(label, fieldKey, control, { top } = {}) {
            const err = fieldKey ? errors.find((e) => e && e.field === fieldKey) : null;
            return (
                <div className={'cachedef-row' + (top ? ' top' : '')}>
                    <label>{label}</label>
                    <div className={'cachedef-field' + (err ? ' invalid' : '')}>
                        {control}
                        {err ? <div className="cachedef-field-err">{strOf(err.message)}</div> : null}
                    </div>
                </div>
            );
        }

        const extraErrors = errors.filter((e) => e && !KNOWN_FIELDS.has(e.field));

        return (
            <div className="cachedef-overlay">
                <style>{DIALOG_CSS}</style>
                <div className="panel cachedef-editor">
                    <div className="panel-header">{title || (definition ? 'Edit Cache Definition' : 'New Cache Definition')}</div>
                    <div className="panel-body">
                        {row('Name:', 'name',
                            <input type="text" value={name} autoFocus
                                onChange={(e) => setName(e.target.value)} />)}
                        {row('', null,
                            <label className="check">
                                <input type="checkbox" checked={enabled}
                                    onChange={(e) => setEnabled(e.target.checked)} />
                                Enabled
                            </label>)}

                        {row('Driver:', null,
                            <select value={driverName} onChange={(e) => onDriverPick(e.target.value)}>
                                {drivers.map((d) => (
                                    <option key={d.name} value={d.name}>{d.name}</option>
                                ))}
                            </select>)}
                        {row('Driver Class:', 'driver',
                            <input type="text" value={driverClass}
                                onChange={(e) => onDriverClassChange(e.target.value)} />)}
                        {row('URL:', 'url',
                            <div className="cachedef-inline">
                                <input type="text" value={url}
                                    onChange={(e) => setUrl(e.target.value)} />
                                <button className="btn" onClick={() => insertUrlTemplate()}>
                                    Insert URL Template
                                </button>
                            </div>)}
                        {/* Integration credentials, not login credentials:
                            autofill/save-password must stay out of both fields. */}
                        {row('Username:', 'username',
                            <input type="text" value={username} autoComplete="off"
                                onChange={(e) => setUsername(e.target.value)} />)}
                        {row('Password:', 'password',
                            <input type="password" value={password} autoComplete="off"
                                onChange={(e) => setPassword(e.target.value)} />)}
                        {row('', null,
                            <div className="cachedef-tests">
                                <button className="btn" disabled={testingConn}
                                    onClick={() => testConnection()}>
                                    {testingConn ? 'Testing…' : 'Test Connection'}
                                </button>
                                <button className="btn" disabled={testingQuery}
                                    onClick={() => testQuery()}>
                                    {testingQuery ? 'Testing…' : 'Test Query'}
                                </button>
                            </div>)}

                        {row('SQL:', 'query',
                            <div className="cachedef-sqlhost" ref={sqlHostRef} />, { top: true })}
                        {row('Key Column:', 'keyColumn',
                            <input type="text" value={keyColumn}
                                onChange={(e) => setKeyColumn(e.target.value)} />)}
                        {row('Value Column:', 'valueColumn',
                            <input type="text" value={valueColumn}
                                onChange={(e) => setValueColumn(e.target.value)} />)}

                        {row('Max Size:', 'maxSize',
                            <input type="text" value={maxSize}
                                onChange={(e) => setMaxSize(e.target.value)} />)}
                        {row('Eviction (min):', 'evictionDurationMinutes',
                            <input type="text" value={eviction}
                                onChange={(e) => setEviction(e.target.value)} />)}
                        {row('Max Connections:', 'maxConnections',
                            <input type="text" value={maxConnections}
                                onChange={(e) => setMaxConnections(e.target.value)} />)}

                        {extraErrors.length > 0 ? (
                            <div className="cachedef-field-err">
                                {extraErrors.map((e) => strOf(e.message)).join(' ')}
                            </div>
                        ) : null}
                    </div>
                    <div className="cachedef-foot">
                        <button className="btn" onClick={() => close()}>Cancel</button>
                        <button className="btn btn-primary" onClick={() => apply()}>Apply</button>
                    </div>
                </div>
            </div>
        );
    }

    // Imperative mount: platform.reactView wraps the component with the shell's
    // providers + error boundary and hands back { el, teardown } (the same
    // bridge routed views use); the overlay inside is position:fixed, so the
    // display:contents wrapper parks harmlessly on document.body.
    mounted = platform.reactView(DefinitionDialog)({ params: {}, query: {} });
    document.body.appendChild(mounted.el);
    return { close };
}
