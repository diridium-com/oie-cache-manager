# SPDX-FileCopyrightText: Copyright 2026 Diridium Technologies Inc.
# SPDX-License-Identifier: MPL-2.0

"""The plugin's REST calls, its lookup channel, and the database-side helpers the scenarios share.

Each cache under test reads a lookup table on the same database server as the engine, through that
database's own JDBC driver (for Derby, a second embedded database next to the engine's).
"""

import os
import re
import subprocess
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = "/extensions/oie-cache-manager"
PLUGIN_PATH = "oie-cache-manager"
CHANNEL_FIXTURE = os.path.join(HERE, "fixtures", "lookup-channel.xml")
DERBY_JARS = ("derby-10.10.2.0.jar", "derbytools-10.10.2.0.jar")

# The driver each database's caches use: the classes the engine ships in server-lib/database.
DRIVERS = {
    "derby": "org.apache.derby.jdbc.EmbeddedDriver",
    "postgres": "org.postgresql.Driver",
    "mysql": "com.mysql.cj.jdbc.Driver",
    "sqlserver": "net.sourceforge.jtds.jdbc.Driver",
    "sqlserver-ms": "com.microsoft.sqlserver.jdbc.SQLServerDriver",
    "oracle": "oracle.jdbc.OracleDriver",
}
ROWS = (("k1", "v1"), ("k_3", "v_3"))   # k_3: '_' is a wildcard in SQL patterns
LOOKUP_LINE = re.compile(r"CMLOOKUP k1=(\S+) k_3=(\S+) missing=(\S+)$")
EXPECTED_LOOKUPS = ("v1", "v_3", "null")


# ---------- the engine's API

def install(api, zip_path):
    with open(zip_path, "rb") as f:
        status, text = api.multipart("/extensions/_install",
                                     [("file", os.path.basename(zip_path), "application/zip", f.read())])
    return status in (200, 204), f"HTTP {status} {text[:200]}"


def plugin_loaded(api):
    return any(el.get("path") == PLUGIN_PATH for el in api.xml("GET", "/extensions/plugins").iter("pluginMetaData"))


def fields(el):
    return {child.tag: (child.text or "") for child in el} if el is not None else {}


def string_reply(status, text):
    """A String endpoint's answer, which comes back as <string>...</string> or as plain text."""
    if status == 200:
        return (ET.fromstring(text).text or "") if text.lstrip().startswith("<string") else text
    return f"HTTP {status} {text[:300]}"


def definition_xml(d):
    """The cacheDefinition the Administrators send; <id> only when updating."""
    parts = [f"<id>{escape(d['id'])}</id>"] if d.get("id") else []
    parts.append("<enabled>true</enabled>")
    for tag in ("name", "driver", "url", "username", "password", "query", "keyColumn", "valueColumn"):
        parts.append(f"<{tag}>{escape(d[tag])}</{tag}>")
    for tag in ("maxSize", "evictionDurationMinutes", "maxConnections"):
        parts.append(f"<{tag}>{d[tag]}</{tag}>")
    return "<cacheDefinition>" + "".join(parts) + "</cacheDefinition>"


def definition(db, engine, settings, cache_name):
    """A cache definition for the lookup table create_lookup_table made. `settings` are the engine's
    database settings from Database.create; the cache connects with the same login."""
    if db.kind == "derby":
        url, user, password = derby_lookup_url(engine), "", ""
    else:
        url, user, password = settings["database.url"], settings["database.username"], settings["database.password"]
    return {"name": cache_name, "driver": DRIVERS[db.kind], "url": url, "username": user, "password": password,
            "query": "SELECT lkey, lvalue FROM lookup_src WHERE lkey = ?", "keyColumn": "lkey",
            "valueColumn": "lvalue", "maxSize": 1000, "evictionDurationMinutes": 60, "maxConnections": 3}


# ---------- the lookup channel

def channel_xml(cid, cache_name):
    """The channel fixture, renamed, with a deploy script that looks two keys and a missing one up."""
    root = ET.parse(CHANNEL_FIXTURE).getroot()
    root.find("id").text = cid
    root.find("name").text = "cm-e2e-lookup"
    root.find("deployScript").text = (
        f"var cache = $g('{cache_name}');\n"
        "logger.info('CMLOOKUP k1=' + cache.lookup('k1') + ' k_3=' + cache.lookup('k_3')"
        " + ' missing=' + cache.lookup('nokey'));\n"
        "return;\n")
    return ET.tostring(root, "unicode")


def lookup_lines(engine, since=0):
    """The deploy script's lookup results, one tuple per deploy, from character `since` of the log on."""
    return [m.groups() for m in (LOOKUP_LINE.search(line) for line in engine.log()[since:].splitlines()) if m]


# ---------- the database

def derby_lookup_url(engine):
    return "jdbc:derby:" + os.path.join(engine.home, "lookupdb")


