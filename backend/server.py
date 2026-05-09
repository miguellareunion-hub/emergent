from fastapi import FastAPI, APIRouter, Request
from fastapi.responses import Response, StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List
import uuid
from datetime import datetime, timezone
import httpx


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# TanStack Start dev server (Vite) where Lovable IDE API routes live.
TANSTACK_BASE = os.environ.get("TANSTACK_BASE", "http://localhost:3000")

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")  # Ignore MongoDB's _id field
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str

# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.model_dump()
    status_obj = StatusCheck(**status_dict)
    
    # Convert to dict and serialize datetime to ISO string for MongoDB
    doc = status_obj.model_dump()
    doc['timestamp'] = doc['timestamp'].isoformat()
    
    _ = await db.status_checks.insert_one(doc)
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    # Exclude MongoDB's _id field from the query results
    status_checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)
    
    # Convert ISO string timestamps back to datetime objects
    for check in status_checks:
        if isinstance(check['timestamp'], str):
            check['timestamp'] = datetime.fromisoformat(check['timestamp'])
    
    return status_checks

# Include the router in the main app
app.include_router(api_router)

# Routes that the Lovable IDE TanStack Start app exposes under /api/ — we
# forward them to localhost:3000 so the public ingress (which routes /api/*
# to this FastAPI process) can still reach them.
TANSTACK_API_PATHS = {
    "chat",
    "exec",
    "http-fetch",
    "web-search",
}


@app.api_route(
    "/api/{full_path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    include_in_schema=False,
)
async def tanstack_proxy(full_path: str, request: Request):
    """Forward unknown /api/* requests to the TanStack Start dev server.

    Uses streaming so SSE responses (e.g. /api/chat with stream=true) flow
    through correctly without buffering. The first path segment is checked
    against an allow-list to keep this proxy narrow.
    """
    first_seg = full_path.split("/", 1)[0]
    if first_seg not in TANSTACK_API_PATHS:
        return Response(status_code=404, content='{"detail":"Not Found"}',
                        media_type="application/json")

    target = f"{TANSTACK_BASE.rstrip('/')}/api/{full_path}"
    body = await request.body()
    # Strip hop-by-hop and ingress-injected headers that confuse the upstream.
    drop = {"host", "content-length", "connection", "transfer-encoding"}
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in drop}

    client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0))
    try:
        upstream = await client.send(
            client.build_request(
                request.method,
                target,
                content=body if body else None,
                headers=fwd_headers,
                params=dict(request.query_params),
            ),
            stream=True,
        )
    except httpx.RequestError as e:
        await client.aclose()
        return Response(
            status_code=502,
            content=f'{{"detail":"Upstream error: {e}"}}',
            media_type="application/json",
        )

    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in {"content-length", "transfer-encoding", "connection"}
    }

    async def streamer():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        streamer(),
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type"),
    )

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
