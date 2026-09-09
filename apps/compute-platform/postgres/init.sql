CREATE ROLE eve_compute_migrator LOGIN PASSWORD 'eve_compute_migrator';
CREATE ROLE eve_compute_runtime LOGIN PASSWORD 'eve_compute_runtime';
CREATE ROLE eve_compute_inspector LOGIN PASSWORD 'eve_compute_inspector';

GRANT CONNECT ON DATABASE eve_compute
  TO eve_compute_migrator, eve_compute_runtime, eve_compute_inspector;
GRANT CREATE ON DATABASE eve_compute TO eve_compute_migrator;
