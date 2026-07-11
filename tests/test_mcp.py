from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
from mcp.client.session import ClientSession
from mcp.shared.memory import create_connected_server_and_client_session

import cartograph.mcp_server as server


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> AsyncGenerator[ClientSession]:
    monkeypatch.setattr(server, "DEFAULT_DB", tmp_path / "cartograph.sqlite3")
    async with create_connected_server_and_client_session(server.mcp, raise_exceptions=True) as session:
        yield session


@pytest.mark.anyio
async def test_protocol_lists_and_calls_bounded_tools(client_session: ClientSession, tmp_path: Path) -> None:
    subject = tmp_path / "subject"
    subject.mkdir()
    (subject / "server.py").write_text(
        "from mcp.server.fastmcp import FastMCP\nmcp = FastMCP('Subject')\n@mcp.tool()\ndef ping(): return 'pong'\n",
        encoding="utf-8",
    )
    tools = await client_session.list_tools()
    names = {tool.name for tool in tools.tools}
    assert names == {
        "project_register", "project_scan", "project_status", "graph_neighbors",
        "graph_path", "graph_gaps", "graph_plague", "graph_export",
    }
    by_name = {tool.name: tool for tool in tools.tools}
    assert by_name["graph_neighbors"].annotations.readOnlyHint is True
    assert by_name["project_scan"].annotations.readOnlyHint is False
    await client_session.call_tool("project_register", {"project": "subject", "path": str(subject)})
    scan_result = await client_session.call_tool("project_scan", {"project": "subject"})
    assert scan_result.isError is False
    export = await client_session.call_tool("graph_export", {"project": "subject", "node_limit": 1})
    assert export.isError is False
