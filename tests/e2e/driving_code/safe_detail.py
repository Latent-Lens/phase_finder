"""Bound arbitrarily large test details before they reach reports or logs."""

import hashlib
import json
import math

MAX_DETAIL_BYTES = 4096


def _digest(value):
    raw = json.dumps(value, default=str, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()[:12]


def _summarize(value, depth=0):
    if depth >= 4:
        return f"<{type(value).__name__}>"
    if isinstance(value, list):
        numbers = [item for item in value if isinstance(item, (int, float)) and math.isfinite(item)]
        summary = {"length": len(value), "sha256": _digest(value)}
        if numbers:
            summary["numeric"] = {"min": min(numbers), "max": max(numbers), "mean": sum(numbers) / len(numbers)}
        summary["head"] = [_summarize(item, depth + 1) for item in value[:4]]
        if len(value) > 4:
            summary["tail"] = [_summarize(item, depth + 1) for item in value[-4:]]
        return summary
    if isinstance(value, dict):
        items = list(value.items())
        result = {str(key): _summarize(item, depth + 1) for key, item in items[:20]}
        if len(items) > 20:
            result["<omitted keys>"] = len(items) - 20
        return result
    if isinstance(value, str) and len(value) > 1000:
        return f"{value[:1000]}… <{len(value)} chars, sha256={hashlib.sha256(value.encode()).hexdigest()[:12]}>"
    return value


def safe_detail(value):
    if value in (None, ""):
        return ""
    parsed = value
    if isinstance(value, str) and value.lstrip().startswith(("[", "{")):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            pass
    rendered = parsed if isinstance(parsed, str) else json.dumps(_summarize(parsed), ensure_ascii=False, separators=(",", ":"))
    raw = rendered.encode()
    if len(raw) <= MAX_DETAIL_BYTES:
        return rendered
    suffix = f"… <truncated, sha256={hashlib.sha256(raw).hexdigest()[:12]}>"
    keep = MAX_DETAIL_BYTES - len(suffix.encode())
    return raw[:keep].decode("utf-8", errors="ignore") + suffix
