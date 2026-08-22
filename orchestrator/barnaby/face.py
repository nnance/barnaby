"""The face channel.

The orchestrator is the server; the browser on the panel connects in. It owns
all policy — faults outrank moods, sleep follows idle — and the face just draws
what it is told. State names must match the keys in barnaby-face's STATES.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Literal

import websockets
from websockets.server import WebSocketServerProtocol

log = logging.getLogger("barnaby.face")

State = Literal[
    "boot", "neutral", "happy", "curious", "surprise", "listening", "sleepy",
    "offline", "haDown", "muted",
]

# Faults outrank moods. A fault indicator a good mood can mask is useless.
FAULTS: set[str] = {"offline", "haDown", "muted"}


class FaceServer:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self._clients: set[WebSocketServerProtocol] = set()
        self._mood: State = "boot"
        self._fault: State | None = None
        self._server = None

    async def start(self) -> None:
        self._server = await websockets.serve(self._handle, self.host, self.port)
        log.info("face channel on ws://%s:%d/face", self.host, self.port)

    async def _handle(self, ws: WebSocketServerProtocol) -> None:
        self._clients.add(ws)
        log.info("face connected (%d client(s))", len(self._clients))
        try:
            await self._send(ws, {"type": "state", "name": self.effective})
            async for _ in ws:            # the face never sends us anything
                pass
        except websockets.ConnectionClosed:
            pass
        finally:
            self._clients.discard(ws)
            log.info("face disconnected")

    @property
    def effective(self) -> State:
        return self._fault or self._mood

    async def _send(self, ws: WebSocketServerProtocol, msg: dict) -> None:
        try:
            await ws.send(json.dumps(msg))
        except websockets.ConnectionClosed:
            self._clients.discard(ws)

    async def _broadcast(self, msg: dict) -> None:
        if self._clients:
            await asyncio.gather(*(self._send(c, msg) for c in list(self._clients)),
                                 return_exceptions=True)

    async def set_mood(self, name: State) -> None:
        if name in FAULTS:
            raise ValueError(f"{name} is a fault, use set_fault()")
        self._mood = name
        if self._fault is None:
            await self._broadcast({"type": "state", "name": name})

    async def set_fault(self, name: State | None) -> None:
        if name == self._fault:
            return
        self._fault = name
        await self._broadcast({"type": "state", "name": self.effective})

    async def look(self, x: float, y: float) -> None:
        """Gaze target from the face tracker, -1..1. Eyes lead the head turn."""
        await self._broadcast({"type": "look", "x": round(x, 3), "y": round(y, 3)})

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
