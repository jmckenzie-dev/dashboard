## Fix Dashboard CPU Thrashing

- Identified that the in-memory parsed parts cache was capped at `PART_CACHE_LIMIT = 10000`, which was smaller than the working set of a single poll tick (~12,700 parts across the 200 non-archived parent sessions).
- This caused "cache thrashing" where the cache size continuously exceeded 10,000, triggering evictions and forcing the server to re-parse thousands of parts on every poll cycle.
- Increased `PART_CACHE_LIMIT` to `100000` to easily accommodate the active working set.
- Verified that the cache miss rate dropped dramatically (from ~50% down to near-zero once warmed up) and instantaneous idle CPU usage dropped from ~26% down to 0.0%.
