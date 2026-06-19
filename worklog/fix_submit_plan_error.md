## Fix Submit Plan Error Priority

- Reproduced a session showing `error` while the latest assistant message had a
  running `submit_plan` review.
- Root cause: `hasError` was computed from any error tool part in the latest 80
  session parts, so an older `submit_plan:error` masked a newer active
  `submit_plan:running`.
- Fixed status inference to scope `hasError` to the latest relevant tool state
  and to prioritize actionable blocking states before current tool errors.
- Added `plan_exit` as an alternate review-blocking tool name.
- Added regression tests covering older plan errors, latest tool errors,
  permission-vs-error priority, `plan_exit`, and the real mixed
  `submit_plan:error` + newer `submit_plan:running` shape.
- Verified the fixed production build reports the target session as
  `blocked_review` on a temporary server. Restart of the real dashboard remains
  blocked from this environment by inaccessible user systemd.
