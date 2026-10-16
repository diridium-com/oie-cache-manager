CREATE TABLE cache_definition (
    id                          CHAR(36) PRIMARY KEY,
    name                        VARCHAR2(255) NOT NULL UNIQUE,
    enabled                     NUMBER(1) DEFAULT 1 NOT NULL,
    driver                      VARCHAR2(512) NOT NULL,
    url                         VARCHAR2(1024) NOT NULL,
    username                    VARCHAR2(255),
    password                    VARCHAR2(1024),
    query                       CLOB NOT NULL,
    key_column                  VARCHAR2(255),
    value_column                VARCHAR2(255),
    max_size                    NUMBER DEFAULT 10000,
    eviction_duration_minutes   NUMBER DEFAULT 60,
    max_connections             NUMBER DEFAULT 5,
    created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
