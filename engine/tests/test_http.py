"""The shared engine (`serve` mode): MCP over streamable HTTP plus the REST API.

    python engine/tests/test_http.py http://127.0.0.1:8765/mcp /tmp/pdf-engine-test/contract.pdf http://127.0.0.1:8090
"""
import asyncio
import json
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def main(url: str, pdf: str, rest_base: str) -> int:
    async with streamablehttp_client(url) as (read, write, _):
        async with ClientSession(read, write) as session:
            info = await session.initialize()
            tools = (await session.list_tools()).tools
            res = await session.call_tool("pdf_info", {"path": pdf})
            pages = json.loads(res.content[0].text)["pageCount"]
            print(f"MCP over HTTP: {info.serverInfo.name} {info.serverInfo.version}, {len(tools)} tools, {pages} pages")
    rest = httpx.get(f"{rest_base}/v1/pdf/engine/ready").json()
    print("REST:", rest)
    ok = pages > 0 and rest.get("ready")
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "http://127.0.0.1:8090")))
