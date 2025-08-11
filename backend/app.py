from typing import Dict, List, Tuple, Optional

from fastapi import FastAPI, Depends, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from botocore.exceptions import ClientError

from auth import verify_token
from config import DEFAULT_BUCKET, PRESIGN_TTL, S3_ZONES, PRESIGN_UPLOAD_TTL
from s3_utils import (
    get_s3_client,
    find_zone_url,
    latest_entry_for_key,
    entry_to_brief,
    find_best_version,
    format_datetime_iso,
)

# ================== FastAPI app ==================
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ================== Routes ==================
@app.get("/zones")
def zones(user=Depends(verify_token)):
    """Return configured zones and default bucket."""
    return {
        "zones": [{"name": name, "endpoint": url} for name, url in S3_ZONES],
        "bucket": DEFAULT_BUCKET,
    }


@app.get("/list")
def list_objects(
        zone: str = Query(..., description="Zone name"),
        prefix: str = Query(default="", description="Optional folder-like prefix, e.g. 'foo/'"),
        bucket: Optional[str] = Query(default=None, description="If omitted, uses BUCKET from .env"),
        user=Depends(verify_token),
):
    """
    Folder-style listing for one zone using Delimiter='/'.
    Returns:
      {
        "folders": ["sub1/","sub2/"],
        "items": [{"key":"foo/bar.txt","last_modified":"...","size":123}, ...],
        "prefix": "foo/"
      }
    """
    bkt = bucket or DEFAULT_BUCKET
    if not bkt:
        raise HTTPException(status_code=400, detail="Missing 'bucket' and no BUCKET default set.")
    if prefix and not prefix.endswith("/"):
        prefix = prefix + "/"

    zone_url = find_zone_url(zone)
    s3 = get_s3_client(zone_url)

    folders: List[str] = []
    items: List[dict] = []
    token: Optional[str] = None

    try:
        while True:
            kwargs = {"Bucket": bkt, "Delimiter": "/"}
            if prefix:
                kwargs["Prefix"] = prefix
            if token:
                kwargs["ContinuationToken"] = token

            resp = s3.list_objects_v2(**kwargs)

            for cp in (resp.get("CommonPrefixes") or []):
                p = cp.get("Prefix")
                if not p:
                    continue
                # show folder name relative to current prefix
                name = p[len(prefix):] if prefix and p.startswith(prefix) else p
                folders.append(name)

            for obj in (resp.get("Contents") or []):
                # skip the "directory marker" (the object that equals the prefix itself)
                if prefix and obj.get("Key") == prefix:
                    continue
                items.append({
                    "key": obj.get("Key"),
                    "last_modified": format_datetime_iso(obj.get("LastModified")),
                    "size": obj.get("Size"),
                })

            if resp.get("IsTruncated") and resp.get("NextContinuationToken"):
                token = resp["NextContinuationToken"]
            else:
                break
    except ClientError as e:
        raise HTTPException(status_code=500, detail=e.response.get("Error", {}).get("Message", "S3 Error"))

    return {"folders": folders, "items": items, "prefix": prefix}


@app.get("/consistency/check")
def consistency_check(
        key: str = Query(..., description="Object key to check"),
        currentZone: str = Query(..., description="Zone currently selected by the UI"),
        bucket: Optional[str] = Query(default=None),
        user=Depends(verify_token),
) -> dict:
    """
    Compare the latest version of `key` across all zones.
    Returns per-zone latest/previous, whether globally consistent by ETag,
    and a recommended zone to download from.
    """
    bkt = bucket or DEFAULT_BUCKET
    if not bkt:
        raise HTTPException(status_code=400, detail="Missing 'bucket' and no BUCKET default set.")

    per_zone: Dict[str, dict] = {}
    latest_candidates: List[Tuple[str, dict]] = []

    for zone_name, zone_url in S3_ZONES:
        s3 = get_s3_client(zone_url)
        try:
            resp = s3.list_object_versions(Bucket=bkt, Prefix=key)

            # Manually tag entries from 'Versions' and 'DeleteMarkers' lists
            # to distinguish them after merging.
            obj_versions = resp.get("Versions") or []
            del_markers = resp.get("DeleteMarkers") or []
            for v in obj_versions: v['IsDeleteMarker'] = False
            for d in del_markers: d['IsDeleteMarker'] = True

            versions = obj_versions + del_markers
            versions = [v for v in versions if v.get("Key") == key]

            latest = latest_entry_for_key(versions)

            per_zone[zone_name] = {
                "zone": zone_name,
                "latest": entry_to_brief(latest),
            }
            if latest:
                latest_candidates.append((zone_name, latest))
        except ClientError as e:
            per_zone[zone_name] = {"zone": zone_name, "error": e.response.get("Error", {}).get("Message", "S3 Error"), "latest": None}

    # Determine global latest and recommended download zone
    global_latest = find_best_version(latest_candidates)
    global_latest_entry = global_latest[1] if global_latest else None
    global_latest_is_delete = bool(global_latest_entry and global_latest_entry.get("IsDeleteMarker"))

    recommended_download = find_best_version(latest_candidates, ignore_delete_markers=True)
    recommended_download_zone = recommended_download[0] if recommended_download else None

    # Classify each zone's state relative to the global latest timestamp
    per_zone_list: List[dict] = []
    current_zone_info = per_zone.get(currentZone)
    current_latest = current_zone_info.get("latest") if current_zone_info else None
    current_zone_latest_is_delete_marker = bool(current_latest and current_latest.get("type") == "DeleteMarker")

    comparator_ts = None
    if global_latest_entry and global_latest_entry.get("LastModified"):
        comparator_ts = format_datetime_iso(global_latest_entry.get("LastModified"))

    for zname, info in per_zone.items():
        latest = info.get("latest")
        state = "Unknown"  # Default state

        if info.get("error"):
            state = "Unknown"
        elif latest is None:
            # If the object is deleted globally, "Missing" is the correct, latest state.
            # If an object exists globally, "Missing" means this zone is outdated.
            state = "Latest" if global_latest_is_delete else "Missing"
        else:
            # Compare the zone's latest version timestamp to the global latest.
            state = "Latest" if (comparator_ts and latest.get("last_modified") == comparator_ts) else "Outdated"

        per_zone_list.append({
            "zone": zname,
            "state": state,
            "latest": latest,
            **({"error": info.get("error")} if info.get("error") else {})
        })

    # Consistency: all non-delete latest ETags equal & no errors
    etags: List[str] = []
    any_error = any("error" in pz for pz in per_zone_list)
    for pz in per_zone_list:
        lt = pz.get("latest")
        if lt and lt.get("type") != "DeleteMarker" and lt.get("etag"):
            etags.append(lt["etag"])
    consistent = (len(etags) > 0 and len(set(etags)) == 1) and not any_error

    return {
        "consistent": consistent,
        "per_zone": per_zone_list,
        "recommended_download_zone": recommended_download_zone,
        "current_zone_latest_is_delete_marker": current_zone_latest_is_delete_marker,
    }


