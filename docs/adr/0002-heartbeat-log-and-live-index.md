# Postgres heartbeat log is the source of truth; warnings are served from an in-memory projection

Heartbeats are appended to a Postgres table, day-partitioned and kept 3 days, before they are acknowledged; all warning queries are answered from an in-memory interval index that is a projection of that log. On startup the index is rebuilt from the last 300 seconds of the log, so a restart or deploy loses no warnings; additional server instances keep their indexes in step through Postgres `LISTEN/NOTIFY`, so scaling out needs no Redis. Expired history is removed by dropping whole day partitions, never by `DELETE`, which keeps a table with millions of rows a day free of bloat and vacuum load.

## Considered Options

- In memory only: fastest and simplest, but a restart blinds the service for up to one TTL, there is no history, and it cannot scale beyond one instance.
- Postgres as the primary store (the original spec's shape): every query is a database round trip, the table churns constantly, and Postgres has no native index on two integer columns.

## Consequences

Drizzle cannot declare partitioned tables, so the `heartbeats` table has one hand-written SQL migration, and the server creates upcoming partitions and drops expired ones itself. Collision events — far fewer rows — live in an ordinary table kept for one year and carry the analytics.
