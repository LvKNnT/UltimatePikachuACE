"""Focused checks for the board parser and two-turn path search."""

import unittest
from unittest.mock import patch

from classic_pikachu_bot import Tile, find_pair, parse_state, wait_for_review


def padded(*rows: tuple[int, ...]) -> tuple[tuple[int, ...], ...]:
    width = len(rows[0])
    edge = (0,) * (width + 2)
    return (edge, *((0, *row, 0) for row in rows), edge)


class PathSearchTests(unittest.TestCase):
    def test_adjacent_pair(self) -> None:
        board = padded((1, 1), (2, 3))
        self.assertEqual(find_pair(board), (Tile(1, 1), Tile(1, 2)))

    def test_path_around_blocker(self) -> None:
        board = padded((1, 2, 1), (3, 4, 5), (6, 7, 8))
        self.assertEqual(find_pair(board), (Tile(1, 1), Tile(1, 3)))

    def test_enclosed_pair_is_unreachable(self) -> None:
        board = padded(
            (2, 3, 4, 5, 6),
            (7, 8, 9, 10, 11),
            (12, 13, 1, 14, 15),
            (16, 17, 18, 19, 20),
            (21, 22, 1, 23, 24),
        )
        self.assertIsNone(find_pair(board))

    def test_page_cells_become_padded_board(self) -> None:
        state = parse_state({
            "rows": 2, "cols": 2,
            "cells": [{"row": 1, "col": 2, "kind": 5}],
            "level": 3, "shuffles": 8, "score": 120,
            "modal": "", "actions": [],
        })
        self.assertEqual(state.board, padded((0, 5), (0, 0)))
        self.assertEqual(state.remaining, 1)


class ReviewPauseTests(unittest.TestCase):
    def test_waits_until_browser_window_is_closed(self) -> None:
        class FakeDriver:
            checks = 0

            @property
            def window_handles(self) -> list[str]:
                self.checks += 1
                return ["open"] if self.checks == 1 else []

        driver = FakeDriver()
        with patch("classic_pikachu_bot.time.sleep") as sleep:
            wait_for_review(driver, enabled=True)
        self.assertEqual(driver.checks, 2)
        sleep.assert_called_once_with(1)

    def test_headless_review_returns_immediately(self) -> None:
        class FakeDriver:
            @property
            def window_handles(self) -> list[str]:
                raise AssertionError("Headless mode should not poll the browser")

        wait_for_review(FakeDriver(), enabled=False)


if __name__ == "__main__":
    unittest.main()
