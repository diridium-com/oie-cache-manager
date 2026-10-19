CREATE TABLE cache_definition (
    id                          CHAR(36) PRIMARY KEY,
    name                        VARCHAR(255) NOT NULL UNIQUE,
    enabled                     BOOLEAN DEFAULT TRUE NOT NULL,
    driver                      VARCHAR(512) NOT NULL,
    url                         VARCHAR(1024) NOT NULL,
    username                    VARCHAR(255),
    password                    VARCHAR(1024),
    query                       CLOB NOT NULL,
    key_column                  VARCHAR(255),
    value_column                VARCHAR(255),
    max_size                    BIGINT DEFAULT 10000,
    eviction_duration_minutes   BIGINT DEFAULT 60,
    max_connections             INTEGER DEFAULT 5,
    created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
