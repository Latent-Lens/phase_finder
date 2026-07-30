# Browser unit baseline — 2026-07-28

This preserves the latest browser-unit result that predates the PREP checklist
work performed on 2026-07-29.

| Field | Value |
| --- | --- |
| Generated | `2026-07-28T18:01:51` |
| Result | **607 passed, 1 failed, 0 warnings (608 total)** |
| Failed group | `Unit / Session TOML` |
| Failure | `Session TOML suite setup` — `serialize_session` read `names` from an undefined value |
| Local report | `tests/e2e/results/20260728-180111-529955/unit_only_20260728-180111.html` |
| Report SHA-256 | `1bcdf8941d0b06cea54210ed3282b92e1209f33303e1293aaa3811eed17bd0f5` |

The audit text's older 415/415 result remains historical context, not the
current baseline. This recorded failure must not be converted into a warning;
the relevant session remediation must make it pass.
