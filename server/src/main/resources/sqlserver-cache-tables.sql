IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'cache_definition') AND type in (N'U'))
CREATE TABLE cache_definition (
    id                          CHAR(36) PRIMARY KEY,
    name                        NVARCHAR(255) NOT NULL UNIQUE,
    enabled                     BIT DEFAULT 1 NOT NULL,
    driver                      NVARCHAR(512) NOT NULL,
    url                         NVARCHAR(1024) NOT NULL,
    username                    NVARCHAR(255),
    password                    NVARCHAR(1024),
    query                       NVARCHAR(MAX) NOT NULL,
    key_column                  NVARCHAR(255),
    value_column                NVARCHAR(255),
    max_size                    BIGINT DEFAULT 10000,
    eviction_duration_minutes   BIGINT DEFAULT 60,
    max_connections             INT DEFAULT 5,
    created_at                  DATETIME2 DEFAULT GETDATE(),
    updated_at                  DATETIME2 DEFAULT GETDATE()
)
