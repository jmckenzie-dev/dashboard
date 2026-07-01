# Fix Polling Interval and TOML Null Serialization

## What we learned
- The project root was different from the provided working directory, which required discovery of the actual source location.
- The `toml` package (tolvajs/toml) doesn't support a null type, leading to a bug where `null` was serialized as the string `"null"`.
- Server-side clamping is necessary because client-side HTML attributes (`min`/`max`) are easily bypassed.

## What failed / Challenges
- Initial task execution happened relative to the wrong directory, though the subagents managed to find their targets (or I would have caught it if they didn't).
- User requested to skip the container restart, preventing full runtime validation of the fix.

## How we fixed it
- Updated `tomlStringify` to omit null values.
- Added a normalization pass in `loadConfig` to map `"null"` strings back to `null`.
- Added `Math.max(1000, Math.min(60000, ...))` in the API PUT handler.
- Updated the settings UI boundaries.
- Updated the configuration file manually to provide immediate CPU relief.
