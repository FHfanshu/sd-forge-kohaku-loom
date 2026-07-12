from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DANBOORU_URL = "https://danbooru.donmai.us"
DEFAULT_LIMIT = 12
MAX_LIMIT = 30
MAX_QUERIES = 12
WIKI_BODY_LIMIT = 12_000
_CATEGORIES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}
_CATEGORY_IDS = {name: category for category, name in _CATEGORIES.items()}


def _limit(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = DEFAULT_LIMIT
    return max(1, min(parsed, MAX_LIMIT))


def _tag_query(value: Any) -> str:
    query = re.sub(r"\s+", "_", str(value or "").strip().lower())
    if not query:
        raise ValueError("Danbooru tag query is required")
    if len(query) > 160:
        raise ValueError("Danbooru tag query is too long")
    return query


def _tag_queries(query: str = "", queries: Any = None) -> list[str]:
    values = queries if isinstance(queries, list) else [query]
    result = []
    for value in values:
        normalized = _tag_query(value)
        if normalized not in result:
            result.append(normalized)
    if len(result) > MAX_QUERIES:
        raise ValueError(f"at most {MAX_QUERIES} Danbooru tag queries are allowed")
    return result


def _request_json(path: str, params: dict[str, Any]) -> Any:
    url = f"{DANBOORU_URL}{path}?{urlencode(params)}"
    request = Request(url, headers={"User-Agent": "ForgeNeoQwen3VLPromptTools/1.0"})
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"Danbooru returned HTTP {error.code}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Danbooru lookup failed: {error}") from error


def _tag_item(tag: dict[str, Any]) -> dict[str, Any]:
    canonical_name = str(tag.get("name") or "")
    return {
        "id": tag.get("id"),
        "name": canonical_name.replace("_", " "),
        "canonical_name": canonical_name,
        "prompt_tag": canonical_name.replace("_", " "),
        "category": _CATEGORIES.get(tag.get("category"), "unknown"),
        "post_count": int(tag.get("post_count") or 0),
        "is_deprecated": bool(tag.get("is_deprecated")),
        "wiki_url": f"{DANBOORU_URL}/wiki_pages/{canonical_name}",
        "tag_url": f"{DANBOORU_URL}/tags?search%5Bname%5D={canonical_name}",
    }


def _candidate_items(query: str, category_name: str, limit: int) -> list[dict[str, Any]]:
    autocomplete = _request_json(
        "/autocomplete.json",
        {"search[query]": query, "search[type]": "tag_query", "limit": limit},
    )
    params: dict[str, Any] = {
        "search[name_matches]": query if "*" in query else f"{query}*",
        "search[hide_empty]": "true",
        "search[order]": "count",
        "limit": limit,
    }
    if category_name:
        params["search[category]"] = _CATEGORY_IDS[category_name]
    prefix = _request_json("/tags.json", params)
    words = [word for word in query.replace("*", " ").split("_") if word]
    fuzzy_params = dict(params)
    fuzzy_params["search[name_matches]"] = "*" + "*".join(words) + "*" if words else "*"
    fuzzy = _request_json("/tags.json", fuzzy_params)
    result = []
    seen: set[str] = set()
    for source, entries in (("autocomplete", autocomplete), ("prefix", prefix), ("fuzzy", fuzzy)):
        for entry in entries if isinstance(entries, list) else []:
            tag = entry.get("tag") if isinstance(entry, dict) and isinstance(entry.get("tag"), dict) else entry
            if not isinstance(tag, dict) or str(tag.get("name") or "") in seen:
                continue
            if category_name and _CATEGORIES.get(tag.get("category")) != category_name:
                continue
            item = _tag_item(tag)
            item["match"] = "exact" if item["canonical_name"] == query else source
            result.append(item)
            seen.add(item["canonical_name"])
            if len(result) >= limit:
                return result
    return result


