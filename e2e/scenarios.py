# SPDX-FileCopyrightText: Copyright 2026 Diridium Technologies Inc.
# SPDX-License-Identifier: MPL-2.0

"""The scenarios. Each one gets its own new database and a freshly unpacked engine.

A check that fails is a FAIL and fails the run. A NOTE records something without judging it.
"""

import hashlib
import os
import re
import time
import uuid
import zipfile

import cache as c
from engine import Engine

CREATED = "INFO Cache definition table created"
ADDED = "INFO Added max_connections column to cache_definition"
CACHE = "cm_e2e"


class Report:
    def __init__(self, scenario):
        self.scenario = scenario
        self.passed = 0
        self.failed = []
        self.notes = []

    def check(self, name, ok, detail=""):
        if ok:
            self.passed += 1
        else:
            self.failed.append(name)
        print(f"{'PASS' if ok else 'FAIL'} [{self.scenario}] {name}" + (f"  [{detail}]" if detail and not ok else ""),
              flush=True)
        return ok

    def note(self, name, value):
        self.notes.append(f"{name}: {value}")
        print(f"NOTE [{self.scenario}] {name}: {value}", flush=True)


# ---------- helpers

def start(engine):
    """Starts the engine. Returns its API and where in the log this start began."""
    since = len(engine.log())
    return engine.start(), since


def migrator_lines(engine, since):
    """What the migrator logged from character `since` of the log on, as 'LEVEL message'."""
    lines = []
    for line in engine.log()[since:].splitlines():
        m = Engine.LINE.match(line)
        if m and m.group(2).endswith(".CacheMigrator"):
            lines.append(f"{m.group(1)} {m.group(3)}")
    return lines


def check_quiet(r, engine, since, when):
    bad = engine.plugin_log_lines(("WARN", "ERROR"), since)
    r.check(f"no WARN or ERROR from or about the plugin {when}", not bad, " | ".join(bad)[:600])


def check_server_jar(r, engine, zip_path):
    """The installed server jar must be the zip's, and the only one (an upgrade must not leave the old one)."""
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if re.search(r"oie-cache-manager-server-[^/]*\.jar$", n))
        want = hashlib.sha256(z.read(name)).hexdigest()
    files = engine.extension_files(c.PLUGIN_PATH) or []
    jars = [f for f in files if f.startswith("oie-cache-manager-server-")]
    got = None
    if len(jars) == 1:
        with open(os.path.join(engine.home, "extensions", c.PLUGIN_PATH, jars[0]), "rb") as f:
            got = hashlib.sha256(f.read()).hexdigest()
    r.check(f"the installed server jar is {os.path.basename(name)} and the only one",
            jars == [os.path.basename(name)] and got == want, f"found {jars}")


def save_lookup_channel(r, api):
    cid = str(uuid.uuid4())
    status, text = api.request("POST", "/channels", c.channel_xml(cid, CACHE), accept="application/json")
    r.check("the lookup channel saves", status == 200 and text.replace(" ", "") == '{"boolean":true}',
            f"HTTP {status} {text[:200]}")
    return cid


