import os
from typing import List, Tuple
from urllib.parse import urlparse

# --- Load .env (optional) ---
try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    pass

# ================== Env ==================
OIDC_ISSUER = os.getenv("OIDC_ISSUER") or os.getenv("KEYCLOAK_URL")
OIDC_AUDIENCE = os.getenv("OIDC_AUDIENCE") or os.getenv("KEYCLOAK_AUDIENCE", "ceph-rgw-browser")

RGW_ACCESS_KEY = os.getenv("RGW_ACCESS_KEY") or os.getenv("S3_ACCESS_KEY")
RGW_SECRET_KEY = os.getenv("RGW_SECRET_KEY") or os.getenv("S3_SECRET_KEY")

DEFAULT_BUCKET = os.getenv("BUCKET")
PRESIGN_TTL = int(os.getenv("PRESIGN_TTL", "600"))
PRESIGN_UPLOAD_TTL = int(os.getenv("PRESIGN_UPLOAD_TTL", "10800"))  # 3 hours for large uploads

raw_zones = os.getenv("S3_ZONES", "")
if not raw_zones.strip():
    raise RuntimeError(
        "S3_ZONES is not set. Examples:\n"
        "  S3_ZONES=zone1=https://ceph-zone1.example.com,zone2=https://ceph-zone2.example.com\n"
        "  or\n"
        "  S3_ZONES=https://ceph-zone1.example.com,https://ceph-zone2.example.com"
    )


def _parse_zones(raw: str) -> List[Tuple[str, str]]:
    """
    Accepts either:  name=url,name2=url2  OR  url1,url2
    When no name is given, derive a short name from hostname or use zoneN.
    """
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    zones: List[Tuple[str, str]] = []
    unnamed = 0
    for p in parts:
        if "=" in p:
            name, url = p.split("=", 1)
            zones.append((name.strip(), url.strip()))
        else:
            host = ""
            try:
                host = urlparse(p).hostname or ""
            except Exception:
                pass
            name = host.split(".")[0] if host else f"zone{unnamed + 1}"
            zones.append((name, p))
            unnamed += 1
    return zones


S3_ZONES: List[Tuple[str, str]] = _parse_zones(raw_zones)

if not OIDC_ISSUER:
    raise RuntimeError("Missing OIDC issuer. Set OIDC_ISSUER (or KEYCLOAK_URL) in .env")
if not RGW_ACCESS_KEY or not RGW_SECRET_KEY:
    raise RuntimeError("Missing RGW credentials. Set RGW_ACCESS_KEY/RGW_SECRET_KEY (or S3_ACCESS_KEY/S3_SECRET_KEY).")