def derby_sql(engine, url, sql):
    """Runs SQL with Derby's ij tool. The engine must be stopped if `url` is its own database."""
    lib = os.path.join(engine.home, "server-lib", "database")
    java = os.path.join(engine.java_home, "bin", "java") if engine.java_home else "java"
    r = subprocess.run([java, "-Dderby.stream.error.file=" + os.path.join(engine.home, "ij-derby.log"),
                        "-cp", os.pathsep.join(os.path.join(lib, j) for j in DERBY_JARS), "org.apache.derby.tools.ij"],
                       input=f"connect '{url}';\n{sql};\nexit;\n", capture_output=True, text=True,
                       timeout=300, cwd=engine.home)
    if r.returncode != 0 or "ERROR" in r.stdout:
        raise RuntimeError(f"ij failed: {r.stdout[-500:]} {r.stderr[-300:]}")
    return r.stdout


def derby_count(engine, sql):
    """A count from the engine's own Derby database. `sql` selects one number."""
    out = derby_sql(engine, "jdbc:derby:" + os.path.join(engine.home, "appdata", "mirthdb"),
                    f"SELECT 'N=' || CAST(({sql}) AS CHAR(10)) FROM SYSIBM.SYSDUMMY1")
    return int(out.split("N=")[1].split()[0])


def create_lookup_table(db, engine, name):
    vtype = "VARCHAR2" if db.kind == "oracle" else "VARCHAR"
    stmts = [f"CREATE TABLE lookup_src (lkey {vtype}(50) PRIMARY KEY, lvalue {vtype}(100))"]
    stmts += [f"INSERT INTO lookup_src VALUES ('{k}', '{v}')" for k, v in ROWS]
    if db.kind == "derby":
        derby_sql(engine, derby_lookup_url(engine) + ";create=true", ";\n".join(stmts))
    elif db.kind == "oracle":
        db.execute(name, ";\n".join(stmts + ["COMMIT"]) + ";")
    else:
        db.execute(name, "; ".join(stmts))


def definition_rows(db, engine, name, where=""):
    """Rows in cache_definition. For Derby the engine must be stopped."""
    sql = "SELECT COUNT(*) FROM cache_definition" + (f" WHERE {where}" if where else "")
    return derby_count(engine, sql) if db.kind == "derby" else db.scalar(name, sql)


def schema(db, engine, name):
    """(cache_definition exists, its max_connections column exists). For Derby the engine must be stopped."""
    if db.kind == "derby":
        t = "SELECT COUNT(*) FROM SYS.SYSTABLES WHERE TABLENAME = 'CACHE_DEFINITION'"
        c = ("SELECT COUNT(*) FROM SYS.SYSCOLUMNS c JOIN SYS.SYSTABLES t ON c.REFERENCEID = t.TABLEID "
             "WHERE t.TABLENAME = 'CACHE_DEFINITION' AND c.COLUMNNAME = 'MAX_CONNECTIONS'")
        return derby_count(engine, t) == 1, derby_count(engine, c) == 1
    if db.server == "oracle":
        t = "SELECT count(*) FROM user_tables WHERE table_name = 'CACHE_DEFINITION'"
        c = "SELECT count(*) FROM user_tab_columns WHERE table_name = 'CACHE_DEFINITION' AND column_name = 'MAX_CONNECTIONS'"
    else:
        scope = f"table_schema = '{name}' AND " if db.server == "mysql" else ""
        t = f"SELECT count(*) FROM information_schema.tables WHERE {scope}table_name = 'cache_definition'"
        c = (f"SELECT count(*) FROM information_schema.columns WHERE {scope}table_name = 'cache_definition' "
             "AND column_name = 'max_connections'")
    return db.scalar(name, t) == 1, db.scalar(name, c) == 1


def drop_max_connections(db, engine, name):
    """Makes the table look like one created before max_connections existed. Engine stopped."""
    if db.kind == "derby":
        derby_sql(engine, "jdbc:derby:" + os.path.join(engine.home, "appdata", "mirthdb"),
                  "ALTER TABLE cache_definition DROP COLUMN max_connections")
    elif db.server == "sqlserver":
        # The column's DEFAULT is a named constraint, which has to go first.
        db.execute(name, "DECLARE @c sysname; SELECT @c = d.name FROM sys.default_constraints d "
                         "JOIN sys.columns c ON d.parent_object_id = c.object_id AND d.parent_column_id = c.column_id "
                         "WHERE d.parent_object_id = OBJECT_ID('cache_definition') AND c.name = 'max_connections'; "
                         "EXEC('ALTER TABLE cache_definition DROP CONSTRAINT ' + @c); "
                         "ALTER TABLE cache_definition DROP COLUMN max_connections;")
    elif db.server == "oracle":
        db.execute(name, "ALTER TABLE cache_definition DROP COLUMN max_connections;")
    else:
        db.execute(name, "ALTER TABLE cache_definition DROP COLUMN max_connections")
