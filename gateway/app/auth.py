import hmac

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader

from app.config import settings

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(api_key: str | None = Security(api_key_header)) -> None:
    if not settings.api_key:
        return
    if not api_key or not hmac.compare_digest(api_key.encode(), settings.api_key.encode()):
        raise HTTPException(status_code=401, detail="API key missing or wrong (send it in the X-API-Key header)")
