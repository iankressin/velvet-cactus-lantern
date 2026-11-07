"""A Portal that serves one EVM chain held in memory, over the routes bj blocks reads, so tests need no network."""

import json
import re


class FakeResponse:
    def __init__(self, status_code, body=None, lines=(), headers=None):
        self.status_code = status_code
        self.headers = headers or {}
        self.body = body
        self.text = "\n".join(json.dumps(line) for line in lines) if lines else json.dumps(body)

    def json(self):
        return self.body


class FakePortal:
    """Block n has timestamp timestamps[n]. Portal's time-to-block route answers the first block at or
    after a time, moved by `guess_offset` to stand for a dataset that resolves times only roughly. The
    first `overloaded` requests get 529, as Portal answers when it is busy."""

    def __init__(self, timestamps, guess_offset=0, overloaded=0):
        self.timestamps = timestamps
        self.guess_offset = guess_offset
        self.overloaded = overloaded
        self.requests = []

    @property
    def head(self):
        return len(self.timestamps) - 1

    def request(self, method, url, json=None, **kwargs):
        dataset, route = url.split("/datasets/", 1)[1].split("/", 1)
        self.requests.append((method, dataset, route, json))
        if self.overloaded:
            self.overloaded -= 1
            return FakeResponse(529, {"error": {"code": "overloaded"}}, headers={"retry-after": "0"})
        if route == "head":
            return FakeResponse(200, {"number": self.head, "hash": "0x00"})
        if found := re.fullmatch(r"timestamps/(\d+)/block", route):
            block = next((n for n, at in enumerate(self.timestamps) if at >= int(found[1])), None)
            if block is None:
                return FakeResponse(404, {"error": {"code": "not_found", "message": "block not in hotblocks"}})
            return FakeResponse(200, {"block_number": min(max(block + self.guess_offset, 0), self.head)})
        if route == "stream":
            # With no data asked for, Portal sends every block only under includeAllBlocks, and else the last.
            first = json["fromBlock"] if json.get("includeAllBlocks") else json["toBlock"]
            blocks = range(first, json["toBlock"] + 1)
            return FakeResponse(200, lines=[{"header": {"number": n, "timestamp": self.timestamps[n]}} for n in blocks])
        return FakeResponse(404, {"error": {"code": "not_found"}})
