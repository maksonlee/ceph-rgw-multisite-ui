from datetime import datetime
from typing import List, Tuple, Optional

import boto3
from fastapi import HTTPException

from config import RGW_ACCESS_KEY, RGW_SECRET_KEY, S3_ZONES


def get_s3_client(zone_url: str):
    return boto3.client(
        "s3",
        endpoint_url=zone_url,
        aws_access_key_id=RGW_ACCESS_KEY,
        aws_secret_access_key=RGW_SECRET_KEY,
    )


def format_datetime_iso(dt: Optional[datetime]) -> Optional[str]:
    """Formats a datetime object to an ISO string without microseconds."""
    if not dt:
        return None
    return dt.replace(microsecond=0).isoformat()


def find_zone_url(name: str) -> str:
    for n, u in S3_ZONES:
        if n == name:
            return u
    raise HTTPException(status_code=404, detail=f"Zone '{name}' not found")


# -------- Version helpers --------
def latest_entry_for_key(versions: List[dict]) -> Optional[dict]:
    if not versions:
        return None
    return sorted(versions, key=lambda v: v.get("LastModified"), reverse=True)[0]


def previous_entry_for_key(versions: List[dict], latest: Optional[dict]) -> Optional[dict]:
    if not versions or not latest:
        return None
    ordered = sorted(versions, key=lambda v: v.get("LastModified"), reverse=True)
    return ordered[1] if len(ordered) > 1 else None


def entry_to_brief(entry: Optional[dict]) -> Optional[dict]:
    if not entry:
        return None
    typ = "DeleteMarker" if entry.get("IsDeleteMarker") else "Version"
    return {
        "type": typ,
        "version_id": entry.get("VersionId"),
        "etag": entry.get("ETag", "").strip('"') if entry.get("ETag") else None,
        "last_modified": format_datetime_iso(entry.get("LastModified")),
        "size": entry.get("Size"),
        "is_latest": bool(entry.get("IsLatest")),
    }


def find_best_version(
        candidates: List[Tuple[str, dict]],
        ignore_delete_markers: bool = False
) -> Optional[Tuple[str, dict]]:
    """Find the best version entry from a list of (zone, entry) tuples based on LastModified."""
    valid_candidates = [
        (zone, entry) for zone, entry in candidates
        if not (ignore_delete_markers and entry.get("IsDeleteMarker")) and entry.get("LastModified")
    ]
    return max(valid_candidates, key=lambda item: item[1]["LastModified"]) if valid_candidates else None
