# OIE Cache Manager

A plugin for [Open Integration Engine](https://github.com/nextgenhealthcare/connect) that provides fast in-memory key-value lookups against external databases using Google Guava's LoadingCache and HikariCP connection pooling.

<p align="center">
  <img src="images/cache-inspector.png" width="700" alt="OIE Administrator with Cache Inspector">
</p>

## Features

- **Lazy per-key loading** — data is fetched from the database on first lookup, then served from memory
- **Automatic eviction** — configurable max size and time-based expiration
- **HikariCP connection pooling** — bounded concurrent connections per cache to prevent connection storms
- **Admin UI** — create, edit, duplicate, enable/disable, and delete cache definitions from the OIE Administrator
- **Cache Inspector** — view hit rates, memory usage, entry counts, and browse cached data
- **REST API** — full CRUD and statistics endpoints with OpenAPI annotations
- **Password encryption** — database credentials encrypted at rest using OIE's built-in encryptor
- **Event logging** — cache operations logged to the OIE event system

## Requirements

- Open Integration Engine 4.7.0
- Java 17+

Running OIE 4.6.0? Use [oie-cache-manager 1.2.0](https://github.com/diridium-com/oie-cache-manager/releases/tag/v1.2.0).

## Installation

1. Download the latest `oie-cache-manager-<version>.zip` from the [Releases](https://github.com/diridium-com/oie-cache-manager/releases) page
2. In OIE Administrator, go to **Settings > Extensions** and click **Install Extension**
3. Select the ZIP file and restart the server
4. Verify the **Cache Manager** tab appears under **Settings**

## Usage

Define a cache in the admin UI pointing at your external database, then look it up from any channel:

```javascript
var state = $g('zip2').lookup(zip);
```

The first call for a given key queries the database. Subsequent calls return from memory.

## Permissions

The plugin registers two permissions, **View Caches** (definitions, statistics,
and the cache inspector) and **Manage Caches** (create, edit, delete, refresh,
and the connection/query tests), covering all of its REST operations and its
settings tab.

On a stock OIE install this changes nothing: the default authorization
controller allows every operation for every authenticated user. On installs
running a role-based authorization controller, the permissions must be granted
to a role before its users can see or manage caches.

> **Upgrading from 1.1.0 or earlier on a role-based server:** cache operations
> previously named the core Server Settings permissions, which extension
> operations cannot actually match, so access followed the controller's
> unknown-operation policy. After upgrading, an administrator must grant
> View Caches / Manage Caches to each role that should have them.

## Building from Source

```bash
./scripts/install-engine-jars.sh
mvn clean package
```

The script installs the five OIE engine jars this plugin builds against into your local Maven repository, taken from the published OIE release matching the POM's `mc.version` and checked against the SHA-256 pinned in the POM (`oie.dist.sha256`). CI runs the same script. Run it once per engine version.

The installable plugin ZIP is produced at:

```
package/target/oie-cache-manager-<version>.zip
```

To build with JAR signing enabled (requires a PKCS#11 token; see [RELEASING.md](RELEASING.md), step 3):

```bash
read -rs PIN
mvn clean package -Psigning -Dsigning.storepass="$PIN"
unset PIN
```

### End-to-end tests

`e2e/run.py` installs a built zip into the released OIE engine through the engine's own installer and checks the plugin on a real database: a fresh install and restarts (the table is created once, a missing `max_connections` column is added once, and the duplicate index on `name` that releases up to 1.3.0 left on MySQL, PostgreSQL and SQL Server is dropped once), an upgrade from each release in `e2e/upgrade-sources.txt` (a release built for an older engine runs on that engine first, from `e2e/engines.txt`, and the engine is upgraded under it), and the features (Test Connection and Test Query, saving, editing and deleting a definition, a channel's `$g('name').lookup(key)` calls, statistics, the inspector, refresh and a restart). Each cache reads a lookup table on the same database server through that database's driver. CI runs it on every push and pull request against Derby, PostgreSQL, MySQL, SQL Server (jTDS and Microsoft drivers) and Oracle, with the engine on Java 17 and on Java 21. While a release targets an engine that isn't published yet, CI runs it on the POM's `mc.version` engine with `--label-as`, which installs copies of the zips whose `plugin.xml` names that engine instead.

It needs Java 17 or later, Docker for every database but Derby, and the distribution tarball of the engine the zip is built for (the `mirthVersion` in its `plugin.xml`):

```bash
python3 e2e/run.py --db postgres --zip package/target/oie-cache-manager-<version>.zip \
    --tarball target/oie-dist/oie_unix_<x_y_z>.tar.gz --work /path/that/does/not/exist/yet
```

The tarball is named for its engine version, `oie_unix_4_6_0.tar.gz` for 4.6.0. When that engine is the POM's `mc.version`, `./scripts/install-engine-jars.sh` leaves its tarball in `target/oie-dist/`, where a full `mvn clean` deletes it. For a zip built for an engine that isn't published yet, use the `mc.version` tarball and add `--label-as <mc.version>`, as CI does.

## Documentation

See the [Wiki](https://github.com/diridium-com/oie-cache-manager/wiki) for full documentation:

- [Getting Started](https://github.com/diridium-com/oie-cache-manager/wiki/Getting-Started)
- [Managing Caches](https://github.com/diridium-com/oie-cache-manager/wiki/Managing-Caches)
- [Cache Inspector](https://github.com/diridium-com/oie-cache-manager/wiki/Cache-Inspector)
- [Using Caches in Channels](https://github.com/diridium-com/oie-cache-manager/wiki/Using-Caches-in-Channels)
- [REST API](https://github.com/diridium-com/oie-cache-manager/wiki/REST-API)
- [Troubleshooting](https://github.com/diridium-com/oie-cache-manager/wiki/Troubleshooting)
- [Security Considerations](https://github.com/diridium-com/oie-cache-manager/wiki/Security-Considerations)

## License

[Mozilla Public License 2.0](LICENSE)