@app.post("/presign/download")
def presign_download(
        payload: dict = Body(..., example={"zone": "ceph-zone1", "key": "file.txt", "version_id": None}),
        bucket: Optional[str] = Query(default=None),
        user=Depends(verify_token),
):
    """Return a presigned GET URL for an object (optionally a specific version)."""
    bkt = bucket or DEFAULT_BUCKET
    if not bkt:
        raise HTTPException(status_code=400, detail="Missing 'bucket' and no BUCKET default set.")

    zone = payload.get("zone")
    key = payload.get("key")
    version_id = payload.get("version_id")

    if not zone or not key:
        raise HTTPException(status_code=400, detail="Missing 'zone' or 'key'")

    zone_url = find_zone_url(zone)
    s3 = get_s3_client(zone_url)
    try:
        params = {"Bucket": bkt, "Key": key}
        if version_id:
            params["VersionId"] = version_id
        url = s3.generate_presigned_url("get_object", Params=params, ExpiresIn=PRESIGN_TTL)
        return {"url": url}
    except ClientError as e:
        raise HTTPException(status_code=500, detail=e.response.get("Error", {}).get("Message", "S3 Error"))


@app.post("/presign/upload")
def presign_upload(
        payload: dict = Body(..., example={"zone": "ceph-zone1", "key": "file.bin",
                                           "content_type": "application/octet-stream"}),
        bucket: Optional[str] = Query(default=None),
        user=Depends(verify_token),
):
    """Return a presigned PUT URL to upload an object to the selected zone."""
    bkt = bucket or DEFAULT_BUCKET
    if not bkt:
        raise HTTPException(status_code=400, detail="Missing 'bucket' and no BUCKET default set.")

    zone = payload.get("zone")
    key = payload.get("key")
    content_type = payload.get("content_type") or "application/octet-stream"

    if not zone or not key:
        raise HTTPException(status_code=400, detail="Missing 'zone' or 'key'")

    zone_url = find_zone_url(zone)
    s3 = get_s3_client(zone_url)
    try:
        # Use a configurable, longer TTL for uploads to accommodate large files and slow connections.
        url = s3.generate_presigned_url(
            "put_object",
            Params={"Bucket": bkt, "Key": key, "ContentType": content_type},
            ExpiresIn=PRESIGN_UPLOAD_TTL,
        )
        return {"url": url}
    except ClientError as e:
        raise HTTPException(status_code=500, detail=e.response.get("Error", {}).get("Message", "S3 Error"))


@app.delete("/objects/{zone}/{key:path}")
def delete_object(
        zone: str,
        key: str,
        bucket: Optional[str] = Query(default=None),
        user=Depends(verify_token),
):
    """
    Delete an object from a specific zone.
    If versioning is enabled on the bucket, this will create a delete marker.
    """
    bkt = bucket or DEFAULT_BUCKET
    if not bkt:
        raise HTTPException(
            status_code=400, detail="Missing 'bucket' and no BUCKET default set."
        )

    zone_url = find_zone_url(zone)
    s3 = get_s3_client(zone_url)
    try:
        s3.delete_object(Bucket=bkt, Key=key)
        return {"status": "ok", "message": f"Object '{key}' deleted from zone '{zone}'."}
    except ClientError as e:
        raise HTTPException(status_code=500, detail=e.response.get("Error", {}).get("Message", "S3 Error"))
