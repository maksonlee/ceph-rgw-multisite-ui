from typing import Optional

import requests
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt

from config import OIDC_ISSUER, OIDC_AUDIENCE

security = HTTPBearer()
JWKS_CACHE: Optional[dict] = None


def _get_jwks() -> dict:
    global JWKS_CACHE
    if JWKS_CACHE:
        return JWKS_CACHE
    jwks_url = f"{OIDC_ISSUER}/protocol/openid-connect/certs"
    resp = requests.get(jwks_url, timeout=5)
    resp.raise_for_status()
    JWKS_CACHE = resp.json()
    return JWKS_CACHE


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        # find matching JWK by kid
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")
        if not kid:
            raise HTTPException(status_code=401, detail="Missing kid in token header")

        jwks = _get_jwks()
        jwk_key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
        if not jwk_key:
            # key rotation fallback: refresh JWKS once
            global JWKS_CACHE
            JWKS_CACHE = None
            jwks = _get_jwks()
            jwk_key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
            if not jwk_key:
                raise HTTPException(status_code=401, detail="No matching JWK for token kid")

        return jwt.decode(token, jwk_key, algorithms=["RS256"], audience=OIDC_AUDIENCE)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Token verification failed: {e}")