def search_danbooru_tags(query: str = "", category: str = "", limit: int = DEFAULT_LIMIT, queries: Any = None) -> dict[str, Any]:
    normalized_queries = _tag_queries(query, queries)
    category_name = str(category or "").strip().lower()
    if category_name and category_name not in _CATEGORY_IDS:
        raise ValueError(f"unknown Danbooru category: {category_name}")
    item_limit = _limit(limit)
    with ThreadPoolExecutor(max_workers=min(6, len(normalized_queries))) as executor:
        groups = list(executor.map(lambda value: _candidate_items(value, category_name, item_limit), normalized_queries))
    results = [
        {
            "query": normalized.replace("_", " "),
            "canonical_query": normalized,
            "items": items,
        }
        for normalized, items in zip(normalized_queries, groups)
    ]
    items = [item for result in results for item in result["items"]]
    return {
        "ok": True,
        "query": results[0]["query"],
        "canonical_query": results[0]["canonical_query"],
        "category": category_name,
        "items": items,
        "results": results,
        "source": DANBOORU_URL,
    }


def inspect_danbooru_tag(name: str, include_wiki: bool = True) -> dict[str, Any]:
    normalized_name = _tag_query(name)
    payload = _request_json("/tags.json", {"search[name_matches]": normalized_name, "limit": 20})
    matches = [item for item in payload if isinstance(item, dict) and item.get("name") == normalized_name] if isinstance(payload, list) else []
    if not matches:
        return {
            "ok": False,
            "name": normalized_name.replace("_", " "),
            "canonical_name": normalized_name,
            "error": "Danbooru tag not found",
            "source": DANBOORU_URL,
        }

    result = _tag_item(matches[0])
    result["ok"] = True
    if include_wiki:
        wiki_payload = _request_json("/wiki_pages.json", {"search[title]": normalized_name, "limit": 1})
        wiki = wiki_payload[0] if isinstance(wiki_payload, list) and wiki_payload and isinstance(wiki_payload[0], dict) else {}
        body = str(wiki.get("body") or "")
        result["wiki"] = (
            {
                "title": str(wiki.get("title") or normalized_name),
                "body": body[:WIKI_BODY_LIMIT],
                "truncated": len(body) > WIKI_BODY_LIMIT,
                "updated_at": wiki.get("updated_at"),
                "url": f"{DANBOORU_URL}/wiki_pages/{normalized_name}",
            }
            if wiki
            else None
        )
    result["source"] = DANBOORU_URL
    return result


def inspect_danbooru_tags(names: Any, include_wiki: bool = False) -> dict[str, Any]:
    if not isinstance(names, list) or not names:
        raise ValueError("Danbooru tag names must be a non-empty list")
    normalized_names = _tag_queries(queries=names)
    with ThreadPoolExecutor(max_workers=min(6, len(normalized_names))) as executor:
        results = list(executor.map(lambda value: inspect_danbooru_tag(value, include_wiki), normalized_names))
    return {"ok": True, "items": results, "source": DANBOORU_URL}


def related_danbooru_tags(name: str, category: str = "", limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
    canonical_name = _tag_query(name)
    category_name = str(category or "").strip().lower()
    if category_name and category_name not in _CATEGORY_IDS:
        raise ValueError(f"unknown Danbooru category: {category_name}")
    params: dict[str, Any] = {"query": canonical_name}
    if category_name:
        params["category"] = category_name
    payload = _request_json("/related_tag.json", params)
    if not isinstance(payload, dict):
        raise RuntimeError("Danbooru returned an invalid related-tag response")
    item_limit = _limit(limit)

    def entries(raw: Any, include_scores: bool = False) -> list[dict[str, Any]]:
        result = []
        for entry in raw if isinstance(raw, list) else []:
            tag = entry.get("tag") if isinstance(entry, dict) and isinstance(entry.get("tag"), dict) else entry
            if not isinstance(tag, dict) or str(tag.get("name") or "") == canonical_name:
                continue
            item = _tag_item(tag)
            if include_scores and isinstance(entry, dict):
                item["frequency"] = round(float(entry.get("frequency") or 0), 4)
                item["cosine_similarity"] = round(float(entry.get("cosine_similarity") or 0), 4)
            result.append(item)
            if len(result) >= item_limit:
                break
        return result

    return {
        "ok": True,
        "name": canonical_name.replace("_", " "),
        "canonical_name": canonical_name,
        "related": entries(payload.get("related_tags"), True),
        "wiki_suggestions": entries(payload.get("wiki_page_tags")),
        "source": DANBOORU_URL,
    }
