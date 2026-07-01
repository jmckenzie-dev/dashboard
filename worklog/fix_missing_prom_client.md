## Fix Missing Prom-Client Dependency

- Identified that the `prom-client` dependency (recently introduced for Prometheus instrumentation) was declared in `package.json` but not installed in the local `node_modules` directory, causing build failures during `npm run check`.
- Installed the missing dependencies by running `npm install`.
- Verified that both `npm run check` and `npm run build` pass without any diagnostics errors or warnings.
- Restarted the dashboard service successfully using `./restart_dashboard.sh`.