def wait_for_lookup(engine, since, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        found = c.lookup_lines(engine, since)
        if found:
            return found[-1]
        time.sleep(2)
    return None


def deploy_and_look_up(r, api, engine, cid, when):
    since = len(engine.log())
    status, text = api.request("POST", f"/channels/{cid}/_deploy", query={"returnErrors": "true"})
    got = wait_for_lookup(engine, since) if status in (200, 204) else None
    r.check(f"{when}: the channel's lookups return the source values", got == c.EXPECTED_LOOKUPS,
            got or f"deploy HTTP {status} {text[:300]}")


# ---------- scenarios

def fresh(r, engine, db, name, settings, new_zip):
    """A fresh install, restarts, and a table from before max_connections: the migrator adds only what is missing."""
    api = engine.start()
    r.check("the zip installs through the engine's installer", *c.install(api, new_zip))
    engine.stop()
    api, since = start(engine)
    r.check("the engine loaded the plugin", c.plugin_loaded(api))
    check_server_jar(r, engine, new_zip)
    lines = migrator_lines(engine, since)
    r.check("first start: the migrator creates the table, once", lines == [CREATED], lines)
    engine.stop()
    r.check("the table and its max_connections column exist", c.schema(db, engine, name) == (True, True))

    for n in (1, 2):
        api, since = start(engine)
        lines = migrator_lines(engine, since)
        r.check(f"restart {n}: the migrator runs nothing", lines == [], lines)
        engine.stop()

    c.drop_max_connections(db, engine, name)
    r.check("max_connections is gone, as in an install from before it existed",
            c.schema(db, engine, name) == (True, False))
    api, since = start(engine)
    lines = migrator_lines(engine, since)
    r.check("next start: the migrator adds max_connections, once", lines == [ADDED], lines)
    engine.stop()
    r.check("max_connections exists again", c.schema(db, engine, name) == (True, True))
    api, since = start(engine)
    lines = migrator_lines(engine, since)
    r.check("the start after that runs nothing", lines == [], lines)
    engine.stop()
    check_quiet(r, engine, 0, "on any start")


def upgrade(r, engine, db, name, settings, new_zip, old_zip):
    """A definition saved under the old release survives the upgrade, and the new build looks values up with it."""
    api = engine.start()
    r.check("the old release installs", *c.install(api, old_zip))
    engine.stop()
    api = engine.start()
    r.check("the engine loaded the old release", c.plugin_loaded(api))
    c.create_lookup_table(db, engine, name)
    d = c.definition(db, engine, settings, CACHE)
    d["id"] = c.fields(api.xml("POST", c.EXT + "/definitions", c.definition_xml(d))).get("id", "")
    r.check("a definition saves under the old release", d["id"])

    r.check("the new zip installs over the old release", *c.install(api, new_zip))
    engine.stop()
    api, since = start(engine)
    r.check("the engine loaded the new build", c.plugin_loaded(api))
    check_server_jar(r, engine, new_zip)
    lines = migrator_lines(engine, since)
    r.check("the migrator runs nothing: the old release's table has everything", lines == [], lines)
    got = c.fields(api.xml("GET", f"{c.EXT}/definitions/{d['id']}"))
    r.check("the definition saved under the old release is still there", got.get("name") == CACHE, got)
    cid = save_lookup_channel(r, api)
    deploy_and_look_up(r, api, engine, cid, "after the upgrade")
    engine.stop()
    # From the upgrade on only: 1.2.0 itself logs migration warnings at startup on Derby, Oracle and SQL Server.
    check_quiet(r, engine, since, "after the upgrade")


def features(r, engine, db, name, settings, new_zip):
    """The plugin used the way an administrator and a channel use it."""
    api = engine.start()
    r.check("the zip installs through the engine's installer", *c.install(api, new_zip))
    engine.stop()
    c.create_lookup_table(db, engine, name)
    api = engine.start()
    d = c.definition(db, engine, settings, CACHE)

    reply = c.string_reply(*api.request("POST", c.EXT + "/testConnectionInline", c.definition_xml(d)))
    r.check("Test Connection succeeds", reply == "Connection successful", reply)
    reply = c.string_reply(*api.request("POST", c.EXT + "/testQueryInline", c.definition_xml(d),
                                        query={"sampleKey": "k1"}))
    r.check("Test Query finds k1's value", "v1" in reply and "fail" not in reply.lower(), reply)

    d["id"] = c.fields(api.xml("POST", c.EXT + "/definitions", c.definition_xml(d))).get("id", "")
    r.check("create returns the definition with an id", d["id"])
    listed = [c.fields(el).get("name") for el in api.xml("GET", c.EXT + "/definitions").iter("cacheDefinition")]
    r.check("the list has the definition", listed == [CACHE], listed)
    d["maxSize"] = 500
    api.xml("PUT", f"{c.EXT}/definitions/{d['id']}", c.definition_xml(d))
    got = c.fields(api.xml("GET", f"{c.EXT}/definitions/{d['id']}"))
    r.check("an update is read back", got.get("maxSize") == "500" and got.get("maxConnections") == "3", got)
    if db.kind != "derby":   # Derby is read once the engine is stopped, below
        rows = c.definition_rows(db, engine, name, f"name = '{CACHE}' AND max_size = 500")
        r.check("the database holds the updated row", rows == 1, rows)

    cid = save_lookup_channel(r, api)
    deploy_and_look_up(r, api, engine, cid, "first deploy")
    stats = c.fields(api.xml("GET", f"{c.EXT}/definitions/{d['id']}/statistics"))
    r.check("statistics count the lookups",
            int(stats.get("requestCount", "0")) >= 3 and int(stats.get("loadSuccessCount", "0")) >= 2, stats)
    entries = {c.fields(e).get("key"): c.fields(e).get("value")
               for e in api.xml("GET", f"{c.EXT}/definitions/{d['id']}/snapshot").iter("cacheEntry")}
    r.check("the inspector shows the cached entries", entries.get("k1") == "v1" and entries.get("k_3") == "v_3", entries)
    names = [c.fields(el).get("name") for el in api.xml("GET", c.EXT + "/statistics").iter("cacheStatistics")]
    r.check("the all-caches statistics list has it", names == [CACHE], names)
    status, text = api.request("POST", f"{c.EXT}/definitions/{d['id']}/refresh")
    r.check("refresh succeeds", status in (200, 204), f"HTTP {status} {text[:300]}")
    deploy_and_look_up(r, api, engine, cid, "after refresh")

    engine.stop()
    if db.kind == "derby":
        rows = c.definition_rows(db, engine, name, f"name = '{CACHE}' AND max_size = 500")
        r.check("the database holds the updated row", rows == 1, rows)
    api, since = start(engine)
    got = c.fields(api.xml("GET", f"{c.EXT}/definitions/{d['id']}"))
    r.check("the definition survives a restart", got.get("name") == CACHE and got.get("maxSize") == "500", got)
    looked_up = wait_for_lookup(engine, since)
    r.check("after a restart the channel deploys and its lookups work", looked_up == c.EXPECTED_LOOKUPS, looked_up)

    status, text = api.request("DELETE", f"{c.EXT}/definitions/{d['id']}")
    r.check("delete succeeds", status in (200, 204), f"HTTP {status} {text[:300]}")
    left = [c.fields(el) for el in api.xml("GET", c.EXT + "/definitions").iter("cacheDefinition")]
    r.check("the list is empty after the delete", not left, left)
    engine.stop()
    rows = c.definition_rows(db, engine, name)
    r.check("the database row is gone", rows == 0, rows)
    check_quiet(r, engine, 0, "on any start")
