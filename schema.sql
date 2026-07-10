DROP TABLE IF EXISTS vps_records;
CREATE TABLE vps_records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    area TEXT NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    stock INTEGER NOT NULL,
    specs TEXT NOT NULL,
    link TEXT NOT NULL,
    latency INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    cpu INTEGER,
    memory INTEGER,
    disk INTEGER,
    bandwidth INTEGER,
    flow INTEGER,
    flow_used INTEGER,
    due_time INTEGER,
    node_name TEXT,
    server_price REAL,
    server_cycle INTEGER,
    ipv4_num INTEGER,
    ipv6_num INTEGER,
    ip_status TEXT,
    ip_check_detail TEXT,
    reset_price REAL
);
CREATE INDEX idx_vps_price ON vps_records(price);
CREATE INDEX idx_vps_updated ON vps_records(updated_at);
