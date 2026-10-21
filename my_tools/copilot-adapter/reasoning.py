"""Split a streamed completion into reasoning text and answer text.

MiniMax (and many other reasoning models) inline the chain of thought in the
normal `content` stream, wrapped in <think>...</think> (or <thinking>).
Workspace renders raw tags as garbage, so we peel them out:

    feed("...") -> [("think", "..."), ("answer", "...")]

Tags may be split across deltas, so a tail that could still grow into a tag is
kept in the buffer instead of being emitted.
"""

from __future__ import annotations

import re
from typing import List, Tuple

_OPEN_RE = re.compile(r"<think(?:ing)?\s*>", re.IGNORECASE)
_CLOSE_RE = re.compile(r"</think(?:ing)?\s*>", re.IGNORECASE)

# Longest partial suffix worth holding back: len("<thinking>") - 1.
_MAX_TAG_TAIL = 10


def _partial_tag_tail(text: str) -> int:
    """Length of the suffix of `text` that may still become a tag."""
    for size in range(min(_MAX_TAG_TAIL, len(text)), 0, -1):
        tail = text[-size:]
        if "<think".startswith(tail.lower()) or "</think".startswith(tail.lower()):
            return size
    return 0


class ReasoningSplitter:
    def __init__(self) -> None:
        self.in_think = False
        self.buf = ""
        self.saw_tags = False

    def _drain(self) -> List[Tuple[str, str]]:
        out: List[Tuple[str, str]] = []
        while True:
            if not self.in_think:
                match = _OPEN_RE.search(self.buf)
                if match:
                    self.saw_tags = True
                    if match.start() > 0:
                        out.append(("answer", self.buf[: match.start()]))
                    self.buf = self.buf[match.end() :]
                    self.in_think = True
                    continue

                # No (complete) opening tag: emit everything but a possible
                # tag fragment at the end, unless it looks like a bare "<think"
                # still waiting for its ">".
                cut = len(self.buf) - _partial_tag_tail(self.buf)
                if cut <= 0:
                    break
                out.append(("answer", self.buf[:cut]))
                self.buf = self.buf[cut:]
                break

            match = _CLOSE_RE.search(self.buf)
            if match:
                if match.start() > 0:
                    out.append(("think", self.buf[: match.start()]))
                self.buf = self.buf[match.end() :]
                self.in_think = False
                continue

            cut = len(self.buf) - _partial_tag_tail(self.buf)
            if cut <= 0:
                break
            out.append(("think", self.buf[:cut]))
            self.buf = self.buf[cut:]
            break
        return out

    def feed(self, text: str) -> List[Tuple[str, str]]:
        self.buf += text
        return self._drain()

    def flush(self) -> List[Tuple[str, str]]:
        if not self.buf:
            return []
        kind = "think" if self.in_think else "answer"
        leftover, self.buf = self.buf, ""
        return [(kind, leftover)]
